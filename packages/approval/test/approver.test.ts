import { test, after } from "node:test";
import assert from "node:assert/strict";
import { TelegramApprover } from "../src/approver.js";
import { TelegramClient } from "../src/telegram.js";
import { startMockTelegram } from "../src/mock-telegram.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/types.js";

const OWNER = 42;
const CHAT = 555;

const REQ: ApprovalRequest = {
  mandateId: "mdt_test_0001",
  agentId: "agent-01",
  rail: "llm",
  payee: "openai",
  amountMicros: 1000,
  summary: "model gpt-4o, up to 0.001000 USD",
};

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error("condition not met in time");
}

interface Made {
  mock: Awaited<ReturnType<typeof startMockTelegram>>;
  client: TelegramClient;
  approver: TelegramApprover;
}

async function makeApprover(
  opts: { timeoutMs?: number; pollTimeoutSec?: number; onDecision?: (req: ApprovalRequest, d: ApprovalDecision) => void } = {},
): Promise<Made> {
  const mock = await startMockTelegram();
  const client = new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl });
  const approver = new TelegramApprover({
    client,
    chatId: CHAT,
    approverUserIds: [OWNER],
    pollTimeoutSec: opts.pollTimeoutSec ?? 1,
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onDecision ? { onDecision: opts.onDecision } : {}),
  });
  cleanups.push(async () => {
    await approver.close();
    await mock.close();
  });
  return { mock, client, approver };
}

test("approve path: the owner's Approve resolves approved and edits the message", async () => {
  const { mock, approver } = await makeApprover();
  const decisionPromise = approver.request(REQ);
  const message = await mock.waitForMessage(1);

  assert.ok(message.text.startsWith("TapVow approval"));
  assert.ok(message.text.includes("0.001000"));
  assert.ok(message.text.includes("Auto-deny in 60 s"));
  const buttons = message.replyMarkup.inline_keyboard[0];
  assert.equal(buttons[0].text, "Approve");
  assert.equal(buttons[1].text, "Deny");
  assert.ok(Buffer.byteLength(buttons[0].callback_data) < 64);
  assert.ok(Buffer.byteLength(buttons[1].callback_data) < 64);

  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  const decision = await decisionPromise;
  assert.equal(decision.decision, "approved");
  if (decision.decision === "approved") {
    assert.equal(decision.decidedBy, `telegram:${OWNER}`);
    assert.match(decision.requestId, /^apr_/);
    assert.ok(decision.latencyMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(decision.decidedAt)));
  } else {
    assert.fail("expected approved");
  }

  await waitUntil(() => mock.answers.some((a) => a.text === "Approved"));
  await waitUntil(() => mock.edits.some((e) => /Approved by 42/.test(e.text)));
  const edit = mock.edits.find((e) => /Approved by 42/.test(e.text))!;
  assert.equal(edit.replyMarkup ?? null, null);
});

test("deny path: the owner's Deny resolves denied", async () => {
  const { mock, approver } = await makeApprover();
  const decisionPromise = approver.request(REQ);
  const message = await mock.waitForMessage(1);
  mock.press({ messageId: message.messageId, button: "Deny", fromUserId: OWNER });
  const decision = await decisionPromise;
  assert.equal(decision.decision, "denied");
  if (decision.decision === "denied") assert.equal(decision.decidedBy, `telegram:${OWNER}`);
  else assert.fail("expected denied");
  await waitUntil(() => mock.answers.some((a) => a.text === "Denied"));
  await waitUntil(() => mock.edits.some((e) => /Denied by 42/.test(e.text)));
});

test("timeout path: no press auto-denies as timeout and edits to expired", async () => {
  const { mock, approver } = await makeApprover({ timeoutMs: 300 });
  const start = Date.now();
  const decision = await approver.request(REQ);
  assert.equal(decision.decision, "timeout");
  assert.ok(Date.now() - start >= 250);
  assert.ok(decision.latencyMs >= 250);
  assert.ok(!("decidedBy" in decision));
  assert.equal(mock.answers.length, 0);
  await waitUntil(() => mock.edits.some((e) => e.text === "Expired, auto-denied"));
});

test("DEFAULT_TIMEOUT_MS is 60000 and the default is used when timeoutMs is omitted", async () => {
  assert.equal(TelegramApprover.DEFAULT_TIMEOUT_MS, 60_000);
  const { mock, approver } = await makeApprover();
  const decisionPromise = approver.request(REQ);
  const message = await mock.waitForMessage(1);
  assert.ok(message.text.includes("Auto-deny in 60 s"));
  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  const decision = await decisionPromise;
  assert.equal(decision.decision, "approved");
});

test("a press by a user not in approverUserIds is refused and the request stays pending", async () => {
  const { mock, approver } = await makeApprover();
  let settled = false;
  const decisionPromise = approver.request(REQ).then((d) => {
    settled = true;
    return d;
  });
  const message = await mock.waitForMessage(1);
  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: 99 });
  await waitUntil(() => mock.answers.some((a) => a.text === "Not authorized"));
  assert.equal(settled, false);

  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  const decision = await decisionPromise;
  assert.equal(decision.decision, "approved");
});

test("a press from another chat is refused and the request stays pending", async () => {
  const { mock, approver } = await makeApprover();
  let settled = false;
  const decisionPromise = approver.request(REQ).then((d) => {
    settled = true;
    return d;
  });
  const message = await mock.waitForMessage(1);
  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER, chatId: CHAT + 1 });
  await waitUntil(() => mock.answers.some((a) => a.text === "Not authorized"));
  assert.equal(settled, false);

  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  assert.equal((await decisionPromise).decision, "approved");
});

test("forged callback_data using the request id instead of the nonce is refused", async () => {
  const { mock, approver } = await makeApprover();
  let settled = false;
  const decisionPromise = approver.request(REQ).then((d) => {
    settled = true;
    return d;
  });
  const message = await mock.waitForMessage(1);
  const requestId = /Request: (apr_[A-Za-z0-9_-]+)/.exec(message.text)?.[1];
  assert.ok(requestId, "the message should show the request id");
  assert.ok(!message.text.includes(`sm1:a:`));

  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER, data: `sm1:a:${requestId}` });
  await waitUntil(() => mock.answers.some((a) => a.text === "Expired"));
  assert.equal(settled, false);

  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  assert.equal((await decisionPromise).decision, "approved");
});

test("a second press after a decision is Expired and changes nothing", async () => {
  const decisions: ApprovalDecision[] = [];
  const { mock, approver } = await makeApprover({ onDecision: (_req, d) => decisions.push(d) });
  // A second, still-pending request keeps the polling loop alive so the late
  // press is actually fetched and answered.
  const first = approver.request(REQ);
  const second = approver.request({ ...REQ, agentId: "agent-02" });
  await mock.waitForMessage(2);
  const firstMessage = mock.sent.find((m) => m.text.includes("agent-01"))!;
  const secondMessage = mock.sent.find((m) => m.text.includes("agent-02"))!;

  mock.press({ messageId: firstMessage.messageId, button: "Approve", fromUserId: OWNER });
  const firstDecision = await first;
  assert.equal(firstDecision.decision, "approved");

  mock.press({ messageId: firstMessage.messageId, button: "Approve", fromUserId: OWNER });
  await waitUntil(() => mock.answers.some((a) => a.text === "Expired"));
  assert.equal(decisions.filter((d) => d.requestId === firstDecision.requestId).length, 1);

  mock.press({ messageId: secondMessage.messageId, button: "Deny", fromUserId: OWNER });
  assert.equal((await second).decision, "denied");
});

test("a press after the timeout is Expired", async () => {
  const { mock, approver } = await makeApprover({ timeoutMs: 300 });
  const decisionPromise = approver.request(REQ);
  const message = await mock.waitForMessage(1);
  assert.equal((await decisionPromise).decision, "timeout");
  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  await waitUntil(() => mock.answers.some((a) => a.text === "Expired"));
});

test("two concurrent requests are decided independently", async () => {
  const { mock, approver } = await makeApprover();
  const first = approver.request(REQ);
  const second = approver.request({ ...REQ, agentId: "agent-02" });
  await mock.waitForMessage(2);
  const firstMessage = mock.sent.find((m) => m.text.includes("agent-01"))!;
  const secondMessage = mock.sent.find((m) => m.text.includes("agent-02"))!;

  mock.press({ messageId: firstMessage.messageId, button: "Approve", fromUserId: OWNER });
  mock.press({ messageId: secondMessage.messageId, button: "Deny", fromUserId: OWNER });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.decision, "approved");
  assert.equal(b.decision, "denied");
  assert.notEqual(a.requestId, b.requestId);
});

test("a sendMessage failure resolves as timeout (fail closed)", async () => {
  const { mock, approver } = await makeApprover();
  mock.failNext("sendMessage", 1);
  const decision = await approver.request(REQ);
  assert.equal(decision.decision, "timeout");
  assert.equal(mock.sent.length, 0);
});

test("getUpdates failing twice then recovering still delivers the decision", async () => {
  const { mock, approver } = await makeApprover();
  mock.failNext("getUpdates", 2);
  const decisionPromise = approver.request(REQ);
  const message = await mock.waitForMessage(1);
  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  const decision = await decisionPromise;
  assert.equal(decision.decision, "approved");
  assert.ok(mock.calls.filter((c) => c.method === "getUpdates").length >= 3);
});

test("close() resolves pending requests as timeout and stops polling", async () => {
  const { mock, approver } = await makeApprover();
  const decisionPromise = approver.request(REQ);
  await mock.waitForMessage(1);
  await approver.close();
  const decision = await decisionPromise;
  assert.equal(decision.decision, "timeout");

  const after = await approver.request(REQ);
  assert.equal(after.decision, "timeout");
});

test("the token never appears in decision objects", async () => {
  const { mock, approver } = await makeApprover({ timeoutMs: 400 });
  mock.failNext("sendMessage", 1);
  const decision = await approver.request(REQ);
  assert.equal(decision.decision, "timeout");
  assert.ok(!JSON.stringify(decision).includes(mock.token));
});

test("message text has no parse_mode and strips U+202E from the summary", async () => {
  const { mock, approver } = await makeApprover();
  const decisionPromise = approver.request({ ...REQ, summary: "safe\u202Eevil\u0007end" });
  const message = await mock.waitForMessage(1);
  assert.ok(!message.text.includes("\u202E"));
  assert.ok(!message.text.includes("\u0007"));

  const sendCall = mock.calls.find((c) => c.method === "sendMessage")!;
  assert.ok(!("parse_mode" in sendCall.params));
  assert.equal(sendCall.params.parse_mode, undefined);

  const callbackData = message.replyMarkup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(callbackData) < 64);

  mock.press({ messageId: message.messageId, button: "Approve", fromUserId: OWNER });
  assert.equal((await decisionPromise).decision, "approved");
});
