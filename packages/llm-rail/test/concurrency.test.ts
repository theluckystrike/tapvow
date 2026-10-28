import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BudgetStore, type Policy } from "../src/store.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { costMicros, type Usage } from "../src/pricing.js";

const REAL_KEY = "sk-test-upstream-NOT-REAL";
const BUDGET = 5_000_000;
const PROMPT = "x".repeat(2000);

const policy: Policy = {
  mandateId: "m",
  budgetMicros: BUDGET,
  perCallCapMicros: 500_000,
  approvalThresholdMicros: 500_000,
  allowedProviders: ["openai", "anthropic"],
  rateLimit: { maxCalls: 100_000, windowSeconds: 60 },
  notBefore: new Date(0).toISOString(),
  expiresAt: new Date(4_102_444_800_000).toISOString(),
};

const dirs: string[] = [];

function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `llm-rail-conc-${name}-`));
  dirs.push(dir);
  return join(dir, "budget.db");
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  trailers: http.IncomingHttpHeaders;
  text: string;
}

function httpJson(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<HttpResult> {
  const url = new URL(baseUrl + path);
  const payload = Buffer.from(JSON.stringify(body));
  const requestHeaders: Record<string, string> = {
    ...headers,
    "content-type": "application/json",
    "content-length": String(payload.length),
  };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: requestHeaders,
        agent: false,
      },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function parseDataLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // ignore
    }
  }
  return out;
}

function openAIUsage(text: string, streaming: boolean): Usage | null {
  let usage: any = null;
  if (streaming) {
    for (const obj of parseDataLines(text)) if (obj.usage) usage = obj.usage;
  } else {
    try {
      usage = JSON.parse(text).usage;
    } catch {
      usage = null;
    }
  }
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function anthropicUsage(text: string, streaming: boolean): Usage | null {
  if (!streaming) {
    try {
      const usage = JSON.parse(text).usage;
      return {
        inputTokens:
          usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      };
    } catch {
      return null;
    }
  }
  let start: any = null;
  let output: number | null = null;
  for (const obj of parseDataLines(text)) {
    if (obj.type === "message_start" && obj.message?.usage) start = obj.message.usage;
    else if (obj.type === "message_delta" && obj.usage?.output_tokens != null) output = obj.usage.output_tokens;
  }
  if (!start || output == null) return null;
  return {
    inputTokens: start.input_tokens + (start.cache_creation_input_tokens ?? 0) + (start.cache_read_input_tokens ?? 0),
    outputTokens: output,
    cachedInputTokens: start.cache_read_input_tokens ?? 0,
  };
}

function requestShape(index: number): {
  model: string;
  isOpenai: boolean;
  path: string;
  streaming: boolean;
  body: any;
  headers: (key: string) => Record<string, string>;
} {
  // 4-way rotation: OpenAI and Anthropic, each streaming and non-streaming.
  const model = index % 2 === 0 ? "gpt-4o" : "claude-sonnet-4-5";
  const isOpenai = model === "gpt-4o";
  const streaming = Math.floor(index / 2) % 2 === 1;
  const body: any = { model, max_tokens: 2000, messages: [{ role: "user", content: PROMPT }] };
  if (streaming) body.stream = true;
  return {
    model,
    isOpenai,
    path: isOpenai ? "/v1/chat/completions" : "/v1/messages",
    streaming,
    body,
    headers: (key: string): Record<string, string> =>
      isOpenai ? { authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" },
  };
}

async function runGateway(seed: number, run: number): Promise<void> {
  const store = new BudgetStore(tempDb(`gw${run}`));
  store.upsertMandate(policy);
  const keys = Array.from({ length: 10 }, (_, i) => store.createAgentKey("m", `agent-${i}`));

  const upstream = await startFakeUpstream({ latencyMs: [20, 120], completion: "random", seed });
  const gateway = createGateway({
    store,
    upstreams: {
      openai: { baseUrl: upstream.url, apiKey: REAL_KEY },
      anthropic: { baseUrl: upstream.url, apiKey: REAL_KEY },
    },
  });
  const port = await listen(gateway);

  let calls = 0;
  let denied = 0;
  let chargedSum = 0;

  async function agentLoop(key: string, offset: number): Promise<void> {
    for (let i = offset; ; i += 1) {
      const shape = requestShape(i);
      const res = await httpJson(`http://127.0.0.1:${port}`, shape.path, shape.headers(key), shape.body);
      if (res.status === 402) {
        denied += 1;
        return;
      }
      if (res.status !== 200) {
        throw new Error(`unexpected status ${res.status}: ${res.text.slice(0, 200)}`);
      }
      calls += 1;
      const charged = res.headers["x-mandate-charged-micros"] ?? res.trailers["x-mandate-charged-micros"];
      if (charged != null) chargedSum += Number(charged);
    }
  }

  await Promise.all(keys.map((key, n) => agentLoop(key, n)));

  const spent = store.spent("m");
  // Independent truth: what the provider billed, summed from the fake
  // upstream's own records, not from anything the gateway reported.
  const billedMicros = upstream.billed.reduce(
    (sum, b) => sum + costMicros(b.model, { inputTokens: b.inputTokens, outputTokens: b.outputTokens, cachedInputTokens: 0 }),
    0,
  );
  assert.ok(billedMicros <= BUDGET, `provider billed ${billedMicros} micros, above the budget`);
  assert.ok(billedMicros <= spent.settledMicros, "the ledger must never count less than the provider billed");
  assert.ok(spent.committedMicros <= BUDGET, `committed ${spent.committedMicros} exceeded budget`);
  assert.equal(chargedSum, spent.settledMicros, "sum of charged headers must equal settled total");
  assert.equal(spent.reservedMicros, 0, "no reservation may be left reserved");

  console.log(
    `gateway run ${run}: spent ${(spent.committedMicros / 1_000_000).toFixed(6)} USD of 5.000000, provider billed ${(billedMicros / 1_000_000).toFixed(6)} (calls ${calls}, denied ${denied})`,
  );

  await closeServer(gateway);
  await upstream.close();
  store.close();
}

async function runNaive(seed: number, run: number): Promise<number> {
  const upstream = await startFakeUpstream({ latencyMs: [20, 120], completion: "random", seed });
  let spentMicros = 0;

  async function agentLoop(offset: number): Promise<void> {
    for (let i = offset; ; i += 1) {
      if (spentMicros >= BUDGET) return;
      const shape = requestShape(i);
      const res = await httpJson(upstream.url, shape.path, { "content-type": "application/json" }, shape.body);
      if (res.status !== 200) throw new Error(`naive upstream status ${res.status}`);
      const usage = shape.isOpenai
        ? openAIUsage(res.text, shape.streaming)
        : anthropicUsage(res.text, shape.streaming);
      if (!usage) throw new Error("naive call had no usage");
      spentMicros += costMicros(shape.model, usage);
    }
  }

  await Promise.all(Array.from({ length: 10 }, (_, n) => agentLoop(n)));

  console.log(`naive run ${run}: spent ${(spentMicros / 1_000_000).toFixed(6)} USD of 5.000000`);
  await upstream.close();
  return spentMicros;
}

test("gateway enforces the budget while naive check-then-act overshoots", async () => {
  for (const run of [1, 2, 3]) {
    await runGateway(run, run);
  }

  const naiveSpends: number[] = [];
  for (const run of [1, 2, 3]) {
    naiveSpends.push(await runNaive(run, run));
  }
  assert.ok(
    naiveSpends.some((spend) => spend > BUDGET),
    `naive baseline should overshoot the budget, got ${JSON.stringify(naiveSpends)}`,
  );
});
