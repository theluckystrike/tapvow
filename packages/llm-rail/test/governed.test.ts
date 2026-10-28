// Step 2 done test through the full stack: a signed mandate, 10 agents with
// their own virtual keys, the gateway, and the signed ledger written in the
// same transaction as each settlement.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner, signMandate, EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { openGovernedRail, policyFromMandate } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { costMicros } from "../src/pricing.js";
import { agentUntilDenied, closeServer, listen } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-governed-"));
  dirs.push(d);
  return d;
}

const issuer = generateSigner("owner-2026-10");
const gatewayKey = generateSigner("gateway-1");
const mandate: Mandate = {
  ...EXAMPLE_MANDATE,
  id: "mdt_fleet_test_0001",
  issuer: { id: "michael", public_key: issuer.publicKey },
  budget: { total: "5.00", period: "lifetime" },
  per_call_cap: "0.50",
  approval_threshold: "0.50",
  rate_limit: { max_calls: 100000, window_seconds: 60 },
  not_before: "2026-01-01T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
};
const signed = signMandate(mandate, issuer.signer);
const REAL = "sk-test-upstream-NOT-REAL";

test("policyFromMandate maps the mandate fields", () => {
  const p = policyFromMandate(mandate);
  assert.equal(p.budgetMicros, 5_000_000);
  assert.equal(p.perCallCapMicros, 500_000);
  assert.deepEqual(p.allowedProviders, ["openai", "anthropic"]);
});

test("a mandate with a bad signature or the wrong issuer key is refused", () => {
  const d = tmp();
  const tampered = { ...signed, mandate: { ...signed.mandate, budget: { total: "500.00", period: "lifetime" } } };
  assert.throws(() => openGovernedRail({ dbPath: join(d, "a.db"), signedMandate: tampered, trustedIssuerKey: issuer.publicKey, ledgerSigner: gatewayKey.signer }), /mandate rejected/);
  const other = generateSigner("x");
  assert.throws(() => openGovernedRail({ dbPath: join(d, "b.db"), signedMandate: signed, trustedIssuerKey: other.publicKey, ledgerSigner: gatewayKey.signer }), /mandate rejected/);
});

test("keys are only issued to agents named in the mandate", () => {
  const rail = openGovernedRail({ dbPath: join(tmp(), "c.db"), signedMandate: signed, trustedIssuerKey: issuer.publicKey, ledgerSigner: gatewayKey.signer });
  assert.throws(() => rail.issueAgentKey("intruder"), /not named/);
  assert.match(rail.issueAgentKey("agent-01"), /^mk_/);
  rail.close();
});

test("DONE TEST step 2: 10 concurrent agents vs a 5.00 USD signed mandate, 3 of 3 runs, ledger verifies", async () => {
  for (const run of [1, 2, 3]) {
    const rail = openGovernedRail({ dbPath: join(tmp(), "rail.db"), signedMandate: signed, trustedIssuerKey: issuer.publicKey, ledgerSigner: gatewayKey.signer });
    const up = await startFakeUpstream({ latencyMs: [20, 120], completion: "random", seed: 100 + run });
    const gw = createGateway({ store: rail.store, upstreams: { openai: { baseUrl: up.url, apiKey: REAL }, anthropic: { baseUrl: up.url, apiKey: REAL } } });
    const port = await listen(gw);
    const keys = mandate.agents.map((a) => rail.issueAgentKey(a));
    const results = await Promise.all(keys.map((k, n) => agentUntilDenied(`http://127.0.0.1:${port}`, k, n)));
    await closeServer(gw);
    await up.close();

    const calls = results.reduce((s, r) => s + r.calls, 0);
    const chargedByHeaders = results.reduce((s, r) => s + r.charged, 0);
    const spent = rail.store.spent(mandate.id);
    const billed = up.billed.reduce((s, b) => s + costMicros(b.model, { inputTokens: b.inputTokens, outputTokens: b.outputTokens, cachedInputTokens: 0 }), 0);

    const v = rail.ledger.verify({ [gatewayKey.signer.keyId]: gatewayKey.publicKey });
    const entries = rail.ledger.entries();
    const settles = entries.filter((e) => e.kind === "llm.settle");
    const ledgerCharged = settles.reduce((s, e) => s + (e.payload as { charged_micros: number }).charged_micros, 0);

    console.log(
      `governed run ${run}: provider billed ${(billed / 1e6).toFixed(6)} USD, ledger ${(ledgerCharged / 1e6).toFixed(6)} USD, cap 5.000000, ` +
        `calls ${calls}, ledger entries ${entries.length}, ledger verify ${v.ok ? "PASS" : "FAIL " + v.reason}`,
    );
    assert.ok(spent.committedMicros <= 5_000_000);
    assert.ok(billed <= 5_000_000, "provider billed above the cap");
    assert.ok(billed <= ledgerCharged, "ledger counted less than the provider billed");
    assert.equal(spent.reservedMicros, 0);
    assert.equal(chargedByHeaders, spent.settledMicros);
    assert.equal(ledgerCharged, spent.settledMicros, "ledger and budget must agree");
    assert.equal(settles.length, calls);
    assert.equal(entries[0]!.kind, "mandate.registered");
    assert.deepEqual(v, { ok: true, checked: entries.length });
    rail.close();
  }
});
