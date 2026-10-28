// DONE TEST for threat model issue 5 through the x402 rail: a replayed older
// signed payee binding is blocked before any payment is signed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner } from "@mandate/core";
import { createGateway } from "@mandate/llm-rail";
import { signBinding, type PayeeBinding } from "@mandate/payee-guard";
import { createPaymentGuard } from "../src/guard.js";
import { createX402Rail } from "../src/rail.js";
import { startLocalFacilitator } from "../src/local-facilitator.js";
import { startPaidResource } from "../src/demo-server.js";
import {
  NETWORK,
  USDC,
  baseMandate,
  closeServer,
  listen,
  openTestRail,
  postJson,
  signTestMandate,
  tokenWallet,
} from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-bind-"));
  dirs.push(d);
  return d;
}

test("a replayed older payee binding is blocked through the x402 rail before signing", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const bindingSigner = generateSigner("payee-binding");

  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const newer = iso(now - 86_400_000);
  const older = iso(now - 2 * 86_400_000);
  const expires = iso(now + 30 * 86_400_000);

  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: 10_000_000n },
  });

  // The resource serves the origin's /.well-known file; JSON.stringify calls
  // toJSON at request time, so the test can swap in the replayed document.
  let servedDoc: unknown = null;
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/report", price: "$0.01", body: { ok: true } }],
    wellKnown: { toJSON: () => servedDoc },
  });

  const bindingFor = (issuedAt: string): PayeeBinding => ({
    version: 1,
    origin: resource.origin,
    payees: [
      {
        network: NETWORK,
        asset: USDC,
        pay_to: payee.account.address,
        quotes: [{ path: "/report", amount: "10000" }],
      },
    ],
    issued_at: issuedAt,
    expires_at: expires,
  });

  const mandate = baseMandate({
    id: `mdt_bind_${Math.random().toString(36).slice(2, 10)}`,
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    approval_threshold: "1.00",
    allowed_payees: [{ rail: "x402", id: `binding:${bindingSigner.publicKey}@${resource.origin}` }],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);

  const x402 = createX402Rail({
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: createPaymentGuard({ rail, networks: [NETWORK] }),
    allowPrivateNetwork: true,
  });
  const gateway = createGateway({
    store: rail.store,
    upstreams: {},
    routes: { "POST /v1/x402/fetch": x402.handler },
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const call = () =>
    postJson(`http://127.0.0.1:${port}`, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/report` });

  try {
    servedDoc = signBinding(bindingFor(newer), bindingSigner.signer);
    const first = await call();
    assert.equal(first.status, 200, first.text);
    assert.equal(resource.paidRequests, 1);

    servedDoc = signBinding(bindingFor(older), bindingSigner.signer);
    const replay = await call();
    const err = JSON.parse(replay.text).error as { code: string; message: string };
    assert.equal(replay.status, 403);
    assert.equal(err.code, "binding_rolled_back");
    assert.ok(err.message.includes(older) && err.message.includes(newer), err.message);
    assert.equal(resource.paidRequests, 1, "no second payment was signed");
    assert.equal(facilitator.token.transfers.length, 1);
    const blocked = rail.ledger.entries().filter((e) => e.kind === "x402.blocked");
    assert.ok(blocked.some((e) => (e.payload as { code?: string }).code === "binding_rolled_back"));
    console.log(`# tm5 x402 replay: HTTP ${replay.status} ${err.code}, no payment signed (paid requests stay 1)`);
  } finally {
    await closeServer(gateway);
    await resource.close();
    await facilitator.close();
    rail.close();
  }
});
