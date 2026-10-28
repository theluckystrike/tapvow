import test from "node:test";
import assert from "node:assert/strict";
import { generateSigner } from "@mandate/core";
import { addressKey, parseX402Allowlist } from "../src/index.js";

const ADDRESS = "0x" + "aB".repeat(20);

test("parses a direct address and an origin binding", () => {
  const { publicKey } = generateSigner("allowlist");
  const result = parseX402Allowlist([
    { rail: "llm", id: "openai" },
    { rail: "x402", id: `eip155:84532:${ADDRESS}` },
    { rail: "x402", id: `binding:${publicKey}@https://api.example.com` },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    [...result.allowlist.addresses],
    [addressKey("eip155:84532", ADDRESS)],
  );
  assert.deepEqual(result.allowlist.bindings, [
    { origin: "https://api.example.com", publicKey },
  ]);
});

test("normalizes address keys to lowercase", () => {
  const result = parseX402Allowlist([{ rail: "x402", id: `eip155:8453:${ADDRESS}` }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.allowlist.addresses.has(`eip155:8453:${ADDRESS.toLowerCase()}`), true);
});

test("ignores payees whose rail is not x402", () => {
  const result = parseX402Allowlist([
    { rail: "llm", id: "not an x402 id at all!!" },
    { rail: "stripe_spt", id: "whatever" },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.allowlist.addresses.size, 0);
  assert.equal(result.allowlist.bindings.length, 0);
});

test("rejects a malformed direct address", () => {
  const result = parseX402Allowlist([{ rail: "x402", id: "eip155:84532:0x123" }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.length > 0);
});

test("rejects a bad binding public key", () => {
  const result = parseX402Allowlist([
    { rail: "x402", id: "binding:not-a-valid-key@https://api.example.com" },
  ]);
  assert.equal(result.ok, false);
});

test("rejects a 42-character binding public key", () => {
  const { publicKey } = generateSigner("allowlist");
  const short = publicKey.slice(0, 42);
  const result = parseX402Allowlist([
    { rail: "x402", id: `binding:${short}@https://api.example.com` },
  ]);
  assert.equal(result.ok, false);
});

test("rejects a binding origin with a path", () => {
  const { publicKey } = generateSigner("allowlist");
  const result = parseX402Allowlist([
    { rail: "x402", id: `binding:${publicKey}@https://api.example.com/path` },
  ]);
  assert.equal(result.ok, false);
});

test("rejects a non-loopback http origin", () => {
  const { publicKey } = generateSigner("allowlist");
  const result = parseX402Allowlist([
    { rail: "x402", id: `binding:${publicKey}@http://api.example.com` },
  ]);
  assert.equal(result.ok, false);
});

test("rejects a trailing slash on the binding origin", () => {
  const { publicKey } = generateSigner("allowlist");
  const result = parseX402Allowlist([
    { rail: "x402", id: `binding:${publicKey}@https://api.example.com/` },
  ]);
  assert.equal(result.ok, false);
});

test("accepts a loopback http origin", () => {
  const { publicKey } = generateSigner("allowlist");
  const result = parseX402Allowlist([
    { rail: "x402", id: `binding:${publicKey}@http://127.0.0.1:8080` },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.allowlist.bindings, [
    { origin: "http://127.0.0.1:8080", publicKey },
  ]);
});
