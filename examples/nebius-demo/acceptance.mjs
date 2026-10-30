// Fixed checks for the initial coding task. This file is maintained with the
// demo agent and is not one of the files a model answer can replace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { parseDuration } = await import(pathToFileURL(join(process.cwd(), "duration.mjs")).href);

test("the required parseDuration export is a function", () => {
  assert.equal(typeof parseDuration, "function");
});

test("each task unit returns milliseconds", () => {
  for (const [input, expected] of [["2d", 172800000], ["1h", 3600000], ["5m", 300000], ["45s", 45000], ["250ms", 250]]) {
    assert.equal(parseDuration(input), expected, input);
  }
});

test("adjacent units satisfy the explicit 1h30m task example", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
});

test("spaced combined units satisfy the task example", () => {
  assert.equal(parseDuration("1h 5m 10s"), 3910000);
});

test("unknown units, invalid text and non-string input throw TypeError", () => {
  for (const input of ["10q", "abc", 42]) {
    assert.throws(() => parseDuration(input), TypeError, String(input));
  }
});
