// Reconciles Solana x402 payments the rail booked as charged_full without a
// confirmed settlement. The only evidence is the chain. A confirmed transfer
// that matches the signed facts settles the booking; a failed transaction
// releases it; a signature that another reservation already booked is released;
// an RPC error leaves the booking untouched (fail closed).
import { auditRail, type GovernedRail } from "@mandate/llm-rail";
import type { LedgerEntry } from "@mandate/core";
import type { ChainVerification, SolanaChain } from "./types.js";
import { checkNetworkGenesis } from "./chain.js";

export type ReconcileResult = "released" | "settled" | "pending" | "mismatch" | "error" | "skipped";

export interface ReconcileOutcome {
  reservationId: string;
  result: ReconcileResult;
  reason?: string;
  signature?: string;
}

export interface ReconcileReport {
  results: ReconcileOutcome[];
  releasedMicros: number;
  confirmedMicros: number;
}

export interface ReconcileOptions {
  /**
   * How far before the booking an unconfirmed transfer may sit. Default
   * 15 minutes, wider than the Solana blockhash lifetime and clock skew.
   */
  searchMarginSeconds?: number;
  /** Clock override, used by tests. */
  now?: () => number;
  /**
   * The CAIP-2 networks this rail serves. Defaults to the networks named by the
   * candidates. When the chain can read a genesis hash, the pass refuses a
   * hash that does not match, before any write.
   */
  networks?: readonly string[];
}

interface Candidate {
  reservationId: string;
  reservedMicros: number;
  createdMs: number;
  details: Record<string, unknown>;
}

interface Facts {
  network: string;
  mint: string;
  payTo: string;
  amountAtomic: string;
  payer: string;
  signature: string | null;
  expiresAtMs: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function factsFrom(details: Record<string, unknown>): Facts | null {
  if (details.unconfirmed !== true) return null;
  const network = details.network;
  const mint = details.asset;
  const payTo = details.pay_to;
  const payer = details.payer;
  const amountAtomic = details.amount_atomic;
  if (typeof network !== "string" || typeof mint !== "string" || typeof payTo !== "string" || typeof payer !== "string") {
    return null;
  }
  if (typeof amountAtomic !== "string" || !/^[1-9]\d*$/.test(amountAtomic)) return null;
  const signature = typeof details.tx_signature === "string" ? details.tx_signature : null;
  const expiresAtMs = typeof details.expires_at_ms === "number" && Number.isSafeInteger(details.expires_at_ms)
    ? details.expires_at_ms
    : null;
  return { network, mint, payTo, amountAtomic, payer, signature, expiresAtMs };
}

interface LastSettle {
  outcome: unknown;
  chargedMicros: unknown;
  details: Record<string, unknown>;
}

function lastSettleDetails(entries: Iterable<LedgerEntry>): Map<string, LastSettle> {
  const last = new Map<string, LastSettle>();
  for (const entry of entries) {
    if (entry.kind !== "x402.settle") continue;
    const payload = asRecord(entry.payload);
    const id = payload.reservation_id;
    if (typeof id !== "string") continue;
    last.set(id, {
      outcome: payload.outcome,
      chargedMicros: payload.charged_micros,
      details: asRecord(payload.details),
    });
  }
  return last;
}

function toCandidates(
  rows: Array<{ id: string; reserved_micros: number; created_ms: number }>,
  last: Map<string, LastSettle>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const row of rows) {
    const entry = last.get(row.id);
    if (!entry || entry.outcome !== "charged_full" || entry.chargedMicros !== row.reserved_micros) continue;
    if (entry.details.unconfirmed !== true) continue;
    out.push({
      reservationId: row.id,
      reservedMicros: row.reserved_micros,
      createdMs: row.created_ms,
      details: entry.details,
    });
  }
  return out;
}

function candidatesFromStore(rail: GovernedRail): Candidate[] {
  const rows = rail.store.database
    .prepare(
      "SELECT id, reserved_micros, created_ms FROM reservations WHERE mandate_id = ? AND rail = 'x402' AND status = 'charged_full'",
    )
    .all(rail.mandate.id) as Array<{ id: string; reserved_micros: number; created_ms: number }>;
  return toCandidates(rows, lastSettleDetails(rail.ledger.entries()));
}

/**
 * A signature that a different reservation already recorded is not paid twice.
 * The outcome does not matter. A booking charged full with the same signature
 * is as much a claim on that transfer as a settled one.
 */
function bookedElsewhere(entries: Iterable<LedgerEntry>, reservationId: string, signature: string): boolean {
  for (const entry of entries) {
    if (entry.kind !== "x402.settle") continue;
    const payload = asRecord(entry.payload);
    if (payload.reservation_id === reservationId) continue;
    if (asRecord(payload.details).tx_signature === signature) return true;
  }
  return false;
}

/**
 * Reconcile every charged_full Solana x402 booking of the rail's mandate.
 * The signed ledger is audited first. An edited ledger is refused.
 */
export async function reconcileSvm(
  rail: GovernedRail,
  chain: SolanaChain,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const marginSeconds = opts.searchMarginSeconds ?? 900;
  if (!Number.isSafeInteger(marginSeconds) || marginSeconds < 0) {
    throw new Error("searchMarginSeconds must be a non-negative safe integer");
  }
  const now = opts.now ?? (() => Date.now());

  const snapshot = rail.store.readTransaction(() => {
    const audit = auditRail(rail.store, rail.ledger, rail.mandate.id, rail.trustedLedgerKeys);
    return { audit, candidates: audit.ok ? candidatesFromStore(rail) : [] };
  });
  if (!snapshot.audit.ok) throw new Error(`reconcile refused: ledger audit failed: ${snapshot.audit.reason}`);

  // A reconcile pass on the wrong chain would find no transfer and, with the
  // expiry release, free a real payment as never_landed. Refuse the pass.
  const candidateNetworks = new Set<string>();
  for (const candidate of snapshot.candidates) {
    const facts = factsFrom(candidate.details);
    if (facts) candidateNetworks.add(facts.network);
  }
  const networks =
    opts.networks && opts.networks.length > 0 ? [...opts.networks] : [...candidateNetworks];
  if (chain.getGenesisHash && networks.length > 0) {
    const genesisHash = await chain.getGenesisHash();
    checkNetworkGenesis(networks, genesisHash);
  }

  const report: ReconcileReport = { results: [], releasedMicros: 0, confirmedMicros: 0 };
  for (const candidate of snapshot.candidates) {
    const facts = factsFrom(candidate.details);
    if (!facts) {
      report.results.push({
        reservationId: candidate.reservationId,
        result: "pending",
        reason: "no unconfirmed Solana authorization to reconcile",
      });
      continue;
    }

    let signature = facts.signature;
    if (signature === null) {
      let search: Awaited<ReturnType<SolanaChain["findTransfer"]>>;
      try {
        search = await chain.findTransfer({
          network: facts.network,
          mint: facts.mint,
          payTo: facts.payTo,
          amountAtomic: facts.amountAtomic,
          payer: facts.payer,
          sinceMs: candidate.createdMs - marginSeconds * 1000,
        });
      } catch (err) {
        report.results.push({
          reservationId: candidate.reservationId,
          result: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (search.kind === "incomplete") {
        // The scan did not finish. That is not proof that no money moved, so
        // the booking stays charged full and no release can happen.
        report.results.push({
          reservationId: candidate.reservationId,
          result: "error",
          reason: `the payer history scan was incomplete (capped ${search.capped}, timed out ${search.timedOut})`,
        });
        continue;
      }
      if (search.kind === "none") {
        // A booking whose authorization window plus the blockhash lifetime has
        // passed can never land. Release it instead of holding the budget for
        // ever. Old bookings have no expiry, so they stay fail closed.
        if (facts.expiresAtMs !== null && now() > facts.expiresAtMs) {
          rail.store.reconcileCharged(candidate.reservationId, { outcome: "released" }, {
            reason: "never_landed",
            expires_at_ms: facts.expiresAtMs,
            released_at_ms: now(),
          });
          report.results.push({
            reservationId: candidate.reservationId,
            result: "released",
            reason: "the booking expired and no matching transfer was found",
          });
          report.releasedMicros += candidate.reservedMicros;
          continue;
        }
        report.results.push({
          reservationId: candidate.reservationId,
          result: "pending",
          reason: "no matching transfer was found yet",
        });
        continue;
      }
      signature = search.signature;
    }

    if (bookedElsewhere(rail.ledger.entries(), candidate.reservationId, signature)) {
      rail.store.reconcileCharged(candidate.reservationId, { outcome: "released" }, {
        reason: "replayed_signature",
        tx_signature: signature,
      });
      report.results.push({
        reservationId: candidate.reservationId,
        result: "released",
        reason: "the signature was already booked for another reservation",
        signature,
      });
      report.releasedMicros += candidate.reservedMicros;
      continue;
    }

    let check: ChainVerification;
    try {
      check = await chain.verifyTransfer(signature, {
        network: facts.network,
        mint: facts.mint,
        payTo: facts.payTo,
        amountAtomic: facts.amountAtomic,
        payer: facts.payer,
      });
    } catch (err) {
      report.results.push({
        reservationId: candidate.reservationId,
        result: "error",
        reason: err instanceof Error ? err.message : String(err),
        signature,
      });
      continue;
    }

    if (check.status === "success") {
      // The signature claim and the settle commit together, the same invariant
      // as settleClaimed on the live path. A null means a live settle or an
      // earlier reconcile pass already booked this transfer.
      const event = rail.store.reconcileSettled(
        candidate.reservationId,
        signature,
        candidate.reservedMicros,
        {
          reason: "settled_late",
          tx_signature: signature,
          tx_signature_source: "chain",
          settlement_verified: true,
        },
      );
      if (event === null) {
        rail.store.reconcileCharged(candidate.reservationId, { outcome: "released" }, {
          reason: "replayed_signature",
          tx_signature: signature,
        });
        report.results.push({
          reservationId: candidate.reservationId,
          result: "released",
          reason: "the signature was already booked for another reservation",
          signature,
        });
        report.releasedMicros += candidate.reservedMicros;
        continue;
      }
      report.results.push({ reservationId: candidate.reservationId, result: "settled", signature });
      report.confirmedMicros += candidate.reservedMicros;
      continue;
    }
    if (check.status === "failed") {
      rail.store.reconcileCharged(candidate.reservationId, { outcome: "released" }, {
        reason: "settlement_failed",
        tx_signature: signature,
        chain_reason: check.reason,
      });
      report.results.push({
        reservationId: candidate.reservationId,
        result: "released",
        reason: check.reason,
        signature,
      });
      report.releasedMicros += candidate.reservedMicros;
      continue;
    }
    // An unreadable result is not proof of anything, so it never releases,
    // not even after expiry. The booking stays charged full for a later pass.
    if (check.status !== "pending" && check.status !== "mismatch") {
      report.results.push({
        reservationId: candidate.reservationId,
        result: "error",
        reason: check.reason,
        signature,
      });
      continue;
    }
    // A pending or mismatched signature after the authorization window and the
    // blockhash lifetime can never land a matching transfer. Release it then.
    if (facts.expiresAtMs !== null && now() > facts.expiresAtMs) {
      rail.store.reconcileCharged(candidate.reservationId, { outcome: "released" }, {
        reason: "never_landed",
        tx_signature: signature,
        expires_at_ms: facts.expiresAtMs,
        released_at_ms: now(),
      });
      report.results.push({
        reservationId: candidate.reservationId,
        result: "released",
        reason: "the booking expired and no matching transfer was verified",
        signature,
      });
      report.releasedMicros += candidate.reservedMicros;
      continue;
    }
    report.results.push({
      reservationId: candidate.reservationId,
      result: check.status === "mismatch" ? "mismatch" : "pending",
      reason: check.reason,
      signature,
    });
  }
  return report;
}

export interface OperatorReleaseOptions {
  /** Who ran the command. Written to the signed ledger entry. */
  operator: string;
  /** Why the booking is released. Written to the signed ledger entry. */
  note?: string;
  /** Clock override, used by tests. */
  now?: () => number;
}

export interface OperatorReleaseResult {
  reservationId: string;
  releasedMicros: number;
}

/**
 * Operator command. Releases one named charged_full Solana x402 booking and
 * writes a signed ledger entry with reason operator_release. A human override
 * must leave the same audit trail as every other booking change, so a direct
 * SQL edit is never needed. The signed ledger is audited before the write.
 */
export function releaseSvmBooking(
  rail: GovernedRail,
  reservationId: string,
  opts: OperatorReleaseOptions,
): OperatorReleaseResult {
  const operator = typeof opts.operator === "string" ? opts.operator.trim() : "";
  if (operator.length === 0) throw new Error("operator release needs an operator id");
  const now = opts.now ?? (() => Date.now());

  const row = rail.store.readTransaction(() => {
    const audit = auditRail(rail.store, rail.ledger, rail.mandate.id, rail.trustedLedgerKeys);
    if (!audit.ok) throw new Error(`operator release refused: ledger audit failed: ${audit.reason}`);
    return rail.store.database
      .prepare("SELECT id, mandate_id, rail, status, reserved_micros FROM reservations WHERE id = ?")
      .get(reservationId) as
      | { id: string; mandate_id: string; rail: string; status: string; reserved_micros: number }
      | undefined;
  });
  if (!row) throw new Error(`unknown reservation: ${reservationId}`);
  if (row.mandate_id !== rail.mandate.id) {
    throw new Error(`reservation ${reservationId} belongs to another mandate`);
  }
  if (row.rail !== "x402") {
    throw new Error(`reservation ${reservationId} is not on the x402 rail`);
  }
  if (row.status !== "charged_full") {
    throw new Error(`reservation ${reservationId} is ${row.status}, only charged_full can be released`);
  }
  const releasedAtMs = now();
  const details: Record<string, unknown> = {
    reason: "operator_release",
    operator,
    released_at_ms: releasedAtMs,
  };
  if (opts.note !== undefined) details.operator_note = opts.note;
  rail.store.reconcileCharged(reservationId, { outcome: "released" }, details);
  return { reservationId, releasedMicros: row.reserved_micros };
}
