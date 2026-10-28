// Step 6 done test: a passkey-signed mandate opens the gateway, an unsigned or
// wrongly signed one is refused, and a change without a valid passkey assertion
// fails. Registration and signing go through @mandate/passkey's PasskeyRegistry
// and its software authenticator, so no browser or network is involved.
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
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { closeServer, listen, post, shape } from "./helpers.js";

const RP_ID = "tapvow.test";
const ORIGIN = "https://tapvow.test";
const AUDIENCE = "gw-test-1";
const ISSUER_ID = "owner-passkey";
const owner = generateSigner("owner-passkey");
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

function baseMandate(): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_passkey_gw_0001",
    issuer: { id: ISSUER_ID, public_key: owner.publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "0.50",
    approval_threshold: "0.50",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-10-18T00:00:00Z",
  };
}

interface Fixture {
  registry: PasskeyRegistry;
  auth: SoftAuthenticator;
  credential: TrustedCredential;
}

async function setup(dir: string): Promise<Fixture> {
  const regDb = new DatabaseSync(join(dir, "passkey.sqlite"));
  dbs.push(regDb);
  const registry = new PasskeyRegistry(regDb, { rpID: RP_ID, rpName: "TapVow", origin: ORIGIN, audience: AUDIENCE });
  registry.init();
  const auth = new SoftAuthenticator();
  const options = await registry.beginRegistration(ISSUER_ID, "alice");
  const response = auth.createCredential(options, { origin: ORIGIN });
  const credential = await registry.finishRegistration(ISSUER_ID, response);
  return { registry, auth, credential };
}

async function signDoc(
  fixture: Fixture,
  mandate: Mandate,
  prevHash: string | null,
  ctx: Partial<SoftAuthenticatorAssertionContext> = {},
): Promise<PasskeySignedMandate> {
  const { challenge, nonce, audience, expires_at } = await fixture.registry.beginEdit({
    issuerId: mandate.issuer.id,
    mandate,
    prevHash,
  });
  const assertion = fixture.auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID, ...ctx });
  return { format: "passkey-v1", mandate, prev_hash: prevHash, nonce, audience, expires_at, assertion };
}

async function finishEdit(fixture: Fixture, doc: PasskeySignedMandate): Promise<void> {
  const result = await fixture.registry.finishEdit(doc);
  if (!result.ok) throw new Error(`finishEdit rejected: ${result.reason}`);
}

function openWithPasskey(dbPath: string, doc: unknown, credentials: TrustedCredential[]): Promise<import("../src/mandate.js").GovernedRail> {
  return openGovernedRailWithPasskey({
    dbPath,
    signedMandate: doc,
    passkey: { credentials, rpID: RP_ID, origin: ORIGIN, audience: AUDIENCE },
    ledgerSigner: gatewayKey.signer,
  });
}

interface Snapshot {
  policies: string;
  passkeyMandates: string;
  passkeyCounters: string;
  entries: number;
}

/** All policy rows, both passkey tables and the ledger length, read from the file. */
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
        rows("SELECT mandate_id, mandate_hash, credential_id, assertion_signature, issuer_id FROM passkey_mandates ORDER BY mandate_id"),
      ),
      passkeyCounters: canonicalize(rows("SELECT credential_id, counter FROM passkey_counters ORDER BY credential_id")),
      entries,
    };
  } finally {
    db.close();
  }
}

async function expectOpenRejected(
  label: string,
  dbPath: string,
  doc: unknown,
  credentials: TrustedCredential[],
  before: Snapshot,
  reason: RegExp,
): Promise<void> {
  let message: string | null = null;
  try {
    const rail = await openWithPasskey(dbPath, doc, credentials);
    rail.close();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message !== null, `${label}: expected a rejection`);
  assert.match(message!, /mandate rejected/, `${label}: expected a mandate rejection`);
  assert.match(message!, reason, `${label}: rejection reason did not match ${reason}`);
  assert.deepEqual(dbSnapshot(dbPath), before, `${label}: policy, passkey tables or ledger changed`);
  console.log(`# step6 ${label}: ${message}`);
}

test("step6 passkey-open: a passkey-signed mandate opens the gateway and settles one completion", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const fixture = await setup(dir);

  // The registry issues the credential and signs the first version of the mandate.
  const v1 = baseMandate();
  const doc = await signDoc(fixture, v1, null);
  await finishEdit(fixture, doc);

  const rail = await openWithPasskey(dbPath, doc, [fixture.credential]);
  const entries = rail.ledger.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "mandate.registered");
  assert.equal((entries[0]!.payload as { auth?: string }).auth, "passkey");
  assert.deepEqual(rail.ledger.verify({ [gatewayKey.signer.keyId]: gatewayKey.publicKey }), { ok: true, checked: 1 });

  // An agent key issued against the passkey policy reaches a (fake) upstream.
  const key = rail.issueAgentKey("agent-01");
  const up = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 7 });
  const gw = createGateway({
    store: rail.store,
    upstreams: {
      openai: { baseUrl: up.url, apiKey: "sk-test-passkey" },
      anthropic: { baseUrl: up.url, apiKey: "sk-test-passkey" },
    },
  });
  const port = await listen(gw);
  try {
    const s = shape(0);
    const r = await post(`http://127.0.0.1:${port}`, s.path, s.headers(key), s.body);
    assert.equal(r.status, 200);
    assert.equal(up.billed.length, 1);
    assert.ok(Number(r.headers["x-mandate-charged-micros"]) > 0);
  } finally {
    await closeServer(gw);
    await up.close();
  }
  assert.equal(rail.store.spent(v1.id).reservedMicros, 0);
  rail.close();
  console.log("# step6 passkey-open: opened, mandate.registered auth=passkey, one completion settled");
});

test("step6 unsigned: bare, Ed25519 and assertion-less documents are rejected", async () => {
  const dir = tmpDir();
  const fixture = await setup(dir);

  {
    const dbPath = join(dir, "bare.db");
    const before = dbSnapshot(dbPath);
    await expectOpenRejected("unsigned-bare-mandate", dbPath, baseMandate(), [fixture.credential], before, /unsigned or malformed/);
  }
  {
    const dbPath = join(dir, "ed25519.db");
    const before = dbSnapshot(dbPath);
    await expectOpenRejected("unsigned-ed25519-document", dbPath, signMandate(baseMandate(), owner.signer), [fixture.credential], before, /unsigned or malformed/);
  }
  {
    const dbPath = join(dir, "noassertion.db");
    const before = dbSnapshot(dbPath);
    const doc = await signDoc(fixture, baseMandate(), null);
    const stripped = { format: doc.format, mandate: doc.mandate, prev_hash: doc.prev_hash, nonce: doc.nonce };
    await expectOpenRejected("unsigned-missing-assertion", dbPath, stripped, [fixture.credential], before, /unsigned or malformed/);
  }
});

test("step6 wrongly signed: another key, tampered, wrong origin/rpID and unverified are rejected", async () => {
  const dir = tmpDir();
  const fixture = await setup(dir);
  const other = new SoftAuthenticator();

  {
    const dbPath = join(dir, "wrongkey.db");
    const before = dbSnapshot(dbPath);
    const doc = await signDoc(fixture, baseMandate(), null, { signWith: other });
    await expectOpenRejected("wrong-key", dbPath, doc, [fixture.credential], before, /passkey assertion rejected|not verified/);
  }
  {
    const dbPath = join(dir, "tampered.db");
    const before = dbSnapshot(dbPath);
    const doc = await signDoc(fixture, baseMandate(), null);
    const tampered = { ...doc, mandate: { ...doc.mandate, budget: { total: "500.00", period: "lifetime" } } };
    await expectOpenRejected("tampered-budget", dbPath, tampered, [fixture.credential], before, /passkey assertion rejected|not verified/);
  }
  {
    const dbPath = join(dir, "origin.db");
    const before = dbSnapshot(dbPath);
    const doc = await signDoc(fixture, baseMandate(), null, { origin: "https://evil.example" });
    await expectOpenRejected("wrong-origin", dbPath, doc, [fixture.credential], before, /passkey assertion rejected|not verified/);
  }
  {
    const dbPath = join(dir, "rpid.db");
    const before = dbSnapshot(dbPath);
    const doc = await signDoc(fixture, baseMandate(), null, { rpID: "evil.example" });
    await expectOpenRejected("wrong-rpid", dbPath, doc, [fixture.credential], before, /passkey assertion rejected|not verified/);
  }
  {
    const dbPath = join(dir, "unverified.db");
    const before = dbSnapshot(dbPath);
    const doc = await signDoc(fixture, baseMandate(), null, { userVerified: false });
    await expectOpenRejected("not-user-verified", dbPath, doc, [fixture.credential], before, /passkey assertion rejected|not verified|user was not verified/);
  }
});

test("step6 edit-valid: a passkey-signed edit updates the policy", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const fixture = await setup(dir);

  const v1 = baseMandate();
  const doc1 = await signDoc(fixture, v1, null);
  await finishEdit(fixture, doc1);
  const rail1 = await openWithPasskey(dbPath, doc1, [fixture.credential]);
  assert.equal(rail1.store.getPolicy(v1.id)?.budgetMicros, 5_000_000);
  rail1.close();

  const v2: Mandate = { ...v1, budget: { total: "9.00", period: "lifetime" }, created_at: "2026-10-19T00:00:00Z" };
  const doc2 = await signDoc(fixture, v2, mandateHash(v1));
  await finishEdit(fixture, doc2);
  const rail2 = await openWithPasskey(dbPath, doc2, [fixture.credential]);
  assert.equal(rail2.store.getPolicy(v2.id)?.budgetMicros, 9_000_000);
  assert.deepEqual(rail2.ledger.entries().map((e) => e.kind), ["mandate.registered", "mandate.updated"]);
  rail2.close();
  console.log("# step6 edit-valid: mandate.updated written, budget now 9.00 USD");
});

test("step6 edit-invalid: changes without a valid passkey assertion are rejected", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const fixture = await setup(dir);

  const v1 = baseMandate();
  const doc1 = await signDoc(fixture, v1, null);
  await finishEdit(fixture, doc1);
  const rail1 = await openWithPasskey(dbPath, doc1, [fixture.credential]);
  rail1.close();

  // A valid Ed25519 owner signature is still refused: the mandate is passkey-protected.
  {
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
    assert.ok(message !== null, "edit-ed25519-protected: expected a rejection");
    assert.match(message!, /protected by a passkey/);
    assert.deepEqual(dbSnapshot(dbPath), before, "edit-ed25519-protected: policy or ledger changed");
    console.log(`# step6 edit-ed25519-protected: ${message}`);
  }

  const other = new SoftAuthenticator();
  {
    const before = dbSnapshot(dbPath);
    const v2: Mandate = { ...v1, budget: { total: "6.00", period: "lifetime" }, created_at: "2026-10-19T00:00:00Z" };
    const doc = await signDoc(fixture, v2, mandateHash(v1), { signWith: other });
    await expectOpenRejected("edit-other-key", dbPath, doc, [fixture.credential], before, /passkey assertion rejected|not verified/);
  }
  {
    const before = dbSnapshot(dbPath);
    const v2: Mandate = { ...v1, budget: { total: "6.00", period: "lifetime" }, created_at: "2026-10-19T00:00:00Z" };
    const doc = await signDoc(fixture, v2, null);
    await expectOpenRejected("edit-prev-hash-null", dbPath, doc, [fixture.credential], before, /prev_hash/);
  }

  const v2: Mandate = { ...v1, budget: { total: "6.00", period: "lifetime" }, created_at: "2026-10-19T00:00:00Z" };
  const doc2 = await signDoc(fixture, v2, mandateHash(v1));
  await finishEdit(fixture, doc2);
  const rail2 = await openWithPasskey(dbPath, doc2, [fixture.credential]);
  rail2.close();

  {
    // Replaying the version 1 document after version 2 is registered.
    const before = dbSnapshot(dbPath);
    await expectOpenRejected("edit-replay-v1", dbPath, doc1, [fixture.credential], before, /prev_hash/);
  }
  {
    // A fresh edit with the right prev_hash but a counter that has already been used.
    const before = dbSnapshot(dbPath);
    const v3: Mandate = { ...v2, budget: { total: "7.00", period: "lifetime" }, created_at: "2026-10-20T00:00:00Z" };
    const doc3 = await signDoc(fixture, v3, mandateHash(v2), { counter: 1 });
    await expectOpenRejected("edit-low-counter", dbPath, doc3, [fixture.credential], before, /counter/);
  }
});

test("step6 restart: reopening with the current document writes no new entry", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "rail.db");
  const fixture = await setup(dir);

  const v1 = baseMandate();
  const doc = await signDoc(fixture, v1, null);
  await finishEdit(fixture, doc);

  const rail1 = await openWithPasskey(dbPath, doc, [fixture.credential]);
  const count = rail1.ledger.entries().length;
  rail1.close();

  const rail2 = await openWithPasskey(dbPath, doc, [fixture.credential]);
  const entries = rail2.ledger.entries();
  assert.equal(entries.length, count);
  assert.equal(rail2.store.getPolicy(v1.id)?.budgetMicros, 5_000_000);
  rail2.close();
  console.log(`# step6 restart: reopened with the current document, no new ledger entry (${entries.length} entries)`);
});
