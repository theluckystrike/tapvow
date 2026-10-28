import test from "node:test";
import assert from "node:assert/strict";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { SoftAuthenticator } from "../src/soft-authenticator.js";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";

test("registration round trip verifies and exposes the COSE key", async () => {
  const auth = new SoftAuthenticator();
  const options = await generateRegistrationOptions({
    rpName: "TapVow",
    rpID: RP_ID,
    userName: "alice",
    userID: new TextEncoder().encode("issuer-a"),
  });
  const response = auth.createCredential(options, { origin: ORIGIN });
  assert.equal(response.id, auth.credentialId);
  assert.equal(response.rawId, auth.credentialId);

  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  assert.equal(result.verified, true);
  if (!result.verified) throw new Error("registration was not verified");
  assert.equal(result.registrationInfo.credential.id, auth.credentialId);
  assert.equal(result.registrationInfo.userVerified, true);

  const cose = isoCBOR.decodeFirst<Map<number, unknown>>(
    new Uint8Array(Buffer.from(auth.credentialPublicKey(), "base64url")),
  );
  assert.equal(cose.get(1), 2);
  assert.equal(cose.get(3), -7);
  assert.equal(cose.get(-1), 1);
  assert.equal((cose.get(-2) as Uint8Array).length, 32);
  assert.equal((cose.get(-3) as Uint8Array).length, 32);

  console.log("# passkey soft authenticator registration round trip ok");
});

test("assertion round trip verifies and advances the counter", async () => {
  const auth = new SoftAuthenticator();
  const options = await generateRegistrationOptions({
    rpName: "TapVow",
    rpID: RP_ID,
    userName: "alice",
    userID: new TextEncoder().encode("issuer-a"),
  });
  const registration = auth.createCredential(options, { origin: ORIGIN });
  const registered = await verifyRegistrationResponse({
    response: registration,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  assert.equal(registered.verified, true);
  if (!registered.verified) throw new Error("registration was not verified");

  const request = await generateAuthenticationOptions({ rpID: RP_ID });
  const assertion = auth.getAssertion(request.challenge, { origin: ORIGIN, rpID: RP_ID });
  const verified = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge: request.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: auth.credentialId,
      publicKey: registered.registrationInfo.credential.publicKey,
      counter: registered.registrationInfo.credential.counter,
    },
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.authenticationInfo.newCounter, 1);
  assert.equal(verified.authenticationInfo.userVerified, true);

  const synced = new SoftAuthenticator({ counterStep: 0 });
  assert.equal(synced.getAssertion("x", { origin: ORIGIN, rpID: RP_ID }).response.signature.length > 0, true);
  const syncedAssertion = synced.createCredential(options, { origin: ORIGIN });
  assert.equal(syncedAssertion.type, "public-key");

  console.log("# passkey soft authenticator assertion round trip ok");
});
