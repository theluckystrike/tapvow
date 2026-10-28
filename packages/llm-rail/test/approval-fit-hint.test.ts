// A denied or timed-out approval tells the agent which max_tokens would have
// stayed under the approval threshold, without changing the status, error code
// or ledger rows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway, type GatewayOptions } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { worstCase } from "../src/estimate.js";
import { PRICING, worstCaseMicros } from "../src/pricing.js";
import { closeServer, listen, post } from "./helpers.js";

const issuer = generateSigner("fit-hint-issuer");
const gatewayKey = generateSigner("fit-hint-gateway");
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

const MODEL = "gpt-4o";

function body(maxTokens: number) {
  return { model: MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: maxTokens };
}

// Independent of fittingMaxTokens: rebuild the same input bound the gateway
// reserves, then scan every output bound for the largest one under the line.
function expectedK(requestBody: Record<string, unknown>, thresholdMicros: number): number {
  const raw = Buffer.from(JSON.stringify(requestBody));
  const price = PRICING[MODEL]!;
  const estimate = worstCase("openai", requestBody, raw.length, price.defaultOutputTokens, price.maxOutputTokens);
  if (!estimate.ok) throw new Error(estimate.reason);
  const forwarded = Buffer.from(JSON.stringify(estimate.body));
  const extra = Math.max(0, forwarded.length - raw.length);
  const inputBound = estimate.maxInputTokens + extra;
  let k = 0;
  for (let candidate = 1; candidate <= estimate.maxOutputTokens; candidate++) {
    if (worstCaseMicros(MODEL, inputBound, candidate, false) > thresholdMicros) break;
    k = candidate;
  }
  return k;
}

async function probe(
  decision: "denied" | "timeout",
  opts: { threshold: string; perCallCap?: string; maxTokens?: number } = { threshold: "0.05" },
) {
  const dir = mkdtempSync(join(tmpdir(), "mandate-fit-hint-"));
  const mandate: Mandate = {
    ...EXAMPLE_MANDATE,
    id: "mdt_fit_hint_0001",
    issuer: { id: "fit-owner", public_key: issuer.publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: opts.perCallCap ?? "0.50",
    approval_threshold: opts.threshold,
    rate_limit: { max_calls: 1000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const rail = openGovernedRail({
    dbPath: join(dir, "rail.db"),
    signedMandate: signMandate(mandate, issuer.signer),
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  const upstream = await startFakeUpstream({ latencyMs: [1, 2], completion: "random", seed: 5 });
  const approver: GatewayOptions["approver"] = {
    request: async () => ({ decision, requestId: `apr_fit_${decision}_0001`, decidedBy: "owner" }),
  };
  const gateway = createGateway({
    store: rail.store,
    upstreams: { openai: { baseUrl: upstream.url, apiKey: "sk-fit-hint-NOT-REAL" } },
    approver,
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey(mandate.agents[0]!);
  const requestBody = body(opts.maxTokens ?? 16384);
  cleanups.push(async () => {
    await closeServer(gateway);
    await upstream.close();
    rail.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const r = await post(`http://127.0.0.1:${port}`, "/v1/chat/completions", { authorization: `Bearer ${key}` }, requestBody);
  const error = JSON.parse(r.text);
  return {
    requestBody,
    status: r.status,
    code: error.error?.code,
    message: error.error?.message as string,
    fitHeader: r.headers["x-mandate-fit-max-tokens"],
    reserved: Number(r.headers["x-mandate-reserved-micros"]),
    upstreamRequests: upstream.requests.length,
    entries: rail.ledger.entries(),
  };
}

function assertLedgerUnchanged(
  entries: Array<{ kind: string; payload: any }>,
  decision: "denied" | "timeout",
  reserved: number,
) {
  const ofKind = (kind: string) => entries.filter((e) => e.kind === kind);
  assert.equal(ofKind("llm.denied").length, 0);
  assert.equal(ofKind("llm.settle").length, 0);
  const approvals = ofKind("llm.approval");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.payload.decision, decision);
  assert.equal(approvals[0]!.payload.amount_micros, reserved);
}

test("a denied approval names the fitting max_tokens in the message and header", async () => {
  const r = await probe("denied");
  const k = expectedK(r.requestBody, 50_000);
  assert.ok(k >= 1 && k < 16_384, `expected a partial k, got ${k}`);
  assert.equal(r.status, 403);
  assert.equal(r.code, "approval_denied");
  assert.equal(Number(r.fitHeader), k);
  assert.match(r.message, /^the owner denied this call\. A request with max_tokens \d+ or less stays under the approval line of 0\.050000 USD and needs no approval\.$/);
  assert.ok(r.message.includes(`max_tokens ${k} or less`), r.message);
  assert.equal(r.upstreamRequests, 0);
  assertLedgerUnchanged(r.entries, "denied", r.reserved);
  console.log(`# fit-hint denied: k=${k}, header ${r.fitHeader}, reserved ${r.reserved}`);
});

test("a timed-out approval gets the same hint and header", async () => {
  const r = await probe("timeout");
  const k = expectedK(r.requestBody, 50_000);
  assert.ok(k >= 1 && k < 16_384, `expected a partial k, got ${k}`);
  assert.equal(r.status, 403);
  assert.equal(r.code, "approval_timeout");
  assert.equal(Number(r.fitHeader), k);
  assert.match(r.message, /^the owner did not answer in time\. A request with max_tokens \d+ or less stays under the approval line of 0\.050000 USD and needs no approval\.$/);
  assert.ok(r.message.includes(`max_tokens ${k} or less`), r.message);
  assert.equal(r.upstreamRequests, 0);
  assertLedgerUnchanged(r.entries, "timeout", r.reserved);
  console.log(`# fit-hint timeout: k=${k}, header ${r.fitHeader}, reserved ${r.reserved}`);
});

test("when even max_tokens 1 is over the threshold the old message and no header stay", async () => {
  const r = await probe("denied", { threshold: "0.000001" });
  assert.equal(expectedK(r.requestBody, 1), 0);
  assert.equal(r.status, 403);
  assert.equal(r.code, "approval_denied");
  assert.equal(r.fitHeader, undefined);
  assert.equal(r.message, "the owner denied this call");
  assert.equal(r.upstreamRequests, 0);
  assertLedgerUnchanged(r.entries, "denied", r.reserved);
  console.log(`# fit-hint no-fit: k=0, header absent, reserved ${r.reserved}`);
});

test("the suggested k and k + 1 straddle the approval threshold", async () => {
  const r = await probe("denied");
  const k = Number(r.fitHeader);
  const expected = expectedK(r.requestBody, 50_000);
  assert.equal(k, expected);
  const raw = Buffer.from(JSON.stringify(r.requestBody));
  const price = PRICING[MODEL]!;
  const estimate = worstCase("openai", r.requestBody, raw.length, price.defaultOutputTokens, price.maxOutputTokens);
  assert.equal(estimate.ok, true);
  if (!estimate.ok) return;
  const forwarded = Buffer.from(JSON.stringify(estimate.body));
  const inputBound = estimate.maxInputTokens + Math.max(0, forwarded.length - raw.length);
  assert.ok(worstCaseMicros(MODEL, inputBound, k, false) <= 50_000);
  assert.ok(worstCaseMicros(MODEL, inputBound, k + 1, false) > 50_000);
  console.log(`# fit-hint boundary: input ${inputBound}, k=${k} fits, k+1 does not`);
});
