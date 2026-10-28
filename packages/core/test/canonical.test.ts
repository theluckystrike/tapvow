import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/canonical.js";

test("object key order does not matter", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("nested structures canonicalize deterministically", () => {
  const a = { z: [{ b: 1, a: 2 }], a: { c: [3, 2, 1], b: null } };
  const b = { a: { b: null, c: [3, 2, 1] }, z: [{ a: 2, b: 1 }] };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize([1, "two", true, null]), '[1,"two",true,null]');
});

test("arrays keep order", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test("strings are JSON encoded", () => {
  assert.equal(canonicalize("héllo\n\"x\""), JSON.stringify("héllo\n\"x\""));
});

test("integers and finite numbers are allowed", () => {
  assert.equal(canonicalize({ a: 1, b: -2.5 }), '{"a":1,"b":-2.5}');
});

test("rejects NaN, Infinity and non-finite numbers", () => {
  assert.throws(() => canonicalize(NaN), TypeError);
  assert.throws(() => canonicalize(Infinity), TypeError);
  assert.throws(() => canonicalize(-Infinity), TypeError);
});

test("rejects undefined, function, symbol and bigint", () => {
  assert.throws(() => canonicalize(undefined), TypeError);
  assert.throws(() => canonicalize(() => 1), TypeError);
  assert.throws(() => canonicalize(Symbol("x")), TypeError);
  assert.throws(() => canonicalize(10n), TypeError);
  assert.throws(() => canonicalize({ a: undefined }), TypeError);
});

test("rejects non-plain objects", () => {
  assert.throws(() => canonicalize(new Date()), TypeError);
  assert.throws(() => canonicalize(new Map()), TypeError);
  assert.throws(() => canonicalize(new Set()), TypeError);
  class Foo {
    x = 1;
  }
  assert.throws(() => canonicalize(new Foo()), TypeError);
});
