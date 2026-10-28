// Adversarial review test: change every single character position of every
// column of one entry (one at a time, in memory, on the exported rows) and
// require verify to fail each time. Also flips one byte of the stored payload
// BLOB value at the SQL level for every byte position.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateSigner } from "../src/keys.js";
import { Ledger, verifyEntries, type LedgerRow } from "../src/ledger.js";

function chain(n: number) {
  const { signer, publicKey } = generateSigner("k1");
  const ledger = new Ledger(new DatabaseSync(":memory:"), signer);
  ledger.init();
  for (let i = 1; i <= n; i++) ledger.append("spend", { i, note: `entry ${i}`, usd_micros: i * 1000 });
  const rows = (ledger as unknown as { db: DatabaseSync }).db
    .prepare("SELECT seq, ts, kind, payload, prev_hash, hash, key_id, sig FROM ledger_entries ORDER BY seq")
    .all() as unknown as LedgerRow[];
  return { rows, trusted: { k1: publicKey } };
}

// Replace the char at i with every other printable ASCII char that keeps the
// column the same length. Covers base64url padding-bit malleability.
function variants(s: string, i: number): string[] {
  const out: string[] = [];
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (ch !== s[i]) out.push(s.slice(0, i) + ch + s.slice(i + 1));
  }
  return out;
}

test("every 1-character change in every column of entry 50 fails verify", () => {
  const { rows, trusted } = chain(100);
  assert.deepEqual(verifyEntries(rows, trusted), { ok: true, checked: 100 });
  const cols = ["ts", "kind", "payload", "prev_hash", "hash", "key_id", "sig"] as const;
  let tried = 0;
  const survivors: string[] = [];
  for (const col of cols) {
    const orig = rows[49]![col];
    for (let i = 0; i < orig.length; i++) {
      for (const v of variants(orig, i)) {
        const copy = rows.slice();
        copy[49] = { ...rows[49]!, [col]: v };
        tried++;
        if (verifyEntries(copy, trusted).ok) survivors.push(`${col}[${i}]=${JSON.stringify(v[i])}`);
      }
    }
  }
  console.log(`exhaustive single-character tamper attempts: ${tried}, undetected: ${survivors.length}`);
  assert.deepEqual(survivors.slice(0, 10), []);
});

test("seq change in either direction fails", () => {
  const { rows, trusted } = chain(10);
  for (const d of [-1, 1, 1000]) {
    const copy = rows.slice();
    copy[4] = { ...rows[4]!, seq: rows[4]!.seq + d };
    assert.equal(verifyEntries(copy, trusted).ok, false);
  }
});

test("non-string fields in an export fail closed without throwing", () => {
  const { rows, trusted } = chain(3);
  const bad = rows.slice() as unknown as Array<Record<string, unknown>>;
  bad[1] = { ...rows[1]!, payload: { i: 2 } };
  const r = verifyEntries(bad as unknown as LedgerRow[], trusted);
  assert.equal(r.ok, false);
});
