// Binds a signed Mandate (from @mandate/core) to the LLM rail: the mandate
// becomes the budget policy, and every settlement is written to the signed
// hash-chain ledger inside the same SQLite transaction as the budget update,
// so the ledger and the budget can never disagree.
import { createPublicKey } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalize,
  checkLedgerAgainstHeads,
  HeadAnchor,
  Ledger,
  parseUsd,
  verifySignedMandate,
  type Mandate,
  type SignedHead,
  type Signer,
} from "@mandate/core";
import {
  mandateHash,
  verifyPasskeyMandate,
  type PasskeySignedMandate,
  type TrustedCredential,
} from "@mandate/passkey";
import { BudgetStore, type DecisionEvent, type Policy, type SettleEvent } from "./store.js";

export function policyFromMandate(m: Mandate): Policy {
  return {
    mandateId: m.id,
    budgetMicros: parseUsd(m.budget.total),
    budgetPeriod: m.budget.period,
    perCallCapMicros: parseUsd(m.per_call_cap),
    approvalThresholdMicros: parseUsd(m.approval_threshold),
    allowedProviders: m.rails.includes("llm")
      ? m.allowed_payees.filter((p) => p.rail === "llm").map((p) => p.id)
      : [],
    rateLimit: { maxCalls: m.rate_limit.max_calls, windowSeconds: m.rate_limit.window_seconds },
    notBefore: m.not_before,
    expiresAt: m.expires_at,
    agents: [...m.agents],
    issuedAt: m.created_at,
    rails: [...m.rails],
  };
}

export interface GovernedRail {
  store: BudgetStore;
  ledger: Ledger;
  mandate: Mandate;
  /**
   * The public keys (by key id) trusted to verify this rail's ledger. Public
   * keys only; the signing key is never kept here.
   */
  trustedLedgerKeys: Record<string, string>;
  issueAgentKey(agentId: string): string;
  /** Publish the current ledger head outside the database now. Null when no head files are configured. */
  publishHead(): SignedHead | null;
  close(): void;
}

interface HeadState {
  ledger: Ledger | null;
  anchor: HeadAnchor | null;
  lastSeq: number;
}

function publishHeadFrom(state: HeadState): SignedHead | null {
  if (!state.anchor || !state.ledger) return null;
  try {
    const written = state.anchor.publish(state.ledger.head());
    state.lastSeq = written.seq;
    return written;
  } catch {
    // a failed publish must not lose the committed entry; the next one repairs it
    return null;
  }
}

/** Publish only when the ledger head moved past the last published seq. */
function maybePublishFrom(state: HeadState): void {
  if (!state.anchor || !state.ledger) return;
  if (state.ledger.head().seq === state.lastSeq) return;
  publishHeadFrom(state);
}

/**
 * Reads the head files and refuses to go on when the ledger does not contain
 * the highest published head. Runs before any write at open (before crash
 * recovery sweeps or the register step), so a shortened ledger never starts.
 */
function anchorLedger(args: {
  headFiles?: string[];
  allowMissingHead?: boolean;
  ledger: Ledger;
  signer: Signer;
  onHeadPublishError?: (path: string, err: Error) => void;
}): HeadAnchor | null {
  if (!args.headFiles || args.headFiles.length === 0) return null;
  const trusted = { [args.signer.keyId]: ledgerPublicKey(args.signer) };
  const anchor = new HeadAnchor(args.headFiles, args.signer, {
    trusted,
    onPublishError: args.onHeadPublishError,
  });
  const check = checkLedgerAgainstHeads(args.ledger, trusted, anchor.readAll(trusted), {
    allowMissing: args.allowMissingHead === true,
  });
  if (!check.ok) throw new Error(`ledger rejected: ${check.reason}`);
  return anchor;
}

/**
 * Opens the budget store and the ledger on one database file.
 * signedMandate must verify against trustedIssuerKey, the issuer's public key
 * that the operator configured; a key found only inside the document is never trusted.
 * ledgerSigner signs every ledger entry (the gateway's own key).
 */
export function openGovernedRail(args: {
  dbPath: string;
  signedMandate: unknown;
  trustedIssuerKey: string;
  ledgerSigner: Signer;
  now?: () => number;
  /** Refuse a mandate that does not name this database's store_id. Default false. */
  requireStoreBinding?: boolean;
  /**
   * One to four paths to keep the signed ledger head in, outside the database.
   * When set, the ledger is checked against them at open and the head is
   * republished after every commit. Extra paths are mirrors.
   */
  headFiles?: string[];
  /** Accept a non-empty ledger with no head file (adopt it). Default false. */
  allowMissingHead?: boolean;
  /**
   * Called the first time publishing the head to one path fails. A failed
   * publish never blocks the commit; the mirror is repaired on a later publish.
   */
  onHeadPublishError?: (path: string, err: Error) => void;
}): GovernedRail {
  const v = verifySignedMandate(args.signedMandate, args.trustedIssuerKey);
  if (!v.ok) throw new Error(`mandate rejected: ${v.reason}`);
  const mandate = v.mandate;

  let ledger: Ledger | null = null;
  const head: HeadState = { ledger: null, anchor: null, lastSeq: -1 };
  const store = new BudgetStore(args.dbPath, {
    now: args.now,
    afterSettleInTx: (_db, ev: SettleEvent) => {
      ledger!.append(`${ev.rail}.settle`, settlementPayload(ev), { inTransaction: true, ts: ev.ts });
    },
    afterDecisionInTx: (_db, ev: DecisionEvent) => {
      appendDecision(ledger!, ev);
    },
    afterCommit: () => maybePublishFrom(head),
  });
  try {
    ledger = new Ledger(store.database, args.ledgerSigner, () => maybePublishFrom(head));
    ledger.init();
    ensurePasskeyTables(store.database);
    head.ledger = ledger;
    head.anchor = anchorLedger({
      headFiles: args.headFiles,
      allowMissingHead: args.allowMissingHead,
      ledger,
      signer: args.ledgerSigner,
      onHeadPublishError: args.onHeadPublishError,
    });

    const sm = args.signedMandate as { signature: string; key_id: string };
    return finishGovernedRail({
      store,
      ledger,
      mandate,
      ledgerSigner: args.ledgerSigner,
      requireStoreBinding: args.requireStoreBinding,
      head,
      register: () => {
        // A mandate protected by a passkey (a row in the unsigned table, or a
        // signed ledger entry with auth "passkey") may only ever be changed by a
        // passkey assertion; a (possibly valid) Ed25519 signature is never
        // enough. Checked inside the transaction, before any write.
        if (isPasskeyProtected(store.database, ledger!, mandate.id)) {
          throw new Error(
            `mandate rejected: ${mandate.id} is protected by a passkey, an edit needs a passkey assertion`,
          );
        }
        // Every policy change is written to the ledger, and a mandate older than
        // the stored one is refused (no silent rollback).
        const existing = store.getPolicy(mandate.id);
        const next = policyFromMandate(mandate);
        const entry = { mandate, mandate_signature: sm.signature, mandate_key_id: String(sm.key_id), store_id: store.storeId };
        if (!existing) {
          store.upsertMandate(next);
          ledger!.append("mandate.registered", entry, { inTransaction: true });
        } else if (canonicalize(existing) !== canonicalize(next)) {
          if (!existing.issuedAt || Date.parse(mandate.created_at) <= Date.parse(existing.issuedAt)) {
            throw new Error(`mandate rejected: ${mandate.id} differs from the registered version and is not newer (created_at)`);
          }
          store.upsertMandate(next);
          ledger!.append("mandate.updated", entry, { inTransaction: true });
        }
      },
    });
  } catch (err) {
    store.close();
    throw err;
  }
}

/**
 * Opens the budget store and the ledger on one database file, verifying the
 * mandate with a passkey assertion instead of an Ed25519 signature. A mandate
 * registered here is passkey-protected: openGovernedRail refuses to touch it.
 */
export async function openGovernedRailWithPasskey(args: {
  dbPath: string;
  signedMandate: unknown;
  passkey: {
    credentials: TrustedCredential[];
    rpID: string;
    origin: string | string[];
    audience: string;
    maxValidityMs?: number;
  };
  ledgerSigner: Signer;
  now?: () => number;
  /** Refuse a mandate that does not name this database's store_id. Default false. */
  requireStoreBinding?: boolean;
  /** One to four paths to keep the signed ledger head in, outside the database. */
  headFiles?: string[];
  /** Accept a non-empty ledger with no head file (adopt it). Default false. */
  allowMissingHead?: boolean;
  /**
   * Called the first time publishing the head to one path fails. A failed
   * publish never blocks the commit; the mirror is repaired on a later publish.
   */
  onHeadPublishError?: (path: string, err: Error) => void;
}): Promise<GovernedRail> {
  let ledger: Ledger | null = null;
  const head: HeadState = { ledger: null, anchor: null, lastSeq: -1 };
  const store = new BudgetStore(args.dbPath, {
    now: args.now,
    afterSettleInTx: (_db, ev: SettleEvent) => {
      ledger!.append(`${ev.rail}.settle`, settlementPayload(ev), { inTransaction: true, ts: ev.ts });
    },
    afterDecisionInTx: (_db, ev: DecisionEvent) => {
      appendDecision(ledger!, ev);
    },
    afterCommit: () => maybePublishFrom(head),
  });
  try {
    ledger = new Ledger(store.database, args.ledgerSigner, () => maybePublishFrom(head));
    ledger.init();
    ensurePasskeyTables(store.database);
    head.ledger = ledger;
    head.anchor = anchorLedger({
      headFiles: args.headFiles,
      allowMissingHead: args.allowMissingHead,
      ledger,
      signer: args.ledgerSigner,
      onHeadPublishError: args.onHeadPublishError,
    });

    const mandateId = passkeyMandateId(args.signedMandate);
    if (mandateId === null) {
      throw new Error("mandate rejected: unsigned or malformed passkey mandate");
    }
    const doc = args.signedMandate as PasskeySignedMandate;
    const registered = getPasskeyMandate(store.database, mandateId);
    const signature = assertionSignatureOf(args.signedMandate);
    const now = args.now ?? Date.now;

    // A restart reopens with the exact document already in the ledger: replay it
    // with a zero counter (the stored one has moved past this assertion) and
    // write nothing. The document may have expired since it was signed, so the
    // restart path skips the freshness window the ledger entry is the truth.
    if (
      registered &&
      signature !== null &&
      signature === registered.assertion_signature &&
      mandateHashOf(doc.mandate) === registered.mandate_hash
    ) {
      const credentials = args.passkey.credentials.map((c) =>
        c.id === registered.credential_id ? { ...c, counter: 0 } : c,
      );
      const replayed = await verifyPasskeyMandate(doc, {
        credentials,
        rpID: args.passkey.rpID,
        origin: args.passkey.origin,
        expectedPrevHash: doc.prev_hash,
        audience: args.passkey.audience,
        now,
        checkExpiry: false,
      });
      if (!replayed.ok) throw new Error(`mandate rejected: ${replayed.reason}`);
      return finishGovernedRail({
        store,
        ledger,
        mandate: replayed.mandate,
        ledgerSigner: args.ledgerSigner,
        requireStoreBinding: args.requireStoreBinding,
        head,
        register: () => {},
      });
    }

    const registeredHash = registered ? registered.mandate_hash : null;
    const counters = getPasskeyCounters(store.database);
    const credentials = args.passkey.credentials.map((c) => ({
      ...c,
      counter: Math.max(c.counter, counters.get(c.id) ?? 0),
    }));
    const before = passkeyStateSnapshot(store.database);
    const verified = await verifyPasskeyMandate(doc, {
      credentials,
      rpID: args.passkey.rpID,
      origin: args.passkey.origin,
      expectedPrevHash: registeredHash,
      audience: args.passkey.audience,
      now,
      maxValidityMs: args.passkey.maxValidityMs,
    });
    if (!verified.ok) throw new Error(`mandate rejected: ${verified.reason}`);

    const signedSignature = verified.doc.assertion.response.signature;
    const id = verified.mandate.id;
    const docHash = mandateHash(verified.mandate);
    return finishGovernedRail({
      store,
      ledger,
      mandate: verified.mandate,
      ledgerSigner: args.ledgerSigner,
      requireStoreBinding: args.requireStoreBinding,
      head,
      register: () => {
        if (passkeyStateSnapshot(store.database) !== before) {
          throw new Error("mandate rejected: concurrent mandate change, retry");
        }
        const existing = store.getPolicy(id);
        const next = policyFromMandate(verified.mandate);
        const policyEqual = existing !== null && canonicalize(existing) === canonicalize(next);
        const entry = {
          mandate: verified.mandate,
          auth: "passkey",
          credential_id: verified.credentialId,
          prev_hash: doc.prev_hash,
          nonce: doc.nonce,
          counter: verified.newCounter,
          assertion: doc.assertion,
          store_id: store.storeId,
        };
        const write = (kind: "mandate.registered" | "mandate.updated" | "mandate.protected"): void => {
          store.upsertMandate(next);
          upsertPasskeyMandate(store.database, {
            mandate_id: id,
            mandate_hash: docHash,
            credential_id: verified.credentialId,
            assertion_signature: signedSignature,
            issuer_id: verified.mandate.issuer.id,
          });
          upsertPasskeyCounter(store.database, verified.credentialId, verified.newCounter);
          ledger!.append(kind, entry, { inTransaction: true });
        };
        const assertNewer = (): void => {
          if (!existing || !existing.issuedAt || Date.parse(verified.mandate.created_at) <= Date.parse(existing.issuedAt)) {
            throw new Error(`mandate rejected: ${id} differs from the registered version and is not newer (created_at)`);
          }
        };

        if (registered) {
          // An existing passkey mandate never changes issuer.
          if (registered.issuer_id !== verified.mandate.issuer.id) {
            throw new Error(`mandate rejected: ${id} belongs to another issuer`);
          }
          if (docHash === registered.mandate_hash) return;
          if (policyEqual) {
            throw new Error(
              `mandate rejected: ${id} passkey document differs from the registered one but changes nothing`,
            );
          }
          assertNewer();
          write("mandate.updated");
          return;
        }

        // No passkey row yet: a first passkey registration or an upgrade of a
        // mandate the Ed25519 path already registered. The issuer named in the
        // signed ledger is authoritative, so the passkey cannot take it over.
        const prior = lastRegisteredMandate(ledger!, id);
        if (
          prior &&
          (prior.issuer.id !== verified.mandate.issuer.id ||
            prior.issuer.public_key !== verified.mandate.issuer.public_key)
        ) {
          throw new Error(`mandate rejected: ${id} belongs to another issuer`);
        }
        if (existing && !policyEqual) assertNewer();
        // Always persist the protection, even when the policy is unchanged: an
        // upgrade from Ed25519 must not silently do nothing.
        write(policyEqual ? "mandate.protected" : existing ? "mandate.updated" : "mandate.registered");
      },
    });
  } catch (err) {
    store.close();
    throw err;
  }
}

/**
 * Everything that happens after a mandate has verified, whatever the signing
 * scheme: apply the register/update step, recover crashed reservations,
 * cross-check the budget tables against the signed ledger in one transaction,
 * and hand back the rail.
 */
function finishGovernedRail(args: {
  store: BudgetStore;
  ledger: Ledger;
  mandate: Mandate;
  ledgerSigner: Signer;
  requireStoreBinding?: boolean;
  head: HeadState;
  register: () => void;
}): GovernedRail {
  // Crash recovery: reservations a dead gateway left open for over 15 minutes
  // are booked at full cost (fail closed) so they show up in the ledger.
  args.store.sweepStale(15 * 60_000);

  const trustedLedgerKeys = { [args.ledgerSigner.keyId]: ledgerPublicKey(args.ledgerSigner) };

  // The register/update step and the budget-vs-ledger audit share one
  // transaction: a failed audit throws before the COMMIT, rolling the writes
  // back, so a gateway never starts on a policy (or passkey protection) that the
  // signed ledger does not back. One BEGIN IMMEDIATE also means a second live
  // gateway cannot settle mid-audit.
  args.store.transaction(() => {
    // A signed mandate can name the database it may spend from. Checked before
    // any write, so a replay against another file leaves no policy or ledger row.
    if (args.mandate.store_id !== undefined) {
      if (args.mandate.store_id !== args.store.storeId) {
        throw new Error(
          `mandate rejected: ${args.mandate.id} is bound to store ${args.mandate.store_id}, this database is ${args.store.storeId}`,
        );
      }
    } else if (args.requireStoreBinding === true) {
      throw new Error(
        `mandate rejected: ${args.mandate.id} has no store_id, this gateway requires a store-bound mandate`,
      );
    }
    args.register();
    const audit = auditRail(args.store, args.ledger, args.mandate.id, trustedLedgerKeys);
    if (!audit.ok) throw new Error(`rail audit failed: ${audit.reason}`);
  });

  // The register/update entry (and any sweep) is committed; publish the head so
  // the outside file matches the ledger from the moment the gateway is usable.
  maybePublishFrom(args.head);

  return {
    store: args.store,
    ledger: args.ledger,
    mandate: args.mandate,
    trustedLedgerKeys,
    issueAgentKey(agentId: string): string {
      if (!args.mandate.agents.includes(agentId)) {
        throw new Error(`agent ${agentId} is not named in mandate ${args.mandate.id}`);
      }
      return args.store.createAgentKey(args.mandate.id, agentId);
    },
    publishHead: () => publishHeadFrom(args.head),
    close(): void {
      // Best effort: publish the head once more before the store goes away.
      maybePublishFrom(args.head);
      args.store.close();
    },
  };
}

/** Opens the database, reads its stable store id and closes it again (used to sign a bound mandate). */
export function readStoreId(dbPath: string): string {
  const store = new BudgetStore(dbPath);
  try {
    return store.storeId;
  } finally {
    store.close();
  }
}

interface PasskeyMandateRow {
  mandate_id: string;
  mandate_hash: string;
  credential_id: string;
  assertion_signature: string;
  issuer_id: string;
}

function ensurePasskeyTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkey_mandates (
      mandate_id TEXT PRIMARY KEY,
      mandate_hash TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      assertion_signature TEXT NOT NULL,
      issuer_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkey_counters (
      credential_id TEXT PRIMARY KEY,
      counter INTEGER NOT NULL
    );
  `);
}

function passkeyMandateId(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const mandate = (doc as { mandate?: unknown }).mandate;
  if (typeof mandate !== "object" || mandate === null || Array.isArray(mandate)) return null;
  const id = (mandate as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function assertionSignatureOf(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const assertion = (doc as { assertion?: unknown }).assertion;
  if (typeof assertion !== "object" || assertion === null || Array.isArray(assertion)) return null;
  const response = (assertion as { response?: unknown }).response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
  const signature = (response as { signature?: unknown }).signature;
  return typeof signature === "string" ? signature : null;
}

function mandateHashOf(mandate: unknown): string | null {
  try {
    return mandateHash(mandate as Mandate);
  } catch {
    return null;
  }
}

function getPasskeyMandate(db: DatabaseSync, mandateId: string): PasskeyMandateRow | null {
  const row = db
    .prepare(
      "SELECT mandate_id, mandate_hash, credential_id, assertion_signature, issuer_id FROM passkey_mandates WHERE mandate_id = ?",
    )
    .get(mandateId) as PasskeyMandateRow | undefined;
  return row ?? null;
}

function getPasskeyCounters(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare("SELECT credential_id, counter FROM passkey_counters").all() as Array<{
    credential_id: string;
    counter: number;
  }>;
  return new Map(rows.map((r) => [r.credential_id, r.counter]));
}

function passkeyStateSnapshot(db: DatabaseSync): string {
  const mandates = db
    .prepare(
      "SELECT mandate_id, mandate_hash, credential_id, assertion_signature, issuer_id FROM passkey_mandates ORDER BY mandate_id",
    )
    .all();
  const counters = db.prepare("SELECT credential_id, counter FROM passkey_counters ORDER BY credential_id").all();
  return canonicalize({ mandates, counters });
}

function upsertPasskeyMandate(db: DatabaseSync, row: PasskeyMandateRow): void {
  db.prepare(
    `INSERT INTO passkey_mandates(mandate_id, mandate_hash, credential_id, assertion_signature, issuer_id)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(mandate_id) DO UPDATE SET
       mandate_hash = excluded.mandate_hash,
       credential_id = excluded.credential_id,
       assertion_signature = excluded.assertion_signature,
       issuer_id = excluded.issuer_id`,
  ).run(row.mandate_id, row.mandate_hash, row.credential_id, row.assertion_signature, row.issuer_id);
}

function upsertPasskeyCounter(db: DatabaseSync, credentialId: string, counter: number): void {
  db.prepare(
    `INSERT INTO passkey_counters(credential_id, counter) VALUES(?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET counter = excluded.counter`,
  ).run(credentialId, counter);
}

/** Every ledger kind that records a mandate version (passkey or Ed25519). */
export const MANDATE_KINDS: ReadonlySet<string> = new Set([
  "mandate.registered",
  "mandate.updated",
  "mandate.protected",
]);

/**
 * A mandate is passkey-protected when either the unsigned passkey table has a
 * row or the signed ledger says so. Reading the ledger closes the hole where
 * deleting the row would let a (valid) Ed25519 signature rewrite the mandate.
 */
function isPasskeyProtected(db: DatabaseSync, ledger: Ledger, mandateId: string): boolean {
  const row = db.prepare("SELECT mandate_id FROM passkey_mandates WHERE mandate_id = ?").get(mandateId);
  if (row) return true;
  for (const e of ledger.entries()) {
    if (!MANDATE_KINDS.has(e.kind)) continue;
    const p = e.payload as { auth?: unknown; mandate?: unknown };
    if (p.auth !== "passkey") continue;
    const m = p.mandate;
    if (typeof m === "object" && m !== null && (m as { id?: unknown }).id === mandateId) return true;
  }
  return false;
}

/**
 * The mandate named by the last mandate.registered/mandate.updated entry for
 * the id, used to refuse an issuer takeover when there is no passkey row.
 */
function lastRegisteredMandate(ledger: Ledger, mandateId: string): Mandate | null {
  let found: Mandate | null = null;
  for (const e of ledger.entries()) {
    if (e.kind !== "mandate.registered" && e.kind !== "mandate.updated") continue;
    const m = (e.payload as { mandate?: unknown }).mandate;
    if (typeof m === "object" && m !== null && (m as { id?: unknown }).id === mandateId) {
      found = m as Mandate;
    }
  }
  return found;
}

export const SETTLE_KINDS: ReadonlySet<string> = new Set(["llm.settle", "x402.settle", "stripe_spt.settle"]);
/** Ledger kinds written for a deny, a human approval decision or a cap marker. */
export const DECISION_KINDS: ReadonlySet<string> = new Set([
  "llm.denied",
  "llm.approval",
  "llm.denials_capped",
]);

function appendDecision(ledger: Ledger, ev: DecisionEvent): void {
  if (ev.kind === "denied") {
    ledger.append(
      "llm.denied",
      {
        rail: "llm",
        mandate_id: ev.mandateId,
        agent_id: ev.agentId,
        payee: ev.provider,
        model: ev.model,
        amount_micros: ev.amountMicros,
        code: ev.code,
        reason: ev.reason,
      },
      { inTransaction: true, ts: ev.ts },
    );
    return;
  }
  if (ev.kind === "capped") {
    // One marker stands in for the denials a per-agent cap suppressed, so the
    // ledger records that the agent was still being denied, not silently dropped.
    ledger.append(
      "llm.denials_capped",
      {
        rail: "llm",
        mandate_id: ev.mandateId,
        agent_id: ev.agentId,
        scope: ev.scope,
        period_start: ev.periodStart,
        cap: ev.cap,
      },
      { inTransaction: true, ts: ev.ts },
    );
    return;
  }
  ledger.append(
    `${ev.rail}.approval`,
    {
      rail: ev.rail,
      mandate_id: ev.mandateId,
      agent_id: ev.agentId,
      payee: ev.provider,
      model: ev.model,
      amount_micros: ev.amountMicros,
      decision: ev.decision,
      request_id: ev.requestId,
      decided_by: ev.decidedBy,
    },
    { inTransaction: true, ts: ev.ts },
  );
}

function settlementPayload(ev: SettleEvent) {
  if (ev.rail === "stripe_spt") {
    return {
      rail: "stripe_spt",
      reservation_id: ev.reservationId,
      mandate_id: ev.mandateId,
      agent_id: ev.agentId,
      payee: ev.provider,
      asset: ev.model,
      outcome: ev.outcome,
      reserved_micros: ev.reservedMicros,
      charged_micros: ev.chargedMicros,
      overrun: ev.overrun,
      details: ev.details ?? null,
    };
  }
  if (ev.rail === "x402") {
    return {
      rail: "x402",
      reservation_id: ev.reservationId,
      mandate_id: ev.mandateId,
      agent_id: ev.agentId,
      payee: ev.provider,
      asset: ev.model,
      outcome: ev.outcome,
      reserved_micros: ev.reservedMicros,
      charged_micros: ev.chargedMicros,
      overrun: ev.overrun,
      details: ev.details ?? null,
    };
  }
  return {
    rail: "llm",
    reservation_id: ev.reservationId,
    mandate_id: ev.mandateId,
    agent_id: ev.agentId,
    payee: ev.provider,
    model: ev.model,
    outcome: ev.outcome,
    reserved_micros: ev.reservedMicros,
    charged_micros: ev.chargedMicros,
    overrun: ev.overrun,
    usage: ev.usage
      ? {
          input_tokens: ev.usage.inputTokens,
          output_tokens: ev.usage.outputTokens,
          cached_input_tokens: ev.usage.cachedInputTokens,
          cache_write_tokens: ev.usage.cacheWriteTokens ?? 0,
          // Only present when the upstream reported reasoning tokens, so old
          // payload shapes stay byte-identical.
          ...(typeof ev.usage.reasoningTokens === "number" && ev.usage.reasoningTokens > 0
            ? { reasoning_tokens: ev.usage.reasoningTokens }
            : {}),
        }
      : null,
    // Only present for a call a human approved, so old payload shapes stay the same.
    ...(typeof ev.approvalId === "string" && ev.approvalId.length > 0
      ? { approval_request_id: ev.approvalId }
      : {}),
    // Only present when the gateway recorded how the charge was priced.
    ...(ev.details !== undefined ? { details: ev.details } : {}),
  };
}

function ledgerPublicKey(signer: Signer): string {
  const der = createPublicKey(signer.privateKey).export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32).toString("base64url");
}

/**
 * Verifies the ledger chain and checks that every settled reservation in the
 * budget tables has a matching signed ledger entry with the same charge, and
 * the reverse. Editing charged_micros in SQLite to free budget makes this fail.
 */
export function auditRail(
  store: BudgetStore,
  ledger: Ledger,
  mandateId: string,
  trusted: Record<string, string>,
): { ok: true; settledMicros: number } | { ok: false; reason: string } {
  const v = ledger.verify(trusted);
  if (!v.ok) return { ok: false, reason: `ledger: ${v.reason} at seq ${v.firstBadSeq}` };

  // store_meta is unsigned, so the signed ledger is the authority: if a mandate
  // entry names a store id, this database must still be that store.
  let latestStoreId: string | null = null;
  for (const e of ledger.entries()) {
    if (!MANDATE_KINDS.has(e.kind)) continue;
    const p = e.payload as { store_id?: unknown; mandate?: unknown };
    if (typeof p.store_id !== "string") continue;
    const m = p.mandate;
    if (typeof m !== "object" || m === null || (m as { id?: unknown }).id !== mandateId) continue;
    latestStoreId = p.store_id;
  }
  if (latestStoreId !== null && latestStoreId !== store.storeId) {
    return { ok: false, reason: "store id differs from the ledger" };
  }

  // The passkey protection table is unsigned, so cross-check it against the
  // signed ledger: the latest passkey entry for this mandate must match the
  // row, and a passkey entry with no row means the table was tampered with.
  let latestPasskey: { mandate: Mandate; credentialId: string } | null = null;
  for (const e of ledger.entries()) {
    if (!MANDATE_KINDS.has(e.kind)) continue;
    const p = e.payload as { auth?: unknown; mandate?: unknown; credential_id?: unknown };
    if (p.auth !== "passkey") continue;
    const m = p.mandate;
    if (typeof m !== "object" || m === null || (m as { id?: unknown }).id !== mandateId) continue;
    latestPasskey = {
      mandate: m as Mandate,
      credentialId: typeof p.credential_id === "string" ? p.credential_id : "",
    };
  }
  const passkeyRow = store.database
    .prepare("SELECT mandate_hash, credential_id, issuer_id FROM passkey_mandates WHERE mandate_id = ?")
    .get(mandateId) as { mandate_hash: string; credential_id: string; issuer_id: string } | undefined;
  if (latestPasskey) {
    if (!passkeyRow) return { ok: false, reason: "passkey protection table differs from the ledger" };
    if (
      passkeyRow.mandate_hash !== mandateHash(latestPasskey.mandate) ||
      passkeyRow.credential_id !== latestPasskey.credentialId ||
      passkeyRow.issuer_id !== latestPasskey.mandate.issuer.id
    ) {
      return { ok: false, reason: "passkey protection table differs from the ledger" };
    }
  }

  const fromLedger = new Map<string, { charged: number; outcome: string; rail: string }>();
  for (const e of ledger.entries()) {
    if (!SETTLE_KINDS.has(e.kind)) continue;
    const p = e.payload as { reservation_id: string; mandate_id: string; charged_micros: number; outcome: string };
    if (p.mandate_id === mandateId) fromLedger.set(p.reservation_id, { charged: p.charged_micros, outcome: p.outcome, rail: e.kind.split(".")[0]! });
  }
  const rows = store.database
    .prepare("SELECT id, charged_micros, status, rail FROM reservations WHERE mandate_id = ? AND status <> 'reserved'")
    .all(mandateId) as Array<{ id: string; charged_micros: number; status: string; rail: string }>;
  if (rows.length !== fromLedger.size) {
    return { ok: false, reason: `budget has ${rows.length} settled reservations, ledger has ${fromLedger.size}` };
  }
  let total = 0;
  for (const r of rows) {
    const l = fromLedger.get(r.id);
    if (!l || l.charged !== r.charged_micros) return { ok: false, reason: `reservation ${r.id} charge differs from the ledger` };
    // Flipping status (settled -> released) would stop spent() counting the money.
    if (l.outcome !== r.status || l.rail !== (r.rail ?? "llm")) return { ok: false, reason: `reservation ${r.id} status or rail differs from the ledger` };
    total += r.charged_micros;
  }
  return { ok: true, settledMicros: total };
}
