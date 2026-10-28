// Regression tests for the second independent review of the LLM rail:
//   1. an unknown model must not let an agent fill the disk through the ledger,
//   2. capped denials need a per-day cap too, with a signed marker entry.
// Every test prints one "# rf <n>: ..." line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream, type FakeUpstream } from "../src/fake-upstream.js";
import { DAILY_DENIAL_CAP } from "../src/store.js";
import { closeServer, listen, post } from "./helpers.js";

const REAL = "sk-rf2-upstream-NOT-REAL";
const issuer = generateSigner("rf2-issuer");
const gatewayKey = generateSigner("rf2-gateway");

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-rf-"));
  dirs.push(d);
  return d;
}

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_rf2_0001_0001",
    issuer: { id: "rf-owner", public_key: issuer.publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "0.50",
    approval_threshold: "0.50",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-10-18T00:00:00Z",
    ...over,
  };
}

interface Harness {
  dbPath: string;
  mandate: Mandate;
  rail: ReturnType<typeof openGovernedRail>;
  upstream: FakeUpstream;
  gateway: http.Server;
  port: number;
  key: string;
  close(): Promise<void>;
}

async function build(over: Partial<Mandate> = {}): Promise<Harness> {
  const dir = tmp();
  const dbPath = join(dir, "rail.db");
  const m = mandate(over);
  const rail = openGovernedRail({
    dbPath,
    signedMandate: signMandate(m, issuer.signer),
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  const upstream = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 3 });
  const gateway = createGateway({
    store: rail.store,
    upstreams: { openai: { baseUrl: upstream.url, apiKey: REAL }, anthropic: { baseUrl: upstream.url, apiKey: REAL } },
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey(m.agents[0]!);
  return {
    dbPath,
    mandate: m,
    rail,
    upstream,
    gateway,
    port,
    key,
    async close() {
      await closeServer(gateway);
      await upstream.close();
      rail.close();
    },
  };
}

function call(h: Harness, body: unknown) {
  return post(`http://127.0.0.1:${h.port}`, "/v1/chat/completions", { authorization: `Bearer ${h.key}` }, body);
}

function ofKind(h: Harness, kind: string) {
  return h.rail.ledger.entries().filter((e) => e.kind === kind);
}

function dbBytes(path: string): number {
  return statSync(path).size;
}

// ---------------------------------------------------------------------------
// Finding 1: the unknown-model path must not store the raw client model
// ---------------------------------------------------------------------------

test("rf 1: 50 unknown models of 100 KB each cannot fill the ledger", async () => {
  const h = await build();
  try {
    const bigModel = "A".repeat(100 * 1024);
    // Checkpoint first so the measurement is the database file itself, not the
    // write-ahead log (a 100 KB payload would land in either, so both count).
    const checkpoint = () => h.rail.store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpoint();
    const before = dbBytes(h.dbPath);
    for (let i = 0; i < 50; i++) {
      const res = await call(h, { model: bigModel, messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
      assert.equal(res.status, 403);
      assert.equal(JSON.parse(res.text).error.code, "model_not_allowed");
    }
    checkpoint();
    const grown = dbBytes(h.dbPath) - before;
    assert.ok(grown < 200 * 1024, `database grew ${grown} bytes, expected < 200 KB`);

    const raw = new DatabaseSync(h.dbPath);
    const rows = raw
      .prepare("SELECT kind, length(payload) AS n FROM ledger_entries")
      .all() as Array<{ kind: string; n: number }>;
    raw.close();
    const longest = Math.max(...rows.map((r) => r.n));
    assert.ok(longest <= 1024, `longest ledger payload is ${longest} bytes`);

    const denied = ofKind(h, "llm.denied");
    assert.equal(denied.length, 50);
    const p = denied[0]!.payload as { model: string; reason: string };
    assert.equal(p.model, "invalid");
    assert.equal(p.reason, "model is not allowed on this route");
    console.log(`# rf 1: 50x100KB models -> 403, db grew ${grown}B, longest payload ${longest}B, model stored "invalid"`);
  } finally {
    await h.close();
  }
});

test("rf 2: an HTML model name is stored as invalid", async () => {
  const h = await build();
  try {
    const model = "<img src=x onerror=alert(1)>";
    const res = await call(h, { model, messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "model_not_allowed");
    const denied = ofKind(h, "llm.denied");
    assert.equal(denied.length, 1);
    const p = denied[0]!.payload as { model: string };
    assert.equal(p.model, "invalid");
    assert.ok(!JSON.stringify(denied[0]!.payload).includes("onerror"));
    console.log(`# rf 2: model "<img ...>" stored as "${p.model}", raw payload free of the injected string`);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Finding 2: a second, daily cap on top of the per-window cap
// ---------------------------------------------------------------------------

test("rf 3: a window cap writes one llm.denials_capped marker (scope window)", async () => {
  const h = await build({
    per_call_cap: "0.000001",
    approval_threshold: "0.000001",
    rate_limit: { max_calls: 5, window_seconds: 3600 },
  });
  try {
    for (let i = 0; i < 30; i++) {
      const res = await call(h, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
      assert.equal(res.status, 402);
      assert.equal(JSON.parse(res.text).error.code, "per_call_cap");
    }
    const denied = ofKind(h, "llm.denied");
    const capped = ofKind(h, "llm.denials_capped");
    assert.equal(denied.length, 5);
    assert.equal(capped.length, 1);
    const p = capped[0]!.payload as { scope: string; cap: number; period_start: string };
    assert.equal(p.scope, "window");
    assert.equal(p.cap, 5);
    assert.ok(Number.isFinite(Date.parse(p.period_start)));
    assert.equal(h.rail.ledger.verify({ [gatewayKey.signer.keyId]: gatewayKey.publicKey }).ok, true);
    console.log(`# rf 3: 30 denials -> ${denied.length} llm.denied + 1 llm.denials_capped (scope ${p.scope}, cap ${p.cap})`);
  } finally {
    await h.close();
  }
});

test("rf 4: the daily cap stops at 1000 denials and writes one day marker", () => {
  const dir = tmp();
  const m = mandate({
    per_call_cap: "0.000001",
    approval_threshold: "0.000001",
    rate_limit: { max_calls: 100, window_seconds: 3600 },
  });
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  let clock = base;
  const rail = openGovernedRail({
    dbPath: join(dir, "rail.db"),
    signedMandate: signMandate(m, issuer.signer),
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
    now: () => clock,
  });
  try {
    for (let w = 0; w < 11; w++) {
      clock = base + w * 3600_000;
      for (let i = 0; i < 100; i++) {
        const r = rail.store.reserve({
          mandateId: m.id,
          agentId: m.agents[0]!,
          model: "gpt-4o",
          provider: "openai",
          amountMicros: 1_000_000,
        });
        assert.equal(r.ok, false);
      }
    }
    const denied = rail.ledger.entries().filter((e) => e.kind === "llm.denied");
    const capped = rail.ledger.entries().filter((e) => e.kind === "llm.denials_capped");
    assert.equal(denied.length, DAILY_DENIAL_CAP);
    assert.equal(capped.length, 1);
    const p = capped[0]!.payload as { scope: string; cap: number; period_start: string };
    assert.equal(p.scope, "day");
    assert.equal(p.cap, DAILY_DENIAL_CAP);
    assert.equal(p.period_start, new Date(base).toISOString());
    assert.equal(rail.ledger.verify({ [gatewayKey.signer.keyId]: gatewayKey.publicKey }).ok, true);
    console.log(`# rf 4: 11 windows x100 -> ${denied.length} llm.denied + 1 llm.denials_capped (scope ${p.scope})`);
  } finally {
    rail.close();
  }
});
