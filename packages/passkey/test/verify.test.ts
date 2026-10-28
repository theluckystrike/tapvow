import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate } from "@mandate/core";
import { SoftAuthenticator } from "../src/soft-authenticator.js";
import { challengeFor, type PasskeySignedMandate } from "../src/envelope.js";
import { verifyPasskeyMandate, type TrustedCredential, type VerifyOptions } from "../src/verify.js";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const OTHER_ORIGIN = "https://evil.example";
const AUDIENCE = "gateway-a";

function mandate(): Mandate {
  return structuredClone(EXAMPLE_MANDATE);
}

function nonce(): string {
  return randomBytes(32).toString("base64url");
}

function expiryIn(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function trusted(auth: SoftAuthenticator, issuerId: string, counter = 0): TrustedCredential {
  return {
    id: auth.credentialId,
    publicKey: auth.credentialPublicKey(),
    counter,
    issuerId,
  };
}

function opts(
  credentials: TrustedCredential[],
  expectedPrevHash: string | null = null,
  extra: Partial<VerifyOptions> = {},
): VerifyOptions {
  return { credentials, rpID: RP_ID, origin: ORIGIN, expectedPrevHash, audience: AUDIENCE, ...extra };
}

function signedDoc(
  auth: SoftAuthenticator,
  m: Mandate,
  o: {
    prevHash?: string | null;
    counters?: number;
    audience?: string;
    expiresAt?: string;
    assertion?: ReturnType<SoftAuthenticator["getAssertion"]>;
  } = {},
): PasskeySignedMandate {
  const prevHash = o.prevHash ?? null;
  const n = nonce();
  const audience = o.audience ?? AUDIENCE;
  const expiresAt = o.expiresAt ?? expiryIn(60_000);
  const challenge = challengeFor({
    mandate: m,
    prev_hash: prevHash,
    nonce: n,
    audience,
    expires_at: expiresAt,
  });
  const assertion =
    o.assertion ??
    auth.getAssertion(challenge, {
      origin: ORIGIN,
      rpID: RP_ID,
      ...(o.counters !== undefined ? { counter: o.counters } : {}),
    });
  return {
    format: "passkey-v1",
    mandate: m,
    prev_hash: prevHash,
    nonce: n,
    audience,
    expires_at: expiresAt,
    assertion,
  };
}

async function rejected(
  doc: unknown,
  options: VerifyOptions,
): Promise<string> {
  const result = await verifyPasskeyMandate(doc, options);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejection");
  return result.reason;
}

test("accepts a correctly signed passkey mandate", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const doc = signedDoc(auth, m);
  const result = await verifyPasskeyMandate(doc, opts([trusted(auth, m.issuer.id)]));
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mandate, m);
  assert.equal(result.newCounter, 1);
  assert.equal(result.credentialId, auth.credentialId);
  console.log("# passkey verify accepts a correctly signed mandate ok");
});

test("accepts a synced (always zero) counter when stored is zero", async () => {
  const auth = new SoftAuthenticator({ counterStep: 0 });
  const m = mandate();
  const doc = signedDoc(auth, m);
  const result = await verifyPasskeyMandate(doc, opts([trusted(auth, m.issuer.id, 0)]));
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.ok, true);
  assert.equal(result.newCounter, 0);
  console.log("# passkey verify accepts counterStep 0 authenticator ok");
});

test("rejects unsigned, malformed and wrongly signed documents", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const cred = trusted(auth, m.issuer.id);
  const good = signedDoc(auth, m);

  const shapeReason = await rejected(m, opts([cred]));
  assert.match(shapeReason, /exactly the keys/);

  const { signer } = generateSigner("key-1");
  const signedReason = await rejected(signMandate(m, signer), opts([cred]));
  assert.match(signedReason, /exactly the keys/);

  const { assertion: _dropped, ...withoutAssertion } = good;
  const missingReason = await rejected(withoutAssertion, opts([cred]));
  assert.match(missingReason, /exactly the keys/);

  // signed by another authenticator's key (wrong signer).
  const other = new SoftAuthenticator();
  const n = nonce();
  const challenge = challengeFor({
    mandate: m,
    prev_hash: null,
    nonce: n,
    audience: AUDIENCE,
    expires_at: good.expires_at,
  });
  const badSignature: PasskeySignedMandate = {
    format: "passkey-v1",
    mandate: m,
    prev_hash: null,
    nonce: n,
    audience: AUDIENCE,
    expires_at: good.expires_at,
    assertion: auth.getAssertion(challenge, { origin: ORIGIN, rpID: RP_ID, signWith: other }),
  };
  const wrongSignerReason = await rejected(badSignature, opts([cred]));
  assert.match(wrongSignerReason, /passkey assertion rejected/);

  // mandate budget changed after signing.
  const tampered = structuredClone(m);
  tampered.budget.total = "6.00";
  const tamperedReason = await rejected({ ...good, mandate: tampered }, opts([cred]));
  assert.match(tamperedReason, /challenge/);

  // changed nonce.
  const nonceReason = await rejected({ ...good, nonce: nonce() }, opts([cred]));
  assert.match(nonceReason, /challenge/);

  // changed prev_hash: expectedPrevHash follows the changed value, so the edit
  // reaches signature verification and fails on the challenge.
  const changedPrev = "a".repeat(64);
  const prevReason = await rejected(
    { ...good, prev_hash: changedPrev },
    opts([cred], changedPrev),
  );
  assert.match(prevReason, /challenge/);

  console.log("# passkey verify rejects unsigned and wrongly signed mandates ok");
});

test("rejects bad origins, rpIDs, flags, types and cross-origin data", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const cred = trusted(auth, m.issuer.id);

  const make = (ctx: Parameters<SoftAuthenticator["getAssertion"]>[1]): PasskeySignedMandate => {
    const n = nonce();
    const expiresAt = expiryIn(60_000);
    const challenge = challengeFor({
      mandate: m,
      prev_hash: null,
      nonce: n,
      audience: AUDIENCE,
      expires_at: expiresAt,
    });
    return {
      format: "passkey-v1",
      mandate: m,
      prev_hash: null,
      nonce: n,
      audience: AUDIENCE,
      expires_at: expiresAt,
      assertion: auth.getAssertion(challenge, ctx),
    };
  };

  const badOrigin = await rejected(make({ origin: OTHER_ORIGIN, rpID: RP_ID }), opts([cred]));
  assert.match(badOrigin, /origin/i);

  const badRp = await rejected(make({ origin: ORIGIN, rpID: "evil.example" }), opts([cred]));
  assert.match(badRp, /rp id|rpID|RP ID|relying party/i);

  const unverified = await rejected(
    make({ origin: ORIGIN, rpID: RP_ID, userVerified: false }),
    opts([cred]),
  );
  assert.match(unverified, /user was not verified|verification/i);

  const noPresence = await rejected(
    make({ origin: ORIGIN, rpID: RP_ID, userPresent: false }),
    opts([cred]),
  );
  assert.match(noPresence, /user not present|not present/i);

  const badType = await rejected(
    make({ origin: ORIGIN, rpID: RP_ID, type: "webauthn.create" }),
    opts([cred]),
  );
  assert.match(badType, /type/i);

  const crossReason = await rejected(
    make({ origin: ORIGIN, rpID: RP_ID, crossOrigin: true }),
    opts([cred]),
  );
  assert.match(crossReason, /cross-origin/);

  const topReason = await rejected(
    make({ origin: ORIGIN, rpID: RP_ID, topOrigin: OTHER_ORIGIN }),
    opts([cred]),
  );
  assert.match(topReason, /cross-origin/);

  console.log("# passkey verify rejects bad origin, rpID, flags and type ok");
});

test("rejects untrusted, foreign and mismatched credentials", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const doc = signedDoc(auth, m);

  const untrustedReason = await rejected(doc, opts([]));
  assert.match(untrustedReason, /credential not trusted/);

  const foreign = trusted(auth, "another-issuer");
  const foreignReason = await rejected(doc, opts([foreign]));
  assert.match(foreignReason, /another issuer/);

  const mismatched: PasskeySignedMandate = {
    ...doc,
    assertion: { ...doc.assertion, rawId: "not-the-same" },
  };
  const mismatchReason = await rejected(mismatched, opts([trusted(auth, m.issuer.id)]));
  assert.match(mismatchReason, /assertion.id must equal assertion.rawId/);

  console.log("# passkey verify rejects untrusted and foreign credentials ok");
});

test("enforces the signature counter against replay and rollback", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const cred = trusted(auth, m.issuer.id, 0);
  const doc = signedDoc(auth, m);
  const first = await verifyPasskeyMandate(doc, opts([cred]));
  if (!first.ok) throw new Error(first.reason);
  assert.equal(first.ok, true);

  // Replay the same assertion once the counter has been raised to its value.
  const replay = await verifyPasskeyMandate(doc, opts([trusted(auth, m.issuer.id, first.newCounter)]));
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.reason, /counter/i);

  // A lower counter.
  const lower = signedDoc(auth, m, { counters: 2 });
  const rollback = await verifyPasskeyMandate(lower, opts([trusted(auth, m.issuer.id, 5)]));
  assert.equal(rollback.ok, false);
  if (!rollback.ok) assert.match(rollback.reason, /counter/i);

  console.log("# passkey verify enforces signature counter ok");
});

test("never throws on garbage input", async () => {
  const auth = new SoftAuthenticator();
  const m = mandate();
  const cred = trusted(auth, m.issuer.id);
  const garbage: unknown[] = [
    null,
    undefined,
    42,
    "a string",
    [],
    {},
    { format: "passkey-v1" },
    {
      format: "passkey-v1",
      mandate: m,
      prev_hash: null,
      nonce: nonce(),
      audience: AUDIENCE,
      expires_at: expiryIn(60_000),
      assertion: null,
    },
    {
      format: "passkey-v1",
      mandate: { nested: { junk: [1, 2, 3] } },
      prev_hash: 1,
      nonce: 2,
      audience: AUDIENCE,
      expires_at: expiryIn(60_000),
      assertion: "x",
    },
  ];
  for (const value of garbage) {
    const reason = await rejected(value, opts([cred]));
    assert.match(reason, /unsigned or malformed/);
  }
  console.log("# passkey verify never throws on garbage input ok");
});
