import test from "node:test";
import assert from "node:assert/strict";
import { formatUsd, parseUsd } from "../src/money.js";

test("parseUsd parses plain and fractional USD", () => {
  assert.equal(parseUsd("5.00"), 5_000_000);
  assert.equal(parseUsd("0.000001"), 1);
  assert.equal(parseUsd("0"), 0);
  assert.equal(parseUsd("0.1"), 100_000);
  assert.equal(parseUsd("123456789.123456"), 123_456_789_123_456);
});

test("parseUsd rejects malformed strings", () => {
  for (const bad of ["1e3", "-1", "1.0000001", "", " 1", "5.0000000", ".5", "1.", "+1", "0x10", "1e-3"]) {
    assert.throws(() => parseUsd(bad), TypeError, `expected ${JSON.stringify(bad)} to throw`);
  }
});

test("formatUsd prints six decimal places", () => {
  assert.equal(formatUsd(5_000_000), "5.000000");
  assert.equal(formatUsd(1), "0.000001");
  assert.equal(formatUsd(0), "0.000000");
  assert.equal(formatUsd(123_456_789_123_456), "123456789.123456");
});

test("parseUsd and formatUsd round-trip", () => {
  const cases: Array<[string, string]> = [
    ["0", "0.000000"],
    ["0.000001", "0.000001"],
    ["5.00", "5.000000"],
    ["0.50", "0.500000"],
    ["999999999.999999", "999999999.999999"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(formatUsd(parseUsd(input)), expected);
  }
});
