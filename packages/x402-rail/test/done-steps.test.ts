// DONE TESTS for plan steps 4 and 5, end to end through one gateway, with the
// real payee guard, the real Telegram approver against a mock Bot API, the
// local x402 facilitator and the same signed mandate and ledger.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, auditRail } from "@mandate/llm-rail";
import { addressKey } from "@mandate/payee-guard";
import { createPaymentGuard } from "../src/guard.js";
import { TelegramApprover, TelegramClient, startMockTelegram } from "@mandate/approval";
import { createX402Rail } from "../src/rail.js";
import { startLocalFacilitator } from "../src/local-facilitator.js";
import { startPaidResource } from "../src/demo-server.js";
import type { Approver } from "../src/types.js";
import { NETWORK, baseMandate, closeServer, listen, openTestRail, postJson, signTestMandate, tokenWallet } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-done-"));
  dirs.push(d);
  return d;
}

const EVIL_PAYEE = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const README = join(import.meta.dirname, "..", "..", "payee-guard", "test", "fixtures", "poisoned-README.md");

async function setup(opts: { approvalThreshold?: string; approver?: Approver } = {}) {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({
    id: `mdt_done_${Math.random().toString(36).slice(2, 10)}`,
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    approval_threshold: opts.approvalThreshold ?? "1.00",
    allowed_payees: [{ rail: "x402", id: `${NETWORK}:${payee.account.address}` }],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail, trusted } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);
  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: 100_000_000n },
  });
  const good = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [
      { path: "/v1/forecast", price: "$0.01", body: { city: "Berlin", forecast: "rain" } },
      { path: "/unlock", price: "$50", body: { premium: true } },
    ],
  });
  const evil = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: EVIL_PAYEE,
    routes: [{ path: "/unlock", price: "$50", body: { premium: true } }],
  });
  const x402 = createX402Rail({ allowPrivateNetwork: true,
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: createPaymentGuard({ rail, networks: [NETWORK] }),
    ...(opts.approver ? { approver: opts.approver } : {}),
  });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const call = (url: string) =>
    postJson(`http://127.0.0.1:${port}`, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url });
  const close = async () => {
    await closeServer(gateway);
    await good.close();
    await evil.close();
    await facilitator.close();
    rail.close();
  };
  return { payer, payee, mandate, rail, trusted, facilitator, good, evil, call, close };
}

test("DONE TEST step 5: a poisoned README asking for 50 USDC is blocked with a reason, a legitimate 0.01 payment passes", async () => {
  const s = await setup();
  const payerStart = s.facilitator.token.balanceOf(s.payer.account.address);

  // The agent reads a README that hides a payment instruction, and obeys it.
  const readme = readFileSync(README, "utf8").replaceAll("http://127.0.0.1:45999", s.evil.origin);
  const injectedUrl = /(http:\/\/127\.0\.0\.1:\d+\/unlock)/.exec(readme)?.[1];
  assert.ok(injectedUrl, "the fixture carries an injected URL");
  assert.match(readme, /50 USDC/);

  const poisoned = await s.call(injectedUrl);
  const err = JSON.parse(poisoned.text).error as { code: string; message: string };
  console.log(`# step5 poisoned README: HTTP ${poisoned.status} ${err.code}: ${err.message}`);
  assert.equal(poisoned.status, 403);
  assert.equal(err.code, "payee_not_allowed");
  assert.ok(err.message.includes(EVIL_PAYEE) && err.message.includes(s.evil.origin), err.message);
  assert.equal(s.evil.paidRequests, 0);

  // The legitimate 0.01 payment to the payee in the signed mandate passes.
  const legit = await s.call(`${s.good.origin}/v1/forecast`);
  const tx = String(legit.headers["x-mandate-tx-hash"] ?? "");
  console.log(`# step5 legitimate payment: HTTP ${legit.status} tx ${tx} amount 0.010000 USDC`);
  assert.equal(legit.status, 200, legit.text);
  assert.match(tx, /^0x[0-9a-f]{64}$/i);

  // The same 50 USDC ask on the allowlisted payee is blocked by the amount bound
  // (more than 3x the 30-day median of 0.01).
  const inflated = await s.call(`${s.good.origin}/unlock`);
  const err2 = JSON.parse(inflated.text).error as { code: string; message: string };
  console.log(`# step5 inflated amount to an allowlisted payee: HTTP ${inflated.status} ${err2.code}: ${err2.message}`);
  assert.equal(inflated.status, 403);
  assert.equal(err2.code, "amount_out_of_bounds");
  assert.match(err2.message, /50\.000000/);

  // Only the 0.01 moved. Both blocks are signed ledger entries.
  assert.equal(s.facilitator.token.balanceOf(s.payer.account.address), payerStart - 10_000n);
  assert.equal(s.facilitator.token.balanceOf(EVIL_PAYEE), 0n);
  const kinds = s.rail.ledger.entries().map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "x402.blocked").length, 2);
  assert.equal(kinds.filter((k) => k === "x402.settle").length, 1);
  const v = s.rail.ledger.verify(s.trusted);
  assert.ok(v.ok, v.reason);
  const audit = auditRail(s.rail.store, s.rail.ledger, s.mandate.id, s.trusted);
  assert.ok(audit.ok, audit.ok ? "" : audit.reason);
  assert.equal(addressKey(NETWORK, EVIL_PAYEE), `${NETWORK}:${EVIL_PAYEE}`);
  await s.close();
});

async function telegramSetup(timeoutMs: number) {
  const mock = await startMockTelegram();
  const approver = new TelegramApprover({
    client: new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl }),
    chatId: 777001,
    approverUserIds: [4242],
    timeoutMs,
  });
  return { mock, approver };
}

test("DONE TEST step 4 (x402): Approve lets the agent pay, Deny and the timeout block it", async () => {
  const tg = await telegramSetup(400);
  const s = await setup({ approvalThreshold: "0.005", approver: tg.approver });
  const url = `${s.good.origin}/v1/forecast`;

  // Approve
  const p1 = s.call(url);
  const m1 = await tg.mock.waitForMessage(1, 5000);
  assert.match(m1.text, /TapVow approval/);
  tg.mock.press({ messageId: m1.messageId, button: "Approve", fromUserId: 4242 });
  const r1 = await p1;
  console.log(`# step4 x402 approve: HTTP ${r1.status} tx ${String(r1.headers["x-mandate-tx-hash"] ?? "")}`);
  assert.equal(r1.status, 200, r1.text);
  const settle = s.rail.ledger.entries().find((e) => e.kind === "x402.settle");
  const details = (settle?.payload as { details: { approval_request_id: string } }).details;
  assert.match(details.approval_request_id, /^apr_/);

  // Deny
  const p2 = s.call(url);
  const m2 = await tg.mock.waitForMessage(2, 5000);
  tg.mock.press({ messageId: m2.messageId, button: "Deny", fromUserId: 4242 });
  const r2 = await p2;
  console.log(`# step4 x402 deny: HTTP ${r2.status} ${JSON.parse(r2.text).error.code}`);
  assert.equal(r2.status, 403);
  assert.equal(JSON.parse(r2.text).error.code, "approval_denied");

  // Timeout (no press)
  const r3 = await s.call(url);
  console.log(`# step4 x402 timeout: HTTP ${r3.status} ${JSON.parse(r3.text).error.code}`);
  assert.equal(r3.status, 403);
  assert.equal(JSON.parse(r3.text).error.code, "approval_timeout");

  // A press by someone else never approves.
  const p4 = s.call(url);
  const m4 = await tg.mock.waitForMessage(4, 5000);
  tg.mock.press({ messageId: m4.messageId, button: "Approve", fromUserId: 9999 });
  const r4 = await p4;
  assert.equal(JSON.parse(r4.text).error.code, "approval_timeout");

  // Only the approved payment moved money.
  assert.equal(s.facilitator.token.transfers.length, 1);
  assert.equal(s.rail.store.spent(s.mandate.id).settledMicros, 10_000);
  await tg.approver.close();
  await tg.mock.close();
  await s.close();
});
