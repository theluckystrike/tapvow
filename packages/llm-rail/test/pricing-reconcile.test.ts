import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BudgetStore, type Policy, type SettleEvent } from "../src/store.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream, type FakeUpstream, type FakeUpstreamOptions } from "../src/fake-upstream.js";
import { costMicros, worstCaseMicros, settleMicros, PRICING, type Usage } from "../src/pricing.js";

const REAL_KEY = "sk-test-upstream-NOT-REAL";
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";

const dirs: string[] = [];
const servers: http.Server[] = [];
const upstreams: FakeUpstream[] = [];

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `llm-rail-reconcile-${name}-`));
  dirs.push(dir);
  return join(dir, "budget.db");
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

const basePolicy: Policy = {
  mandateId: "base",
  budgetMicros: 1_000_000_000,
  perCallCapMicros: 500_000_000,
  approvalThresholdMicros: 500_000_000,
  allowedProviders: ["openai", "anthropic"],
  rateLimit: { maxCalls: 1_000_000, windowSeconds: 60 },
  notBefore: new Date(0).toISOString(),
  expiresAt: new Date(4_102_444_800_000).toISOString(),
};

interface Harness {
  port: number;
  key: string;
  store: BudgetStore;
  settles: SettleEvent[];
  upstream: FakeUpstream;
}

async function harness(name: string, upstreamOpts: FakeUpstreamOptions = {}): Promise<Harness> {
  const settles: SettleEvent[] = [];
  const store = new BudgetStore(tempDb(name), { afterSettleInTx: (_db, ev) => settles.push(ev) });
  store.upsertMandate({ ...basePolicy, mandateId: name });
  const key = store.createAgentKey(name, "a1");
  const upstream = await startFakeUpstream({ latencyMs: [2, 5], ...upstreamOpts });
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
  return { port, key, store, settles, upstream };
}

function chargedOf(res: HttpResult, stream: boolean): number {
  return Number(stream ? res.trailers["x-mandate-charged-micros"] : res.headers["x-mandate-charged-micros"]);
}

after(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(upstreams.map((u) => u.close()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("dogfood replay", () => {
  const calls: Array<[number, number, number, number]> = [
    [13788, 1536, 94, 1898.81],
    [18106, 13568, 448, 990.2],
    [18569, 18176, 85, 219.35],
    [18692, 18176, 18, 195.69],
    [13758, 0, 97, 2121.9],
    [18572, 2560, 568, 2750.28],
    [19155, 18688, 61, 217.36],
    [13805, 13312, 65, 178.44],
    [13761, 13312, 101, 192.92],
    [13902, 13568, 58, 164.26],
    [15632, 13568, 176, 455.9],
    [15821, 15360, 310, 331.93],
    [16146, 15872, 29, 163.4],
    [13762, 13312, 65, 175.0],
    [13891, 13568, 83, 175.88],
    [13987, 13568, 3, 143.56],
  ];

  let booked = 0;
  let upstream = 0;
  for (const [input, cached, output, micros] of calls) {
    const usage: Usage = { inputTokens: input, cachedInputTokens: cached, outputTokens: output };
    const charge = costMicros(DEEPSEEK, usage);
    booked += charge;
    upstream += micros;
    assert.ok(charge >= micros, `call ${input}/${cached}/${output}: booked ${charge} < upstream ${micros}`);
    assert.ok(
      worstCaseMicros(DEEPSEEK, input, output) >= micros,
      `call ${input}/${cached}/${output}: reservation below upstream ${micros}`,
    );
  }
  assert.ok(booked >= 0.99 * 10375, `booked total ${booked} is below 99% of the upstream 10375 micro-USD`);
  assert.ok(Math.abs(upstream - 10375) <= 0.5, `upstream sum ${upstream} does not round to 10375`);
  console.log(`dogfood replay: booked ${booked} micro-USD vs upstream ${upstream.toFixed(2)} micro-USD`);
});

test("reservation never below exact cost", () => {
  const rng = mulberry32(7);
  const randInt = (max: number): number => Math.floor(rng() * (max + 1));
  for (const model of Object.keys(PRICING)) {
    const price = PRICING[model]!;
    for (let i = 0; i < 2000; i++) {
      const input = randInt(200_000);
      const cached = randInt(input);
      const output = randInt(5000);
      const usage: Usage = { inputTokens: input, cachedInputTokens: cached, outputTokens: output };
      const charge = costMicros(model, usage);
      const reservation = worstCaseMicros(model, input, output);
      assert.ok(reservation >= charge, `worstCaseMicros ${reservation} < costMicros ${charge} for ${model}`);

      const lc = price.longContext;
      const tier = lc && input > lc.thresholdTokens ? { ...price, ...lc } : price;
      const cacheRead = tier.cacheReadPerMTok ?? tier.inPerMTok;
      const cachedCount = Math.min(cached, input);
      const plain = input - cachedCount;
      const exact = plain * tier.inPerMTok + cachedCount * cacheRead + output * tier.outPerMTok;
      assert.ok(charge >= exact, `costMicros ${charge} < exact ${exact} for ${model}`);
    }
  }
});

function usageFromResponse(text: string, stream: boolean): Usage {
  if (stream) {
    const usage = openAIStreamUsage(text);
    assert.ok(usage, "no streamed usage");
    return usage;
  }
  const json = JSON.parse(text).usage;
  return {
    inputTokens: json.prompt_tokens,
    outputTokens: json.completion_tokens,
    cachedInputTokens: json.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

test("reasoning tokens outside completion_tokens are billed as output", async () => {
  const outside = await harness("reason-out", {
    completion: "max",
    reasoningTokens: { count: 400, insideCompletion: false },
  });
  const inside = await harness("reason-in", {
    completion: "max",
    reasoningTokens: { count: 50, insideCompletion: true },
  });

  for (const stream of [false, true]) {
    const out = await request(outside.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${outside.key}` },
      body: { model: DEEPSEEK, messages: [{ role: "user", content: "hi" }], max_tokens: 100, ...(stream ? { stream: true } : {}) },
    });
    assert.equal(out.status, 200);
    const outUsage = usageFromResponse(out.text, stream);
    const outExpected = costMicros(DEEPSEEK, {
      inputTokens: outUsage.inputTokens,
      cachedInputTokens: 0,
      outputTokens: outUsage.outputTokens + 400,
    });
    assert.equal(chargedOf(out, stream), outExpected, `outside reasoning not billed as output (stream=${stream})`);

    const inRes = await request(inside.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${inside.key}` },
      body: { model: DEEPSEEK, messages: [{ role: "user", content: "hi" }], max_tokens: 100, ...(stream ? { stream: true } : {}) },
    });
    assert.equal(inRes.status, 200);
    const inUsage = usageFromResponse(inRes.text, stream);
    const inExpected = costMicros(DEEPSEEK, {
      inputTokens: inUsage.inputTokens,
      cachedInputTokens: 0,
      outputTokens: inUsage.outputTokens,
    });
    assert.equal(chargedOf(inRes, stream), inExpected, `inside reasoning double counted (stream=${stream})`);
  }
});

test("dogfood reasoning overcount is not double billed", async () => {
  const cases: Array<{ input: number; cached: number; completion: number; reasoning: number; upstreamMicros: number }> = [
    { input: 29431, cached: 1536, completion: 3048, reasoning: 3159, upstreamMicros: 6018 },
    { input: 33839, cached: 33024, completion: 1066, reasoning: 1111, upstreamMicros: 945 },
    { input: 35255, cached: 34816, completion: 2499, reasoning: 2554, upstreamMicros: 1800 },
  ];

  for (const [i, c] of cases.entries()) {
    const upstreamCostUsd = c.upstreamMicros / 1e6;
    const h = await harness(`overcount-${i}`, {
      completion: "max",
      usageOverride: {
        promptTokens: c.input,
        completionTokens: c.completion,
        cachedTokens: c.cached,
        reasoningTokens: c.reasoning,
        totalTokens: c.input + c.completion,
        costUsd: upstreamCostUsd,
      },
    });
    const table = costMicros(DEEPSEEK, {
      inputTokens: c.input,
      cachedInputTokens: c.cached,
      outputTokens: c.completion,
    });
    const expectedCharged = Math.max(table, c.upstreamMicros);

    for (const stream of [false, true]) {
      const res = await request(h.port, "/v1/chat/completions", {
        headers: { authorization: `Bearer ${h.key}` },
        body: {
          model: DEEPSEEK,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 100,
          ...(stream ? { stream: true } : {}),
        },
      });
      assert.equal(res.status, 200);
      assert.equal(chargedOf(res, stream), expectedCharged, `case ${i}: charged (stream=${stream})`);
      const ev = h.settles.at(-1);
      assert.ok(ev?.usage, `case ${i}: no settle usage`);
      assert.equal(ev.usage.outputTokens, c.completion, `case ${i}: booked ${ev.usage.outputTokens} != completion ${c.completion} (stream=${stream})`);
      assert.equal(ev.usage.reasoningTokens, c.reasoning, `case ${i}: reasoning_tokens not recorded (stream=${stream})`);
      assert.equal(ev.details?.upstream_cost_micros, c.upstreamMicros, `case ${i}: upstream cost micros (stream=${stream})`);
      assert.ok(
        worstCaseMicros(DEEPSEEK, c.input, c.completion) >= expectedCharged,
        `case ${i}: reservation below exact cost (stream=${stream})`,
      );
    }
    console.log(
      `# reasoning dogfood-${i + 1}: booked output ${c.completion} tokens (completion ${c.completion}), charged ${expectedCharged} micro-USD vs upstream ${c.upstreamMicros} micro-USD`,
    );
  }
});

test("explicit outside signal adds reasoning to output", async () => {
  const h = await harness("outside-signal", {
    completion: "max",
    reasoningTokens: { count: 400, insideCompletion: false },
  });
  const res = await request(h.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${h.key}` },
    body: { model: DEEPSEEK, messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
  });
  assert.equal(res.status, 200);
  const ev = h.settles.at(-1);
  assert.ok(ev?.usage, "no settle usage");
  assert.equal(ev.usage.outputTokens, 500, `booked ${ev.usage.outputTokens} != completion 100 + reasoning 400`);
  assert.equal(ev.usage.reasoningTokens, 400);
  console.log(
    `# reasoning outside-signal: booked output ${ev.usage.outputTokens} tokens (completion 100 + reasoning 400), charged ${ev.chargedMicros} micro-USD`,
  );
});

test("upstream cost overrides the estimate when higher", async () => {
  const body = (stream: boolean) => ({
    model: DEEPSEEK,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    ...(stream ? { stream: true } : {}),
  });

  const probe = await harness("cost-probe", { completion: "max" });
  const probeRes = await request(probe.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${probe.key}` },
    body: body(false),
  });
  const probeUsage = JSON.parse(probeRes.text).usage;
  const probeTable = costMicros(DEEPSEEK, {
    inputTokens: probeUsage.prompt_tokens,
    cachedInputTokens: 0,
    outputTokens: probeUsage.completion_tokens,
  });
  const tenX = (probeTable * 10) / 1e6;

  // usage.cost, non-streaming
  const viaBody = await harness("cost-body", { completion: "max", reportCostUsd: tenX });
  const bodyRes = await request(viaBody.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${viaBody.key}` },
    body: body(false),
  });
  assert.equal(bodyRes.status, 200);
  const bodyCharged = chargedOf(bodyRes, false);
  assert.equal(bodyCharged, probeTable * 10);
  const bodyEvent = viaBody.settles.at(-1);
  assert.ok(bodyEvent?.details, "settle event has no details");
  assert.equal(bodyEvent.details?.price_basis, "upstream_cost");
  assert.ok((bodyEvent.details?.table_micros as number) < bodyCharged);
  assert.equal(bodyEvent.details?.upstream_cost_micros, bodyCharged);

  // cost header, no usage.cost, streaming
  const headerValue = String(tenX);
  const viaHeader = await harness("cost-header", { completion: "max", costHeader: { name: "x-cost-usd", value: headerValue } });
  const headerRes = await request(viaHeader.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${viaHeader.key}` },
    body: body(true),
  });
  assert.equal(headerRes.status, 200);
  const headerCharged = chargedOf(headerRes, true);
  assert.equal(headerCharged, probeTable * 10);
  const headerEvent = viaHeader.settles.at(-1);
  assert.ok(headerEvent?.details, "settle event has no details");
  assert.equal(headerEvent.details?.price_basis, "upstream_cost");
  assert.ok((headerEvent.details?.table_micros as number) < headerCharged);

  // placeholder cost below the table, non-streaming
  const viaPlaceholder = await harness("cost-placeholder", { completion: "max", reportCostUsd: 0.00005 });
  const placeholderRes = await request(viaPlaceholder.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${viaPlaceholder.key}` },
    body: { model: DEEPSEEK, messages: [{ role: "user", content: "hi" }], max_tokens: 1000 },
  });
  assert.equal(placeholderRes.status, 200);
  const placeholderUsage = JSON.parse(placeholderRes.text).usage;
  const placeholderTable = costMicros(DEEPSEEK, {
    inputTokens: placeholderUsage.prompt_tokens,
    cachedInputTokens: 0,
    outputTokens: placeholderUsage.completion_tokens,
  });
  assert.ok(50 < placeholderTable, "placeholder cost is not below the table cost");
  const placeholderCharged = chargedOf(placeholderRes, false);
  assert.equal(placeholderCharged, placeholderTable);
  const placeholderEvent = viaPlaceholder.settles.at(-1);
  assert.equal(placeholderEvent?.details?.price_basis, "price_table");
  assert.equal(placeholderEvent?.details?.upstream_cost_micros, 50);
});

test("settleMicros rounds the upstream cost up and clamps absurd values", () => {
  const usage: Usage = { inputTokens: 13758, cachedInputTokens: 0, outputTokens: 97 };
  const s = settleMicros(DEEPSEEK, usage, 0.0021219);
  assert.equal(s.upstreamCostMicros, 2122);
  assert.equal(s.tableMicros, 2122);
  assert.equal(s.chargedMicros, 2122);
  assert.equal(settleMicros(DEEPSEEK, usage, 0.0030000001).chargedMicros, 3001);
  assert.equal(settleMicros(DEEPSEEK, usage, 1e20).chargedMicros, 1e12);
  assert.equal(settleMicros(DEEPSEEK, usage, null).basis, "price_table");
  assert.equal(settleMicros(DEEPSEEK, usage, Number.NaN).upstreamCostMicros, null);
});
