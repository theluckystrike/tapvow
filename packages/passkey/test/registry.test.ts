import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { PasskeyRegistry, type PasskeyRegistryOptions } from "../src/registry.js";
import { SoftAuthenticator } from "../src/soft-authenticator.js";
import { challengeFor, type PasskeySignedMandate } from "../src/envelope.js";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const AUDIENCE = "gateway-a";
const ISSUER = EXAMPLE_MANDATE.issuer.id;

function mandate(): Mandate {
  return structuredClone(EXAMPLE_MANDATE);
}

interface Ctx {
  registry: PasskeyRegistry;
  db: DatabaseSync;
  close: () => void;
}

function makeRegistry(t: { after: (fn: () => void) => void }, extra: Partial<PasskeyRegistryOptions> = {}): Ctx {
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
  const close = (): void => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  };
  t.after(close);
  return { registry, db, close };
}

async function register(
  registry: PasskeyRegistry,
  auth: SoftAuthenticator,
  issuerId = ISSUER,
  ctx: Parameters<SoftAuthenticator["createCredential"]>[1] = { origin: ORIGIN },
): Promise<ReturnType<PasskeyRegistry["finishRegistration"]>> {
  const options = await registry.beginRegistration(issuerId, "alice");
  const response = auth.createCredential(options, ctx);
  return registry.finishRegistration(issuerId, response);
}

test("registration round trip stores the credential with the right issuer", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();
  const credential = await register(registry, auth);
  assert.equal(credential.id, auth.credentialId);
  assert.equal(credential.issuerId, ISSUER);
  assert.equal(credential.counter, 0);
  const stored = registry.credentialsFor(ISSUER);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.issuerId, ISSUER);
  assert.equal(stored[0]!.publicKey, auth.credentialPublicKey());
  console.log("# passkey registry registration round trip ok");
});

test("registration rejects wrong origin, rpID, verification and challenges", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();

  await assert.rejects(
    () => register(registry, auth, ISSUER, { origin: "https://evil.example" }),
    /registration response rejected/,
  );
  await assert.rejects(
    () => register(registry, auth, ISSUER, { origin: ORIGIN, rpID: "evil.example" }),
    /registration response rejected/,
  );
  await assert.rejects(
    () => register(registry, auth, ISSUER, { origin: ORIGIN, userVerified: false }),
    /registration response rejected/,
  );

  // Reused challenge.
  const options = await registry.beginRegistration(ISSUER, "alice");
  const response = auth.createCredential(options, { origin: ORIGIN });
  await registry.finishRegistration(ISSUER, response);
  await assert.rejects(
    () => registry.finishRegistration(ISSUER, response),
    /registration challenge unknown, expired or already used/,
  );

  // Challenge issued for another issuer.
  const otherOptions = await registry.beginRegistration("issuer-a", "alice");
  const otherResponse = auth.createCredential(otherOptions, { origin: ORIGIN });
  await assert.rejects(
    () => registry.finishRegistration("issuer-b", otherResponse),
    /registration challenge unknown, expired or already used/,
  );

  console.log("# passkey registry rejects bad registrations ok");
});

test("registration rejects an expired challenge", async (t) => {
  let now = 1_000;
  const { registry } = makeRegistry(t, { now: () => now, challengeTtlMs: 1_000 });
  const auth = new SoftAuthenticator();
  const options = await registry.beginRegistration(ISSUER, "alice");
  const response = auth.createCredential(options, { origin: ORIGIN });
  now = 3_000;
  await assert.rejects(
    () => registry.finishRegistration(ISSUER, response),
    /registration challenge unknown, expired or already used/,
  );
  console.log("# passkey registry rejects an expired registration challenge ok");
});

test("finishEdit succeeds once and advances the stored counter", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();
  await register(registry, auth);
  const m = mandate();
  const { challenge, nonce, audience, expires_at } = await registry.beginEdit({
    issuerId: ISSUER,
    mandate: m,
    prevHash: null,
  });
  assert.equal(challenge, challengeFor({ mandate: m, prev_hash: null, nonce, audience, expires_at }));
  const assertion = auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  const doc: PasskeySignedMandate = {
    format: "passkey-v1",
    mandate: m,
    prev_hash: null,
    nonce,
    audience,
    expires_at,
    assertion,
  };

  const first = await registry.finishEdit(doc);
  if (!first.ok) throw new Error(first.reason);
  assert.equal(first.ok, true);
  assert.equal(first.newCounter, 1);
  assert.equal(registry.credentialsFor(ISSUER)[0]!.counter, 1);

  const second = await registry.finishEdit(doc);
  assert.equal(second.ok, false);

  console.log("# passkey registry finishEdit succeeds once and updates counter ok");
});

test("finishEdit rejects an expired challenge", async (t) => {
  let now = 1_000;
  const { registry } = makeRegistry(t, { now: () => now, challengeTtlMs: 1_000 });
  const auth = new SoftAuthenticator();
  await register(registry, auth);
  const m = mandate();
  const { challenge, nonce, audience, expires_at } = await registry.beginEdit({
    issuerId: ISSUER,
    mandate: m,
    prevHash: null,
  });
  const assertion = auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  now = 3_000;
  const result = await registry.finishEdit({
    format: "passkey-v1",
    mandate: m,
    prev_hash: null,
    nonce,
    audience,
    expires_at,
    assertion,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unknown, expired or already used/);
  console.log("# passkey registry rejects an expired edit challenge ok");
});

test("finishEdit rejects a mandate swapped after beginEdit", async (t) => {
  const { registry } = makeRegistry(t);
  const auth = new SoftAuthenticator();
  await register(registry, auth);
  const m = mandate();
  const { nonce, audience, expires_at } = await registry.beginEdit({
    issuerId: ISSUER,
    mandate: m,
    prevHash: null,
  });
  const swapped = structuredClone(m);
  swapped.budget.total = "6.00";
  const challenge = challengeFor({ mandate: swapped, prev_hash: null, nonce, audience, expires_at });
  const assertion = auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID });
  const result = await registry.finishEdit({
    format: "passkey-v1",
    mandate: swapped,
    prev_hash: null,
    nonce,
    audience,
    expires_at,
    assertion,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unknown, expired or already used/);
  console.log("# passkey registry rejects a swapped mandate ok");
});
