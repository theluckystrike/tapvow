import test from "node:test";
import assert from "node:assert/strict";
import { signBinding, verifyBinding, type PayeeBinding } from "../src/index.js";
import { ASSET, NETWORK, PAY_TO, makeBinding, newKey } from "./helpers.js";

const ORIGIN = "https://api.example.com";
const NOW = Date.parse("2026-10-18T00:00:00Z");

test("valid binding passes", () => {
  const { signer, publicKey } = newKey();
  const binding = makeBinding(ORIGIN);
  const doc = signBinding(binding, signer);
  const result = verifyBinding(doc, publicKey, ORIGIN, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.binding.origin, ORIGIN);
  assert.match(result.hash, /^[0-9a-f]{64}$/);
});

test("tampered payee fails", () => {
  const { signer, publicKey } = newKey();
  const doc = signBinding(makeBinding(ORIGIN), signer);
  doc.binding.payees[0]!.pay_to = "0x" + "c".repeat(40);
  const result = verifyBinding(doc, publicKey, ORIGIN, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(typeof result.reason, "string");
});

test("wrong key fails", () => {
  const { signer } = newKey();
  const other = newKey();
  const doc = signBinding(makeBinding(ORIGIN), signer);
  assert.equal(verifyBinding(doc, other.publicKey, ORIGIN, NOW).ok, false);
});

test("wrong origin fails", () => {
  const { signer, publicKey } = newKey();
  const doc = signBinding(makeBinding(ORIGIN), signer);
  assert.equal(verifyBinding(doc, publicKey, "https://other.example.com", NOW).ok, false);
});

test("expired binding fails", () => {
  const { signer, publicKey } = newKey();
  const doc = signBinding(
    makeBinding(ORIGIN, {
      issued_at: "2026-09-01T00:00:00Z",
      expires_at: "2026-10-01T00:00:00Z",
    }),
    signer,
  );
  const result = verifyBinding(doc, publicKey, ORIGIN, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /expired/i);
});

test("not yet valid binding fails", () => {
  const { signer, publicKey } = newKey();
  const doc = signBinding(
    makeBinding(ORIGIN, {
      issued_at: "2026-10-19T00:00:00Z",
      expires_at: "2026-11-19T00:00:00Z",
    }),
    signer,
  );
  const result = verifyBinding(doc, publicKey, ORIGIN, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /not yet valid/i);
});

test("unknown field fails", () => {
  const { signer, publicKey } = newKey();
  const binding = makeBinding(ORIGIN) as PayeeBinding & { extra?: string };
  binding.extra = "nope";
  const doc = signBinding(binding, signer);
  assert.equal(verifyBinding(doc, publicKey, ORIGIN, NOW).ok, false);

  const { signer: s2, publicKey: k2 } = newKey();
  const nested = makeBinding(ORIGIN);
  (nested.payees[0] as unknown as Record<string, unknown>).surprise = true;
  assert.equal(verifyBinding(signBinding(nested, s2), k2, ORIGIN, NOW).ok, false);
});

test("non-canonical amount fails", () => {
  const { signer, publicKey } = newKey();
  const binding = makeBinding(ORIGIN);
  binding.payees[0]!.quotes![0]!.amount = "010";
  const doc = signBinding(binding, signer);
  const result = verifyBinding(doc, publicKey, ORIGIN, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /amount/i);
});

test("zero amount fails", () => {
  const { signer, publicKey } = newKey();
  const binding = makeBinding(ORIGIN);
  binding.payees[0]!.quotes![0]!.amount = "0";
  const doc = signBinding(binding, signer);
  assert.equal(verifyBinding(doc, publicKey, ORIGIN, NOW).ok, false);
});

test("validity window over 400 days fails", () => {
  const { signer, publicKey } = newKey();
  const doc = signBinding(
    makeBinding(ORIGIN, {
      issued_at: "2026-01-01T00:00:00Z",
      expires_at: "2027-03-01T00:00:00Z",
    }),
    signer,
  );
  assert.equal(verifyBinding(doc, publicKey, ORIGIN, NOW).ok, false);
});

test("binding with the bound payee passes shape checks", () => {
  const { signer, publicKey } = newKey();
  const binding = makeBinding(ORIGIN, {
    payees: [{ network: NETWORK, asset: ASSET, pay_to: PAY_TO }],
  });
  const doc = signBinding(binding, signer);
  assert.equal(verifyBinding(doc, publicKey, ORIGIN, NOW).ok, true);
});
