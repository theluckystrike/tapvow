// DONE TEST step 3 (local facilitator): 12 payments of 0.01 USDC settle
// through the gateway, on the same signed mandate and ledger the LLM rail uses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, auditRail } from "@mandate/llm-rail";
import { createX402Rail } from "../src/rail.js";
import { startLocalFacilitator, BASE_SEPOLIA_USDC as FAC_USDC } from "../src/local-facilitator.js";
import { startPaidResource } from "../src/demo-server.js";
import {
  NETWORK,
  allowlistGuard,
  baseMandate,
  closeServer,
  listen,
  openTestRail,
  postJson,
  signTestMandate,
  tokenWallet,
} from "./helpers.js";

const USDC = FAC_USDC;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-x402-"));
  dirs.push(d);
  return d;
}

test("DONE TEST step 3 (local facilitator): 12 payments of 0.01 USDC settle through the gateway", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({
    id: "mdt_x402_done_0001",
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "llm", id: "anthropic" },
      { rail: "x402", id: `${NETWORK}:${payee.account.address}` },
    ],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail, trusted } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);

  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: 10_000_000n, [payee.account.address]: 0n },
  });
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
  });

  const x402 = createX402Rail({ allowPrivateNetwork: true,
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: allowlistGuard([payee.account.address]),
  });
  const gateway = createGateway({
    store: rail.store,
    upstreams: {},
    routes: { "POST /v1/x402/fetch": x402.handler },
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const base = `http://127.0.0.1:${port}`;

  const txHashes: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/data` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers["x-mandate-rail"], "x402");
    const tx = String(r.headers["x-mandate-tx-hash"] ?? "");
    assert.match(tx, /^0x[0-9a-f]{64}$/i);
    txHashes.push(tx);
    console.log(`# x402 local payment ${i}: tx ${tx} amount 0.010000 USDC`);
  }
  console.log(
    `# x402 local summary: 12 payments, settled ${(rail.store.spent(mandate.id).settledMicros / 1e6).toFixed(6)} USD, payee ${(Number(facilitator.token.balanceOf(payee.account.address)) / 1e6).toFixed(6)} USDC`,
  );

  assert.equal(new Set(txHashes).size, 12, "tx hashes must be distinct");
  assert.equal(resource.paidRequests, 12);
  assert.equal(facilitator.token.balanceOf(payee.account.address), 120_000n);
  assert.equal(facilitator.token.balanceOf(payer.account.address), 10_000_000n - 120_000n);
  assert.equal(rail.store.spent(mandate.id).settledMicros, 120_000);
  assert.equal(rail.store.spent(mandate.id).reservedMicros, 0);

  const settles = rail.ledger.entries().filter((e) => e.kind === "x402.settle");
  assert.equal(settles.length, 12);
  const ledgerTx = settles.map((e) => (e.payload as { details: { tx_hash: string } }).details.tx_hash).sort();
  const tokenTx = facilitator.token.transfers.map((t) => t.txHash).sort();
  assert.deepEqual(ledgerTx, tokenTx);

  const v = rail.ledger.verify(trusted);
  assert.ok(v.ok, v.ok ? "" : v.reason);
  const audit = auditRail(rail.store, rail.ledger, mandate.id, trusted);
  assert.ok(audit.ok, audit.ok ? "" : audit.reason);

  await closeServer(gateway);
  await resource.close();
  await facilitator.close();
  rail.close();
});

test("the private key never appears in a response, header or ledger payload", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({ id: "mdt_x402_secret_0001", allowed_payees: [{ rail: "x402", id: `${NETWORK}:${payee.account.address}` }] });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);

  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: 1_000_000n },
  });
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
  });
  const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([payee.account.address]) });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const base = `http://127.0.0.1:${port}`;

  const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/data` });
  assert.equal(r.status, 200);

  const haystack = [
    r.text,
    JSON.stringify(r.headers),
    JSON.stringify(rail.ledger.entries()),
    JSON.stringify(rail.store.getPolicy(mandate.id)),
  ].join("\n");
  assert.ok(!haystack.includes(payer.privateKey), "payer private key leaked");
  assert.ok(!haystack.includes(payee.privateKey), "payee private key leaked");
  assert.ok(!haystack.includes(payer.privateKey.slice(2)), "payer key hex leaked");

  await closeServer(gateway);
  await resource.close();
  await facilitator.close();
  rail.close();
});

// Referenced so the USDC constant is exercised in requirements-shape assertions.
test("the local facilitator advertises production Base Sepolia USDC", async () => {
  const facilitator = await startLocalFacilitator({ networks: [NETWORK], balances: {} });
  const res = await fetch(`${facilitator.url}/supported`);
  const body = (await res.json()) as { kinds: Array<{ scheme: string; network: string }> };
  assert.ok(body.kinds.some((k) => k.scheme === "exact" && k.network === NETWORK));
  const payer = tokenWallet();
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payer.account.address,
    routes: [{ path: "/data", price: "$0.01", body: {} }],
  });
  const r = await fetch(`${resource.origin}/data`);
  assert.equal(r.status, 402);
  const required = JSON.parse(Buffer.from(String(r.headers.get("PAYMENT-REQUIRED")), "base64").toString("utf8")) as {
    accepts: Array<{ asset: string; amount: string; extra: { name: string; version: string } }>;
  };
  assert.equal(required.accepts[0]!.asset, USDC);
  assert.equal(required.accepts[0]!.amount, "10000");
  assert.equal(required.accepts[0]!.extra.name, "USDC");
  assert.equal(required.accepts[0]!.extra.version, "2");
  await resource.close();
  await facilitator.close();
});
