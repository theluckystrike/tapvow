import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize } from "../src/canonical.js";
import { sha256Hex, signBytes, generateSigner } from "../src/keys.js";
import { GENESIS_HASH, Ledger, type LedgerRow } from "../src/ledger.js";

const KEY_ID = "key-1";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "mandate-ledger-"));
}

function payloadFor(i: number): unknown {
  return {
    n: i,
    marker: `marker-${String(i).padStart(4, "0")}-abcdef`,
    nested: { a: [i, i + 1, { deep: true }], "z-key": null },
    unicode: `héllo-${i}-✓-世界`,
    ratio: i / 7,
  };
}

function buildChain(dbPath: string, n = 100): { publicKey: string } {
  const { signer, publicKey } = generateSigner(KEY_ID);
  const ledger = Ledger.open(dbPath, signer);
  for (let i = 1; i <= n; i++) ledger.append("spend", payloadFor(i));
  ledger.close();
  return { publicKey };
}

function flipChar(s: string, idx = 5): string {
  const i = Math.min(idx, s.length - 1);
  const c = s[i]!;
  const repl = c === "a" ? "b" : "a";
  return s.slice(0, i) + repl + s.slice(i + 1);
}

function ledgerHash(
  seq: number,
  ts: string,
  kind: string,
  payloadCanonical: string,
  prev_hash: string,
  key_id: string,
): string {
  return sha256Hex(
    canonicalize({
      v: 1,
      seq,
      ts,
      kind,
      payload_sha256: sha256Hex(payloadCanonical),
      prev_hash,
      key_id,
    }),
  );
}

function ledgerSig(privateKey: import("node:crypto").KeyObject, hash: string): string {
  return signBytes(privateKey, new TextEncoder().encode("mandate-ledger/v1\n" + hash));
}

test("100-entry chain verifies", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);
    const ledger = Ledger.open(dbPath);
    const result = ledger.verify({ [KEY_ID]: publicKey });
    assert.deepEqual(result, { ok: true, checked: 100 });
    assert.equal(ledger.head().seq, 100);
    assert.equal(ledger.entries(1, 1).length, 1);
    assert.equal(ledger.entries(90).length, 11);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing one byte in any single column makes verify fail", () => {
  const columns = ["payload", "hash", "prev_hash", "sig", "ts", "kind", "key_id"] as const;
  for (const column of columns) {
    const dir = freshDir();
    try {
      const dbPath = join(dir, "ledger.db");
      const { publicKey } = buildChain(dbPath, 100);
      const db = new DatabaseSync(dbPath);
      const before = db.prepare(`SELECT ${column} AS v FROM ledger_entries WHERE seq = 50`).get() as {
        v: string;
      };
      db.prepare(`UPDATE ledger_entries SET ${column} = ? WHERE seq = 50`).run(flipChar(before.v));
      db.close();

      const verifier = Ledger.open(dbPath);
      const result = verifier.verify({ [KEY_ID]: publicKey });
      verifier.close();

      assert.equal(result.ok, false, `column ${column} should fail`);
      assert.ok(
        result.firstBadSeq === 50 || result.firstBadSeq === 51,
        `column ${column} firstBadSeq was ${result.firstBadSeq}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("1 byte flipped in the raw database file fails verify", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);

    {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    }

    const marker = "marker-0050-abcdef";
    const bytes = readFileSync(dbPath);
    const idx = bytes.indexOf(Buffer.from(marker, "utf8"));
    assert.ok(idx >= 0, "marker was not found in the database file");

    const target = idx + marker.indexOf("abcdef");
    assert.equal(bytes[target], 0x61);
    bytes[target] = 0x62;
    writeFileSync(dbPath, bytes);

    let failedClosed = false;
    try {
      const verifier = Ledger.open(dbPath);
      const result = verifier.verify({ [KEY_ID]: publicKey });
      verifier.close();
      if (!result.ok) failedClosed = true;
    } catch {
      failedClosed = true;
    }
    assert.equal(failedClosed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a middle row fails", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);
    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM ledger_entries WHERE seq = 50");
    db.close();

    const verifier = Ledger.open(dbPath);
    const result = verifier.verify({ [KEY_ID]: publicKey });
    verifier.close();
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swapping the payloads of two rows fails", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);
    const db = new DatabaseSync(dbPath);
    const a = (db.prepare("SELECT payload AS v FROM ledger_entries WHERE seq = 50").get() as { v: string }).v;
    const b = (db.prepare("SELECT payload AS v FROM ledger_entries WHERE seq = 51").get() as { v: string }).v;
    db.prepare("UPDATE ledger_entries SET payload = ? WHERE seq = 50").run(b);
    db.prepare("UPDATE ledger_entries SET payload = ? WHERE seq = 51").run(a);
    db.close();

    const verifier = Ledger.open(dbPath);
    const result = verifier.verify({ [KEY_ID]: publicKey });
    verifier.close();
    assert.equal(result.ok, false);
    assert.equal(result.firstBadSeq, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting the last row is caught with expectedHead", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);
    const reader = Ledger.open(dbPath);
    const head = reader.head();
    reader.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM ledger_entries WHERE seq = 100");
    db.close();

    const verifier = Ledger.open(dbPath);
    const withoutHead = verifier.verify({ [KEY_ID]: publicKey });
    assert.equal(withoutHead.ok, true);
    const withHead = verifier.verify({ [KEY_ID]: publicKey }, head);
    verifier.close();
    assert.equal(withHead.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifying with a different trusted key fails", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    buildChain(dbPath, 100);
    const wrong = generateSigner(KEY_ID);
    const verifier = Ledger.open(dbPath);
    const result = verifier.verify({ [KEY_ID]: wrong.publicKey });
    verifier.close();
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an attacker who rewrites the tail with their own key fails", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);

    const attacker = generateSigner("attacker-key");
    const db = new DatabaseSync(dbPath);
    const rows = db
      .prepare("SELECT seq, ts, kind, payload, prev_hash, hash, key_id, sig FROM ledger_entries ORDER BY seq ASC")
      .all() as LedgerRow[];

    let prevHash = rows[48]!.hash;
    for (let i = 49; i < rows.length; i++) {
      const row = rows[i]!;
      const payload = canonicalize({ hacked: true, seq: row.seq });
      const hash = ledgerHash(row.seq, row.ts, row.kind, payload, prevHash, attacker.signer.keyId);
      const sig = ledgerSig(attacker.signer.privateKey, hash);
      db.prepare(
        "UPDATE ledger_entries SET payload = ?, prev_hash = ?, hash = ?, key_id = ?, sig = ? WHERE seq = ?",
      ).run(payload, prevHash, hash, attacker.signer.keyId, sig, row.seq);
      prevHash = hash;
    }
    db.close();

    const verifier = Ledger.open(dbPath);
    const result = verifier.verify({ [KEY_ID]: publicKey });
    verifier.close();
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown key_id fails", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { publicKey } = buildChain(dbPath, 100);
    const attacker = generateSigner("attacker-key");
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT hash FROM ledger_entries WHERE seq = 50").get() as { hash: string };
    const sig = ledgerSig(attacker.signer.privateKey, row.hash);
    db.prepare("UPDATE ledger_entries SET key_id = ?, sig = ? WHERE seq = 50").run("ghost", sig);
    db.close();

    const verifier = Ledger.open(dbPath);
    const result = verifier.verify({ [KEY_ID]: publicKey });
    verifier.close();
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed signatures fail without throwing", () => {
  for (const bad of ["not-base64url!!", "AAAA", "", "a".repeat(200), "***"]) {
    const dir = freshDir();
    try {
      const dbPath = join(dir, "ledger.db");
      const { publicKey } = buildChain(dbPath, 100);
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE ledger_entries SET sig = ? WHERE seq = 50").run(bad);
      db.close();

      const verifier = Ledger.open(dbPath);
      const result = verifier.verify({ [KEY_ID]: publicKey });
      verifier.close();
      assert.equal(result.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("genesis and empty-ledger handling", () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "empty.db");
    const ledger = Ledger.open(dbPath);
    assert.deepEqual(ledger.head(), { seq: 0, hash: GENESIS_HASH });
    assert.deepEqual(ledger.verify({}), { ok: true, checked: 0 });
    assert.equal(ledger.verify({}, { seq: 0, hash: GENESIS_HASH }).ok, true);
    assert.equal(ledger.verify({}, { seq: 1, hash: GENESIS_HASH }).ok, false);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent appends from two connections keep one chain", async () => {
  const dir = freshDir();
  try {
    const dbPath = join(dir, "ledger.db");
    const { signer, publicKey } = generateSigner(KEY_ID);
    const a = Ledger.open(dbPath, signer);
    const b = Ledger.open(dbPath, signer);

    const run = async (ledger: Ledger, who: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        ledger.append("interleave", { who, i });
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    await Promise.all([run(a, "a"), run(b, "b")]);

    const result = a.verify({ [KEY_ID]: publicKey });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 200);

    const rows = b.entries();
    assert.equal(rows.length, 200);
    rows.forEach((row, index) => {
      assert.equal(row.seq, index + 1);
      assert.equal(row.prev_hash, index === 0 ? GENESIS_HASH : rows[index - 1]!.hash);
    });

    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
