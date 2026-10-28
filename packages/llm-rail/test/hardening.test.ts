// Tests for the fixes made in the adversarial review of the worker's code.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worstCase } from "../src/estimate.js";
import { costMicros, worstCaseMicros } from "../src/pricing.js";
import { BudgetStore, periodStartMs, type Policy } from "../src/store.js";
import { createGateway } from "../src/gateway.js";
import { closeServer, listen, post } from "./helpers.js";
import http from "node:http";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), "mandate-hard-"));
  dirs.push(d);
  return join(d, "b.db");
};
const msg = [{ role: "user", content: "hi" }];

test("estimate refuses features billed outside token usage", () => {
  const cases: Array<[("openai" | "anthropic"), Record<string, unknown>]> = [
    ["anthropic", { max_tokens: 10, messages: msg, tools: [{ type: "web_search_20250305", name: "web_search" }] }],
    ["openai", { messages: msg, tools: [{ type: "web_search" }] }],
    ["openai", { messages: msg, web_search_options: {} }],
    ["openai", { messages: msg, audio: { voice: "x" } }],
    ["openai", { messages: msg, modalities: ["text", "audio"] }],
    ["openai", { messages: msg, prediction: { type: "content", content: "x" } }],
    ["openai", { messages: msg, service_tier: "priority" }],
    ["anthropic", { max_tokens: 10, messages: msg, mcp_servers: [{}] }],
    ["openai", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }],
  ];
  for (const [d, b] of cases) assert.equal(worstCase(d, b, 100, 1024).ok, false, JSON.stringify(b));
  assert.equal(worstCase("openai", { messages: msg, tools: [{ type: "function", function: { name: "f" } }] }, 100, 1024).ok, true);
  assert.equal(worstCase("anthropic", { max_tokens: 5, messages: msg, tools: [{ name: "f", input_schema: {} }] }, 100, 1024).ok, true);
});

test("when both max_tokens fields are sent, the larger one bounds the output", () => {
  const r = worstCase("openai", { messages: msg, max_tokens: 10, max_completion_tokens: 5000 }, 100, 1024);
  assert.ok(r.ok && r.maxOutputTokens === 5000);
  const r2 = worstCase("openai", { messages: msg }, 100, 1024);
  assert.ok(r2.ok && r2.maxOutputTokens === 1024 && r2.body.max_tokens === 1024);
});

test("cache writes and long context are priced, never below the base rate", () => {
  const base = costMicros("claude-sonnet-4-5", { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0 });
  const writes = costMicros("claude-sonnet-4-5", { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 1000 });
  assert.equal(base, 3000);
  assert.equal(writes, 6000);
  const long = costMicros("claude-sonnet-4-5", { inputTokens: 200_001, outputTokens: 1, cachedInputTokens: 0 });
  assert.equal(long, Math.ceil(200_001 * 6 + 22.5));
  assert.ok(worstCaseMicros("claude-sonnet-4-5", 1000, 0, true) >= writes);
  assert.throws(() => costMicros("gpt-unknown", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }));
});

const policy: Policy = {
  mandateId: "m", budgetMicros: 1000, perCallCapMicros: 1000, approvalThresholdMicros: 1000,
  allowedProviders: ["openai"], rateLimit: { maxCalls: 1000, windowSeconds: 60 },
  notBefore: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", budgetPeriod: "day",
};

test("a daily budget resets at the UTC day boundary but in-flight money still counts", () => {
  let now = Date.parse("2026-10-18T23:59:00Z");
  const s = new BudgetStore(tmpDb(), { now: () => now });
  s.upsertMandate(policy);
  const a = s.reserve({ mandateId: "m", agentId: "a", model: "gpt-4o", provider: "openai", amountMicros: 600 });
  assert.ok(a.ok);
  s.settle((a as { reservationId: string }).reservationId, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, 600);
  const b = s.reserve({ mandateId: "m", agentId: "a", model: "gpt-4o", provider: "openai", amountMicros: 300 });
  assert.ok(b.ok);
  assert.equal(s.reserve({ mandateId: "m", agentId: "a", model: "gpt-4o", provider: "openai", amountMicros: 200 }).ok, false);
  now = Date.parse("2026-10-19T00:00:01Z");
  assert.equal(periodStartMs("day", now), Date.parse("2026-10-19T00:00:00Z"));
  // new day: settled 600 drops out, open reservation of 300 still counts
  assert.equal(s.reserve({ mandateId: "m", agentId: "a", model: "gpt-4o", provider: "openai", amountMicros: 800 }).ok, false);
  assert.equal(s.reserve({ mandateId: "m", agentId: "a", model: "gpt-4o", provider: "openai", amountMicros: 700 }).ok, true);
  s.close();
});

test("sweepStale books abandoned reservations at full cost, never releases them", () => {
  let now = 1_800_000_000_000;
  const s = new BudgetStore(tmpDb(), { now: () => now });
  s.upsertMandate({ ...policy, budgetPeriod: "lifetime" });
  const r = s.reserve({ mandateId: "m", agentId: "a", model: "gpt-4o", provider: "openai", amountMicros: 400 });
  assert.ok(r.ok);
  now += 10 * 60_000;
  const ev = s.sweepStale(5 * 60_000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.outcome, "charged_full");
  assert.deepEqual(s.spent("m"), { settledMicros: 400, reservedMicros: 0, committedMicros: 400 });
  s.close();
});

test("upstream error bodies are redacted and anthropic-beta is blocked by default", async () => {
  const REAL = "sk-test-upstream-NOT-REAL-abcdef123456";
  const up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${REAL}. Also sk-proj-****abcd` } }));
    });
  });
  const upPort = await listen(up);
  const s = new BudgetStore(tmpDb());
  s.upsertMandate({ ...policy, budgetMicros: 5_000_000, perCallCapMicros: 500_000, approvalThresholdMicros: 500_000, allowedProviders: ["openai", "anthropic"], budgetPeriod: "lifetime" });
  const key = s.createAgentKey("m", "a");
  const gw = createGateway({ store: s, upstreams: { openai: { baseUrl: `http://127.0.0.1:${upPort}`, apiKey: REAL }, anthropic: { baseUrl: `http://127.0.0.1:${upPort}`, apiKey: REAL } } });
  const port = await listen(gw);
  const base = `http://127.0.0.1:${port}`;
  const r = await post(base, "/v1/chat/completions", { authorization: `Bearer ${key}` }, { model: "gpt-4o", max_tokens: 10, messages: msg });
  assert.equal(r.status, 401);
  assert.ok(!r.text.includes(REAL) && !r.text.includes("sk-proj"), r.text);
  assert.equal(s.spent("m").committedMicros, 0, "an upstream error before any tokens is released");
  const b = await post(base, "/v1/messages", { "x-api-key": key, "anthropic-beta": "context-1m-2025-08-07" }, { model: "claude-sonnet-4-5", max_tokens: 10, messages: msg });
  assert.equal(b.status, 400);
  await closeServer(gw);
  await closeServer(up);
  s.close();
});
