// The gateway sizes the reservation from the model's own output limits
// (PRICING.maxOutputTokens / defaultOutputTokens) and explains a per-call cap
// refusal with the largest max_tokens that would fit. Every case goes through
// the real gateway over HTTP and prints one "# mt-after" line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway, fittingMaxTokens, type GatewayOptions } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { worstCaseMicros } from "../src/pricing.js";
import { closeServer, listen, post } from "./helpers.js";

const issuer = generateSigner("mt-after-issuer");
const gatewayKey = generateSigner("mt-after-gateway");
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

type CallResult = {
  status: number;
  code: string;
  message: string;
  error: any;
  param: string | null;
  suggestedMaxTokens: number | null;
  maxTokensHeader: number | null;
  reserved: number | null;
  forwarded: any;
  forwardedMaxTokens: number | null;
  forwardedMaxCompletionTokens: number | null;
};

interface ProbeOptions {
  perCallCap?: string;
  model?: string;
  gatewayOptions?: Partial<GatewayOptions>;
}

async function probe(dialect: "openai" | "anthropic", fields: Record<string, unknown>, opts: ProbeOptions = {}) {
  const perCallCap = opts.perCallCap ?? "0.50";
  const model = opts.model ?? (dialect === "openai" ? "gpt-4o" : "claude-sonnet-4-5");
  const dir = mkdtempSync(join(tmpdir(), "mandate-mt-after-"));
  const m: Mandate = {
    ...EXAMPLE_MANDATE,
    id: "mdt_mt_after_0001",
    issuer: { id: "mt-owner", public_key: issuer.publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: perCallCap,
    approval_threshold: perCallCap,
    rate_limit: { max_calls: 1000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const rail = openGovernedRail({ dbPath: join(dir, "rail.db"), signedMandate: signMandate(m, issuer.signer), trustedIssuerKey: issuer.publicKey, ledgerSigner: gatewayKey.signer });
  const upstream = await startFakeUpstream({ latencyMs: [1, 2], completion: "random", seed: 7 });
  const gateway = createGateway({
    store: rail.store,
    upstreams: { openai: { baseUrl: upstream.url, apiKey: "sk-mt-NOT-REAL" }, anthropic: { baseUrl: upstream.url, apiKey: "sk-mt-NOT-REAL" } },
    ...opts.gatewayOptions,
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey(m.agents[0]!);
  const base = `http://127.0.0.1:${port}`;
  let calls = 0;

  const call = async (f: Record<string, unknown>): Promise<CallResult> => {
    const body = { model, messages: [{ role: "user", content: "hello" }], ...f };
    const seen = upstream.requests.length;
    const r = dialect === "openai"
      ? await post(base, "/v1/chat/completions", { authorization: `Bearer ${key}` }, body)
      : await post(base, "/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, body);
    calls++;
    let error: any = null;
    try {
      error = JSON.parse(r.text);
    } catch {
      error = null;
    }
    const errObj = error && typeof error.error === "object" && error.error !== null ? error.error : {};
    const code = typeof error?.code === "string" ? error.code : typeof errObj.code === "string" ? errObj.code : "";
    const fwd = upstream.requests.length > seen ? upstream.requests[upstream.requests.length - 1]?.body : null;
    const header = r.headers["x-mandate-max-tokens"];
    const out: CallResult = {
      status: r.status,
      code,
      message: typeof errObj.message === "string" ? errObj.message : "",
      error,
      param: typeof errObj.param === "string" ? errObj.param : null,
      suggestedMaxTokens: typeof errObj.suggested_max_tokens === "number" ? errObj.suggested_max_tokens : null,
      maxTokensHeader: header != null ? Number(header) : null,
      reserved: r.headers["x-mandate-reserved-micros"] ? Number(r.headers["x-mandate-reserved-micros"]) : null,
      forwarded: fwd,
      forwardedMaxTokens:
        fwd && Object.prototype.hasOwnProperty.call(fwd, "max_tokens") ? (fwd.max_tokens as number) : null,
      forwardedMaxCompletionTokens:
        fwd && Object.prototype.hasOwnProperty.call(fwd, "max_completion_tokens")
          ? (fwd.max_completion_tokens as number)
          : null,
    };
    console.log(
      `# mt-after ${dialect} ${model} ${JSON.stringify(f)} cap ${perCallCap} -> ${JSON.stringify({
        status: out.status,
        code: out.code,
        maxTokensHeader: out.maxTokensHeader,
        reserved: out.reserved,
        forwardedMaxTokens: out.forwardedMaxTokens,
        forwardedMaxCompletionTokens: out.forwardedMaxCompletionTokens,
        suggestedMaxTokens: out.suggestedMaxTokens,
      })}`,
    );
    return out;
  };

  const first = await call(fields);
  cleanups.push(async () => {
    await closeServer(gateway);
    await upstream.close();
    rail.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...first, call };
}

function inputBoundOf(message: string): number {
  const m = /input bound (\d+) tokens/.exec(message);
  assert.ok(m, `message does not state the input bound: ${message}`);
  return Number(m[1]);
}

test("after: openai, no max_tokens forwards the model default 4096 and reports it in the header", async () => {
  const r = await probe("openai", {});
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 4096);
  assert.equal(r.maxTokensHeader, 4096);
});

test("after: openai, max_tokens null counts as not sent and forwards 4096", async () => {
  const r = await probe("openai", { max_tokens: null });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 4096);
});

test("after: openai, max_tokens 0 is still a 400", async () => {
  const r = await probe("openai", { max_tokens: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.maxTokensHeader, null);
});

test("after: openai, max_tokens 1,000,000 is clamped to 16384, forwarded, and reserves under 0.20 USD", async () => {
  const r = await probe("openai", { max_tokens: 1_000_000 });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 16384);
  assert.equal(r.maxTokensHeader, 16384);
  assert.ok(r.reserved! < 200_000, `reserved ${r.reserved} micros`);
});

test("after: openai, max_tokens 20,000 is clamped to the gpt-4o limit 16384", async () => {
  const r = await probe("openai", { max_tokens: 20_000 });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 16384);
});

test("after: openai, max_completion_tokens 2000 alone is forwarded and max_tokens stays absent", async () => {
  const r = await probe("openai", { max_completion_tokens: 2000 });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxCompletionTokens, 2000);
  assert.equal(r.forwardedMaxTokens, null);
  assert.equal(r.maxTokensHeader, 2000);
});

test("after: openai, max_completion_tokens 1,000,000 alone is clamped to 16384", async () => {
  const r = await probe("openai", { max_completion_tokens: 1_000_000 });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxCompletionTokens, 16384);
  assert.equal(r.forwardedMaxTokens, null);
});

test("after: anthropic, no max_tokens forwards the sonnet default 2048", async () => {
  const r = await probe("anthropic", {});
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 2048);
});

test("after: anthropic, max_tokens null counts as not sent and forwards 2048", async () => {
  const r = await probe("anthropic", { max_tokens: null });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 2048);
});

test("after: anthropic, max_tokens 0 is still a 400", async () => {
  const r = await probe("anthropic", { max_tokens: 0 });
  assert.equal(r.status, 400);
});

test("after: anthropic, max_tokens 1,000,000 is clamped to 64000 and the cap refusal names the fitting k", async () => {
  const r = await probe("anthropic", { max_tokens: 1_000_000 });
  assert.equal(r.status, 402);
  assert.equal(r.code, "per_call_cap");
  assert.equal(r.param, "max_tokens");
  assert.match(r.message, /Lower max_tokens to/);
  assert.match(r.message, /lowered to the model limit 64000/);
  const k = r.suggestedMaxTokens;
  assert.ok(k != null && k >= 1, `suggested_max_tokens ${k}`);
  const input = inputBoundOf(r.message);
  assert.ok(worstCaseMicros("claude-sonnet-4-5", input, k, false) <= 500_000);
  assert.ok(worstCaseMicros("claude-sonnet-4-5", input, k + 1, false) > 500_000);
  console.log(`# mt-after fitting check anthropic input ${input} -> k=${k} fits, k+1=${k + 1} does not`);
});

test("after: anthropic, max_completion_tokens 2000 alone is forwarded as max_tokens 2000", async () => {
  const r = await probe("anthropic", { max_completion_tokens: 2000 });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 2000);
  assert.equal(r.forwardedMaxCompletionTokens, null);
});

test("after: openai over a 0.01 USD cap suggests a k that then gets a 200", async () => {
  const r = await probe("openai", { max_tokens: 2000 }, { perCallCap: "0.010000" });
  assert.equal(r.status, 402);
  assert.equal(r.code, "per_call_cap");
  assert.equal(r.param, "max_tokens");
  assert.match(r.message, /Lower max_tokens to/);
  const k = r.suggestedMaxTokens;
  assert.ok(k != null && k >= 1, `suggested_max_tokens ${k}`);
  const retry = await r.call({ max_tokens: k });
  assert.equal(retry.status, 200);
  assert.equal(retry.forwardedMaxTokens, k);
});

test("after: anthropic clamped call, then a retry with the suggested k gets a 200", async () => {
  const r = await probe("anthropic", { max_tokens: 1_000_000 });
  assert.equal(r.status, 402);
  const k = r.suggestedMaxTokens;
  assert.ok(k != null && k >= 1);
  const retry = await r.call({ max_tokens: k });
  assert.equal(retry.status, 200);
  assert.equal(retry.forwardedMaxTokens, k);
});

test("after: openai on a 0.000001 USD cap refuses on the prompt alone and suggests 0", async () => {
  const r = await probe("openai", {}, { perCallCap: "0.000001" });
  assert.equal(r.status, 402);
  assert.equal(r.code, "per_call_cap");
  assert.match(r.message, /The prompt alone/);
  assert.equal(r.suggestedMaxTokens, 0);
  assert.equal(r.param, "max_tokens");
});

test("after: deepseek/deepseek-v4.1-flash-1017 max_tokens 32000 forwards 32000", async () => {
  const r = await probe("openai", { max_tokens: 32000 }, { model: "deepseek/deepseek-v4.1-flash-1017" });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 32000);
  assert.equal(r.maxTokensHeader, 32000);
});

test("after: gateway option defaultMaxTokens 100 overrides the price table", async () => {
  const r = await probe("openai", {}, { gatewayOptions: { defaultMaxTokens: 100 } });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 100);
  assert.equal(r.maxTokensHeader, 100);
});

test("after: gateway option defaultMaxTokens 1,000,000 is still clamped to 16384", async () => {
  const r = await probe("openai", {}, { gatewayOptions: { defaultMaxTokens: 1_000_000 } });
  assert.equal(r.status, 200);
  assert.equal(r.forwardedMaxTokens, 16384);
});

test("after: fittingMaxTokens returns the largest k that fits and k + 1 does not", () => {
  const limit = 50_000;
  const k = fittingMaxTokens("gpt-4o", 1000, false, limit, 16384);
  assert.ok(k > 0);
  assert.ok(worstCaseMicros("gpt-4o", 1000, k, false) <= limit);
  assert.ok(worstCaseMicros("gpt-4o", 1000, k + 1, false) > limit);
  console.log(`# mt-after fittingMaxTokens gpt-4o input 1000 limit ${limit} -> k=${k}`);
});

test("after: fittingMaxTokens returns 0 when the prompt alone is above the limit", () => {
  const limit = 1;
  const k = fittingMaxTokens("gpt-4o", 1000, false, limit, 16384);
  assert.equal(k, 0);
  console.log(`# mt-after fittingMaxTokens prompt alone input 1000 limit ${limit} -> k=${k}`);
});

test("after: fittingMaxTokens returns maxOutput when everything fits", () => {
  const k = fittingMaxTokens("gpt-4o", 1000, false, 1_000_000_000, 16384);
  assert.equal(k, 16384);
  console.log(`# mt-after fittingMaxTokens everything fits -> k=${k}`);
});

test("after: fittingMaxTokens works across the sonnet long context threshold", () => {
  const model = "claude-sonnet-4-5";
  const input = 250_000;
  const limit = 3_500_000;
  const k = fittingMaxTokens(model, input, true, limit, 64000);
  assert.ok(k > 0 && k < 64000, `k=${k}`);
  assert.ok(worstCaseMicros(model, input, k, true) <= limit);
  assert.ok(worstCaseMicros(model, input, k + 1, true) > limit);
  console.log(`# mt-after fittingMaxTokens long context input ${input} limit ${limit} -> k=${k}`);
});
