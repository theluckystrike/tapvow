import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  canonicalize,
  checkLedgerAgainstHeads,
  GENESIS_HASH,
  HeadAnchor,
  Ledger,
  signBytes,
  verifyBytes,
  verifyEntries,
  verifySignedHead,
  verifySignedMandate,
  type LedgerRow,
  type SignedHead,
  type SignedMandate,
  type Signer,
} from "@mandate/core";
import { readStoreId } from "@mandate/llm-rail";
import { readJson } from "./home.js";

export const PACK_FORMAT = "spendmandate-receipt-pack/v1";
const PACK_SIGNING_PREFIX = "spendmandate-pack/v1\n";
export const HEAD_FILES = ["ledger.head.json", "heads/ledger.head.json"] as const;

const PACK_KEYS = new Set([
  "format",
  "created_at",
  "store_id",
  "mandate",
  "public_keys",
  "entries",
  "head",
  "totals",
  "head_signature",
  "head_key_id",
  "signed_head",
]);
const SIGNED_MANDATE_KEYS = new Set(["mandate", "signature", "key_id"]);
const PUBLIC_KEYS_KEYS = new Set(["issuer", "ledger"]);
const LEDGER_ROW_KEYS = ["seq", "ts", "kind", "payload", "prev_hash", "hash", "key_id", "sig"] as const;
const LEDGER_ROW_KEY_SET = new Set<string>(LEDGER_ROW_KEYS);

/** The exact bytes the CLI and export use for a pack: JSON, two-space indent, no trailing newline. */
export function packText(pack: unknown): string {
  return JSON.stringify(pack, null, 2);
}

/**
 * True when raw is exactly the canonical pack text (so it carries no duplicate
 * JSON keys and no hand-edited formatting).
 */
export function isCanonicalPackText(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return raw.trimEnd() === packText(parsed);
}

export interface PackTotals {
  settled_micros: number;
  calls_settled: number;
  calls_denied: number;
  approvals: number;
}

export interface ReceiptPack {
  format: string;
  created_at: string;
  store_id: string;
  mandate: SignedMandate;
  public_keys: { issuer: string; ledger: Record<string, string> };
  entries: LedgerRow[];
  head: { seq: number; hash: string };
  totals: PackTotals;
  head_signature: string;
  head_key_id: string;
  /** The head that was last published outside the database, when a head file exists. */
  signed_head: SignedHead | null;
}

interface LedgerConfig {
  db: string;
}

interface StoredKey {
  key_id: string;
  public_key: string;
  private_key_pkcs8: string;
}

export function readLedgerRows(dbPath: string): LedgerRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "SELECT seq, ts, kind, payload, prev_hash, hash, key_id, sig FROM ledger_entries ORDER BY seq ASC",
      )
      .all() as unknown as LedgerRow[];
  } finally {
    db.close();
  }
}

function payloadOf(payload: string): Record<string, unknown> {
  try {
    const v = JSON.parse(payload);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isDenied(kind: string): boolean {
  // "…_capped" entries record that the ledger stopped counting denials; they
  // are not denials themselves and must never inflate the denial count.
  if (kind.endsWith("_capped")) return false;
  return kind.endsWith(".denied") || kind.endsWith(".blocked");
}

function isApproval(kind: string): boolean {
  return kind === "llm.approval" || kind.endsWith(".approval");
}

/** Reads the published signed head from the first head file, or null when it is absent. */
export function readPublishedHead(home: string): SignedHead | null {
  let raw: string;
  try {
    raw = readFileSync(join(home, HEAD_FILES[0]), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as SignedHead;
  } catch {
    return null;
  }
}

/**
 * The published head, verified against the trusted ledger keys. A head that does
 * not verify is not put in the pack, so the pack never carries a forged head.
 */
export function readVerifiedPublishedHead(
  home: string,
  trusted: Record<string, string>,
): SignedHead | null {
  const raw = readPublishedHead(home);
  if (!raw) return null;
  const v = verifySignedHead(raw, trusted);
  return v.ok ? v.head : null;
}

export function computeTotals(rows: Iterable<{ kind: string; payload: string }>, mandateId: string): PackTotals {
  const totals: PackTotals = { settled_micros: 0, calls_settled: 0, calls_denied: 0, approvals: 0 };
  for (const row of rows) {
    const p = payloadOf(row.payload);
    if (p.mandate_id !== mandateId) continue;
    if (row.kind.endsWith(".settle")) {
      const charged = p.charged_micros;
      totals.calls_settled += 1;
      if (typeof charged === "number" && Number.isFinite(charged)) totals.settled_micros += charged;
    } else if (isDenied(row.kind)) {
      totals.calls_denied += 1;
    } else if (isApproval(row.kind)) {
      totals.approvals += 1;
    }
  }
  return totals;
}

export function buildPack(args: { home: string }): ReceiptPack {
  const cfg = readJson<LedgerConfig>(join(args.home, "config.json"));
  const signed = readJson<SignedMandate>(join(args.home, "mandate.signed.json"));
  const publicKeys = readJson<{ issuer: string; ledger: Record<string, string> }>(
    join(args.home, "public-keys.json"),
  );
  const ledgerKey = readJson<StoredKey>(join(args.home, "ledger-key.json"));

  const rows = readLedgerRows(cfg.db);
  const storeId = readStoreId(cfg.db);
  const mandateId = signed.mandate.id;
  const totals = computeTotals(rows, mandateId);
  const last = rows.length > 0 ? rows[rows.length - 1]! : undefined;
  const head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
  const created_at = new Date().toISOString();

  const privateKey = createPrivateKey({
    key: Buffer.from(ledgerKey.private_key_pkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signer: Signer = { keyId: ledgerKey.key_id, privateKey };

  // Publish the current ledger head before reading it, so the pack carries the
  // head that is actually on disk (and repairs a mirror that lagged a commit).
  const anchor = new HeadAnchor(HEAD_FILES.map((p) => join(args.home, p)), signer, {
    trusted: publicKeys.ledger,
  });
  anchor.publish(head);
  const signed_head = readVerifiedPublishedHead(args.home, publicKeys.ledger);

  const message =
    PACK_SIGNING_PREFIX +
    canonicalize({ format: PACK_FORMAT, created_at, store_id: storeId, mandate_id: mandateId, head, totals });
  const head_signature = signBytes(privateKey, new TextEncoder().encode(message));

  return {
    format: PACK_FORMAT,
    created_at,
    store_id: storeId,
    mandate: signed,
    public_keys: publicKeys,
    entries: rows,
    head,
    totals,
    head_signature,
    head_key_id: ledgerKey.key_id,
    signed_head,
  };
}

export interface TrustedKeys {
  issuer: string;
  ledger: Record<string, string>;
}

export interface VerifySummary {
  entries: number;
  head_seq: number;
  head_hash: string;
  settled_micros: number;
  calls_settled: number;
  calls_denied: number;
  approvals: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKey(obj: Record<string, unknown>, allowed: Set<string>, prefix: string): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `${prefix}${key}: unknown field`;
  }
  return null;
}

export function verifyPack(
  pack: unknown,
  trusted: TrustedKeys,
): { ok: true; summary: VerifySummary } | { ok: false; reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

  if (!isRecord(pack)) return fail("pack: must be an object");
  const extraTop = unknownKey(pack, PACK_KEYS, "");
  if (extraTop) return fail(extraTop);
  if (pack.format !== PACK_FORMAT) return fail(`format: must be ${PACK_FORMAT}`);
  if (typeof pack.created_at !== "string") return fail("created_at: must be a string");
  if (typeof pack.store_id !== "string") return fail("store_id: must be a string");
  if (!isRecord(pack.mandate)) return fail("mandate: must be an object");
  const extraMandate = unknownKey(pack.mandate, SIGNED_MANDATE_KEYS, "mandate.");
  if (extraMandate) return fail(extraMandate);
  if (!isRecord(pack.public_keys)) return fail("public_keys: must be an object");
  const extraPublicKeys = unknownKey(pack.public_keys, PUBLIC_KEYS_KEYS, "public_keys.");
  if (extraPublicKeys) return fail(extraPublicKeys);
  if (!Array.isArray(pack.entries)) return fail("entries: must be an array");
  for (const entry of pack.entries) {
    if (!isRecord(entry)) return fail("entries: every entry must be an object");
    const extraEntry = unknownKey(entry, LEDGER_ROW_KEY_SET, "entry ");
    if (extraEntry) return fail(extraEntry);
  }
  if (!isRecord(pack.head) || typeof pack.head.seq !== "number" || typeof pack.head.hash !== "string") {
    return fail("head: must be {seq, hash}");
  }
  if (!isRecord(pack.totals)) return fail("totals: must be an object");
  for (const field of ["settled_micros", "calls_settled", "calls_denied", "approvals"] as const) {
    if (typeof (pack.totals as Record<string, unknown>)[field] !== "number") {
      return fail(`totals.${field}: must be a number`);
    }
  }
  if (typeof pack.head_signature !== "string") return fail("head_signature: must be a string");
  if (typeof pack.head_key_id !== "string") return fail("head_key_id: must be a string");

  const publicKeys = pack.public_keys as Record<string, unknown>;
  if (typeof publicKeys.issuer !== "string") return fail("public_keys.issuer: must be a string");
  if (!isRecord(publicKeys.ledger)) return fail("public_keys.ledger: must be an object");
  const ledgerKeys = publicKeys.ledger as Record<string, unknown>;
  const entries = pack.entries as LedgerRow[];
  const headKeyId = pack.head_key_id;
  const signedHeadRaw = (pack as { signed_head?: unknown }).signed_head;

  // 2. The pack's keys must be exactly the trusted ones.
  if (publicKeys.issuer !== trusted.issuer) return fail("issuer key in the pack does not match the trusted key");
  const used = new Set<string>([headKeyId]);
  if (isRecord(signedHeadRaw) && typeof (signedHeadRaw as { key_id?: unknown }).key_id === "string") {
    used.add((signedHeadRaw as { key_id: string }).key_id);
  }
  for (const e of entries) {
    if (isRecord(e) && typeof (e as { key_id?: unknown }).key_id === "string") used.add((e as { key_id: string }).key_id);
  }
  for (const id of used) {
    const inPack = ledgerKeys[id];
    if (typeof inPack !== "string") return fail(`public key ${id} is missing from the pack`);
    if (trusted.ledger[id] !== inPack) return fail(`public key ${id} does not match the trusted key`);
  }
  // Every key the pack carries must be one the operator trusts.
  for (const id of Object.keys(ledgerKeys)) {
    if (!Object.prototype.hasOwnProperty.call(trusted.ledger, id)) {
      return fail(`public key ${id} is not a trusted ledger key`);
    }
    if (trusted.ledger[id] !== ledgerKeys[id]) return fail(`public key ${id} does not match the trusted key`);
  }

  // 3. The signed mandate must verify against the trusted issuer.
  const signed = verifySignedMandate(pack.mandate, trusted.issuer);
  if (!signed.ok) return fail(`mandate: ${signed.reason}`);
  const mandateId = signed.mandate.id;

  // 4. The whole chain, ending at the head the pack claims.
  const v = verifyEntries(entries, trusted.ledger, pack.head as { seq: number; hash: string });
  if (!v.ok) return fail(`ledger: ${v.reason}`);

  // 4b. The published signed head, when the pack carries one.
  if (signedHeadRaw !== undefined && signedHeadRaw !== null) {
    const vh = verifySignedHead(signedHeadRaw, trusted.ledger);
    if (!vh.ok) return fail(`signed_head: ${vh.reason}`);
    const sh = vh.head;
    if (sh.seq > (pack.head as { seq: number }).seq) return fail("signed_head: is ahead of the pack head");
    if (sh.seq > 0) {
      const row = entries.find((e) => e.seq === sh.seq);
      if (!row) return fail(`signed_head: seq ${sh.seq} is not in the entries`);
      if (row.hash !== sh.hash) return fail(`signed_head: entry at seq ${sh.seq} differs from the published head`);
    }
  }

  // 5. The head signature, by the key the pack names.
  const headKey = trusted.ledger[headKeyId];
  if (typeof headKey !== "string") return fail(`head_key_id ${headKeyId} is not trusted`);
  const message =
    PACK_SIGNING_PREFIX +
    canonicalize({
      format: pack.format,
      created_at: pack.created_at,
      store_id: pack.store_id,
      mandate_id: mandateId,
      head: pack.head,
      totals: pack.totals,
    });
  if (!verifyBytes(headKey, new TextEncoder().encode(message), pack.head_signature as string)) {
    return fail("head_signature: signature verification failed");
  }

  // 6. The ledger must carry this exact mandate version. The latest mandate
  // entry (registered, updated or passkey-protected) is the authoritative one.
  let latestKind: string | null = null;
  let latestMandate: unknown = null;
  for (const e of entries) {
    if (e.kind !== "mandate.registered" && e.kind !== "mandate.updated" && e.kind !== "mandate.protected") continue;
    const p = payloadOf(e.payload);
    const m = p.mandate;
    if (isRecord(m) && m.id === mandateId) {
      latestKind = e.kind;
      latestMandate = m;
    }
  }
  if (latestKind === null) return fail(`no registration entry for mandate ${mandateId}`);
  if (latestKind === "mandate.protected") {
    return fail("the latest mandate entry is passkey-protected, this pack carries an Ed25519 mandate");
  }
  if (canonicalize(latestMandate) !== canonicalize(signed.mandate)) {
    return fail("the registered mandate differs from the pack mandate");
  }

  // 7. A bound mandate names the same store.
  if (signed.mandate.store_id !== undefined && signed.mandate.store_id !== pack.store_id) {
    return fail("the mandate store_id differs from pack.store_id");
  }

  // 8. The totals must match the entries.
  const recomputed = computeTotals(entries, mandateId);
  if (canonicalize(recomputed) !== canonicalize(pack.totals)) {
    return fail("totals do not match the entries");
  }

  return {
    ok: true,
    summary: {
      entries: entries.length,
      head_seq: (pack.head as { seq: number }).seq,
      head_hash: (pack.head as { hash: string }).hash,
      settled_micros: recomputed.settled_micros,
      calls_settled: recomputed.calls_settled,
      calls_denied: recomputed.calls_denied,
      approvals: recomputed.approvals,
    },
  };
}

export interface LiveVerifySummary {
  anchoredSeq: number;
  entries: number;
  headSeq: number;
}

/**
 * Verifies the live database in a home against the signed head files and the
 * full chain, without writing anything. This is what catches a shortened
 * ledger: the last entries are gone, but the head file outside the database
 * is not.
 */
export function verifyLive(
  home: string,
): { ok: true; summary: LiveVerifySummary } | { ok: false; reason: string } {
  let cfg: { db: string };
  let publicKeys: { issuer: string; ledger: Record<string, string> };
  try {
    cfg = readJson<{ db: string }>(join(home, "config.json"));
    publicKeys = readJson<{ issuer: string; ledger: Record<string, string> }>(
      join(home, "public-keys.json"),
    );
  } catch (err) {
    return { ok: false, reason: `home: ${err instanceof Error ? err.message : String(err)}` };
  }

  let ledger: Ledger;
  try {
    ledger = Ledger.openReadOnly(cfg.db);
  } catch (err) {
    return { ok: false, reason: `database: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const trusted = publicKeys.ledger;
    const anchor = new HeadAnchor(HEAD_FILES.map((p) => join(home, p)));
    const check = checkLedgerAgainstHeads(ledger, trusted, anchor.readAll(trusted), {
      allowMissing: false,
    });
    if (!check.ok) return { ok: false, reason: check.reason };
    const v = ledger.verify(trusted);
    if (!v.ok) return { ok: false, reason: `ledger: ${v.reason} at seq ${v.firstBadSeq}` };
    return {
      ok: true,
      summary: { anchoredSeq: check.anchoredSeq, entries: v.checked, headSeq: ledger.head().seq },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    ledger.close();
  }
}
