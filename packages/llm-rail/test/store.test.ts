import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BudgetStore, type Policy } from "../src/store.js";
import { costMicros } from "../src/pricing.js";

const dirs: string[] = [];
function tempDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `llm-rail-${name}-`));
  dirs.push(dir);
  return join(dir, "budget.db");
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    mandateId: "m1",
    budgetMicros: 5_000_000,
    perCallCapMicros: 1_000_000,
    approvalThresholdMicros: 1_000_000,
    allowedProviders: ["openai", "anthropic"],
    rateLimit: { maxCalls: 1000, windowSeconds: 60 },
    notBefore: new Date(0).toISOString(),
    expiresAt: new Date(4_102_444_800_000).toISOString(),
    ...overrides,
  };
}

test("costMicros rounds up and applies cache pricing", () => {
  assert.equal(
    costMicros("gpt-4o", { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 }),
    12_500_000,
  );
  assert.equal(
    costMicros("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 }),
    1_250_000,
  );
  assert.equal(
    costMicros("claude-sonnet-4-5", { inputTokens: 500, outputTokens: 200, cachedInputTokens: 0 }),
    Math.ceil(500 * 3 + 200 * 15),
  );
  assert.throws(() => costMicros("not-a-model", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }));
});

test("reserve/settle/release/chargeFull accounting", () => {
  const store = new BudgetStore(tempDb("accounting"));
  store.upsertMandate(policy());
  const key = store.createAgentKey("m1", "a1");
  const auth = store.authenticate(key);
  assert.ok(auth);

  const r1 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
  assert.ok(r1.ok);
  const r2 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 2000 });
  assert.ok(r2.ok);
  const r3 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 3000 });
  assert.ok(r3.ok);
  const r4 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 4000 });
  assert.ok(r4.ok);

  assert.equal(store.spent("m1").reservedMicros, 10_000);
  const ev1 = store.settle(r1.reservationId, { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, 500);
  assert.equal(ev1.chargedMicros, 500);
  assert.equal(ev1.overrun, false);
  const ev2 = store.settle(r2.reservationId, { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, 2500);
  assert.equal(ev2.overrun, true);
  const ev3 = store.release(r3.reservationId);
  assert.equal(ev3.chargedMicros, 0);
  assert.equal(ev3.outcome, "released");
  const ev4 = store.chargeFull(r4.reservationId);
  assert.equal(ev4.chargedMicros, 4000);
  assert.equal(ev4.outcome, "charged_full");

  const spent = store.spent("m1");
  assert.equal(spent.settledMicros, 500 + 2500 + 0 + 4000);
  assert.equal(spent.reservedMicros, 0);
  assert.equal(spent.committedMicros, 7000);
  store.close();
});

test("double settle throws and settle after release throws", () => {
  const store = new BudgetStore(tempDb("double"));
  store.upsertMandate(policy());
  store.createAgentKey("m1", "a1");
  const r = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
  assert.ok(r.ok);
  store.settle(r.reservationId, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, 10);
  assert.throws(() => store.settle(r.reservationId, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, 10));
  const r2 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
  assert.ok(r2.ok);
  store.release(r2.reservationId);
  assert.throws(() => store.settle(r2.reservationId, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, 10));
  store.close();
});

test("each check produces the correct Deny", () => {
  const now = 1_000_000;
  const store = new BudgetStore(tempDb("denies"), { now: () => now });
  store.upsertMandate(policy());
  store.createAgentKey("m1", "a1");

  const perCall = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 2_000_000 });
  assert.equal(perCall.ok, false);
  if (!perCall.ok) {
    assert.equal(perCall.status, 402);
    assert.equal(perCall.code, "per_call_cap");
  }

  const approvalPolicy = policy({ perCallCapMicros: 10_000_000, approvalThresholdMicros: 1000 });
  store.upsertMandate(approvalPolicy);
  const approval = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 2000 });
  assert.equal(approval.ok, false);
  if (!approval.ok) {
    assert.equal(approval.status, 403);
    assert.equal(approval.code, "approval_required");
  }

  const payeePolicy = policy({ allowedProviders: ["anthropic"] });
  store.upsertMandate(payeePolicy);
  const payee = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 100 });
  assert.equal(payee.ok, false);
  if (!payee.ok) {
    assert.equal(payee.status, 403);
    assert.equal(payee.code, "payee_not_allowed");
  }

  const modelPolicy = policy({ allowedModels: ["gpt-4o"] });
  store.upsertMandate(modelPolicy);
  const badModel = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o-mini", provider: "openai", amountMicros: 100 });
  assert.equal(badModel.ok, false);
  if (!badModel.ok) {
    assert.equal(badModel.status, 403);
    assert.equal(badModel.code, "model_not_allowed");
  }

  const ratePolicy = policy({ rateLimit: { maxCalls: 1, windowSeconds: 60 } });
  store.upsertMandate(ratePolicy);
  const first = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 100 });
  assert.ok(first.ok);
  const rate = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 100 });
  assert.equal(rate.ok, false);
  if (!rate.ok) {
    assert.equal(rate.status, 429);
    assert.equal(rate.code, "rate_limited");
  }

  const notActivePolicy = policy({ notBefore: new Date(now + 10_000).toISOString() });
  store.upsertMandate(notActivePolicy);
  const notActive = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 100 });
  assert.equal(notActive.ok, false);
  if (!notActive.ok) {
    assert.equal(notActive.status, 403);
    assert.equal(notActive.code, "mandate_not_active");
  }

  const expiredPolicy = policy({ expiresAt: new Date(now - 1).toISOString() });
  store.upsertMandate(expiredPolicy);
  const expired = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 100 });
  assert.equal(expired.ok, false);
  if (!expired.ok) {
    assert.equal(expired.status, 403);
    assert.equal(expired.code, "mandate_expired");
  }

  const tightPolicy = policy({ budgetMicros: 1000 });
  store.upsertMandate(tightPolicy);
  const budget = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 2000 });
  assert.equal(budget.ok, false);
  if (!budget.ok) {
    assert.equal(budget.status, 402);
    assert.equal(budget.code, "budget_exceeded");
  }
  store.close();
});

test("keys are stored hashed, never in plaintext", () => {
  const path = tempDb("keys");
  const store = new BudgetStore(path);
  store.upsertMandate(policy());
  const key = store.createAgentKey("m1", "a1");
  const other = store.createAgentKey("m1", "a1");
  assert.notEqual(key, other);

  const raw = new DatabaseSync(path);
  const rows = raw.prepare("SELECT key_hash FROM agent_keys").all() as Array<{ key_hash: string }>;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.key_hash, key);
    assert.ok(!row.key_hash.includes(key));
    assert.match(row.key_hash, /^[0-9a-f]{64}$/);
  }
  raw.close();

  assert.deepEqual(store.authenticate(key), { agentId: "a1", mandateId: "m1" });
  store.revokeAgentKey(key);
  assert.equal(store.authenticate(key), null);
  store.close();
});

test("authenticate rejects malformed keys", () => {
  const store = new BudgetStore(tempDb("auth"));
  store.upsertMandate(policy());
  assert.equal(store.authenticate("not-a-key"), null);
  assert.equal(store.authenticate(""), null);
  assert.equal(store.authenticate("x".repeat(200)), null);
  store.close();
});

test("afterSettleInTx commits with the settlement and rolls back on throw", () => {
  const path = tempDb("tx");
  const store = new BudgetStore(path, {
    afterSettleInTx: (db, ev) => {
      db.exec("CREATE TABLE IF NOT EXISTS ledger(x INTEGER)");
      db.prepare("INSERT INTO ledger(x) VALUES(?)").run(ev.chargedMicros);
      if (ev.chargedMicros === 999) throw new Error("boom");
    },
  });
  store.upsertMandate(policy());
  store.createAgentKey("m1", "a1");

  const r1 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
  assert.ok(r1.ok);
  store.settle(r1.reservationId, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, 100);

  const r2 = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
  assert.ok(r2.ok);
  assert.throws(() => store.settle(r2.reservationId, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, 999));

  const spent = store.spent("m1");
  assert.equal(spent.settledMicros, 100);
  assert.equal(spent.reservedMicros, 1000);
  store.close();

  const raw = new DatabaseSync(path);
  const ledger = raw.prepare("SELECT x FROM ledger ORDER BY x").all() as Array<{ x: number }>;
  raw.close();
  assert.deepEqual(ledger.map((row) => row.x), [100]);
});

test("two stores on one file never exceed the budget under concurrency", async () => {
  const path = tempDb("concurrent");
  const budget = 100_000;
  const a = new BudgetStore(path);
  const b = new BudgetStore(path);
  a.upsertMandate(policy({ budgetMicros: budget, perCallCapMicros: 10_000_000, approvalThresholdMicros: 10_000_000, rateLimit: { maxCalls: 1_000_000, windowSeconds: 60 } }));
  a.createAgentKey("m1", "a1");

  let successes = 0;
  async function worker(store: BudgetStore): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const r = store.reserve({ mandateId: "m1", agentId: "a1", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
      if (!r.ok) return;
      successes += 1;
      await Promise.resolve();
    }
  }

  await Promise.all([worker(a), worker(b)]);
  const spent = a.spent("m1");
  assert.ok(successes * 1000 <= budget);
  assert.ok(spent.committedMicros <= budget);
  assert.ok(spent.reservedMicros <= budget);
  a.close();
  b.close();
});
