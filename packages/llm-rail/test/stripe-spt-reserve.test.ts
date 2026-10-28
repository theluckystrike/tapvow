import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetStore, DAILY_DENIAL_CAP, type Policy } from "../src/store.js";

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
    allowedProviders: ["openai"],
    rateLimit: { maxCalls: 1000, windowSeconds: 60 },
    notBefore: new Date(0).toISOString(),
    expiresAt: new Date(4_102_444_800_000).toISOString(),
    ...overrides,
  };
}

test("reserve fails closed for stripe_spt unless the policy lists the rail and a verified payee", () => {
  const store = new BudgetStore(tempDb("stripe-reserve"));
  store.upsertMandate(policy({ mandateId: "m-llm", rails: ["llm"] }));
  store.upsertMandate(policy({ mandateId: "m-none" }));
  store.upsertMandate(policy({ mandateId: "m-stripe", rails: ["stripe_spt"] }));

  const args = {
    agentId: "a1",
    model: "stripe_spt:usd",
    provider: "acct_test_0001",
    amountMicros: 1000,
    rail: "stripe_spt" as const,
  };
  const noRail = store.reserve({ ...args, mandateId: "m-llm", payeeVerifiedBy: "allowlist" });
  assert.equal(noRail.ok, false);
  if (!noRail.ok) assert.equal(noRail.code, "rail_not_allowed");

  const missingRails = store.reserve({ ...args, mandateId: "m-none", payeeVerifiedBy: "allowlist" });
  assert.equal(missingRails.ok, false);
  if (!missingRails.ok) assert.equal(missingRails.code, "rail_not_allowed");

  const noVerification = store.reserve({ ...args, mandateId: "m-stripe" });
  assert.equal(noVerification.ok, false);
  if (!noVerification.ok) assert.equal(noVerification.code, "payee_not_allowed");
  store.close();
});

test("recordRailBlock caps a rail's signed blocks per agent per UTC day", () => {
  const store = new BudgetStore(tempDb("rail-block-cap"));
  store.database.exec(
    "CREATE TABLE IF NOT EXISTS ledger_entries (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  const ts = new Date().toISOString();
  const insert = store.database.prepare(
    "INSERT INTO ledger_entries (seq, ts, kind, payload) VALUES (?, ?, ?, ?)",
  );
  for (let i = 1; i <= DAILY_DENIAL_CAP; i++) {
    insert.run(i, ts, "llm.denied", JSON.stringify({ agent_id: "capped-agent" }));
  }

  const appended: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const append = (kind: string, payload: Record<string, unknown>): void => {
    appended.push({ kind, payload });
  };

  store.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "capped-agent", payload: { agent_id: "capped-agent" } },
    append,
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.kind, "stripe_spt.blocks_capped");
  assert.equal(appended[0]!.payload.cap, DAILY_DENIAL_CAP);

  store.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "capped-agent", payload: { agent_id: "capped-agent" } },
    append,
  );
  assert.equal(appended.length, 1, "only one marker per agent per day");

  store.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "fresh-agent", payload: { agent_id: "fresh-agent" } },
    append,
  );
  assert.equal(appended.length, 2);
  assert.equal(appended[1]!.kind, "stripe_spt.blocked");
  store.close();
});

test("recordRailBlock leaves out rows from a previous UTC day and caps across a restart", () => {
  // Yesterday's 1000 rows must not count toward today, so the next call is a
  // real block, not the cap marker. This also exercises the seed query.
  const dbPath = tempDb("rail-block-yesterday");
  const store = new BudgetStore(dbPath);
  store.database.exec(
    "CREATE TABLE IF NOT EXISTS ledger_entries (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterday = new Date(todayStart - 1000).toISOString();
  const insert = store.database.prepare("INSERT INTO ledger_entries (seq, ts, kind, payload) VALUES (?, ?, ?, ?)");
  for (let i = 1; i <= DAILY_DENIAL_CAP; i++) {
    insert.run(i, yesterday, "llm.denied", JSON.stringify({ agent_id: "yesterday-agent" }));
  }
  const appended: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const append = (kind: string, payload: Record<string, unknown>): void => {
    appended.push({ kind, payload });
  };
  store.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "yesterday-agent", payload: { agent_id: "yesterday-agent" } },
    append,
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.kind, "stripe_spt.blocked", "yesterday's rows must not count toward today's cap");

  // Seed today's 1000 rows, then close and reopen: a fresh store (new maps)
  // must still see the cap from the ledger, not start counting at zero.
  const today = new Date().toISOString();
  for (let i = 0; i < DAILY_DENIAL_CAP; i++) {
    insert.run(DAILY_DENIAL_CAP + 1 + i, today, "llm.denied", JSON.stringify({ agent_id: "capped-agent" }));
  }
  store.close();

  const reopened = new BudgetStore(dbPath);
  const appended2: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  reopened.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "capped-agent", payload: { agent_id: "capped-agent" } },
    (kind, payload) => appended2.push({ kind, payload }),
  );
  assert.equal(appended2.length, 1);
  assert.equal(appended2[0]!.kind, "stripe_spt.blocks_capped", "the cap survives a restart");
  reopened.close();
});

test("recordRailBlock counts llm.denied rows another writer adds after the seed and appends the cap marker", () => {
  const store = new BudgetStore(tempDb("rail-block-other-writer"));
  store.database.exec(
    "CREATE TABLE IF NOT EXISTS ledger_entries (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  const insert = store.database.prepare(
    "INSERT INTO ledger_entries (seq, ts, kind, payload) VALUES (?, ?, ?, ?)",
  );
  const nextSeq = (): number => {
    const row = store.database.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM ledger_entries").get() as { m: number };
    return row.m + 1;
  };
  const ts = new Date().toISOString();
  const appended: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const append = (kind: string, payload: Record<string, unknown>): void => {
    appended.push({ kind, payload });
    insert.run(nextSeq(), ts, kind, JSON.stringify(payload));
  };

  store.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "mixed-agent", payload: { agent_id: "mixed-agent" } },
    append,
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.kind, "stripe_spt.blocked");

  for (let i = 0; i < DAILY_DENIAL_CAP; i++) {
    insert.run(nextSeq(), ts, "llm.denied", JSON.stringify({ agent_id: "mixed-agent" }));
  }

  store.recordRailBlock(
    { kind: "stripe_spt.blocked", mandateId: "m1", agentId: "mixed-agent", payload: { agent_id: "mixed-agent" } },
    append,
  );
  assert.equal(appended.length, 2);
  assert.equal(
    appended[1]!.kind,
    "stripe_spt.blocks_capped",
    "a stripe block plus 1000 llm.denied rows from another writer reaches the shared cap",
  );
  store.close();
});

test("recordRailBlock counts today's rows when an older-ts row is appended after them and appends the cap marker", () => {
  const store = new BudgetStore(tempDb("rail-block-old-ts-late"));
  store.database.exec(
    "CREATE TABLE IF NOT EXISTS ledger_entries (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  const insert = store.database.prepare(
    "INSERT INTO ledger_entries (seq, ts, kind, payload) VALUES (?, ?, ?, ?)",
  );
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const today = new Date().toISOString();
  const yesterday = new Date(todayStart - 1000).toISOString();
  for (let i = 1; i <= DAILY_DENIAL_CAP; i++) {
    insert.run(i, today, "llm.denied", JSON.stringify({ agent_id: "late-old-ts-agent" }));
  }
  insert.run(DAILY_DENIAL_CAP + 1, yesterday, "llm.denied", JSON.stringify({ agent_id: "late-old-ts-agent" }));

  const appended: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  store.recordRailBlock(
    {
      kind: "stripe_spt.blocked",
      mandateId: "m1",
      agentId: "late-old-ts-agent",
      payload: { agent_id: "late-old-ts-agent" },
    },
    (kind, payload) => appended.push({ kind, payload }),
  );
  assert.equal(appended.length, 1);
  assert.equal(
    appended[0]!.kind,
    "stripe_spt.blocks_capped",
    "an older-ts row appended after today's rows must not hide them from the count",
  );
  store.close();
});
