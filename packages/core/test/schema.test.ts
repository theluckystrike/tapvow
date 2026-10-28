import test from "node:test";
import assert from "node:assert/strict";
import {
  EXAMPLE_MANDATE,
  signMandate,
  validateMandate,
  verifySignedMandate,
  type Mandate,
} from "../src/schema.js";
import { generateSigner } from "../src/keys.js";

function clone(): Mandate {
  return structuredClone(EXAMPLE_MANDATE);
}

test("EXAMPLE_MANDATE validates", () => {
  const result = validateMandate(EXAMPLE_MANDATE);
  assert.equal(result.ok, true);
});

test("missing budget fails", () => {
  const m = clone() as Partial<Mandate>;
  delete m.budget;
  assert.equal(validateMandate(m).ok, false);
});

test("budget.total must be a USD string", () => {
  for (const bad of ["-1", "1e3", "", "1.0000001", " 1"]) {
    const m = clone();
    m.budget.total = bad;
    assert.equal(validateMandate(m).ok, false, `expected ${JSON.stringify(bad)} to fail`);
  }
});

test("per_call_cap greater than budget fails", () => {
  const m = clone();
  m.per_call_cap = "9.00";
  const result = validateMandate(m);
  assert.equal(result.ok, false);
});

test("approval_threshold greater than budget fails", () => {
  const m = clone();
  m.approval_threshold = "9.00";
  assert.equal(validateMandate(m).ok, false);
});

test("expires_at before not_before fails", () => {
  const m = clone();
  m.not_before = "2026-11-17T00:00:00Z";
  m.expires_at = "2026-10-18T00:00:00Z";
  assert.equal(validateMandate(m).ok, false);
});

test("unknown rail fails", () => {
  const m = clone();
  (m.rails as string[]) = ["llm", "bogus"];
  assert.equal(validateMandate(m).ok, false);
});

test("extra unknown fields fail at top level and inside budget", () => {
  const top = clone() as Mandate & { extra?: unknown };
  top.extra = true;
  assert.equal(validateMandate(top).ok, false);

  const nested = clone();
  (nested.budget as unknown as Record<string, unknown>).extra = 1;
  assert.equal(validateMandate(nested).ok, false);
});

test("payee on a rail not listed in rails fails", () => {
  const m = clone();
  m.rails = ["llm"];
  m.allowed_payees = [{ rail: "x402", id: "0xabc" }];
  assert.equal(validateMandate(m).ok, false);
});

test("sign then verify succeeds", () => {
  const { signer, publicKey } = generateSigner("issuer-key");
  const m = clone();
  m.issuer.public_key = publicKey;
  const signed = signMandate(m, signer);
  const verified = verifySignedMandate(signed, publicKey);
  assert.equal(verified.ok, true);
});

test("changing a signed field fails verification", () => {
  const { signer, publicKey } = generateSigner("issuer-key");
  const m = clone();
  m.issuer.public_key = publicKey;
  const signed = signMandate(m, signer);
  const tampered = structuredClone(signed);
  tampered.mandate.budget.total = "4.00";
  assert.equal(verifySignedMandate(tampered, publicKey).ok, false);
});

test("verifying with a different trusted key fails", () => {
  const { signer, publicKey } = generateSigner("issuer-key");
  const other = generateSigner("other-key");
  const m = clone();
  m.issuer.public_key = publicKey;
  const signed = signMandate(m, signer);
  assert.equal(verifySignedMandate(signed, other.publicKey).ok, false);
});

test("a document self-signed by an attacker fails against the real key", () => {
  const real = generateSigner("real-key");
  const attacker = generateSigner("attacker-key");
  const m = clone();
  m.issuer.public_key = attacker.publicKey;
  const signed = signMandate(m, attacker.signer);
  assert.equal(verifySignedMandate(signed, real.publicKey).ok, false);
});

test("impossible calendar dates fail (Date.parse would roll them over)", () => {
  const bad = { ...EXAMPLE_MANDATE, not_before: "2026-02-31T00:00:00Z" };
  assert.equal(validateMandate(bad).ok, false);
});

test("a non-canonical base64url issuer key fails", () => {
  const bad = { ...EXAMPLE_MANDATE, issuer: { ...EXAMPLE_MANDATE.issuer, public_key: "A".repeat(42) + "B" } };
  assert.equal(validateMandate(bad).ok, false);
});
