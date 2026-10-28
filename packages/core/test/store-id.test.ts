// A mandate may name the one budget database it is allowed to spend from. The
// field is covered by the issuer signature like every other signed field.
import test from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_MANDATE, signMandate, validateMandate, verifySignedMandate, type Mandate } from "../src/schema.js";
import { generateSigner } from "../src/keys.js";

const STORE_ID = "st_" + "a".repeat(22);

function clone(): Mandate {
  return structuredClone(EXAMPLE_MANDATE);
}

test("a valid store_id is accepted", () => {
  const m = clone();
  m.store_id = STORE_ID;
  const result = validateMandate(m);
  assert.equal(result.ok, true);
});

test("a malformed store_id is rejected", () => {
  for (const bad of ["st_short", "ST_" + "a".repeat(22), "st_" + "a".repeat(65), "st_" + "!".repeat(22), ""]) {
    const m = clone();
    m.store_id = bad;
    assert.equal(validateMandate(m).ok, false, `expected ${JSON.stringify(bad)} to fail`);
  }
});

test("changing store_id breaks the signature", () => {
  const { signer, publicKey } = generateSigner("issuer-key");
  const m = clone();
  m.issuer.public_key = publicKey;
  m.store_id = STORE_ID;
  const signed = signMandate(m, signer);
  assert.equal(verifySignedMandate(signed, publicKey).ok, true);

  const tampered = structuredClone(signed);
  tampered.mandate.store_id = "st_" + "b".repeat(22);
  assert.equal(verifySignedMandate(tampered, publicKey).ok, false);

  const removed = structuredClone(signed) as { mandate: Mandate };
  delete removed.mandate.store_id;
  assert.equal(verifySignedMandate(removed, publicKey).ok, false);
});
