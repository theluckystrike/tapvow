import { DatabaseSync } from "node:sqlite";
import { canonicalize } from "./canonical.js";
import { sha256Hex, signBytes, verifyBytes, type Signer } from "./keys.js";

export interface LedgerEntry {
  seq: number;
  ts: string;
  kind: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
  key_id: string;
  sig: string;
}

export interface LedgerRow {
  seq: number;
  ts: string;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
  key_id: string;
  sig: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  firstBadSeq?: number;
  reason?: string;
}

export const GENESIS_HASH = "0".repeat(64);

const LEDGER_SIGNING_PREFIX = "mandate-ledger/v1\n";

function computeHash(
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

function signHash(privateKey: import("node:crypto").KeyObject, hash: string): string {
  return signBytes(privateKey, new TextEncoder().encode(LEDGER_SIGNING_PREFIX + hash));
}

function signatureMessage(hash: string): Uint8Array {
  return new TextEncoder().encode(LEDGER_SIGNING_PREFIX + hash);
}

export function verifyEntries(
  rows: Iterable<LedgerRow>,
  trusted: Record<string, string>,
  expectedHead?: { seq: number; hash: string },
): VerifyResult {
  let checked = 0;
  try {
    let prevHash = GENESIS_HASH;
    let i = -1;
    let last: LedgerRow | undefined;
    for (const row of rows) {
      i++;
      last = row;
      const expectedSeq = i + 1;
      for (const f of ["ts", "kind", "payload", "prev_hash", "hash", "key_id", "sig"] as const) {
        if (typeof row[f] !== "string") {
          return { ok: false, checked, firstBadSeq: expectedSeq, reason: `${f}: must be a string` };
        }
      }
      if (row.seq !== expectedSeq) {
        return {
          ok: false,
          checked,
          firstBadSeq: row.seq,
          reason: `seq: expected ${expectedSeq} but found ${row.seq}`,
        };
      }
      if (row.prev_hash !== prevHash) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: "prev_hash: does not link to previous entry" };
      }
      let payloadCanonical: string;
      try {
        payloadCanonical = canonicalize(JSON.parse(row.payload));
      } catch {
        return { ok: false, checked, firstBadSeq: row.seq, reason: "payload: is not valid JSON" };
      }
      if (payloadCanonical !== row.payload) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: "payload: is not canonical JSON" };
      }
      const recomputed = computeHash(row.seq, row.ts, row.kind, row.payload, row.prev_hash, row.key_id);
      if (recomputed !== row.hash) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: "hash: does not match entry contents" };
      }
      const publicKey = trusted[row.key_id];
      if (!publicKey) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: `key_id: ${row.key_id} is not trusted` };
      }
      if (!verifyBytes(publicKey, signatureMessage(row.hash), row.sig)) {
        return { ok: false, checked, firstBadSeq: row.seq, reason: "sig: signature verification failed" };
      }
      prevHash = row.hash;
      checked++;
    }

    if (expectedHead) {
      const actual =
        last === undefined ? { seq: 0, hash: GENESIS_HASH } : { seq: last.seq, hash: last.hash };
      if (actual.seq !== expectedHead.seq || actual.hash !== expectedHead.hash) {
        return { ok: false, checked, reason: "head: does not match expected head" };
      }
    }

    return { ok: true, checked };
  } catch (err) {
    return { ok: false, checked, reason: err instanceof Error ? err.message : String(err) };
  }
}

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly signer?: Signer;
  /**
   * Called after an append that committed its own transaction, never after a
   * rollback. Used to publish the head outside the database. Appends inside a
   * caller's transaction do not fire it; the caller's own commit hook does.
   */
  private readonly onCommit?: () => void;

  constructor(db: DatabaseSync, signer?: Signer, onCommit?: () => void) {
    this.db = db;
    this.signer = signer;
    this.onCommit = onCommit;
  }

  static open(path: string, signer?: Signer): Ledger {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 10000"); // before WAL: the mode switch takes a lock
    db.exec("PRAGMA journal_mode = WAL");
    const ledger = new Ledger(db, signer);
    ledger.init();
    return ledger;
  }

  /**
   * Opens an existing database read-only, for verification. Never creates a
   * table and never writes: the journal mode is left as it is.
   */
  static openReadOnly(path: string, signer?: Signer): Ledger {
    const db = new DatabaseSync(path, { readOnly: true } as unknown as { open?: boolean });
    db.exec("PRAGMA busy_timeout = 10000");
    return new Ledger(db, signer);
  }

  init(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ledger_entries (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        key_id TEXT NOT NULL,
        sig TEXT NOT NULL
      )`,
    );
  }

  private lastRow(): LedgerRow | undefined {
    return this.db
      .prepare(
        "SELECT seq, ts, kind, payload, prev_hash, hash, key_id, sig FROM ledger_entries ORDER BY seq DESC LIMIT 1",
      )
      .get() as LedgerRow | undefined;
  }

  head(): { seq: number; hash: string } {
    const row = this.lastRow();
    if (!row) return { seq: 0, hash: GENESIS_HASH };
    return { seq: row.seq, hash: row.hash };
  }

  append(kind: string, payload: unknown, opts?: { inTransaction?: boolean; ts?: string }): LedgerEntry {
    if (!this.signer) {
      throw new Error("ledger has no signer; cannot append");
    }
    const ownTransaction = opts?.inTransaction !== true;
    if (ownTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const payloadCanonical = canonicalize(payload);
      const head = this.head();
      const seq = head.seq + 1;
      const prev_hash = head.hash;
      const ts = opts?.ts ?? new Date().toISOString();
      const key_id = this.signer.keyId;
      const hash = computeHash(seq, ts, kind, payloadCanonical, prev_hash, key_id);
      const sig = signHash(this.signer.privateKey, hash);
      this.db
        .prepare(
          "INSERT INTO ledger_entries (seq, ts, kind, payload, prev_hash, hash, key_id, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(seq, ts, kind, payloadCanonical, prev_hash, hash, key_id, sig);
      if (ownTransaction) this.db.exec("COMMIT");
      if (ownTransaction) {
        try {
          this.onCommit?.();
        } catch {
          // a later publish repairs the head; the committed entry is not lost
        }
      }
      return { seq, ts, kind, payload, prev_hash, hash, key_id, sig };
    } catch (err) {
      if (ownTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // the transaction may never have started; ignore.
        }
      }
      throw err;
    }
  }

  entries(fromSeq = 1, limit?: number): LedgerEntry[] {
    const columns = "seq, ts, kind, payload, prev_hash, hash, key_id, sig";
    const rows = (
      limit === undefined
        ? this.db.prepare(`SELECT ${columns} FROM ledger_entries WHERE seq >= ? ORDER BY seq ASC`).all(fromSeq)
        : this.db.prepare(`SELECT ${columns} FROM ledger_entries WHERE seq >= ? ORDER BY seq ASC LIMIT ?`).all(fromSeq, limit)
    ) as LedgerRow[];
    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
      prev_hash: row.prev_hash,
      hash: row.hash,
      key_id: row.key_id,
      sig: row.sig,
    }));
  }

  verify(trusted: Record<string, string>, expectedHead?: { seq: number; hash: string }): VerifyResult {
    const stmt = this.db.prepare(
      "SELECT seq, ts, kind, payload, prev_hash, hash, key_id, sig FROM ledger_entries ORDER BY seq ASC",
    );
    // Streamed with iterate() (node >= 22.13; @types/node 22.10 lacks it), so a
    // large ledger is never held in memory at once.
    const rows = (stmt as unknown as { iterate(): Iterable<LedgerRow> }).iterate();
    return verifyEntries(rows, trusted, expectedHead);
  }

  close(): void {
    this.db.close();
  }
}
