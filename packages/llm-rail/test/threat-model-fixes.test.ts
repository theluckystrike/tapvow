// Regression tests for the two threat-model fixes:
//   A. the LLM rail signs deny and human-approval decisions into the ledger,
//   B. one signed mandate is bound to one budget database (store id).
// Every test prints one "# tm <n>: ..." line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXAMPLE_MANDATE, canonicalize, generateSigner, signMandate, type Mandate } from "@mandate/core";
import {
  PasskeyRegistry,
  type PasskeySignedMandate,
  type TrustedCredential,
} from "@mandate/passkey";
import { SoftAuthenticator } from "@mandate/passkey/testing";
import { openGovernedRail, openGovernedRailWithPasskey, readStoreId } from "../src/mandate.js";
import { createGateway, type GatewayOptions } from "../src/gateway.js";
import { startFakeUpstream, type FakeUpstream } from "../src/fake-upstream.js";
import { closeServer, listen, post } from "./helpers.js";

const REAL = "sk-test-upstream-NOT-REAL";
const issuer = generateSigner("tm-issuer");
const gatewayKey = generateSigner("tm-gateway");

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-tm-"));
  dirs.push(d);
  return d;
}

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_tm_0001_0001",
    issuer: { id: "tm-owner", public_key: issuer.publicKey },
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

const BODY = { model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(2000) }], max_tokens: 100 };

interface Harness {
  dir: string;
  dbPath: string;
  mandate: Mandate;
  signed: ReturnType<typeof signMandate>;
  rail: ReturnType<typeof openGovernedRail>;
  upstream: FakeUpstream;
  gateway: http.Server;
  port: number;
  key: string;
  close(): Promise<void>;
}

async function build(over: Partial<Mandate> = {}, approver?: GatewayOptions["approver"]): Promise<Harness> {
  const dir = tmp();
  const dbPath = join(dir, "rail.db");
  const m = mandate(over);
  const signed = signMandate(m, issuer.signer);
  const rail = openGovernedRail({
    dbPath,
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  const upstream = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 3 });
  const gateway = createGateway({
    store: rail.store,
    upstreams: { openai: { baseUrl: upstream.url, apiKey: REAL }, anthropic: { baseUrl: upstream.url, apiKey: REAL } },
    ...(approver ? { approver } : {}),
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey(m.agents[0]!);
  return {
    dir,
    dbPath,
    mandate: m,
    signed,
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

function call(h: Harness, body: unknown = BODY) {
  return post(`http://127.0.0.1:${h.port}`, "/v1/chat/completions", { authorization: `Bearer ${h.key}` }, body);
}

function ofKind(h: Harness, kind: string) {
  return h.rail.ledger.entries().filter((e) => e.kind === kind);
}

function verify(h: Harness) {
  return h.rail.ledger.verify({ [gatewayKey.signer.keyId]: gatewayKey.publicKey });
}

const approver = (answer: () => Promise<{ decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string }>) => ({ request: answer });

// ---------------------------------------------------------------------------
// Fix A: deny and approval decisions are signed
// ---------------------------------------------------------------------------

test("tm 1: a per-call-cap deny is signed exactly once and the ledger verifies", async () => {
  const h = await build({ per_call_cap: "0.001000", approval_threshold: "0.001000" });
  try {
    const res = await call(h);
    assert.equal(res.status, 402);
    assert.equal(JSON.parse(res.text).error.code, "per_call_cap");
    const denied = ofKind(h, "llm.denied");
    assert.equal(denied.length, 1);
    const p = denied[0]!.payload as { code: string; agent_id: string };
    assert.equal(p.code, "per_call_cap");
    assert.equal(p.agent_id, h.mandate.agents[0]);
    const v = verify(h);
    assert.equal(v.ok, true);
    console.log(`# tm 1: 402 per_call_cap, 1 signed llm.denied, ledger verify ${v.ok ? "PASS" : "FAIL"}`);
  } finally {
    await h.close();
  }
});

test("tm 2: budget_exceeded is signed with the agent and amount", async () => {
  const h = await build({
    budget: { total: "0.010000", period: "lifetime" },
    per_call_cap: "0.010000",
    approval_threshold: "0.010000",
  });
  try {
    const seeded = h.rail.store.reserve({
      mandateId: h.mandate.id,
      agentId: h.mandate.agents[0]!,
      model: "gpt-4o",
      provider: "openai",
      amountMicros: 5000,
    });
    if (!seeded.ok) throw new Error(`seed reserve failed: ${seeded.reason}`);
    h.rail.store.settle(seeded.reservationId, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, 5000);

    const res = await call(h);
    assert.equal(res.status, 402);
    assert.equal(JSON.parse(res.text).error.code, "budget_exceeded");
    const denied = ofKind(h, "llm.denied").filter((e) => (e.payload as { code?: string }).code === "budget_exceeded");
    assert.equal(denied.length, 1);
    const p = denied[0]!.payload as { agent_id: string; amount_micros: number };
    assert.equal(p.agent_id, h.mandate.agents[0]);
    assert.equal(p.amount_micros, Number(res.headers["x-mandate-reserved-micros"]));
    console.log(`# tm 2: budget_exceeded signed for ${p.agent_id}, amount ${p.amount_micros}`);
  } finally {
    await h.close();
  }
});

test("tm 3: an unknown model is signed as model_not_allowed with amount 0", async () => {
  const h = await build();
  try {
    const res = await call(h, { model: "gpt-not-a-real-model", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "model_not_allowed");
    const denied = ofKind(h, "llm.denied");
    assert.equal(denied.length, 1);
    const p = denied[0]!.payload as { code: string; amount_micros: number; agent_id: string };
    assert.equal(p.code, "model_not_allowed");
    assert.equal(p.amount_micros, 0);
    assert.equal(p.agent_id, h.mandate.agents[0]);
    console.log(`# tm 3: model_not_allowed signed with amount_micros 0 for ${p.agent_id}`);
  } finally {
    await h.close();
  }
});

test("tm 4: an approval is signed, then the settlement names the approval id", async () => {
  const requestId = "apr_tm4_00000001";
  const h = await build(
    { approval_threshold: "0.001000" },
    approver(async () => ({ decision: "approved", requestId, decidedBy: "owner" })),
  );
  try {
    const res = await call(h);
    assert.equal(res.status, 200);
    const approvals = ofKind(h, "llm.approval");
    assert.equal(approvals.length, 1);
    const ap = approvals[0]!.payload as { decision: string; request_id: string };
    assert.equal(ap.decision, "approved");
    assert.equal(ap.request_id, requestId);
    const settles = ofKind(h, "llm.settle");
    assert.equal(settles.length, 1);
    const sp = settles[0]!.payload as { approval_request_id?: string };
    assert.equal(sp.approval_request_id, requestId);
    assert.ok(approvals[0]!.seq < settles[0]!.seq, "approval must be signed before the settlement");
    console.log(`# tm 4: llm.approval approved ${requestId}, llm.settle carries approval_request_id`);
  } finally {
    await h.close();
  }
});

test("tm 5: a denied approval is signed, with no llm.denied and no settlement", async () => {
  const h = await build(
    { approval_threshold: "0.001000" },
    approver(async () => ({ decision: "denied", requestId: "" })),
  );
  try {
    const res = await call(h);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_denied");
    const approvals = ofKind(h, "llm.approval");
    assert.equal(approvals.length, 1);
    assert.equal((approvals[0]!.payload as { decision: string }).decision, "denied");
    assert.equal(ofKind(h, "llm.denied").length, 0);
    assert.equal(ofKind(h, "llm.settle").length, 0);
    assert.equal(h.upstream.requests.length, 0);
    console.log("# tm 5: llm.approval denied, no llm.denied and no settle");
  } finally {
    await h.close();
  }
});

test("tm 6: a timeout is signed as an llm.approval timeout", async () => {
  const h = await build(
    { approval_threshold: "0.001000" },
    approver(async () => ({ decision: "timeout", requestId: "" })),
  );
  try {
    const res = await call(h);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_timeout");
    const approvals = ofKind(h, "llm.approval");
    assert.equal(approvals.length, 1);
    assert.equal((approvals[0]!.payload as { decision: string }).decision, "timeout");
    console.log("# tm 6: llm.approval timeout signed");
  } finally {
    await h.close();
  }
});

test("tm 7: an approver that throws is signed as denied", async () => {
  const h = await build(
    { approval_threshold: "0.001000" },
    approver(async () => {
      throw new Error("approver blew up");
    }),
  );
  try {
    const res = await call(h);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_denied");
    const approvals = ofKind(h, "llm.approval");
    assert.equal(approvals.length, 1);
    assert.equal((approvals[0]!.payload as { decision: string }).decision, "denied");
    console.log("# tm 7: throwing approver signed as decision denied");
  } finally {
    await h.close();
  }
});

test("tm 8: a rate-limited agent adds at most one llm.denied per window", async () => {
  const h = await build({ rate_limit: { max_calls: 1, window_seconds: 3600 } });
  try {
    assert.equal((await call(h)).status, 200);
    for (let i = 0; i < 20; i++) {
      const res = await call(h);
      assert.equal(res.status, 429);
      assert.equal(JSON.parse(res.text).error.code, "rate_limited");
    }
    const rateLimited = ofKind(h, "llm.denied").filter(
      (e) => (e.payload as { code?: string }).code === "rate_limited",
    );
    assert.equal(rateLimited.length, 1);
    console.log(`# tm 8: 20 rate-limited calls added ${rateLimited.length} llm.denied entry`);
  } finally {
    await h.close();
  }
});

test("tm 9: editing an llm.denied payload makes ledger.verify fail", async () => {
  const h = await build({ per_call_cap: "0.001000", approval_threshold: "0.001000" });
  try {
    assert.equal((await call(h)).status, 402);
    const raw = new DatabaseSync(h.dbPath);
    const row = raw
      .prepare("SELECT seq, payload FROM ledger_entries WHERE kind = 'llm.denied'")
      .get() as { seq: number; payload: string };
    const changed = canonicalize({ ...(JSON.parse(row.payload) as object), code: "budget_exceeded" });
    raw.prepare("UPDATE ledger_entries SET payload = ? WHERE seq = ?").run(changed, row.seq);
    raw.close();

    const v = verify(h);
    assert.equal(v.ok, false);
    console.log(`# tm 9: signed llm.denied payload tamper detected (${v.reason})`);
  } finally {
    await h.close();
  }
});

test("tm 10: reopening the rail after decision entries passes the startup audit", async () => {
  const h = await build({ per_call_cap: "0.001000", approval_threshold: "0.001000" });
  try {
    assert.equal((await call(h)).status, 402);
  } finally {
    await h.close();
  }
  const reopened = openGovernedRail({
    dbPath: h.dbPath,
    signedMandate: h.signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  try {
    assert.ok(reopened.ledger.entries().some((e) => e.kind === "llm.denied"));
    assert.equal(reopened.ledger.verify({ [gatewayKey.signer.keyId]: gatewayKey.publicKey }).ok, true);
    console.log("# tm 10: reopen after llm.denied entries passed the startup audit");
  } finally {
    reopened.close();
  }
});

// ---------------------------------------------------------------------------
// Fix B: one mandate, one budget store
// ---------------------------------------------------------------------------

const openBound = (dbPath: string, signed: unknown, extra: { requireStoreBinding?: boolean } = {}) =>
  openGovernedRail({
    dbPath,
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
    ...extra,
  });

test("tm 11: a mandate bound to db A refuses db B and leaves db B empty", () => {
  const dbA = join(tmp(), "a.db");
  const dbB = join(tmp(), "b.db");
  const storeA = readStoreId(dbA);
  assert.match(storeA, /^st_[A-Za-z0-9_-]{16,64}$/);
  const signed = signMandate(mandate({ store_id: storeA }), issuer.signer);

  const rail = openBound(dbA, signed);
  assert.equal(rail.store.storeId, storeA);
  rail.close();

  assert.throws(() => openBound(dbB, signed), /is bound to store/);
  const raw = new DatabaseSync(dbB);
  const mandates = raw.prepare("SELECT COUNT(*) AS c FROM mandates").get() as { c: number };
  const entries = raw.prepare("SELECT COUNT(*) AS c FROM ledger_entries").get() as { c: number };
  raw.close();
  assert.equal(mandates.c, 0);
  assert.equal(entries.c, 0);
  console.log(`# tm 11: db A opened (${storeA.slice(0, 12)}...), db B refused with no mandate row or ledger entry`);
});

test("tm 12: two stores on the same file agree on the id and both open the bound mandate", () => {
  const dbPath = join(tmp(), "shared.db");
  const id1 = readStoreId(dbPath);
  const id2 = readStoreId(dbPath);
  assert.equal(id1, id2);
  const signed = signMandate(mandate({ store_id: id1 }), issuer.signer);
  const rail1 = openBound(dbPath, signed);
  const rail2 = openBound(dbPath, signed);
  try {
    assert.equal(rail1.store.storeId, id1);
    assert.equal(rail2.store.storeId, id1);
    assert.equal(rail1.store.storeId, rail2.store.storeId);
    console.log(`# tm 12: two stores on one file agree on ${id1} and both opened the mandate`);
  } finally {
    rail1.close();
    rail2.close();
  }
});

test("tm 13: requireStoreBinding refuses an unbound mandate, the default still opens it", () => {
  const dbPath = join(tmp(), "rail.db");
  const signed = signMandate(mandate(), issuer.signer);
  assert.throws(() => openBound(dbPath, signed, { requireStoreBinding: true }), /has no store_id/);
  const rail = openBound(dbPath, signed);
  try {
    assert.ok(rail.store.storeId.startsWith("st_"));
    console.log("# tm 13: unbound mandate refused with requireStoreBinding, accepted by default");
  } finally {
    rail.close();
  }
});

test("tm 14: changing store_meta.store_id is caught by the binding or the ledger audit", () => {
  // A bound mandate is refused by the signature-level binding check.
  const dbA = join(tmp(), "a.db");
  const storeA = readStoreId(dbA);
  const signedBound = signMandate(mandate({ store_id: storeA }), issuer.signer);
  openBound(dbA, signedBound).close();
  const rawA = new DatabaseSync(dbA);
  rawA.prepare("UPDATE store_meta SET v = ? WHERE k = 'store_id'").run("st_" + "z".repeat(22));
  rawA.close();
  let boundMessage: string | null = null;
  try {
    openBound(dbA, signedBound).close();
  } catch (err) {
    boundMessage = err instanceof Error ? err.message : String(err);
  }
  assert.ok(boundMessage !== null);
  assert.match(boundMessage!, /is bound to store|store id differs from the ledger/);

  // An unbound mandate has no signature to compare, so the ledger audit catches it.
  const dbB = join(tmp(), "b.db");
  const signedUnbound = signMandate(mandate({ id: "mdt_tm_0014_0002" }), issuer.signer);
  openBound(dbB, signedUnbound).close();
  const rawB = new DatabaseSync(dbB);
  rawB.prepare("UPDATE store_meta SET v = ? WHERE k = 'store_id'").run("st_" + "y".repeat(22));
  rawB.close();
  let auditMessage: string | null = null;
  try {
    openBound(dbB, signedUnbound).close();
  } catch (err) {
    auditMessage = err instanceof Error ? err.message : String(err);
  }
  assert.ok(auditMessage !== null);
  assert.match(auditMessage!, /store id differs from the ledger/);
  console.log(`# tm 14: store_meta change caught (${boundMessage}; ${auditMessage})`);
});

test("tm 15: a newer mandate moved to another store is refused on the original db", () => {
  const dbA = join(tmp(), "a.db");
  const dbB = join(tmp(), "b.db");
  const idA = readStoreId(dbA);
  const idB = readStoreId(dbB);
  const v1 = mandate({ id: "mdt_tm_0015_0001", store_id: idA, created_at: "2026-10-18T00:00:00Z" });
  const signed1 = signMandate(v1, issuer.signer);
  openBound(dbA, signed1).close();

  const v2: Mandate = { ...v1, store_id: idB, created_at: "2026-10-19T00:00:00Z" };
  const signed2 = signMandate(v2, issuer.signer);
  assert.throws(() => openBound(dbA, signed2), /is bound to store/);
  console.log(`# tm 15: newer mandate moved to ${idB} refused on db bound to ${idA}`);
});

const RP_ID = "tapvow.test";
const ORIGIN = "https://tapvow.test";
const AUDIENCE = "gw-tm-1";

interface Passkey {
  registry: PasskeyRegistry;
  auth: SoftAuthenticator;
  credential: TrustedCredential;
}

async function newPasskey(dir: string, issuerId: string): Promise<Passkey> {
  const regDb = new DatabaseSync(join(dir, `passkey-${issuerId}.sqlite`));
  dbs.push(regDb);
  const registry = new PasskeyRegistry(regDb, { rpID: RP_ID, rpName: "TapVow", origin: ORIGIN, audience: AUDIENCE });
  registry.init();
  const auth = new SoftAuthenticator();
  const options = await registry.beginRegistration(issuerId, issuerId);
  const response = auth.createCredential(options, { origin: ORIGIN });
  const credential = await registry.finishRegistration(issuerId, response);
  return { registry, auth, credential };
}

async function signPasskeyDoc(p: Passkey, m: Mandate, prevHash: string | null): Promise<PasskeySignedMandate> {
  const { challenge, nonce, audience, expires_at } = await p.registry.beginEdit({
    issuerId: m.issuer.id,
    mandate: m,
    prevHash,
  });
  const assertion = p.auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  return { format: "passkey-v1", mandate: m, prev_hash: prevHash, nonce, audience, expires_at, assertion };
}

test("tm 16: the passkey path enforces the store binding too", async () => {
  const dir = tmp();
  const passkeyOwner = generateSigner("tm-passkey-owner");
  const p = await newPasskey(dir, "tm-passkey-owner");
  const dbA = join(dir, "a.db");
  const dbB = join(dir, "b.db");
  const storeA = readStoreId(dbA);

  const m = mandate({
    id: "mdt_tm_0016_0001",
    issuer: { id: "tm-passkey-owner", public_key: passkeyOwner.publicKey },
    store_id: storeA,
  });
  const doc = await signPasskeyDoc(p, m, null);
  const finished = await p.registry.finishEdit(doc);
  if (!finished.ok) throw new Error(`finishEdit rejected: ${finished.reason}`);

  const openPasskey = (dbPath: string) =>
    openGovernedRailWithPasskey({
      dbPath,
      signedMandate: doc,
      passkey: { credentials: [p.credential], rpID: RP_ID, origin: ORIGIN, audience: AUDIENCE },
      ledgerSigner: gatewayKey.signer,
    });

  const railA = await openPasskey(dbA);
  railA.close();

  let message: string | null = null;
  try {
    const railB = await openPasskey(dbB);
    railB.close();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message !== null);
  assert.match(message!, /is bound to store/);
  console.log(`# tm 16: passkey mandate opened on its store; other db refused (${message})`);
});

test("tm 17: denials of any kind are capped at rate_limit.max_calls per agent per window", async () => {
  // per_call_cap 0.000001 USD: every call is denied before the rate limit counts it.
  const h = await build({ per_call_cap: "0.000001", approval_threshold: "0.000001", rate_limit: { max_calls: 5, window_seconds: 3600 } });
  try {
    for (let i = 0; i < 30; i++) {
      const res = await call(h);
      assert.equal(res.status, 402);
    }
    const denied = ofKind(h, "llm.denied");
    assert.equal(denied.length, 5);
    assert.ok(denied.every((e) => (e.payload as { code?: string }).code === "per_call_cap"));
    console.log(`# tm 17: 30 denied calls added ${denied.length} llm.denied entries (cap 5 per window)`);
  } finally {
    await h.close();
  }
});

test("tm 18: a leftover real x-api-key next to the virtual bearer key uses the virtual key and never goes upstream", async () => {
  const h = await build();
  try {
    const leftover = "sk-ant-leftover-REAL-0003";
    const res = await post(
      `http://127.0.0.1:${h.port}`,
      "/v1/messages",
      { "x-api-key": leftover, authorization: `Bearer ${h.key}`, "anthropic-version": "2023-06-01" },
      { model: "claude-haiku-4-5", max_tokens: 20, messages: [{ role: "user", content: "hi" }] },
    );
    assert.equal(res.status, 200);
    const last = h.upstream.requests.at(-1)!;
    assert.equal(last.headers["x-api-key"], REAL);
    assert.ok(!JSON.stringify(h.upstream.requests).includes(leftover));
    assert.ok(!JSON.stringify(h.rail.ledger.entries()).includes(leftover));
    console.log("# tm 18: virtual bearer key used, leftover real key not forwarded or stored");
  } finally {
    await h.close();
  }
});
