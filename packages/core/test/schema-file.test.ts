// The published JSON Schema and the TypeScript validator must agree on the
// field set, so a client validating with the JSON file sees the same contract.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXAMPLE_MANDATE } from "../src/schema.js";

test("JSON Schema lists exactly the Mandate fields, all required, no extras allowed", () => {
  const s = JSON.parse(readFileSync(new URL("../schema/mandate.schema.json", import.meta.url), "utf8"));
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(Object.keys(s.properties).sort(), Object.keys(EXAMPLE_MANDATE).sort());
  assert.deepEqual([...s.required].sort(), Object.keys(EXAMPLE_MANDATE).sort());
});
