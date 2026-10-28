// One budget across rails, guard blocks, per-call cap, rate limit, and the
// approval step-up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, startFakeUpstream } from "@mandate/llm-rail";
import { createX402Rail, type X402Rail } from "../src/rail.js";
import { startLocalFacilitator } from "../src/local-facilitator.js";
import { startPaidResource } from "../src/demo-server.js";
import type { Approver } from "../src/types.js";
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

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-x402-gov-"));
  dirs.push(d);
  return d;
}

interface Stack {
  base: string;
  key: string;
  rail: ReturnType<typeof openTestRail>["rail"];
  facilitator: Awaited<ReturnType<typeof startLocalFacilitator>>;
  payee: ReturnType<typeof tokenWallet>;
  x402: X402Rail;
  resourceUrl: string;
  close(): Promise<void>;
}

async function buildStack(args: {
  id: string;
  price: string;
  budget: string;
  perCallCap: string;
  approvalThreshold: string;
  maxCalls?: number;
  approver?: Approver;
  guard?: ReturnType<typeof allowlistGuard>;
  withLlm?: boolean;
}): Promise<Stack> {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({
    id: args.id,
    budget: { total: args.budget, period: "lifetime" },
    per_call_cap: args.perCallCap,
    approval_threshold: args.approvalThreshold,
    rate_limit: { max_calls: args.maxCalls ?? 100000, window_seconds: 60 },
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "llm", id: "anthropic" },
      { rail: "x402", id: `${NETWORK}:${payee.account.address}` },
    ],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), `${args.id}.db`), signed, issuer.publicKey);
  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: 10_000_000n, [payee.account.address]: 0n },
  });
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/data", price: args.price, body: { data: "paid" } }],
  });
  const x402 = createX402Rail({ allowPrivateNetwork: true,
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: args.guard ?? allowlistGuard([payee.account.address]),
    approver: args.approver,
  });
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>> | null = null;
  const upstreams: Parameters<typeof createGateway>[0]["upstreams"] = {};
  if (args.withLlm) {
    upstream = await startFakeUpstream({ latencyMs: [1, 3] });
    upstreams.openai = { baseUrl: upstream.url, apiKey: "sk-test-not-real" };
    upstreams.anthropic = { baseUrl: upstream.url, apiKey: "sk-test-not-real" };
  }
  const gateway = createGateway({
    store: rail.store,
    upstreams,
    routes: { "POST /v1/x402/fetch": x402.handler },
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  return {
    base: `http://127.0.0.1:${port}`,
    key,
    rail,
    facilitator,
    payee,
    x402,
    resourceUrl: `${resource.origin}/data`,
    async close() {
      await closeServer(gateway);
      await resource.close();
      await facilitator.close();
      await upstream?.close();
      rail.close();
    },
  };
}

function stackUrl(stack: Stack): string {
  return stack.resourceUrl;
}

test("one budget across rails: x402 spend blocks the LLM, and the reverse", async () => {
  {
    const payer = tokenWallet();
    const payee = tokenWallet();
    const mandate = baseMandate({
      id: "mdt_budget_x402first",
      budget: { total: "0.03", period: "lifetime" },
      per_call_cap: "0.03",
      approval_threshold: "0.03",
      allowed_payees: [
        { rail: "llm", id: "openai" },
        { rail: "x402", id: `${NETWORK}:${payee.account.address}` },
      ],
    });
    const { issuer, signed } = signTestMandate(mandate);
    const { rail } = openTestRail(join(tmp(), "x402first.db"), signed, issuer.publicKey);
    const facilitator = await startLocalFacilitator({
      networks: [NETWORK],
      balances: { [payer.account.address]: 10_000_000n, [payee.account.address]: 0n },
    });
    const resource = await startPaidResource({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: payee.account.address,
      routes: [{ path: "/data", price: "$0.01", body: {} }],
    });
    const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([payee.account.address]) });
    const upstream = await startFakeUpstream({ latencyMs: [1, 3] });
    const gateway = createGateway({
      store: rail.store,
      upstreams: { openai: { baseUrl: upstream.url, apiKey: "sk-test-not-real" } },
      routes: { "POST /v1/x402/fetch": x402.handler },
    });
    const port = await listen(gateway);
    const key = rail.issueAgentKey("agent-01");
    const base = `http://127.0.0.1:${port}`;

    for (let i = 0; i < 3; i++) {
      const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/data` });
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(rail.store.spent(mandate.id).settledMicros, 30000);
    const llm = await postJson(
      base,
      "/v1/chat/completions",
      { authorization: `Bearer ${key}` },
      { model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    );
    assert.equal(llm.status, 402, llm.text);
    assert.equal((JSON.parse(llm.text) as { error: { code: string } }).error.code, "budget_exceeded");

    await closeServer(gateway);
    await resource.close();
    await facilitator.close();
    await upstream.close();
    rail.close();
  }

  {
    const payer = tokenWallet();
    const payee = tokenWallet();
    const mandate = baseMandate({
      id: "mdt_budget_llmfirst",
      budget: { total: "0.03", period: "lifetime" },
      per_call_cap: "0.03",
      approval_threshold: "0.03",
      allowed_payees: [
        { rail: "llm", id: "openai" },
        { rail: "x402", id: `${NETWORK}:${payee.account.address}` },
      ],
    });
    const { issuer, signed } = signTestMandate(mandate);
    const { rail } = openTestRail(join(tmp(), "llmfirst.db"), signed, issuer.publicKey);
    const facilitator = await startLocalFacilitator({
      networks: [NETWORK],
      balances: { [payer.account.address]: 10_000_000n, [payee.account.address]: 0n },
    });
    const resource = await startPaidResource({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: payee.account.address,
      routes: [{ path: "/data", price: "$0.03", body: {} }],
    });
    const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([payee.account.address]) });
    const upstream = await startFakeUpstream({ latencyMs: [1, 3] });
    const gateway = createGateway({
      store: rail.store,
      upstreams: { openai: { baseUrl: upstream.url, apiKey: "sk-test-not-real" } },
      routes: { "POST /v1/x402/fetch": x402.handler },
    });
    const port = await listen(gateway);
    const key = rail.issueAgentKey("agent-01");
    const base = `http://127.0.0.1:${port}`;

    for (let i = 0; i < 100; i++) {
      const r = await postJson(
        base,
        "/v1/chat/completions",
        { authorization: `Bearer ${key}` },
        { model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      );
      if (r.status === 402) break;
      assert.equal(r.status, 200, r.text);
    }
    const spent = rail.store.spent(mandate.id).settledMicros;
    assert.ok(spent > 0 && spent <= 30000);
    const x = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/data` });
    assert.equal(x.status, 402, x.text);
    assert.equal((JSON.parse(x.text) as { error: { code: string } }).error.code, "budget_exceeded");

    await closeServer(gateway);
    await resource.close();
    await facilitator.close();
    await upstream.close();
    rail.close();
  }
});

test("a guard block is refused, moves no money, and is written to the ledger", async () => {
  let decision: "allow" | "deny" = "deny";
  const stack = await buildStack({
    id: "mdt_guard_block",
    price: "$0.01",
    budget: "1.00",
    perCallCap: "1.00",
    approvalThreshold: "1.00",
    guard: async (ask) => {
      if (decision === "deny") return { ok: false, code: "payee_not_allowed", reason: `payee ${ask.payTo} is not allowed` };
      return { ok: true, amountMicros: Number(ask.amount), payeeBasis: "allowlist", priceBasis: "first_payment", referenceMicros: null };
    },
  });
  // The resource URL is the origin the paid resource was created at; recover it
  // by making the gateway pay a URL the buildStack helper exposed.
  const url = stackUrl(stack);
  const r = await postJson(stack.base, "/v1/x402/fetch", { authorization: `Bearer ${stack.key}` }, { url });
  assert.equal(r.status, 403, r.text);
  const body = JSON.parse(r.text) as { error: { type: string; code: string; message: string } };
  assert.equal(body.error.type, "mandate_denied");
  assert.equal(body.error.code, "payee_not_allowed");
  assert.match(body.error.message, /not allowed/);
  assert.equal(stack.facilitator.token.transfers.length, 0);
  assert.equal(stack.facilitator.token.balanceOf(stack.payee.account.address), 0n);
  assert.equal(stack.rail.store.spent("mdt_guard_block").committedMicros, 0);
  const blocked = stack.rail.ledger.entries().filter((e) => e.kind === "x402.blocked");
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0]!.payload as { code: string }).code, "payee_not_allowed");
  await stack.close();
});

test("a mandate without the x402 rail is refused with rail_not_allowed even if the guard passes", async () => {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({
    id: "mdt_no_x402_rail",
    rails: ["llm"],
    allowed_payees: [{ rail: "llm", id: "openai" }],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "norail.db"), signed, issuer.publicKey);
  const facilitator = await startLocalFacilitator({ networks: [NETWORK], balances: { [payer.account.address]: 1_000_000n } });
  const resource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/data", price: "$0.01", body: {} }],
  });
  const x402 = createX402Rail({ allowPrivateNetwork: true, rail, account: payer.account, networks: [NETWORK], guard: allowlistGuard([payee.account.address]) });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  const base = `http://127.0.0.1:${port}`;

  const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/data` });
  assert.equal(r.status, 403, r.text);
  assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "rail_not_allowed");
  assert.equal(rail.ledger.entries().filter((e) => e.kind === "x402.blocked").length, 1);

  await closeServer(gateway);
  await resource.close();
  await facilitator.close();
  rail.close();
});

test("per_call_cap and rate limit apply to x402 calls", async () => {
  {
    const stack = await buildStack({ id: "mdt_percall_cap", price: "$0.01", budget: "1.00", perCallCap: "0.005", approvalThreshold: "1.00" });
    const r = await postJson(stack.base, "/v1/x402/fetch", { authorization: `Bearer ${stack.key}` }, { url: stackUrl(stack) });
    assert.equal(r.status, 402, r.text);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "per_call_cap");
    assert.equal(stack.facilitator.token.transfers.length, 0);
    await stack.close();
  }
  {
    const stack = await buildStack({ id: "mdt_ratelimit", price: "$0.01", budget: "1.00", perCallCap: "1.00", approvalThreshold: "1.00", maxCalls: 1 });
    const url = stackUrl(stack);
    const first = await postJson(stack.base, "/v1/x402/fetch", { authorization: `Bearer ${stack.key}` }, { url });
    assert.equal(first.status, 200, first.text);
    const second = await postJson(stack.base, "/v1/x402/fetch", { authorization: `Bearer ${stack.key}` }, { url });
    assert.equal(second.status, 429, second.text);
    assert.equal((JSON.parse(second.text) as { error: { code: string } }).error.code, "rate_limited");
    assert.equal(stack.facilitator.token.transfers.length, 1);
    await stack.close();
  }
});

test("approval: approved settles with the request id, denied and timeout sign nothing", async () => {
  const decisions: Array<"approved" | "denied" | "timeout"> = ["approved", "denied", "timeout"];
  for (const decision of decisions) {
    const calls: string[] = [];
    const approver: Approver = {
      async request(req) {
        calls.push(req.summary);
        return { decision, requestId: "apr_test_1", decidedBy: "mike" };
      },
    };
    const stack = await buildStack({
      id: `mdt_approval_${decision}`,
      price: "$0.01",
      budget: "0.10",
      perCallCap: "0.10",
      approvalThreshold: "0.005",
      approver,
    });
    const r = await postJson(stack.base, "/v1/x402/fetch", { authorization: `Bearer ${stack.key}` }, { url: stackUrl(stack) });
    assert.equal(calls.length, 1, "the approver must be asked exactly once");
    assert.match(calls[0]!, /0\.010000 USDC/);
    if (decision === "approved") {
      assert.equal(r.status, 200, r.text);
      const settle = stack.rail.ledger.entries().find((e) => e.kind === "x402.settle");
      assert.ok(settle);
      assert.equal((settle!.payload as { details: { approval_request_id: string } }).details.approval_request_id, "apr_test_1");
      assert.equal(stack.facilitator.token.transfers.length, 1);
    } else {
      assert.equal(r.status, 403, r.text);
      const body = JSON.parse(r.text) as { error: { code: string } };
      assert.equal(body.error.code, decision === "denied" ? "approval_denied" : "approval_timeout");
      assert.equal(stack.facilitator.token.transfers.length, 0, "a denied or timed-out approval must not sign");
      assert.equal(stack.facilitator.token.balanceOf(stack.payee.account.address), 0n);
      assert.equal(stack.rail.ledger.entries().filter((e) => e.kind === "x402.blocked").length, 1);
    }
    await stack.close();
  }
});
