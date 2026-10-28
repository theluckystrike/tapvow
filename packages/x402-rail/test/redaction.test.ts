// Finding L: redaction must catch query values, userinfo and any vendor's
// scheme-less host, without turning ordinary path words into secrets.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  redactError,
  registerRedactionSecrets,
  resetRedactionSecretsForTests,
} from "../src/reconcile.js";

beforeEach(() => resetRedactionSecretsForTests());

test("a query parameter value is redacted when the text quotes it without the scheme", () => {
  registerRedactionSecrets("https://rpc.ankr.com/base?apikey=QSECRET99");
  const out = redactError(new Error("request failed apikey=QSECRET99"));
  assert.doesNotMatch(out, /QSECRET99/);
});

test("userinfo from the URL is redacted", () => {
  registerRedactionSecrets("https://user:PW12345@node.example.org/");
  const out = redactError(new Error("auth failed for user:PW12345"));
  assert.doesNotMatch(out, /PW12345/);
});

test("a scheme-less host and path is redacted without a vendor list", () => {
  const out = redactError(new Error("base.llamarpc.com/sk_ABCDEF failed"));
  assert.doesNotMatch(out, /sk_ABCDEF/);
  assert.match(out, /<rpc>/);
});

test("a two-label scheme-less host and path is redacted", () => {
  const out = redactError(new Error("llamarpc.com/sk_ABCDEF failed"));
  assert.doesNotMatch(out, /sk_ABCDEF/);
  assert.match(out, /<rpc>/);
});

test("common path segments stay readable after an RPC URL registers them", () => {
  registerRedactionSecrets("https://rpc.provider.example/base/mainnet");
  assert.match(redactError(new Error("database is locked")), /database is locked/);
  assert.match(redactError(new Error("mainnet")), /mainnet/);
  assert.match(redactError(new Error("base")), /base/);
});

test("a long credential-like path segment is still redacted", () => {
  const segment = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
  assert.equal(segment.length, 32);
  registerRedactionSecrets(`https://rpc.provider.example/${segment}`);
  const out = redactError(new Error(`upload failed at ${segment}`));
  assert.doesNotMatch(out, new RegExp(segment));
  assert.match(out, /<rpc>/);
});
