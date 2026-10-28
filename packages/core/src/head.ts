// A signed head that lives outside the database. The ledger proves the past;
// the head proves how far the past reached. Anyone who can write the database
// file can delete the last entries and the matching budget rows, so the last
// head must be published to a file the gateway keeps separately (threat model
// issue 1). Publishing the same head to more than one path makes a rollback
// have to roll back every copy.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { canonicalize } from "./canonical.js";
import { sha256Hex, signBytes, verifyBytes, type Signer } from "./keys.js";
import type { Ledger } from "./ledger.js";

export const HEAD_FORMAT = "spendmandate-head-v1";
const HEAD_KEYS = ["format", "seq", "hash", "ts", "key_id", "sig"] as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface SignedHead {
  format: "spendmandate-head-v1";
  seq: number;
  hash: string;
  ts: string;
  key_id: string;
  sig: string;
}

/**
 * The exact bytes a head signature covers: sha256 of the canonical form of
 * every field except sig, signed with the same Ed25519 helper as a ledger entry.
 */
function headMessage(fields: Omit<SignedHead, "sig">): Uint8Array {
  return new TextEncoder().encode(
    sha256Hex(
      canonicalize({
        format: fields.format,
        seq: fields.seq,
        hash: fields.hash,
        ts: fields.ts,
        key_id: fields.key_id,
      }),
    ),
  );
}

export function signHead(signer: Signer, head: { seq: number; hash: string }, ts?: string): SignedHead {
  const fields = {
    format: HEAD_FORMAT,
    seq: head.seq,
    hash: head.hash,
    ts: ts ?? new Date().toISOString(),
    key_id: signer.keyId,
  } as const;
  return { ...fields, sig: signBytes(signer.privateKey, headMessage(fields)) };
}

export function verifySignedHead(
  h: unknown,
  trusted: Record<string, string>,
): { ok: true; head: SignedHead } | { ok: false; reason: string } {
  if (typeof h !== "object" || h === null || Array.isArray(h)) {
    return { ok: false, reason: "head: must be an object" };
  }
  const obj = h as Record<string, unknown>;
  const keySet = new Set<string>(HEAD_KEYS);
  for (const key of Object.keys(obj)) {
    if (!keySet.has(key)) return { ok: false, reason: `head: unknown field ${key}` };
  }
  for (const key of HEAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return { ok: false, reason: `head: missing field ${key}` };
    }
  }
  if (obj.format !== HEAD_FORMAT) return { ok: false, reason: `head: format must be ${HEAD_FORMAT}` };
  if (typeof obj.seq !== "number" || !Number.isSafeInteger(obj.seq) || obj.seq < 0) {
    return { ok: false, reason: "head: seq must be a safe integer >= 0" };
  }
  if (typeof obj.hash !== "string" || !HASH_RE.test(obj.hash)) {
    return { ok: false, reason: "head: hash must be 64 lowercase hex characters" };
  }
  if (typeof obj.ts !== "string" || obj.ts.length === 0) {
    return { ok: false, reason: "head: ts must be a non-empty string" };
  }
  if (typeof obj.key_id !== "string" || obj.key_id.length === 0) {
    return { ok: false, reason: "head: key_id must be a non-empty string" };
  }
  if (typeof obj.sig !== "string") return { ok: false, reason: "head: sig must be a string" };
  const publicKey = trusted[obj.key_id];
  if (typeof publicKey !== "string") {
    return { ok: false, reason: `head: key_id ${obj.key_id} is not trusted` };
  }
  const fields = {
    format: HEAD_FORMAT,
    seq: obj.seq,
    hash: obj.hash,
    ts: obj.ts,
    key_id: obj.key_id,
  } as const;
  if (!verifyBytes(publicKey, headMessage(fields), obj.sig)) {
    return { ok: false, reason: "head: signature verification failed" };
  }
  return { ok: true, head: { ...fields, sig: obj.sig } };
}

export interface HeadReadResult {
  path: string;
  head: SignedHead | null;
  error?: string;
}

/**
 * Reads a head file without verifying its signature, just to compare sequences.
 * The shape is still checked, so a corrupt file can never be republished. The
 * full signature check happens in readAll / verifySignedHead.
 */
function readRawHead(path: string): SignedHead | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const h = parsed as Record<string, unknown>;
    if (h.format !== HEAD_FORMAT) return null;
    if (typeof h.seq !== "number" || !Number.isSafeInteger(h.seq) || h.seq < 0) return null;
    if (typeof h.hash !== "string" || !HASH_RE.test(h.hash)) return null;
    if (typeof h.ts !== "string" || h.ts.length === 0) return null;
    if (typeof h.key_id !== "string" || h.key_id.length === 0) return null;
    if (typeof h.sig !== "string") return null;
    return parsed as SignedHead;
  } catch {
    return null;
  }
}

function writeFileAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the temp file may already be gone
    }
    throw err;
  }
}

export interface HeadAnchorOptions {
  /**
   * Trusted ledger keys. When given, an existing head only counts towards the
   * high-water mark if its signature verifies against one of these keys, so a
   * forged file cannot be republished to every mirror.
   */
  trusted?: Record<string, string>;
  /**
   * Called the first time a write to one path fails. Publishing keeps going to
   * the other paths, so a broken mirror never blocks a commit; a later publish
   * after the permission is repaired brings the mirror up to date.
   */
  onPublishError?: (path: string, err: Error) => void;
}

export class HeadAnchor {
  private readonly paths: string[];
  private readonly signer: Signer | undefined;
  private readonly trusted: Record<string, string> | undefined;
  private readonly onPublishError: ((path: string, err: Error) => void) | undefined;
  /** Paths whose first write failure has already been reported. */
  private readonly reported = new Set<string>();

  constructor(paths: string[], signer?: Signer, opts: HeadAnchorOptions = {}) {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 4) {
      throw new Error("head anchor: paths must have 1 to 4 entries");
    }
    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0) {
        throw new Error("head anchor: every path must be a non-empty string");
      }
    }
    this.paths = [...paths];
    this.signer = signer;
    this.trusted = opts.trusted;
    this.onPublishError = opts.onPublishError;
  }

  get files(): readonly string[] {
    return this.paths;
  }

  /**
   * Reads an existing head from one path. With trusted keys, a head that does
   * not verify is ignored entirely, so a forged high seq cannot win the
   * high-water comparison. Without trusted keys only the shape is checked.
   */
  private existingHead(path: string): SignedHead | null {
    const raw = readRawHead(path);
    if (!raw) return null;
    if (!this.trusted) return raw;
    const v = verifySignedHead(raw, this.trusted);
    return v.ok ? v.head : null;
  }

  /**
   * Writes one signed head to every path, atomically. It never lowers a head:
   * the highest *verified* head already on disk wins, so a rollback has to roll
   * back every copy while a forged file is ignored. A write failure on one path
   * is reported once and does not stop the other paths. Returns the head that
   * was actually written.
   */
  publish(head: { seq: number; hash: string }): SignedHead {
    if (!this.signer) throw new Error("head anchor: cannot publish without a signer");
    let chosen = signHead(this.signer, head);
    for (const path of this.paths) {
      const existing = this.existingHead(path);
      if (existing && existing.seq > chosen.seq) chosen = existing;
    }
    const data = JSON.stringify(chosen);
    for (const path of this.paths) {
      try {
        writeFileAtomic(path, data);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!this.reported.has(path)) {
          this.reported.add(path);
          try {
            this.onPublishError?.(path, error);
          } catch {
            // a broken error reporter must not break publishing either
          }
        }
      }
    }
    return chosen;
  }

  /** Reads every path, returning the valid head (or an error) for each. */
  readAll(trusted: Record<string, string>): HeadReadResult[] {
    return this.paths.map((path) => {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path, head: null };
        return { path, head: null, error: err instanceof Error ? err.message : String(err) };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { path, head: null, error: "not valid JSON" };
      }
      const v = verifySignedHead(parsed, trusted);
      if (!v.ok) return { path, head: null, error: v.reason };
      return { path, head: v.head };
    });
  }
}

/**
 * Checks the ledger against the heads read from disk. The highest valid head
 * wins. The ledger may be longer than the head (a crash after commit and before
 * publish), but it must contain the head's entry with exactly the head's hash.
 */
export function checkLedgerAgainstHeads(
  ledger: Ledger,
  trusted: Record<string, string>,
  results: HeadReadResult[],
  opts: { allowMissing: boolean },
): { ok: true; anchoredSeq: number } | { ok: false; reason: string } {
  for (const r of results) {
    if (r.error) return { ok: false, reason: `head file ${r.path} is invalid: ${r.error}` };
  }
  const valid = results.filter((r): r is { path: string; head: SignedHead } => r.head !== null);
  if (valid.length === 0) {
    if (ledger.head().seq === 0) return { ok: true, anchoredSeq: 0 };
    if (opts.allowMissing) return { ok: true, anchoredSeq: 0 };
    return { ok: false, reason: "head file missing for a non-empty ledger" };
  }
  let best = valid[0]!;
  for (const r of valid) {
    if (r.head.seq > best.head.seq) best = r;
  }
  const head = best.head;
  if (head.seq === 0) return { ok: true, anchoredSeq: 0 };

  const actual = ledger.head();
  if (actual.seq < head.seq) {
    return {
      ok: false,
      reason: `ledger is shorter than the published head at seq ${head.seq}, entries were deleted`,
    };
  }
  const row = ledger.entries(head.seq, 1)[0];
  if (!row || row.seq !== head.seq) {
    return {
      ok: false,
      reason: `ledger is shorter than the published head at seq ${head.seq}, entries were deleted`,
    };
  }
  if (row.hash !== head.hash) {
    return { ok: false, reason: `ledger entry at seq ${head.seq} differs from the published head` };
  }
  return { ok: true, anchoredSeq: head.seq };
}
