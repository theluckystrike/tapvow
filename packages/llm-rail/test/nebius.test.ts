// The Nebius Token Factory rail: Nemotron models are served on the chat
// completions route, routed to the Nebius upstream (never the OpenAI one),
// capped by the signed mandate, and settled into the signed ledger. A fake
// Nebius provider stands in for the real API; no paid call is made.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner, signMandate, EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream, type FakeUpstream } from "../src/fake-upstream.js";
import {
  costMicros,
  NEBIUS_DEFAULT_MODEL,
  NEBIUS_MODELS,
  NEBIUS_PRICING_SOURCES,
  PRICING,
  PROVIDER_DIALECT,
  picoRate,
  worstCaseMicros,
} from "../src/pricing.js";
import { closeServer, listen, post } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-nebius-"));
  dirs.push(d);
  return d;
}

const issuer = generateSigner("owner-nebius");
const ledgerKey = generateSigner("ledger-nebius");
const NEBIUS_KEY = "nebius-test-key-NOT-REAL-0001";
const OPENAI_KEY = "sk-openai-test-NOT-REAL";
const MODEL = NEBIUS_DEFAULT_MODEL;

function mandateWith(overrides: Partial<Mandate>): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_nebius_test_0001",
    issuer: { id: "owner", public_key: issuer.publicKey },
    budget: { total: "0.05", period: "day" },
    per_call_cap: "0.02",
    approval_threshold: "0.02",
    allowed_payees: [{ rail: "llm", id: "nebius" }],
    rails: ["llm"],
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

interface Rig {
  url: string;
  key: string;
  nebius: FakeUpstream;
  openai: FakeUpstream;
  rail: ReturnType<typeof openGovernedRail>;
  close(): Promise<void>;
}

async function rig(m: Mandate, opts: { withNebius?: boolean } = {}): Promise<Rig> {
  const rail = openGovernedRail({
    dbPath: join(tmp(), "rail.db"),
    signedMandate: signMandate(m, issuer.signer),
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: ledgerKey.signer,
  });
  const nebius = await startFakeUpstream({ latencyMs: [1, 5], completion: "max" });
  const openai = await startFakeUpstream({ latencyMs: [1, 5], completion: "max" });
  const upstreams: Parameters<typeof createGateway>[0]["upstreams"] = {
    openai: { baseUrl: openai.url, apiKey: OPENAI_KEY },
  };
  if (opts.withNebius !== false) upstreams.nebius = { baseUrl: nebius.url, apiKey: NEBIUS_KEY };
  const gw = createGateway({ store: rail.store, upstreams });
  const port = await listen(gw);
  return {
    url: `http://127.0.0.1:${port}`,
    key: rail.issueAgentKey(m.agents[0]!),
    nebius,
    openai,
    rail,
    async close() {
      await closeServer(gw);
      await nebius.close();
      await openai.close();
      rail.close();
    },
  };
}

function chat(model: string, maxTokens: number, stream = false, content = "Write a function that reverses a string."): Record<string, unknown> {
  const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages: [{ role: "user", content }] };
  if (stream) body.stream = true;
  return body;
}

function verifyLedger(r: Rig): { ok: boolean } {
  return r.rail.ledger.verify({ [ledgerKey.signer.keyId]: ledgerKey.publicKey });
}

test("nebius pricing rows are OpenAI-dialect, sourced, and include NVIDIA Nemotron", () => {
  assert.equal(PROVIDER_DIALECT.nebius, "openai");
  assert.ok(NEBIUS_MODELS.length >= 3, "a Nemotron model plus other coding models");
  assert.ok(NEBIUS_MODELS.some((m) => /nemotron/i.test(m)), "at least one Nemotron model");
  assert.ok(/nemotron/i.test(NEBIUS_DEFAULT_MODEL), "the default Nebius model is a Nemotron model");
  for (const m of NEBIUS_MODELS) {
    const p = PRICING[m];
    assert.ok(p, `${m} is priced`);
    assert.equal(p!.provider, "nebius");
    assert.ok(p!.inPerMTok > 0 && p!.outPerMTok > 0, `${m} has positive prices`);
    const src = NEBIUS_PRICING_SOURCES[m];
    assert.ok(src && /^https:\/\//.test(src.url) && /^2026-\d\d-\d\d$/.test(src.date), `${m} has a source URL and date`);
  }
});

test("nebius 1: a Nemotron call under the cap passes, goes only to the Nebius upstream with the Nebius key, and settles exactly", async () => {
  const r = await rig(mandateWith({}));
  try {
    const res = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, 256));
    assert.equal(res.status, 200, res.text);
    assert.equal(r.nebius.requests.length, 1);
    assert.equal(r.openai.requests.length, 0, "a Nebius model never reaches the OpenAI upstream");
    const sent = r.nebius.requests[0]!;
    assert.equal(sent.path, "/v1/chat/completions");
    assert.equal(sent.headers.authorization, `Bearer ${NEBIUS_KEY}`, "the real Nebius key goes upstream");
    assert.ok(!JSON.stringify(sent).includes(r.key), "the virtual key never goes upstream");
    const billed = r.nebius.billed[0]!;
    const expected = costMicros(MODEL, { inputTokens: billed.inputTokens, outputTokens: billed.outputTokens, cachedInputTokens: 0 });
    assert.equal(Number(res.headers["x-mandate-charged-micros"]), expected);
    const settle = r.rail.ledger.entries().find((e) => e.kind === "llm.settle")!;
    assert.equal((settle.payload as { payee: string }).payee, "nebius");
    assert.equal((settle.payload as { charged_micros: number }).charged_micros, expected);
    assert.deepEqual(verifyLedger(r), { ok: true, checked: r.rail.ledger.entries().length });
    console.log(`# nebius 1: charged ${expected} micro-USD for ${billed.inputTokens} in / ${billed.outputTokens} out`);
  } finally {
    await r.close();
  }
});

test("nebius 2: calls until the daily cap answer 402 budget_exceeded with a clear reason, the provider bill stays under the cap, the ledger verifies", async () => {
  const r = await rig(mandateWith({ budget: { total: "0.05", period: "day" }, per_call_cap: "0.05", approval_threshold: "0.05" }));
  try {
    let calls = 0;
    let denial: { status: number; text: string } | null = null;
    for (let i = 0; i < 10_000; i++) {
      const res = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, 4096, i % 2 === 1));
      if (res.status !== 200) {
        denial = res;
        break;
      }
      calls++;
    }
    assert.ok(denial, "the cap was reached");
    assert.equal(denial!.status, 402);
    const err = JSON.parse(denial!.text).error as { code: string; type: string; message: string };
    assert.equal(err.code, "budget_exceeded");
    assert.equal(err.type, "mandate_denied");
    assert.match(err.message, /^budget exceeded\. This call reserves up to \d+\.\d{6} USD/);
    assert.match(err.message, new RegExp(`on ${MODEL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
    assert.match(err.message, /The budget is 0\.050000 USD per day \(UTC\), \d+\.\d{6} USD is already spent or held, so \d+\.\d{6} USD is left\./);
    assert.match(err.message, /Lower max_tokens to \d+ or less|Wait for the next day/);

    const billed = r.nebius.billed.reduce((s, b) => s + costMicros(b.model, { inputTokens: b.inputTokens, outputTokens: b.outputTokens, cachedInputTokens: 0 }), 0);
    const spent = r.rail.store.spent("mdt_nebius_test_0001");
    assert.ok(billed <= 50_000, `provider billed ${billed} above the 0.05 USD cap`);
    assert.equal(spent.reservedMicros, 0, "no hold left open");
    assert.equal(spent.settledMicros, billed, "the ledger counts what the provider billed, exactly");
    const entries = r.rail.ledger.entries();
    const denied = entries.filter((e) => e.kind === "llm.denied");
    assert.equal(denied.length, 1);
    assert.equal((denied[0]!.payload as { code: string }).code, "budget_exceeded");
    assert.equal(entries.filter((e) => e.kind === "llm.settle").length, calls);
    assert.equal(r.nebius.requests.length, calls, "the refused call never reached Nebius");
    assert.deepEqual(verifyLedger(r), { ok: true, checked: entries.length });
    console.log(`# nebius 2: ${calls} calls, provider billed ${(billed / 1e6).toFixed(6)} USD of 0.050000, then 402: ${err.message}`);
  } finally {
    await r.close();
  }
});

test("nebius 3: a streamed Nemotron call gets include_usage upstream and its streamed usage is what settles", async () => {
  const r = await rig(mandateWith({}));
  try {
    const res = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, 512, true));
    assert.equal(res.status, 200);
    assert.match(res.text, /data: \[DONE\]/);
    const sent = r.nebius.requests[0]!.body as { stream: boolean; stream_options?: { include_usage?: boolean } };
    assert.equal(sent.stream, true);
    assert.equal(sent.stream_options?.include_usage, true, "the gateway asks Nebius for streamed usage");
    const billed = r.nebius.billed[0]!;
    const expected = costMicros(MODEL, { inputTokens: billed.inputTokens, outputTokens: billed.outputTokens, cachedInputTokens: 0 });
    assert.equal(Number(res.trailers["x-mandate-charged-micros"]), expected, "trailer carries the exact charge");
    const settle = r.rail.ledger.entries().find((e) => e.kind === "llm.settle")!;
    const p = settle.payload as { charged_micros: number; outcome: string; output_tokens?: number };
    assert.equal(p.charged_micros, expected, "settled from the streamed usage, not the full reservation");
    assert.ok(expected < Number(res.headers["x-mandate-reserved-micros"]), "the charge is below the hold");
    assert.equal(r.rail.store.spent("mdt_nebius_test_0001").reservedMicros, 0);
    assert.ok(verifyLedger(r).ok);
  } finally {
    await r.close();
  }
});

test("nebius 4: a call above the per-call cap is refused with 402 and the max_tokens that would fit, before Nebius sees it", async () => {
  const r = await rig(mandateWith({ per_call_cap: "0.001", approval_threshold: "0.001" }));
  try {
    const res = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, 100_000));
    assert.equal(res.status, 402);
    const err = JSON.parse(res.text).error as { code: string; message: string; suggested_max_tokens: number };
    assert.equal(err.code, "per_call_cap");
    assert.match(err.message, /above the per-call cap of 0\.001000 USD/);
    assert.ok(err.suggested_max_tokens >= 1);
    assert.equal(r.nebius.requests.length, 0, "nothing reached the provider");
    const retry = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, err.suggested_max_tokens));
    assert.equal(retry.status, 200, "the suggested max_tokens fits");
    assert.ok(verifyLedger(r).ok);
  } finally {
    await r.close();
  }
});

test("nebius 5: a mandate that does not allow nebius refuses a Nemotron call with 403 payee_not_allowed", async () => {
  const r = await rig(mandateWith({ allowed_payees: [{ rail: "llm", id: "openai" }] }));
  try {
    const res = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, 64));
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "payee_not_allowed");
    assert.equal(r.nebius.requests.length, 0);
    const ok = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat("gpt-4o-mini", 64));
    assert.equal(ok.status, 200, "the OpenAI model on the same route still works");
    assert.equal(r.openai.requests.length, 1);
    assert.equal(r.nebius.requests.length, 0);
  } finally {
    await r.close();
  }
});

test("nebius 6: a Nemotron model on the Anthropic route is refused, and a missing Nebius upstream answers 502 without a charge", async () => {
  const r = await rig(mandateWith({}), { withNebius: false });
  try {
    const wrongRoute = await post(
      r.url,
      "/v1/messages",
      { "x-api-key": r.key, "anthropic-version": "2023-06-01" },
      chat(MODEL, 64),
    );
    assert.equal(wrongRoute.status, 403);
    const missing = await post(r.url, "/v1/chat/completions", { authorization: `Bearer ${r.key}` }, chat(MODEL, 64));
    assert.equal(missing.status, 502);
    assert.match(JSON.parse(missing.text).error.message, /upstream nebius not configured/);
    assert.equal(r.openai.requests.length, 0, "never falls back to the OpenAI upstream");
    assert.equal(r.rail.store.spent("mdt_nebius_test_0001").committedMicros, 0);
  } finally {
    await r.close();
  }
});

test("cost math is exact integer math: every table rate scales to pico-USD, and the 0.06 USD rows never reserve below the charge", () => {
  for (const [model, p] of Object.entries(PRICING)) {
    for (const rate of [p.inPerMTok, p.outPerMTok, p.cacheReadPerMTok, p.cacheWritePerMTok]) {
      if (rate !== undefined) assert.ok(Number.isSafeInteger(picoRate(rate)), `${model} rate ${rate}`);
    }
  }
  assert.throws(() => picoRate(0.0000001), /more than 6 decimals/);
  // 7 tokens at 0.06 USD/M is 0.42 micro-USD, billed as 1; split across plain and
  // cached input it must still be 1 and never above the reservation.
  assert.equal(costMicros("nvidia/Nemotron-3_5-Lightning", { inputTokens: 7, cachedInputTokens: 3, outputTokens: 0 }), 1);
  for (let input = 0; input < 3000; input += 7) {
    const usage = { inputTokens: input, cachedInputTokens: Math.floor(input / 3), outputTokens: input % 500 };
    for (const m of NEBIUS_MODELS) {
      assert.ok(worstCaseMicros(m, input, usage.outputTokens) >= costMicros(m, usage), `${m} at ${input}`);
    }
  }
});
