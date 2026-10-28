import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import {
  PasskeyRegistry,
  type PasskeyRegistryOptions,
  type PasskeySignedApproval,
} from "../src/registry.js";
import { SoftAuthenticator } from "../src/soft-authenticator.js";
import { challengeFor, type PasskeySignedMandate } from "../src/envelope.js";
import { verifyPasskeyMandate, type TrustedCredential, type VerifyOptions } from "../src/verify.js";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const AUDIENCE = "gateway-a";
const ISSUER = EXAMPLE_MANDATE.issuer.id;

function mandate(): Mandate {
  return structuredClone(EXAMPLE_MANDATE);
}

function nonce(): string {
  return randomBytes(32).toString("base64url");
}

function wholeUtc(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function expiryFrom(offsetMs: number): string {
  return wholeUtc(Date.now() + offsetMs);
}

function trusted(auth: SoftAuthenticator, issuerId: string, counter = 0): TrustedCredential {
  return { id: auth.credentialId, publicKey: auth.credentialPublicKey(), counter, issuerId };
}

function verifyOpts(
  credentials: TrustedCredential[],
  extra: Partial<VerifyOptions> = {},
): VerifyOptions {
  return { credentials, rpID: RP_ID, origin: ORIGIN, expectedPrevHash: null, audience: AUDIENCE, ...extra };
}

function signedDoc(
  auth: SoftAuthenticator,
  m: Mandate,
  o: { audience?: string; expiresAt?: string } = {},
): PasskeySignedMandate {
  const n = nonce();
  const audience = o.audience ?? AUDIENCE;
  const expiresAt = o.expiresAt ?? expiryFrom(60_000);
  const challenge = challengeFor({
    mandate: m,
    prev_hash: null,
    nonce: n,
    audience,
    expires_at: expiresAt,
  });
  return {
    format: "passkey-v1",
    mandate: m,
    prev_hash: null,
    nonce: n,
    audience,
    expires_at: expiresAt,
    assertion: auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID }),
  };
}

interface Ctx {
  registry: PasskeyRegistry;
  db: DatabaseSync;
}

function makeRegistry(
  t: { after: (fn: () => void) => void },
  extra: Partial<PasskeyRegistryOptions> = {},
): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "mandate-passkey-"));
  const db = new DatabaseSync(join(dir, "passkey.sqlite"));
  const registry = new PasskeyRegistry(db, {
    rpID: RP_ID,
    rpName: "TapVow",
    origin: ORIGIN,
    audience: AUDIENCE,
    ...extra,
  });
  registry.init();
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { registry, db };
}

async function registerPrimary(
  registry: PasskeyRegistry,
  auth: SoftAuthenticator,
  issuerId = ISSUER,
): Promise<void> {
  const options = await registry.beginRegistration(issuerId, "alice");
  const response = auth.createCredential(options, { origin: ORIGIN });
  await registry.finishRegistration(issuerId, response);
}

// ---------------------------------------------------------------------------
// F4: freshness and audience.
// ---------------------------------------------------------------------------

test("F4 rejects an expired document", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const doc = signedDoc(auth, m, { expiresAt: expiryFrom(-60_000) });
  const result = await verifyPasskeyMandate(doc, verifyOpts([trusted(auth, m.issuer.id)]));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.match(result.reason, /^passkey mandate document expired$/);
  console.log(`# passkey review 1: ${result.reason}`);
});

test("F4 rejects a document with a far future expires_at", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const doc = signedDoc(auth, m, { expiresAt: expiryFrom(24 * 60 * 60 * 1000) });
  const result = await verifyPasskeyMandate(doc, verifyOpts([trusted(auth, m.issuer.id)]));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.match(result.reason, /^passkey mandate document validity window too long$/);
  console.log(`# passkey review 2: ${result.reason}`);
});

test("F4 rejects a document for another audience", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const doc = signedDoc(auth, m, { audience: "gateway-b" });
  const result = await verifyPasskeyMandate(doc, verifyOpts([trusted(auth, m.issuer.id)]));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.match(result.reason, /^audience does not match this gateway$/);
  console.log(`# passkey review 3: ${result.reason}`);
});

test("F4 changing audience or expires_at after signing is a challenge mismatch", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const cred = trusted(auth, m.issuer.id);

  const base = signedDoc(auth, m, { audience: "gateway-a", expiresAt: expiryFrom(600_000) });

  const audienceChanged = await verifyPasskeyMandate(
    { ...base, audience: "gateway-b" },
    verifyOpts([cred], { audience: "gateway-b" }),
  );
  assert.equal(audienceChanged.ok, false);
  if (audienceChanged.ok) throw new Error("expected rejection");
  assert.match(audienceChanged.reason, /challenge/);

  const expiryChanged = await verifyPasskeyMandate(
    { ...base, expires_at: expiryFrom(660_000) },
    verifyOpts([cred]),
  );
  assert.equal(expiryChanged.ok, false);
  if (expiryChanged.ok) throw new Error("expected rejection");
  assert.match(expiryChanged.reason, /challenge/);

  console.log(`# passkey review 4: ${audienceChanged.reason}`);
});

// ---------------------------------------------------------------------------
// F6: anyone can add a passkey for an issuer.
// ---------------------------------------------------------------------------

test("F6 a second registration without approval is refused", async (t) => {
  const { registry } = makeRegistry(t);
  await registerPrimary(registry, new SoftAuthenticator());
  await assert.rejects(
    () => registry.beginRegistration(ISSUER, "alice"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /^adding a passkey to issuer .+ needs an assertion from an existing passkey$/,
      );
      console.log(`# passkey review 5: ${err.message}`);
      return true;
    },
  );
});

test("F6 an approval signed by another issuer's authenticator is refused", async (t) => {
  const { registry } = makeRegistry(t);
  await registerPrimary(registry, new SoftAuthenticator(), ISSUER);
  const otherIssuerAuth = new SoftAuthenticator();
  await registerPrimary(registry, otherIssuerAuth, "issuer-b");

  const { challenge } = await registry.beginCredentialApproval(ISSUER);
  const assertion = otherIssuerAuth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  const approval: PasskeySignedApproval = { challenge, assertion };
  await assert.rejects(
    () => registry.beginRegistration(ISSUER, "alice", approval),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /^adding a passkey to issuer .+ needs an assertion from an existing passkey$/,
      );
      console.log(`# passkey review 6: ${err.message}`);
      return true;
    },
  );
});

test("F6 a reused approval is refused", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();
  await registerPrimary(registry, auth);

  const { challenge } = await registry.beginCredentialApproval(ISSUER);
  const assertion = auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  const approval: PasskeySignedApproval = { challenge, assertion };
  await registry.beginRegistration(ISSUER, "alice", approval);

  await assert.rejects(
    () => registry.beginRegistration(ISSUER, "alice", approval),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /^adding a passkey to issuer .+ needs an assertion from an existing passkey$/,
      );
      console.log(`# passkey review 7: ${err.message}`);
      return true;
    },
  );
});

test("F6 a valid approval lets a second credential be registered", async (t) => {
  const { registry } = makeRegistry(t);
  const first = new SoftAuthenticator();
  await registerPrimary(registry, first);

  const { challenge } = await registry.beginCredentialApproval(ISSUER);
  const assertion = first.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  const options = await registry.beginRegistration(ISSUER, "alice", { challenge, assertion });

  const second = new SoftAuthenticator();
  const response = second.createCredential(options, { origin: ORIGIN });
  const credential = await registry.finishRegistration(ISSUER, response);
  assert.equal(credential.id, second.credentialId);

  const stored = registry.credentialsFor(ISSUER);
  assert.equal(stored.length, 2);
  console.log(`# passkey review 8: issuer now has ${stored.length} credentials`);
});

// ---------------------------------------------------------------------------
// F7: registration is looser than the options.
// ---------------------------------------------------------------------------

test("F7 cross-origin registrations are refused", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();

  const crossOptions = await registry.beginRegistration(ISSUER, "alice");
  const crossResponse = auth.createCredential(crossOptions, { origin: ORIGIN, crossOrigin: true });
  await assert.rejects(
    () => registry.finishRegistration(ISSUER, crossResponse),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /cross-origin registration refused/);
      console.log(`# passkey review 9: ${err.message}`);
      return true;
    },
  );

  const topOptions = await registry.beginRegistration(ISSUER, "alice");
  const topResponse = auth.createCredential(topOptions, {
    origin: ORIGIN,
    topOrigin: "https://evil.example",
  });
  await assert.rejects(
    () => registry.finishRegistration(ISSUER, topResponse),
    /cross-origin registration refused/,
  );
});

test("F7 an unsupported COSE algorithm is refused", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();
  const options = await registry.beginRegistration(ISSUER, "alice");
  const response = auth.createCredential(options, { origin: ORIGIN, coseAlg: -8 });
  await assert.rejects(
    () => registry.finishRegistration(ISSUER, response),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Unexpected public key alg/);
      console.log(`# passkey review 10: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// F8: finishEdit takes the issuer from the document.
// ---------------------------------------------------------------------------

test("F8 an edit challenge for mandate A cannot be finished with mandate B", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();
  await registerPrimary(registry, auth);

  const mandateA = mandate();
  const { nonce: n, audience, expires_at } = await registry.beginEdit({
    issuerId: ISSUER,
    mandate: mandateA,
    prevHash: null,
  });

  const mandateB = structuredClone(mandateA);
  mandateB.id = "mdt_bbbbbbbbbbbb";
  const challenge = challengeFor({
    mandate: mandateB,
    prev_hash: null,
    nonce: n,
    audience,
    expires_at,
  });
  const assertion = auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  const result = await registry.finishEdit({
    format: "passkey-v1",
    mandate: mandateB,
    prev_hash: null,
    nonce: n,
    audience,
    expires_at,
    assertion,
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  assert.match(result.reason, /^edit challenge unknown, expired or already used$/);
  console.log(`# passkey review 11: ${result.reason}`);
});
