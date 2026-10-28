import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BudgetStore, type Policy } from "../src/store.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream, type FakeUpstream } from "../src/fake-upstream.js";
import { costMicros, type Usage } from "../src/pricing.js";

const REAL_KEY = "sk-test-upstream-NOT-REAL";

const dirs: string[] = [];
const servers: http.Server[] = [];
const upstreams: FakeUpstream[] = [];

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `llm-rail-gw-${name}-`));
  dirs.push(dir);
  return join(dir, "budget.db");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  trailers: http.IncomingHttpHeaders;
  text: string;
}

function request(port: number, path: string, opts: { headers?: Record<string, string>; body?: any }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          trailers: res.trailers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openAIStreamUsage(text: string): Usage | null {
  let usage: Usage | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let obj: any;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.usage) {
      usage = {
        inputTokens: obj.usage.prompt_tokens,
        outputTokens: obj.usage.completion_tokens,
        cachedInputTokens: obj.usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
  }
  return usage;
}

function anthropicStreamUsage(text: string): Usage | null {
  let input: any = null;
  let output: number | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    let obj: any;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.type === "message_start" && obj.message?.usage) input = obj.message.usage;
    else if (obj.type === "message_delta" && obj.usage?.output_tokens != null) output = obj.usage.output_tokens;
  }
  if (!input || output == null) return null;
  return {
    inputTokens: input.input_tokens + (input.cache_creation_input_tokens ?? 0) + (input.cache_read_input_tokens ?? 0),
    outputTokens: output,
    cachedInputTokens: input.cache_read_input_tokens ?? 0,
  };
}

const policy: Policy = {
  mandateId: "m1",
  budgetMicros: 100_000_000,
  perCallCapMicros: 50_000_000,
  approvalThresholdMicros: 50_000_000,
  allowedProviders: ["openai", "anthropic"],
  rateLimit: { maxCalls: 1_000_000, windowSeconds: 60 },
  notBefore: new Date(0).toISOString(),
  expiresAt: new Date(4_102_444_800_000).toISOString(),
};

const store = new BudgetStore(tempDb("main"));
store.upsertMandate(policy);
const virtualKey = store.createAgentKey("m1", "a1");

const upstream = await startFakeUpstream({ latencyMs: [5, 15], completion: "random", seed: 7 });
upstreams.push(upstream);
const gateway = createGateway({
  store,
  upstreams: {
    openai: { baseUrl: upstream.url, apiKey: REAL_KEY },
    anthropic: { baseUrl: upstream.url, apiKey: REAL_KEY },
  },
});
const port = await listen(gateway);
servers.push(gateway);

after(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(upstreams.map((u) => u.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("GET /healthz", async () => {
  const res = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/healthz", method: "GET", agent: false }, (r) => {
      r.resume();
      r.on("end", () => resolve(r.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(res, 200);
});

test("OpenAI non-stream succeeds and charges actual usage", async () => {
  const res = await request(port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${virtualKey}` },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hello there" }], max_tokens: 100 },
  });
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  const usage: Usage = {
    inputTokens: json.usage.prompt_tokens,
    outputTokens: json.usage.completion_tokens,
    cachedInputTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
  assert.equal(res.headers["x-mandate-charged-micros"], String(costMicros("gpt-4o", usage)));
  assert.ok(res.headers["x-mandate-reserved-micros"]);
  assert.ok(res.headers["x-mandate-remaining-micros"]);
});

test("OpenAI stream succeeds and charges actual usage", async () => {
  const res = await request(port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${virtualKey}` },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "stream please" }], max_tokens: 120, stream: true },
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /data: \[DONE\]/);
  const usage = openAIStreamUsage(res.text);
  assert.ok(usage);
  assert.equal(res.trailers["x-mandate-charged-micros"], String(costMicros("gpt-4o", usage)));
});

test("Anthropic non-stream succeeds and charges actual usage", async () => {
  const res = await request(port, "/v1/messages", {
    headers: { "x-api-key": virtualKey, "anthropic-version": "2023-06-01" },
    body: { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(res.status, 200);
  const json = JSON.parse(res.text);
  const usage: Usage = {
    inputTokens:
      json.usage.input_tokens + (json.usage.cache_creation_input_tokens ?? 0) + (json.usage.cache_read_input_tokens ?? 0),
    outputTokens: json.usage.output_tokens,
    cachedInputTokens: json.usage.cache_read_input_tokens ?? 0,
  };
  assert.equal(res.headers["x-mandate-charged-micros"], String(costMicros("claude-sonnet-4-5", usage)));
});

test("Anthropic stream succeeds and charges actual usage", async () => {
  const res = await request(port, "/v1/messages", {
    headers: { "x-api-key": virtualKey, "anthropic-version": "2023-06-01" },
    body: { model: "claude-sonnet-4-5", max_tokens: 80, messages: [{ role: "user", content: "stream" }], stream: true },
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /event: message_stop/);
  const usage = anthropicStreamUsage(res.text);
  assert.ok(usage);
  assert.equal(res.trailers["x-mandate-charged-micros"], String(costMicros("claude-sonnet-4-5", usage)));
});

test("upstream receives the real key and never the virtual key", () => {
  for (const recorded of upstream.requests) {
    for (const value of Object.values(recorded.headers)) {
      assert.notEqual(value, virtualKey);
      assert.ok(!(value ?? "").includes(virtualKey));
    }
  }
  const openaiRequests = upstream.requests.filter((r) => r.path === "/v1/chat/completions");
  assert.ok(openaiRequests.length > 0);
  assert.equal(openaiRequests[0]?.headers.authorization, `Bearer ${REAL_KEY}`);
  const anthropicRequests = upstream.requests.filter((r) => r.path === "/v1/messages");
  assert.ok(anthropicRequests.length > 0);
  assert.equal(anthropicRequests[0]?.headers["x-api-key"], REAL_KEY);
  assert.equal(anthropicRequests[0]?.headers.authorization, undefined);
});

test("bad virtual key -> 401 and upstream sees no request", async () => {
  const before = upstream.requests.length;
  const res = await request(port, "/v1/chat/completions", {
    headers: { authorization: "Bearer mk_this_key_does_not_exist" },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
  });
  assert.equal(res.status, 401);
  const json = JSON.parse(res.text);
  assert.equal(json.error.type, "mandate_denied");
  assert.equal(json.error.code, "invalid_key");
  assert.equal(upstream.requests.length, before);
});

test("model of the wrong dialect -> 403", async () => {
  const res = await request(port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${virtualKey}` },
    body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
  });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.text).error.code, "model_not_allowed");
});

test("image content part -> 400", async () => {
  const res = await request(port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${virtualKey}` },
    body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://example.com/x.png" } }] }],
      max_tokens: 10,
    },
  });
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.text).error.message, /not supported/);
});

test("deny bodies use the dialect shape", async () => {
  const smallStore = new BudgetStore(tempDb("deny"));
  smallStore.upsertMandate({ ...policy, mandateId: "small", budgetMicros: 1 });
  const smallKey = smallStore.createAgentKey("small", "a1");
  const smallUpstream = await startFakeUpstream({ latencyMs: [5, 5] });
  upstreams.push(smallUpstream);
  const smallGateway = createGateway({
    store: smallStore,
    upstreams: {
      openai: { baseUrl: smallUpstream.url, apiKey: REAL_KEY },
      anthropic: { baseUrl: smallUpstream.url, apiKey: REAL_KEY },
    },
  });
  const smallPort = await listen(smallGateway);
  servers.push(smallGateway);

  const openai = await request(smallPort, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${smallKey}` },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
  });
  assert.equal(openai.status, 402);
  const openaiBody = JSON.parse(openai.text);
  assert.equal(openaiBody.error.type, "mandate_denied");
  assert.equal(openaiBody.error.code, "budget_exceeded");

  const anthropic = await request(smallPort, "/v1/messages", {
    headers: { "x-api-key": smallKey },
    body: { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(anthropic.status, 402);
  const anthropicBody = JSON.parse(anthropic.text);
  assert.equal(anthropicBody.type, "error");
  assert.equal(anthropicBody.error.type, "mandate_denied");
  assert.equal(anthropicBody.code, "budget_exceeded");
});

test("upstream 500 releases the reservation and relays status", async () => {
  const failStore = new BudgetStore(tempDb("fail"));
  failStore.upsertMandate({ ...policy, mandateId: "fail" });
  const failKey = failStore.createAgentKey("fail", "a1");
  const failUpstream = await startFakeUpstream({ latencyMs: [5, 5], failEvery: 1 });
  upstreams.push(failUpstream);
  const failGateway = createGateway({
    store: failStore,
    upstreams: { openai: { baseUrl: failUpstream.url, apiKey: REAL_KEY } },
  });
  const failPort = await listen(failGateway);
  servers.push(failGateway);

  const res = await request(failPort, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${failKey}` },
    body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
  });
  assert.equal(res.status, 500);
  assert.equal(res.headers["x-mandate-charged-micros"], "0");
  const spent = failStore.spent("fail");
  assert.equal(spent.reservedMicros, 0);
  assert.equal(spent.settledMicros, 0);
});

function abortMidStream(portNum: number, key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(
      JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
    );
    const req = http.request(
      {
        host: "127.0.0.1",
        port: portNum,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          authorization: `Bearer ${key}`,
        },
        agent: false,
      },
      (res) => {
        const reserved = Number(res.headers["x-mandate-reserved-micros"]);
        res.once("data", () => {
          req.destroy();
          resolve(reserved);
        });
        res.on("error", () => {});
      },
    );
    req.on("error", () => {});
    req.write(payload);
    req.end();
    const timer = setTimeout(() => reject(new Error("no stream data received")), 5000);
    timer.unref();
  });
}

test("client abort mid-stream -> charged_full", async () => {
  const abortStore = new BudgetStore(tempDb("abort"));
  abortStore.upsertMandate({ ...policy, mandateId: "abort" });
  const abortKey = abortStore.createAgentKey("abort", "a1");
  const abortUpstream = await startFakeUpstream({ latencyMs: [5, 5], streamChunkDelayMs: 120, completion: "max" });
  upstreams.push(abortUpstream);
  const abortGateway = createGateway({
    store: abortStore,
    upstreams: { openai: { baseUrl: abortUpstream.url, apiKey: REAL_KEY } },
  });
  const abortPort = await listen(abortGateway);
  servers.push(abortGateway);

  const reserved = await abortMidStream(abortPort, abortKey);
  assert.ok(reserved > 0);
  for (let i = 0; i < 200 && abortStore.spent("abort").reservedMicros !== 0; i += 1) {
    await sleep(20);
  }
  const spent = abortStore.spent("abort");
  assert.equal(spent.reservedMicros, 0);
  assert.equal(spent.settledMicros, reserved);
});
