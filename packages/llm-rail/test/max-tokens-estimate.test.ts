// Output limits for the worst-case estimate: every priced model declares a
// max and a default output bound, and worstCase clamps a requested max_tokens
// to the model limit without mutating the client body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { worstCase } from "../src/estimate.js";
import { PRICING, outputLimits } from "../src/pricing.js";

const messages = [{ role: "user", content: "hi" }];
const GPT = "gpt-4o";
const CLAUDE = "claude-sonnet-4-5";

function openaiLimit(model = GPT): number {
  return PRICING[model]!.maxOutputTokens;
}

function anthropicLimit(model = CLAUDE): number {
  return PRICING[model]!.maxOutputTokens;
}

function ok(r: ReturnType<typeof worstCase>) {
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r;
}

test("every PRICING model has integer output limits with default <= max and default >= 1024", () => {
  const models = Object.keys(PRICING);
  assert.ok(models.length > 0);
  for (const model of models) {
    const p = PRICING[model]!;
    assert.ok(Number.isInteger(p.maxOutputTokens), `${model} maxOutputTokens is an integer`);
    assert.ok(Number.isInteger(p.defaultOutputTokens), `${model} defaultOutputTokens is an integer`);
    assert.ok(p.maxOutputTokens > 0, `${model} maxOutputTokens is positive`);
    assert.ok(p.defaultOutputTokens <= p.maxOutputTokens, `${model} default <= max`);
    assert.ok(p.defaultOutputTokens >= 1024, `${model} default >= 1024`);
  }
});

test("outputLimits returns the table limits and null for an unknown model", () => {
  for (const model of Object.keys(PRICING)) {
    assert.deepEqual(outputLimits(model), {
      max: PRICING[model]!.maxOutputTokens,
      default: PRICING[model]!.defaultOutputTokens,
    });
  }
  assert.equal(outputLimits("gpt-unknown"), null);
  assert.equal(outputLimits("constructor"), null);
  assert.equal(outputLimits("__proto__"), null);
});

test("every default output bound follows the 0.05 USD rule", () => {
  for (const model of Object.keys(PRICING)) {
    const p = PRICING[model]!;
    const cost = (tokens: number) => (tokens * p.outPerMTok) / 1e6;
    const d = p.defaultOutputTokens;
    const allowed = cost(d) <= 0.05 || d === p.maxOutputTokens || d === 1024;
    assert.ok(allowed, `${model} default ${d} costs ${cost(d)} USD at the list output price`);
    if (d < p.maxOutputTokens && d !== 1024) {
      assert.ok((d & (d - 1)) === 0, `${model} default ${d} below max is a power of two`);
      assert.ok(cost(d * 2) > 0.05, `${model} doubling default ${d} would cost more than 0.05 USD`);
    }
  }
});

test("openai: a missing, undefined or null max_tokens uses defaultMaxTokens as the bound and forwards it", () => {
  for (const body of [{ messages }, { messages, max_tokens: undefined }, { messages, max_tokens: null }]) {
    const r = ok(worstCase("openai", body, 100, 1024, 16384));
    assert.equal(r.maxOutputTokens, 1024);
    assert.equal(r.requestedOutputTokens, null);
    assert.equal(r.clamped, false);
    assert.equal(r.body.max_tokens, 1024);
    assert.equal("max_completion_tokens" in r.body, false);
  }
});

test("openai: 0, -1, 1.5 and the string \"100\" are refused as not a positive integer", () => {
  for (const bad of [0, -1, 1.5, "100"]) {
    const r = worstCase("openai", { messages, max_tokens: bad }, 100, 1024, 16384);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.status === 400);
    assert.ok(!r.ok && r.reason === "max tokens must be a positive integer");
  }
  for (const bad of [0, -1, 1.5, "100"]) {
    const r = worstCase("openai", { messages, max_completion_tokens: bad }, 100, 1024, 16384);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("openai: a max_tokens at or below the limit is kept and not clamped", () => {
  for (const v of [1, 500, 16384]) {
    const r = ok(worstCase("openai", { messages, max_tokens: v }, 100, 1024, 16384));
    assert.equal(r.maxOutputTokens, v);
    assert.equal(r.requestedOutputTokens, v);
    assert.equal(r.clamped, false);
    assert.equal(r.body.max_tokens, v);
  }
});

test("openai: a max_tokens above the limit is clamped for the reservation and in the body", () => {
  for (const v of [16385, 1_000_000]) {
    const r = ok(worstCase("openai", { messages, max_tokens: v }, 100, 1024, 16384));
    assert.equal(r.maxOutputTokens, 16384);
    assert.equal(r.requestedOutputTokens, v);
    assert.equal(r.clamped, true);
    assert.equal(r.body.max_tokens, 16384);
  }
});

test("openai: an unsent max_tokens stays absent when only max_completion_tokens is sent", () => {
  const r = ok(worstCase("openai", { messages, max_completion_tokens: 500 }, 100, 1024, 16384));
  assert.equal(r.maxOutputTokens, 500);
  assert.equal(r.requestedOutputTokens, 500);
  assert.equal(r.clamped, false);
  assert.equal(r.body.max_completion_tokens, 500);
  assert.equal("max_tokens" in r.body, false);
});

test("openai: both fields are rewritten and the larger one bounds the output", () => {
  const r = ok(worstCase("openai", { messages, max_tokens: 10, max_completion_tokens: 5000 }, 100, 1024, 16384));
  assert.equal(r.maxOutputTokens, 5000);
  assert.equal(r.requestedOutputTokens, 5000);
  assert.equal(r.clamped, false);
  assert.equal(r.body.max_tokens, 10);
  assert.equal(r.body.max_completion_tokens, 5000);
});

test("openai: both fields above the limit are both rewritten to the limit", () => {
  const r = ok(worstCase("openai", { messages, max_tokens: 20000, max_completion_tokens: 30000 }, 100, 1024, 16384));
  assert.equal(r.maxOutputTokens, 16384);
  assert.equal(r.requestedOutputTokens, 30000);
  assert.equal(r.clamped, true);
  assert.equal(r.body.max_tokens, 16384);
  assert.equal(r.body.max_completion_tokens, 16384);
});

test("anthropic: a missing, undefined or null max_tokens is filled with defaultMaxTokens", () => {
  for (const body of [{ messages }, { messages, max_tokens: undefined }, { messages, max_tokens: null }]) {
    const r = ok(worstCase("anthropic", body, 100, 4096, 64000));
    assert.equal(r.maxOutputTokens, 4096);
    assert.equal(r.requestedOutputTokens, null);
    assert.equal(r.clamped, false);
    assert.equal(r.body.max_tokens, 4096);
    assert.equal("max_completion_tokens" in r.body, false);
  }
});

test("anthropic: 0, -1, 1.5 and the string \"100\" are refused with the anthropic reason", () => {
  for (const bad of [0, -1, 1.5, "100"]) {
    const r = worstCase("anthropic", { messages, max_tokens: bad }, 100, 4096, 64000);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.status === 400);
    assert.ok(!r.ok && r.reason === "max_tokens must be a positive integer");
  }
});

test("anthropic: a max_tokens below or above the limit bounds and clamps as needed", () => {
  const below = ok(worstCase("anthropic", { messages, max_tokens: 500 }, 100, 4096, 64000));
  assert.equal(below.maxOutputTokens, 500);
  assert.equal(below.requestedOutputTokens, 500);
  assert.equal(below.clamped, false);
  assert.equal(below.body.max_tokens, 500);

  for (const v of [64001, 1_000_000]) {
    const above = ok(worstCase("anthropic", { messages, max_tokens: v }, 100, 4096, 64000));
    assert.equal(above.maxOutputTokens, 64000);
    assert.equal(above.requestedOutputTokens, v);
    assert.equal(above.clamped, true);
    assert.equal(above.body.max_tokens, 64000);
  }
});

test("anthropic: max_completion_tokens alone is forwarded as max_tokens and the key is removed", () => {
  const r = ok(worstCase("anthropic", { messages, max_completion_tokens: 500 }, 100, 4096, 64000));
  assert.equal(r.maxOutputTokens, 500);
  assert.equal(r.requestedOutputTokens, 500);
  assert.equal(r.clamped, false);
  assert.equal(r.body.max_tokens, 500);
  assert.equal("max_completion_tokens" in r.body, false);
});

test("anthropic: both fields use the larger one and forward only max_tokens", () => {
  const r = ok(worstCase("anthropic", { messages, max_tokens: 10, max_completion_tokens: 5000 }, 100, 4096, 64000));
  assert.equal(r.maxOutputTokens, 5000);
  assert.equal(r.requestedOutputTokens, 5000);
  assert.equal(r.clamped, false);
  assert.equal(r.body.max_tokens, 5000);
  assert.equal("max_completion_tokens" in r.body, false);
});

test("worstCase never mutates the input body", () => {
  for (const dialect of ["openai", "anthropic"] as const) {
    const body = { messages, max_tokens: 1_000_000, max_completion_tokens: 200, stream: true };
    const snapshot = JSON.stringify(body);
    ok(worstCase(dialect, body, 100, 1024, 16384));
    assert.equal(JSON.stringify(body), snapshot, `${dialect} body unchanged`);
    assert.equal(body.max_tokens, 1_000_000);
    assert.equal(body.max_completion_tokens, 200);
  }
  const body = { messages };
  ok(worstCase("anthropic", body, 100, 4096, 64000));
  assert.equal("max_tokens" in body, false);
});

test("without the fifth argument there is no clamp and an openai request still gets defaultMaxTokens", () => {
  const missing = ok(worstCase("openai", { messages }, 100, 1024));
  assert.equal(missing.maxOutputTokens, 1024);
  assert.equal(missing.body.max_tokens, 1024);
  assert.equal(missing.clamped, false);
  assert.equal(missing.requestedOutputTokens, null);

  const big = ok(worstCase("openai", { messages, max_tokens: 1_000_000 }, 100, 1024));
  assert.equal(big.maxOutputTokens, 1_000_000);
  assert.equal(big.body.max_tokens, 1_000_000);
  assert.equal(big.clamped, false);

  const claude = ok(worstCase("anthropic", { messages, max_tokens: 1_000_000 }, 100, 4096));
  assert.equal(claude.maxOutputTokens, 1_000_000);
  assert.equal(claude.clamped, false);
});

test("a non-positive or non-integer maxOutputTokens argument means no limit", () => {
  for (const limit of [undefined, 0, -1, 1.5, Number.NaN]) {
    const r = ok(worstCase("openai", { messages, max_tokens: 1_000_000 }, 100, 1024, limit));
    assert.equal(r.maxOutputTokens, 1_000_000, JSON.stringify(limit));
    assert.equal(r.clamped, false);
    assert.equal(r.body.max_tokens, 1_000_000);
  }
});

test("openaiLimit and anthropicLimit match the documented model maxima", () => {
  assert.equal(openaiLimit("gpt-4o"), 16384);
  assert.equal(openaiLimit("gpt-4.1"), 32768);
  assert.equal(anthropicLimit("claude-sonnet-4-5"), 64000);
  assert.equal(anthropicLimit("claude-opus-4-1"), 32000);
});
