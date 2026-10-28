// Replay protection, failure after signing, and free-resource passthrough.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "@mandate/llm-rail";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Network } from "@x402/core/types";
import { createX402Rail } from "../src/rail.js";
import { startLocalFacilitator } from "../src/local-facilitator.js";
import { startPaidResource } from "../src/demo-server.js";
import {
  NETWORK,
  USDC,
  allowlistGuard,
  baseMandate,
  closeServer,
  getJson,
  listen,
  openTestRail,
  postJson,
  signTestMandate,
  tokenWallet,
} from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-x402-hard-"));
  dirs.push(d);
  return d;
}

test("replaying a captured payment signature is refused and moves no money; settling twice throws", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: 1_000_000n, [payee.account.address]: 0n },
  });
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
  });

  const initial = await getJson(resource.origin, "/data");
  assert.equal(initial.status, 402);
  const paymentRequired = decodePaymentRequiredHeader(String(initial.headers["payment-required"]));

  const client = new x402Client();
  client.setSpendControls(false);
  client.register(NETWORK as Network, new ExactEvmScheme(payer.account));
  const payload = await client.createPaymentPayload(paymentRequired);
  const signatureHeader = encodePaymentSignatureHeader(payload);

  const first = await getJson(resource.origin, "/data", { "PAYMENT-SIGNATURE": signatureHeader });
  assert.equal(first.status, 200, first.text);
  assert.equal(facilitator.token.balanceOf(payee.account.address), 10000n);

  const replay = await getJson(resource.origin, "/data", { "PAYMENT-SIGNATURE": signatureHeader });
  assert.equal(replay.status, 402, replay.text);
  assert.equal(facilitator.token.balanceOf(payee.account.address), 10000n, "a replay must move no money");
  assert.equal(facilitator.token.transfers.length, 1);

  // Settling one reservation twice throws.
  const mandate = baseMandate({ id: "mdt_settle_twice", allowed_payees: [{ rail: "x402", id: `${NETWORK}:${payee.account.address}` }] });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "twice.db"), signed, issuer.publicKey);
  const reserved = rail.store.reserve({
    mandateId: mandate.id,
    agentId: "agent-01",
    model: `x402:${NETWORK}:${USDC.toLowerCase()}`,
    provider: payee.account.address.toLowerCase(),
    amountMicros: 10000,
    rail: "x402",
    payeeVerifiedBy: "allowlist",
  });
  assert.ok(reserved.ok);
  rail.store.settle(reserved.reservationId, null, 10000, { tx_hash: null });
  assert.throws(() => rail.store.settle(reserved.reservationId, null, 10000, {}), /already settled/);

  await resource.close();
  await facilitator.close();
  rail.close();
});

test("a resource that takes the payment but answers 500 without settling is charged in full", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const broken = await startBrokenResource(payee.account.address);
  const mandate = baseMandate({ id: "mdt_broken_resource", allowed_payees: [{ rail: "x402", id: `${NETWORK}:${payee.account.address}` }] });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "broken.db"), signed, issuer.publicKey);
  const facilitator = await startLocalFacilitator({ networks: [NETWORK], balances: { [payer.account.address]: 1_000_000n } });
  const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([payee.account.address]) });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const base = `http://127.0.0.1:${port}`;

  const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${broken.origin}/pay` });
  assert.equal(r.status, 500, r.text);
  const spent = rail.store.spent(mandate.id);
  assert.equal(spent.settledMicros, 10000, "a signed but unsettled payment is booked in full");
  assert.equal(spent.reservedMicros, 0, "it must not stay reserved");
  const settlement = rail.ledger.entries().filter((e) => e.kind === "x402.settle");
  assert.equal(settlement.length, 1);
  const payload = settlement[0]!.payload as { outcome: string; details: { unconfirmed?: boolean; tx_hash: string | null } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.unconfirmed, true);
  assert.equal(payload.details.tx_hash, null);

  await closeServer(gateway);
  await broken.close();
  await facilitator.close();
  rail.close();
});

test("a non-402 response passes through with no charge and no ledger entry", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const free = await startFreeResource();
  const mandate = baseMandate({ id: "mdt_free_resource", allowed_payees: [{ rail: "x402", id: `${NETWORK}:${payee.account.address}` }] });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "free.db"), signed, issuer.publicKey);
  const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([payee.account.address]) });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const base = `http://127.0.0.1:${port}`;

  const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${free.origin}/hello` });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text), { free: true });
  assert.equal(r.headers["x-mandate-charged-micros"], "0");
  assert.equal(rail.store.spent(mandate.id).committedMicros, 0);
  const kinds = rail.ledger.entries().map((e) => e.kind);
  assert.ok(!kinds.includes("x402.settle"));
  assert.ok(!kinds.includes("x402.blocked"));

  await closeServer(gateway);
  await free.close();
  rail.close();
});

test("the gateway refuses a non-http(s) URL and an unauthenticated request", async () => {
  const payer = tokenWallet();
  const { issuer, signed } = signTestMandate(baseMandate({ id: "mdt_url_guard" }));
  const { rail } = openTestRail(join(tmp(), "urls.db"), signed, issuer.publicKey);
  const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([]) });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const base = `http://127.0.0.1:${port}`;

  const bad = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: "file:///etc/passwd" });
  assert.equal(bad.status, 400);
  const unauth = await postJson(base, "/v1/x402/fetch", {}, { url: "http://example.com" });
  assert.equal(unauth.status, 401);

  await closeServer(gateway);
  rail.close();
});

async function startBrokenResource(payTo: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const signature = req.headers["payment-signature"] ?? req.headers["PAYMENT-SIGNATURE"];
    if (!signature) {
      const paymentRequired = {
        x402Version: 2,
        resource: { url: `http://127.0.0.1/pay` },
        accepts: [
          { scheme: "exact", network: NETWORK as Network, asset: USDC, amount: "10000", payTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } },
        ],
      };
      res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
      res.end("{}");
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  return listenResource(server);
}

async function startFreeResource(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ free: true }));
  });
  return listenResource(server);
}

function listenResource(server: Server): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close(): Promise<void> {
          return closeServer(server);
        },
      });
    });
  });
}
