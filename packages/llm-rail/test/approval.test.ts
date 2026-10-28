// Step 4 done test through the full stack: a signed mandate whose approval
// threshold is crossed by a normal call, the gateway, and a real Telegram
// approver driven by the mock Telegram server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import { generateSigner, signMandate, EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { startMockTelegram, TelegramApprover, TelegramClient } from "@mandate/approval";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream, type FakeUpstream } from "../src/fake-upstream.js";
import { closeServer, listen, post } from "./helpers.js";

const issuer = generateSigner("owner-2026-10");
const gatewayKey = generateSigner("gateway-1");
const REAL = "sk-test-upstream-NOT-REAL";
const OWNER = 42;
const CHAT = 777;
const MANDATE_ID = "mdt_approval_test_0001";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Harness {
  store: ReturnType<typeof openGovernedRail>["store"];
  ledger: ReturnType<typeof openGovernedRail>["ledger"];
  rail: ReturnType<typeof openGovernedRail>;
  upstream: FakeUpstream;
  gateway: http.Server;
  mock: Awaited<ReturnType<typeof startMockTelegram>>;
  approver: TelegramApprover | null;
  port: number;
  key: string;
  close(): Promise<void>;
}

async function build(
  opts: { budget?: string; perCallCap?: string; threshold?: string; withApprover?: boolean; timeoutMs?: number; customApprover?: { request(req: unknown): Promise<any> } } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mandate-approval-"));
  dirs.push(dir);
  const mandate: Mandate = {
    ...EXAMPLE_MANDATE,
    id: MANDATE_ID,
    issuer: { id: "michael", public_key: issuer.publicKey },
    budget: { total: opts.budget ?? "5.00", period: "lifetime" },
    per_call_cap: opts.perCallCap ?? "0.50",
    approval_threshold: opts.threshold ?? "0.001000",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const signed = signMandate(mandate, issuer.signer);
  const rail = openGovernedRail({
    dbPath: join(dir, "rail.db"),
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  const upstream = await startFakeUpstream({ latencyMs: [5, 15], completion: "random", seed: 11 });
  const mock = await startMockTelegram();
  let approver: TelegramApprover | null = null;
  if (opts.withApprover ?? true) {
    approver = new TelegramApprover({
      client: new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl }),
      chatId: CHAT,
      approverUserIds: [OWNER],
      timeoutMs: opts.timeoutMs ?? 500,
      pollTimeoutSec: 1,
    });
  }
  const gateway = createGateway({
    store: rail.store,
    upstreams: { openai: { baseUrl: upstream.url, apiKey: REAL } },
    ...(opts.customApprover ? { approver: opts.customApprover } : approver ? { approver } : {}),
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey(mandate.agents[0]!);
  return {
    store: rail.store,
    ledger: rail.ledger,
    rail,
    upstream,
    gateway,
    mock,
    approver,
    port,
    key,
    async close() {
      await closeServer(gateway);
      await upstream.close();
      if (approver) await approver.close();
      await mock.close();
      rail.close();
    },
  };
}

const BODY = { model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(2000) }], max_tokens: 100 };

function call(h: Harness) {
  return post(`http://127.0.0.1:${h.port}`, "/v1/chat/completions", { authorization: `Bearer ${h.key}` }, BODY);
}

test("DONE TEST step 4: Approve lets the agent continue", async () => {
  const h = await build();
  try {
    const callPromise = call(h);
    const message = await h.mock.waitForMessage(1);
    assert.ok(message.text.startsWith("TapVow approval"));
    h.mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
    const res = await callPromise;

    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.object, "chat.completion");
    assert.ok(Array.isArray(json.choices) && json.choices.length > 0);
    const settles = h.ledger.entries().filter((e) => e.kind === "llm.settle");
    assert.equal(settles.length, 1);
    assert.equal(h.upstream.requests.length, 1);
    console.log(
      `# step4 approve: status ${res.status}, completion "${json.choices?.[0]?.message?.content}", ledger llm.settle ${settles.length}`,
    );
  } finally {
    await h.close();
  }
});

test("DONE TEST step 4: Deny blocks the agent", async () => {
  const h = await build();
  try {
    const callPromise = call(h);
    const message = await h.mock.waitForMessage(1);
    h.mock.press({ messageId: message.messageId, button: "Deny", fromUserId: OWNER });
    const res = await callPromise;

    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_denied");
    assert.equal(h.upstream.requests.length, 0);
    assert.equal(h.ledger.entries().filter((e) => e.kind === "llm.settle").length, 0);
    console.log(
      `# step4 deny: status ${res.status}, code approval_denied, upstream requests ${h.upstream.requests.length}, ledger llm.settle 0`,
    );
  } finally {
    await h.close();
  }
});

test("DONE TEST step 4: no answer within the timeout auto-denies", async () => {
  const h = await build({ timeoutMs: 500 });
  try {
    const res = await call(h);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_timeout");
    assert.equal(h.upstream.requests.length, 0);
    console.log(
      `# step4 timeout: status ${res.status}, code approval_timeout, upstream requests ${h.upstream.requests.length}`,
    );
  } finally {
    await h.close();
  }
});

test("DONE TEST step 4: an approved call still respects the budget", async () => {
  const h = await build({ budget: "0.010000", perCallCap: "0.010000", threshold: "0.001000" });
  try {
    // The owner is shown the call, and while the prompt is open other spend
    // uses up the budget. Approve must not override the budget re-check.
    const callPromise = call(h);
    const message = await h.mock.waitForMessage(1);
    const seeded = h.store.reserve({
      mandateId: MANDATE_ID,
      agentId: "agent-01",
      model: "gpt-4o",
      provider: "openai",
      amountMicros: 5000,
      approval: { requestId: "seed-approval-1", decidedBy: "test" },
    });
    assert.ok(seeded.ok);
    h.store.settle(seeded.reservationId, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, 5000);
    h.mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
    const res = await callPromise;

    assert.equal(res.status, 402);
    assert.equal(JSON.parse(res.text).error.code, "budget_exceeded");
    assert.equal(h.upstream.requests.length, 0);

    // A call that is already over budget never prompts the owner at all.
    const res2 = await call(h);
    assert.equal(res2.status, 402);
    assert.equal(JSON.parse(res2.text).error.code, "budget_exceeded");
    assert.equal(h.mock.sent.length, 1);
    console.log(`# step4 budget: status ${res.status}, code budget_exceeded`);
  } finally {
    await h.close();
  }
});

test("DONE TEST step 4: without an approver the call needs approval", async () => {
  const h = await build({ withApprover: false });
  try {
    const res = await call(h);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_required");
    console.log(`# step4 no-approver: status ${res.status}, code approval_required`);
  } finally {
    await h.close();
  }
});

test("an approver answer other than an explicit approval with a request id is a deny", async () => {
  for (const answer of [{ decision: "Approved", requestId: "apr_x" }, { decision: "approved", requestId: "" }, undefined, { decision: "error" }]) {
    const h = await build({ withApprover: false, customApprover: { request: async () => answer } });
    try {
      const res = await call(h);
      assert.equal(res.status, 403, JSON.stringify(answer));
      assert.equal(JSON.parse(res.text).error.code, "approval_denied");
      assert.equal(h.upstream.requests.length, 0);
    } finally {
      await h.close();
    }
  }
});
