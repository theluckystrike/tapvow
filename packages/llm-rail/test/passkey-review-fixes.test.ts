// Regression tests for the independent review of the passkey gateway: issuer
// takeover, the silent Ed25519->passkey upgrade, protection kept only in an
// unsigned table, a failed audit that did not roll the register writes back, and
// document freshness. Every rejection asserts the reason, the registered policy,
// both passkey tables and the ledger length. No browser or network is involved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXAMPLE_MANDATE, canonicalize, generateSigner, signMandate, type Mandate } from "@mandate/core";
import {
  PasskeyRegistry,
  mandateHash,
  type PasskeySignedMandate,
  type TrustedCredential,
} from "@mandate/passkey";
import { SoftAuthenticator, type SoftAuthenticatorAssertionContext } from "@mandate/passkey/testing";
import { openGovernedRail, openGovernedRailWithPasskey } from "../src/mandate.js";

const RP_ID = "tapvow.test";
const ORIGIN = "https://tapvow.test";
const AUDIENCE = "gw-test-1";
const gatewayKey = generateSigner("gateway-passkey");

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

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-pk-gw-"));
  dirs.push(d);
  return d;
}

interface Passkey {
  registry: PasskeyRegistry;
  auth: SoftAuthenticator;
  credential: TrustedCredential;
}

async function newPasskey(
  dir: string,
  issuerId: string,
  opts: { audience?: string; now?: () => number } = {},
): Promise<Passkey> {
  const regDb = new DatabaseSync(join(dir, `passkey-${issuerId}.sqlite`));
  dbs.push(regDb);
  const registry = new PasskeyRegistry(regDb, {
    rpID: RP_ID,
    rpName: "TapVow",
    origin: ORIGIN,
    audience: opts.audience ?? AUDIENCE,
    now: opts.now,
  });
  registry.init();
  const auth = new SoftAuthenticator();
  const options = await registry.beginRegistration(issuerId, issuerId);
  const response = auth.createCredential(options, { origin: ORIGIN });
  const credential = await registry.finishRegistration(issuerId, response);
  return { registry, auth, credential };
}

function baseMandate(issuerId: string, publicKey: string): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_pk_review_0001",
    issuer: { id: issuerId, public_key: publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "0.50",
    approval_threshold: "0.50",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-10-18T00:00:00Z",
  };
}

async function signDoc(
  p: Passkey,
  mandate: Mandate,
  prevHash: string | null,
  ctx: Partial<SoftAuthenticatorAssertionContext> = {},
): Promise<PasskeySignedMandate> {
  const { challenge, nonce, audience, expires_at } = await p.registry.beginEdit({
    issuerId: mandate.issuer.id,
    mandate,
    prevHash,
  });
  const assertion = p.auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID, ...ctx });
  return { format: "passkey-v1", mandate, prev_hash: prevHash, nonce, audience, expires_at, assertion };
}

async function finishEdit(p: Passkey, doc: PasskeySignedMandate): Promise<void> {
  const result = await p.registry.finishEdit(doc);
  if (!result.ok) throw new Error(`finishEdit rejected: ${result.reason}`);
}

interface Snapshot {
  policies: string;
  passkeyMandates: string;
  passkeyCounters: string;
  entries: number;
}

/** Every policy row, both passkey tables and the ledger length, read from disk. */
function dbSnapshot(dbPath: string): Snapshot {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = (sql: string): unknown[] => {
      try {
        return db.prepare(sql).all();
      } catch {
        return [];
      }
    };
    let entries = 0;
    try {
      entries = (db.prepare("SELECT COUNT(*) AS c FROM ledger_entries").get() as { c: number }).c;
    } catch {
      entries = 0;
    }
    return {
      policies: canonicalize(rows("SELECT id, policy FROM mandates ORDER BY id")),
      passkeyMandates: canonicalize(
        rows(
          "SELECT mandate_id, mandate_hash, credential_id, assertion_signature, issuer_id FROM passkey_mandates ORDER BY mandate_id",
        ),
      ),
      passkeyCounters: canonicalize(
        rows("SELECT credential_id, counter FROM passkey_counters ORDER BY credential_id"),
      ),
      entries,
    };
  } finally {
    db.close();
  }
}

function openWithPasskey(
  dbPath: string,
  doc: unknown,
  credentials: TrustedCredential[],
  opts: { audience?: string; now?: () => number } = {},
): Promise<import("../src/mandate.js").GovernedRail> {
  return openGovernedRailWithPasskey({
    dbPath,
    signedMandate: doc,
    passkey: { credentials, rpID: RP_ID, origin: ORIGIN, audience: opts.audience ?? AUDIENCE },
    ledgerSigner: gatewayKey.signer,
    now: opts.now,
  });
}

async function expectRejected(
  n: number,
  label: string,
  dbPath: string,
  doc: unknown,
  credentials: TrustedCredential[],
  before: Snapshot,
  reason: RegExp,
  opts: { audience?: string; now?: () => number } = {},
): Promise<void> {
  let message: string | null = null;
  try {
    const rail = await openWithPasskey(dbPath, doc, credentials, opts);
    rail.close();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message !== null, `${label}: expected a rejection`);
  assert.match(message!, reason, `${label}: rejection reason did not match ${reason}`);
  assert.deepEqual(dbSnapshot(dbPath), before, `${label}: policy, passkey tables or ledger changed`);
  console.log(`# step6 review ${n}: ${message}`);
}

test("review 1: another issuer cannot take over a passkey mandate", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const issuerA = generateSigner("issuer-a");
  const issuerB = generateSigner("issuer-b");
  const pa = await newPasskey(dir, "issuer-a");
  const pb = await newPasskey(dir, "issuer-b");
  const credentials = [pa.credential, pb.credential];

  const v1 = baseMandate("issuer-a", issuerA.publicKey);
  const doc1 = await signDoc(pa, v1, null);
  await finishEdit(pa, doc1);
  const rail = await openWithPasskey(dbPath, doc1, credentials);
  assert.equal(rail.ledger.entries()[0]!.kind, "mandate.registered");
  rail.close();

  const before = dbSnapshot(dbPath);
  const v2: Mandate = {
    ...v1,
    issuer: { id: "issuer-b", public_key: issuerB.publicKey },
    budget: { total: "999.00", period: "lifetime" },
    created_at: "2026-10-19T00:00:00Z",
  };
  const doc2 = await signDoc(pb, v2, mandateHash(v1));
  await finishEdit(pb, doc2);
  await expectRejected(1, "takeover-passkey", dbPath, doc2, credentials, before, /belongs to another issuer/);
});

test("review 1: an Ed25519-registered mandate cannot be taken over by a passkey issuer", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const issuerA = generateSigner("issuer-a");
  const issuerB = generateSigner("issuer-b");
  const pb = await newPasskey(dir, "issuer-b");

  const v1 = baseMandate("issuer-a", issuerA.publicKey);
  const rail = openGovernedRail({
    dbPath,
    signedMandate: signMandate(v1, issuerA.signer),
    trustedIssuerKey: issuerA.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  rail.close();

  const before = dbSnapshot(dbPath);
  const v2: Mandate = {
    ...v1,
    issuer: { id: "issuer-b", public_key: issuerB.publicKey },
    budget: { total: "999.00", period: "lifetime" },
    created_at: "2026-10-19T00:00:00Z",
  };
  const doc2 = await signDoc(pb, v2, null);
  await finishEdit(pb, doc2);
  await expectRejected(1, "takeover-ed25519", dbPath, doc2, [pb.credential], before, /belongs to another issuer/);
});

test("review 2: an unchanged Ed25519 mandate upgraded to a passkey writes mandate.protected", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const owner = generateSigner("owner-passkey");
  const p = await newPasskey(dir, "owner-passkey");

  const v1 = baseMandate("owner-passkey", owner.publicKey);
  const rail1 = openGovernedRail({
    dbPath,
    signedMandate: signMandate(v1, owner.signer),
    trustedIssuerKey: owner.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  assert.deepEqual(rail1.ledger.entries().map((e) => e.kind), ["mandate.registered"]);
  rail1.close();

  // The same content, now signed with a passkey: the protection must be written
  // even though the policy does not change.
  const doc = await signDoc(p, v1, null);
  await finishEdit(p, doc);
  const rail2 = await openWithPasskey(dbPath, doc, [p.credential]);
  const kinds = rail2.ledger.entries().map((e) => e.kind);
  assert.deepEqual(kinds, ["mandate.registered", "mandate.protected"]);
  assert.equal((rail2.ledger.entries()[1]!.payload as { auth?: string }).auth, "passkey");
  rail2.close();

  // Once protected, a valid Ed25519 edit is refused.
  const before = dbSnapshot(dbPath);
  const v2: Mandate = { ...v1, budget: { total: "9.00", period: "lifetime" }, created_at: "2026-10-19T00:00:00Z" };
  let message: string | null = null;
  try {
    const rail = openGovernedRail({
      dbPath,
      signedMandate: signMandate(v2, owner.signer),
      trustedIssuerKey: owner.publicKey,
      ledgerSigner: gatewayKey.signer,
    });
    rail.close();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message !== null, "expected the Ed25519 edit to be rejected");
  assert.match(message!, /protected by a passkey/);
  assert.deepEqual(dbSnapshot(dbPath), before, "policy, passkey tables or ledger changed");
  console.log(`# step6 review 2: mandate.protected written; later Ed25519 edit rejected: ${message}`);
});

test("review 3: protection survives deleting the passkey table row", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const owner = generateSigner("owner-passkey");
  const p = await newPasskey(dir, "owner-passkey");

  const v1 = baseMandate("owner-passkey", owner.publicKey);
  const doc1 = await signDoc(p, v1, null);
  await finishEdit(p, doc1);
  const rail = await openWithPasskey(dbPath, doc1, [p.credential]);
  rail.close();

  const raw = new DatabaseSync(dbPath);
  raw.exec("DELETE FROM passkey_mandates");
  raw.close();

  const before = dbSnapshot(dbPath);

  // The row is gone, but the signed ledger still says the mandate is protected.
  let edMessage: string | null = null;
  try {
    const rail2 = openGovernedRail({
      dbPath,
      signedMandate: signMandate(v1, owner.signer),
      trustedIssuerKey: owner.publicKey,
      ledgerSigner: gatewayKey.signer,
    });
    rail2.close();
  } catch (err) {
    edMessage = err instanceof Error ? err.message : String(err);
  }
  assert.ok(edMessage !== null, "expected the Ed25519 open to be rejected");
  assert.match(edMessage!, /protected by a passkey/);
  assert.deepEqual(dbSnapshot(dbPath), before, "policy, passkey tables or ledger changed");

  // Reopening with the passkey document cannot silently re-create the row either.
  let pkMessage: string | null = null;
  try {
    const rail3 = await openWithPasskey(dbPath, doc1, [p.credential]);
    rail3.close();
  } catch (err) {
    pkMessage = err instanceof Error ? err.message : String(err);
  }
  assert.ok(pkMessage !== null, "expected the passkey reopen to be rejected");
  assert.match(pkMessage!, /counter/, "passkey reopen reason did not match /counter/");
  assert.deepEqual(dbSnapshot(dbPath), before, "policy, passkey tables or ledger changed");
  console.log(`# step6 review 3: Ed25519 open rejected (${edMessage}); passkey reopen rejected (${pkMessage})`);
});

test("review 9: a failed audit rolls the register writes back", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const owner = generateSigner("owner-passkey");
  const p = await newPasskey(dir, "owner-passkey");

  const v1 = baseMandate("owner-passkey", owner.publicKey);
  const doc1 = await signDoc(p, v1, null);
  await finishEdit(p, doc1);
  const rail = await openWithPasskey(dbPath, doc1, [p.credential]);
  assert.match(rail.issueAgentKey("agent-01"), /^mk_/);
  const res = rail.store.reserve({ mandateId: v1.id, agentId: "agent-01", model: "gpt-4o", provider: "openai", amountMicros: 1000 });
  if (!res.ok) throw new Error(`reserve failed: ${res.reason}`);
  rail.store.settle(res.reservationId, null, 1000);
  rail.close();

  const raw = new DatabaseSync(dbPath);
  raw.exec("UPDATE reservations SET charged_micros = 0 WHERE status <> 'reserved'");
  raw.close();

  const before = dbSnapshot(dbPath);
  const v2: Mandate = { ...v1, budget: { total: "9.00", period: "lifetime" }, created_at: "2026-10-19T00:00:00Z" };
  const doc2 = await signDoc(p, v2, mandateHash(v1));
  await finishEdit(p, doc2);

  let message: string | null = null;
  try {
    const rail2 = await openWithPasskey(dbPath, doc2, [p.credential]);
    rail2.close();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message !== null, "expected the audit to fail");
  assert.match(message!, /rail audit failed/);
  assert.deepEqual(dbSnapshot(dbPath), before, "the passkey edit was not rolled back");
  console.log(`# step6 review 9: ${message}`);
});

test("review 6: an expired edit document is rejected", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const clock = Date.parse("2026-01-01T00:00:00Z");
  const p = await newPasskey(dir, "owner-passkey", { now: () => clock });
  const owner = generateSigner("owner-passkey");
  const v1 = baseMandate("owner-passkey", owner.publicKey);
  const doc = await signDoc(p, v1, null);
  await finishEdit(p, doc);

  const before = dbSnapshot(dbPath);
  await expectRejected(6, "expired-document", dbPath, doc, [p.credential], before, /expired/, {
    now: () => clock + 400_000,
  });
});

test("review 7: a document for another audience is rejected", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const p = await newPasskey(dir, "owner-passkey", { audience: "gw-other" });
  const owner = generateSigner("owner-passkey");
  const v1 = baseMandate("owner-passkey", owner.publicKey);
  const doc = await signDoc(p, v1, null);
  await finishEdit(p, doc);

  const before = dbSnapshot(dbPath);
  await expectRejected(7, "wrong-audience", dbPath, doc, [p.credential], before, /audience/);
});

test("review 8: the restart path opens after the document expires_at has passed", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const clock = Date.parse("2026-01-01T00:00:00Z");
  const p = await newPasskey(dir, "owner-passkey", { now: () => clock });
  const owner = generateSigner("owner-passkey");
  const v1 = baseMandate("owner-passkey", owner.publicKey);
  const doc = await signDoc(p, v1, null);
  await finishEdit(p, doc);

  const rail1 = await openWithPasskey(dbPath, doc, [p.credential], { now: () => clock });
  const count = rail1.ledger.entries().length;
  rail1.close();

  const rail2 = await openWithPasskey(dbPath, doc, [p.credential], { now: () => clock + 400_000 });
  const entries = rail2.ledger.entries();
  assert.equal(entries.length, count, "the restart wrote a new ledger entry");
  assert.equal(rail2.store.getPolicy(v1.id)?.budgetMicros, 5_000_000);
  rail2.close();
  console.log(`# step6 review 8: restart after expires_at opened with no new entry (${entries.length} entries)`);
});
