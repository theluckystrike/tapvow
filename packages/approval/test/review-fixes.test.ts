// Regression tests for the independent review of 18 Oct 2026.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { TelegramApprover } from "../src/approver.js";
import { TelegramClient } from "../src/telegram.js";
import { startMockTelegram } from "../src/mock-telegram.js";
import type { ApprovalRequest } from "../src/types.js";

const OWNER = 42;
const CHAT = 555;
const REQ: ApprovalRequest = { mandateId: "mdt_test_0001", agentId: "agent-01", rail: "x402", payee: "0xabc", amountMicros: 20000, summary: "pay" };

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function make(extra: { maxPendingPerAgent?: number } = {}) {
  const mock = await startMockTelegram();
  const client = new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl });
  const approver = new TelegramApprover({ client, chatId: CHAT, approverUserIds: [OWNER], pollTimeoutSec: 1, timeoutMs: 400, ...extra });
  cleanups.push(async () => {
    await approver.close();
    await mock.close();
  });
  return { mock, client, approver };
}

test("line separators, zero-width, direction marks and the Hangul filler are stripped, fields are capped", async () => {
  const { mock, approver } = await make();
  const summary = "Pay https://x.example/a Amount  0.01​‎‏؜﻿ㅤ USD";
  const p = approver.request({ ...REQ, summary, payee: "0x" + "a".repeat(200) });
  const m = await mock.waitForMessage(1);
  for (const ch of [" ", " ", "​", "‎", "‏", "؜", "﻿", "ㅤ"]) {
    assert.ok(!m.text.includes(ch), `U+${ch.codePointAt(0)!.toString(16)} must be stripped`);
  }
  const payeeLine = m.text.split("\n").find((l) => l.includes("aaaa")) ?? "";
  assert.ok(payeeLine.length < 100, "a long payee is capped");
  assert.equal((await p).decision, "timeout");
});

test("a third open prompt from the same agent is denied at once without messaging the owner", async () => {
  const { mock, approver } = await make({ maxPendingPerAgent: 2 });
  const a = approver.request(REQ);
  const b = approver.request(REQ);
  await mock.waitForMessage(2);
  const c = await approver.request(REQ);
  assert.equal(c.decision, "timeout");
  assert.equal(mock.sent.length, 2);
  // Another agent is not blocked by agent-01's prompts.
  const d = approver.request({ ...REQ, agentId: "agent-02" });
  await mock.waitForMessage(3);
  assert.equal(mock.sent.length, 3);
  await Promise.all([a, b, d]);
});

test("the constructor refuses an empty approver list and non-integer ids", async () => {
  const mock = await startMockTelegram();
  cleanups.push(() => mock.close());
  const client = new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl });
  assert.throws(() => new TelegramApprover({ client, chatId: CHAT, approverUserIds: [] }), /approver/);
  assert.throws(() => new TelegramApprover({ client, chatId: 1.5, approverUserIds: [OWNER] }), /chatId/);
  assert.throws(() => new TelegramApprover({ client, chatId: CHAT, approverUserIds: [Number.NaN] }), /approver/);
});

test("the bot token is not reachable through JSON, inspection or own properties", async () => {
  const mock = await startMockTelegram();
  cleanups.push(() => mock.close());
  const client = new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl });
  const { inspect } = await import("node:util");
  assert.ok(!JSON.stringify(client).includes(mock.token));
  assert.ok(!inspect(client, { depth: 5 }).includes(mock.token));
  assert.ok(!Object.values(client).some((v) => v === mock.token));
});
