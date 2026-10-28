import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Usage } from "./pricing.js";

export interface Policy {
  mandateId: string;
  budgetMicros: number;
  perCallCapMicros: number;
  approvalThresholdMicros: number;
  allowedProviders: string[];
  allowedModels?: string[];
  rateLimit: { maxCalls: number; windowSeconds: number };
  notBefore: string;
  expiresAt: string;
  /** "lifetime" (default), or a calendar "day" / "month" in UTC that resets the budget. */
  budgetPeriod?: "lifetime" | "day" | "month";
  /** Agent ids the mandate names. When set, a key for any other agent is refused even if it was issued earlier. */
  agents?: string[];
  /** created_at of the signed mandate this policy came from, used to refuse rollbacks. */
  issuedAt?: string;
  /** Rails the signed mandate covers. The x402 rail is refused unless it is listed here. */
  rails?: string[];
}

export type RailName = "llm" | "x402" | "stripe_spt";

/**
 * Most denial entries one agent may add to the ledger in one UTC day. The
 * window cap (rate_limit.max_calls) still lets a full window through on every
 * window, so without this a spamming agent could add ~170k entries a day.
 */
export const DAILY_DENIAL_CAP = 1000;

export function periodStartMs(period: Policy["budgetPeriod"], now: number): number {
  if (!period || period === "lifetime") return 0;
  const d = new Date(now);
  return period === "day"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export type DenyCode =
  | "invalid_key"
  | "budget_exceeded"
  | "per_call_cap"
  | "approval_required"
  | "rate_limited"
  | "mandate_expired"
  | "mandate_not_active"
  | "payee_not_allowed"
  | "model_not_allowed"
  | "rail_not_allowed"
  | "approval_denied"
  | "approval_timeout";

export type Deny = {
  ok: false;
  status: 401 | 402 | 403 | 429;
  code: DenyCode;
  reason: string;
};

export interface SettleEvent {
  reservationId: string;
  mandateId: string;
  agentId: string;
  model: string;
  provider: string;
  reservedMicros: number;
  chargedMicros: number;
  usage: Usage | null;
  outcome: "settled" | "released" | "charged_full";
  overrun: boolean;
  ts: string;
  rail: RailName;
  /** Set when a human approved the call this reservation booked. */
  approvalId?: string | null;
  /** Rail-specific facts written to the ledger with the settlement (x402: tx hash, network, nonce). */
  details?: Record<string, unknown>;
}

/**
 * A deny or human approval decision the gateway wants in the signed ledger.
 * Denials are emitted by reserve(); approvals by recordApproval().
 */
export interface DecisionEvent {
  kind: "denied" | "approval" | "capped";
  rail: RailName;
  mandateId: string;
  agentId: string;
  provider: string;
  model: string;
  amountMicros: number;
  code?: DenyCode;
  reason?: string;
  decision?: "approved" | "denied" | "timeout";
  requestId?: string;
  decidedBy?: string;
  /** kind "capped": which cap suppressed further denials, and for which period. */
  scope?: "window" | "day";
  periodStart?: string;
  cap?: number;
  ts: string;
}

export interface BudgetStoreOptions {
  now?: () => number;
  afterSettleInTx?: (db: DatabaseSync, ev: SettleEvent) => void;
  /** Runs inside the reservation/decision transaction, so the ledger and the budget cannot disagree. */
  afterDecisionInTx?: (db: DatabaseSync, ev: DecisionEvent) => void;
  /**
   * Runs after a transaction COMMITs, never after a rollback. Used to publish
   * the ledger head outside the database. A throw here is swallowed, so a failed
   * publish can never look like a failed commit.
   */
  afterCommit?: () => void;
}

interface ReservationRow {
  id: string;
  mandate_id: string;
  agent_id: string;
  model: string;
  provider: string;
  reserved_micros: number;
  charged_micros: number | null;
  status: string;
  overrun: number;
  created_ms: number;
  settled_ms: number | null;
  rail: string;
  approval_id: string | null;
}

function deny(status: Deny["status"], code: DenyCode, reason: string): Deny {
  return { ok: false, status, code, reason };
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function reservationId(): string {
  return "res_" + randomBytes(16).toString("base64url");
}

export class BudgetStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly afterSettleInTx:
    | ((db: DatabaseSync, ev: SettleEvent) => void)
    | undefined;
  private readonly afterDecisionInTx:
    | ((db: DatabaseSync, ev: DecisionEvent) => void)
    | undefined;
  private readonly afterCommit: (() => void) | undefined;
  private readonly storeIdValue: string;
  // The denial caps below are per process and reset on restart: they bound how
  // fast a runaway agent can grow the signed ledger, not its total size.
  /** agentId -> start of the rate window whose rate_limited deny was already logged. */
  private readonly rateLoggedWindow = new Map<string, number>();
  /** agentId -> denials signed into the ledger in the current rate window. */
  private readonly deniesLogged = new Map<string, { window: number; count: number }>();
  /** agentId -> denials signed into the ledger in the current UTC day. */
  private readonly deniesLoggedDay = new Map<string, { day: number; count: number }>();
  /** agentId -> start of the rate window whose window-cap marker was already logged. */
  private readonly windowCapLogged = new Map<string, number>();
  /** agentId -> start of the UTC day whose day-cap marker was already logged. */
  private readonly dayCapLogged = new Map<string, number>();
  /** agentId -> start of the UTC day whose rail block-cap marker was already logged. */
  private readonly railCapLogged = new Map<string, number>();
  /**
   * agentId -> { day, count, lastSeq } of rail blocks signed for the current
   * UTC day. Seeded once per agent per day from the ledger, then topped up on
   * each later call with rows other writers appended after `lastSeq`, so the
   * cap is exact across writers and costs one cheap primary-key range query.
   */
  private readonly railBlockCount = new Map<string, { day: number; count: number; lastSeq: number }>();

  constructor(path: string, opts: BudgetStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.afterSettleInTx = opts.afterSettleInTx;
    this.afterDecisionInTx = opts.afterDecisionInTx;
    this.afterCommit = opts.afterCommit;
    this.db = new DatabaseSync(path);
    // busy_timeout first: switching to WAL takes a lock, and two processes
    // opening the same file at once fail with "database is locked" otherwise.
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY,
        policy TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_keys (
        key_hash TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        mandate_id TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        mandate_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        reserved_micros INTEGER NOT NULL,
        charged_micros INTEGER,
        status TEXT NOT NULL CHECK(status IN ('reserved','settled','released','charged_full')),
        overrun INTEGER NOT NULL DEFAULT 0,
        created_ms INTEGER NOT NULL,
        settled_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_mandate_status
        ON reservations(mandate_id, status);
      CREATE INDEX IF NOT EXISTS idx_reservations_agent_created
        ON reservations(agent_id, created_ms);
    `);
    // Migration: databases created before the x402 rail have no rail column.
    const cols = this.db.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "rail")) {
      this.db.exec("ALTER TABLE reservations ADD COLUMN rail TEXT NOT NULL DEFAULT 'llm'");
    }
    if (!cols.some((c) => c.name === "price_basis")) {
      this.db.exec("ALTER TABLE reservations ADD COLUMN price_basis TEXT");
    }
    if (!cols.some((c) => c.name === "approval_id")) {
      this.db.exec("ALTER TABLE reservations ADD COLUMN approval_id TEXT");
    }
    // One id per database file. This stops a signed mandate from being used
    // against another database by mistake or by replay, but it is not a
    // cryptographic binding: a byte copy of the file carries the same id, and
    // anyone with write access to the file can write any id into it.
    this.db
      .prepare("INSERT OR IGNORE INTO store_meta(k, v) VALUES('store_id', ?)")
      .run("st_" + randomBytes(16).toString("base64url"));
    const meta = this.get<{ v: string }>("SELECT v FROM store_meta WHERE k = 'store_id'");
    if (!meta) throw new Error("store_meta.store_id is missing");
    this.storeIdValue = meta.v;
  }

  /** This database file's stable id, stored in the unsigned store_meta table. */
  get storeId(): string {
    return this.storeIdValue;
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params as never[])) as T | undefined;
  }

  private run(sql: string, ...params: unknown[]): void {
    const stmt = this.db.prepare(sql);
    stmt.run(...(params as never[]));
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      if (this.afterCommit) {
        try {
          this.afterCommit();
        } catch {
          // never after ROLLBACK, and never let a failed publish look like a
          // failed commit: the committed entry stands and the next publish repairs it
        }
      }
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; the original error is what matters
      }
      throw err;
    }
  }

  /** Run fn inside one BEGIN IMMEDIATE transaction on this store's connection. */
  transaction<T>(fn: () => T): T {
    return this.tx(fn);
  }

  /**
   * Run fn inside one BEGIN DEFERRED transaction, so every read sees a single
   * WAL snapshot without blocking the writer.
   */
  readTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN DEFERRED");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failures; the original error is what matters
      }
      throw err;
    }
  }

  /**
   * Applies the per-agent denial caps and hands the entry to the decision hook
   * when a cap does not suppress it. Shared by the denials in reserve() and the
   * denials written outside it (recordDenial).
   *
   * Caps, all per process and reset on restart:
   *  - at most rate_limit.max_calls denials per agent per rate window;
   *  - at most DAILY_DENIAL_CAP denials per agent per UTC day.
   * The first denial a cap suppresses in a period is replaced by one marker
   * entry ("llm.denials_capped"), so a spamming agent cannot grow the signed
   * ledger without bound.
   */
  private logDenial(args: {
    mandateId: string;
    agentId: string;
    provider: string;
    model: string;
    amountMicros: number;
    code: DenyCode;
    reason: string;
    now: number;
    windowMs: number;
    maxCalls: number;
  }): void {
    const { now, windowMs, maxCalls } = args;
    const window = Math.floor(now / windowMs) * windowMs;
    // One rate_limited entry per agent per rate window.
    if (args.code === "rate_limited") {
      if (this.rateLoggedWindow.get(args.agentId) === window) return;
      this.rateLoggedWindow.set(args.agentId, window);
    }
    const d = new Date(now);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const logged = this.deniesLogged.get(args.agentId);
    const windowCount = logged && logged.window === window ? logged.count : 0;
    const loggedDay = this.deniesLoggedDay.get(args.agentId);
    const dayCount = loggedDay && loggedDay.day === day ? loggedDay.count : 0;

    // The day cap is checked first, so after it no window markers are written either.
    if (dayCount >= DAILY_DENIAL_CAP) {
      if (this.dayCapLogged.get(args.agentId) !== day) {
        this.dayCapLogged.set(args.agentId, day);
        this.emitCapped(args, "day", day, DAILY_DENIAL_CAP, now);
      }
      return;
    }
    if (windowCount >= maxCalls) {
      if (this.windowCapLogged.get(args.agentId) !== window) {
        this.windowCapLogged.set(args.agentId, window);
        this.emitCapped(args, "window", window, maxCalls, now);
      }
      return;
    }
    this.deniesLogged.set(args.agentId, { window, count: windowCount + 1 });
    this.deniesLoggedDay.set(args.agentId, { day, count: dayCount + 1 });
    this.afterDecisionInTx?.(this.db, {
      kind: "denied",
      rail: "llm",
      mandateId: args.mandateId,
      agentId: args.agentId,
      provider: args.provider,
      model: args.model,
      amountMicros: args.amountMicros,
      code: args.code,
      reason: args.reason,
      ts: new Date(now).toISOString(),
    });
  }

  private emitCapped(
    args: {
      mandateId: string;
      agentId: string;
      provider: string;
      model: string;
      amountMicros: number;
    },
    scope: "window" | "day",
    periodStart: number,
    cap: number,
    now: number,
  ): void {
    this.afterDecisionInTx?.(this.db, {
      kind: "capped",
      rail: "llm",
      mandateId: args.mandateId,
      agentId: args.agentId,
      provider: args.provider,
      model: args.model,
      amountMicros: 0,
      scope,
      periodStart: new Date(periodStart).toISOString(),
      cap,
      ts: new Date(now).toISOString(),
    });
  }

  upsertMandate(p: Policy): void {
    this.run(
      "INSERT INTO mandates(id, policy) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET policy = excluded.policy",
      p.mandateId,
      JSON.stringify(p),
    );
  }

  getPolicy(mandateId: string): Policy | null {
    const row = this.get<{ policy: string }>(
      "SELECT policy FROM mandates WHERE id = ?",
      mandateId,
    );
    if (!row) return null;
    return JSON.parse(row.policy) as Policy;
  }

  createAgentKey(mandateId: string, agentId: string): string {
    const key = "mk_" + randomBytes(32).toString("base64url");
    this.run(
      "INSERT INTO agent_keys(key_hash, agent_id, mandate_id, revoked, created_at) VALUES(?, ?, ?, 0, ?)",
      hashKey(key),
      agentId,
      mandateId,
      new Date(this.now()).toISOString(),
    );
    return key;
  }

  revokeAgentKey(key: string): void {
    this.run("UPDATE agent_keys SET revoked = 1 WHERE key_hash = ?", hashKey(key));
  }

  authenticate(key: string): { agentId: string; mandateId: string } | null {
    if (typeof key !== "string") return null;
    if (!key.startsWith("mk_")) return null;
    if (key.length > 128) return null;
    const row = this.get<{ agent_id: string; mandate_id: string; revoked: number }>(
      "SELECT agent_id, mandate_id, revoked FROM agent_keys WHERE key_hash = ?",
      hashKey(key),
    );
    if (!row || row.revoked !== 0) return null;
    const policy = this.getPolicy(row.mandate_id);
    if (!policy || (policy.agents && !policy.agents.includes(row.agent_id))) return null;
    return { agentId: row.agent_id, mandateId: row.mandate_id };
  }

  reserve(args: {
    mandateId: string;
    agentId: string;
    model: string;
    provider: string;
    amountMicros: number;
    /** Default "llm". */
    rail?: RailName;
    /** x402 only: how the caller verified the payee (mandate allowlist or a signed binding). Required for x402. */
    payeeVerifiedBy?: "allowlist" | "binding";
    /** A human approved this exact call. Skips the approval threshold only; caps and budget still apply. */
    approval?: { requestId: string; decidedBy: string };
    /** x402 only: which price reference the payee guard used (quote, median_30d, first_payment). */
    priceBasis?: string;
    /**
     * The caller has an approver and will log the human decision itself, so an
     * approval_required deny is not written as an llm.denied ledger entry.
     */
    deferApproval?: boolean;
  }): { ok: true; reservationId: string; remainingMicros: number } | Deny {
    const { mandateId, agentId, model, provider, amountMicros } = args;
    const rail: RailName = args.rail ?? "llm";
    if (rail !== "llm" && rail !== "x402" && rail !== "stripe_spt") throw new Error(`unknown rail: ${String(rail)}`);
    if (args.approval !== undefined && (typeof args.approval.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(args.approval.requestId))) {
      throw new Error("approval.requestId must be a non-empty id");
    }
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
      throw new Error("amountMicros must be a positive safe integer");
    }

    return this.tx(() => {
      const row = this.get<{ policy: string }>(
        "SELECT policy FROM mandates WHERE id = ?",
        mandateId,
      );
      if (!row) return deny(401, "invalid_key", "mandate not found");
      const policy = JSON.parse(row.policy) as Policy;
      const now = this.now();
      const windowMs = policy.rateLimit.windowSeconds * 1000;
      // A deny is signed into the ledger before this transaction commits. The
      // unknown-mandate case has nothing to attach to; x402 writes its own
      // x402.blocked entry; deferred approvals are logged as the human decision.
      const emit = (d: Deny): Deny => {
        if (rail !== "llm" || d.code === "invalid_key") return d;
        if (d.code === "approval_required" && args.deferApproval === true) return d;
        this.logDenial({
          mandateId,
          agentId,
          provider,
          model,
          amountMicros,
          code: d.code,
          reason: d.reason,
          now,
          windowMs,
          maxCalls: policy.rateLimit.maxCalls,
        });
        return d;
      };
      if (policy.agents && !policy.agents.includes(agentId)) {
        return emit(deny(401, "invalid_key", "agent is not named in the current mandate"));
      }

      const notBefore = Date.parse(policy.notBefore);
      const expiresAt = Date.parse(policy.expiresAt);
      if (Number.isFinite(notBefore) && now < notBefore) {
        return emit(deny(403, "mandate_not_active", "mandate is not yet active"));
      }
      if (Number.isFinite(expiresAt) && now >= expiresAt) {
        return emit(deny(403, "mandate_expired", "mandate has expired"));
      }
      if (rail === "x402" || rail === "stripe_spt") {
        // Fail closed: a policy without a rails list predates these rails.
        if (!policy.rails || !policy.rails.includes(rail)) {
          return emit(deny(403, "rail_not_allowed", `mandate does not cover the ${rail} rail`));
        }
        if (args.payeeVerifiedBy !== "allowlist" && args.payeeVerifiedBy !== "binding") {
          return emit(deny(403, "payee_not_allowed", `payee ${provider} was not verified`));
        }
      } else if (!policy.allowedProviders.includes(provider)) {
        return emit(deny(403, "payee_not_allowed", `provider ${provider} is not allowed`));
      }
      if (policy.allowedModels && !policy.allowedModels.includes(model)) {
        return emit(deny(403, "model_not_allowed", `model ${model} is not allowed`));
      }
      if (amountMicros > policy.perCallCapMicros) {
        return emit(deny(402, "per_call_cap", "amount exceeds per-call cap"));
      }

      const rate = this.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM reservations WHERE agent_id = ? AND created_ms > ?",
        agentId,
        now - windowMs,
      );
      if ((rate?.c ?? 0) >= policy.rateLimit.maxCalls) {
        return emit(deny(429, "rate_limited", "rate limit exceeded"));
      }

      // A periodic budget counts reservations created in the current period.
      // Open reservations from an earlier period still count, so a period
      // boundary can never free money that is still in flight.
      const since = periodStartMs(policy.budgetPeriod, now);
      const settled = this.get<{ s: number }>(
        "SELECT COALESCE(SUM(charged_micros), 0) AS s FROM reservations WHERE mandate_id = ? AND status IN ('settled','charged_full') AND created_ms >= ?",
        mandateId,
        since,
      );
      const held = this.get<{ s: number }>(
        "SELECT COALESCE(SUM(reserved_micros), 0) AS s FROM reservations WHERE mandate_id = ? AND status = 'reserved'",
        mandateId,
      );
      const committed = (settled?.s ?? 0) + (held?.s ?? 0);
      if (committed + amountMicros > policy.budgetMicros) {
        return emit(deny(402, "budget_exceeded", "budget exceeded"));
      }
      // Last, so a human is only asked about a call that passes every other check.
      if (amountMicros > policy.approvalThresholdMicros) {
        if (!args.approval) return emit(deny(403, "approval_required", "amount requires human approval"));
        const used = this.get<{ c: number }>("SELECT COUNT(*) AS c FROM reservations WHERE approval_id = ?", args.approval.requestId);
        if ((used?.c ?? 0) > 0) return emit(deny(403, "approval_required", "this approval was already used"));
      }

      const id = reservationId();
      this.run(
        "INSERT INTO reservations(id, mandate_id, agent_id, model, provider, reserved_micros, charged_micros, status, overrun, created_ms, settled_ms, rail, price_basis, approval_id) VALUES(?, ?, ?, ?, ?, ?, NULL, 'reserved', 0, ?, NULL, ?, ?, ?)",
        id,
        mandateId,
        agentId,
        model,
        provider,
        amountMicros,
        now,
        rail,
        args.priceBasis ?? null,
        args.approval?.requestId ?? null,
      );
      return {
        ok: true as const,
        reservationId: id,
        remainingMicros: policy.budgetMicros - (committed + amountMicros),
      };
    });
  }

  /** Sign a deny that happened outside reserve() (for example a bad model). */
  recordDenial(args: {
    mandateId: string;
    agentId: string;
    provider: string;
    model: string;
    amountMicros: number;
    code: DenyCode;
    reason: string;
  }): void {
    if (!this.afterDecisionInTx) return;
    const policy = this.getPolicy(args.mandateId);
    const now = this.now();
    const windowMs = (policy?.rateLimit.windowSeconds ?? 60) * 1000;
    this.tx(() => {
      this.logDenial({
        ...args,
        now,
        windowMs,
        maxCalls: policy?.rateLimit.maxCalls ?? Number.MAX_SAFE_INTEGER,
      });
    });
  }

  /** Sign the human decision that let an over-threshold call through, or stopped it. */
  recordApproval(args: {
    mandateId: string;
    agentId: string;
    rail: RailName;
    provider: string;
    model: string;
    amountMicros: number;
    decision: "approved" | "denied" | "timeout";
    requestId: string;
    decidedBy: string;
  }): void {
    if (!this.afterDecisionInTx) return;
    this.tx(() => {
      this.afterDecisionInTx!(this.db, {
        kind: "approval",
        rail: args.rail,
        mandateId: args.mandateId,
        agentId: args.agentId,
        provider: args.provider,
        model: args.model,
        amountMicros: args.amountMicros,
        decision: args.decision,
        requestId: args.requestId,
        decidedBy: args.decidedBy,
        ts: new Date(this.now()).toISOString(),
      });
    });
  }

  /**
   * Sign a refusal written outside reserve() by a rail that keeps its own
   * ledger entries (currently stripe_spt.blocked). The daily cap is the same
   * one the llm rail applies, and it is counted from the signed ledger, so a
   * process restart cannot reset it. Once the cap is reached, one
   * stripe_spt.blocks_capped marker stands in for the suppressed entries and
   * nothing further is appended until the next UTC day.
   *
   * The caller passes the append callback because the ledger is not owned by
   * the store.
   */
  recordRailBlock(
    args: {
      kind: string;
      mandateId: string;
      agentId: string;
      payload: Record<string, unknown>;
    },
    append: (kind: string, payload: Record<string, unknown>) => void,
  ): void {
    const now = this.now();
    const d = new Date(now);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dayStart = new Date(day).toISOString();
    // Seed the day's count from the ledger once per agent on ts alone. Do not
    // bound the seed by sequence: a row with an older ts can be appended after
    // today's rows, which would hide every today row from a seq-bounded count.
    // `lastSeq` is the ledger head at the seed so later top-ups only look at
    // rows appended since.
    let cached = this.railBlockCount.get(args.agentId);
    if (cached === undefined || cached.day !== day) {
      const counted = this.get<{ c: number; m: number }>(
        "SELECT COUNT(*) AS c, (SELECT COALESCE(MAX(seq), 0) FROM ledger_entries) AS m FROM ledger_entries WHERE (kind LIKE '%.blocked' OR kind LIKE '%.denied') AND json_extract(payload, '$.agent_id') = ? AND ts >= ?",
        args.agentId,
        dayStart,
      );
      cached = { day, count: counted?.c ?? 0, lastSeq: counted?.m ?? 0 };
      this.railBlockCount.set(args.agentId, cached);
    } else {
      // Count what other writers appended since the last call. This uses the
      // INTEGER PRIMARY KEY as a rowid range, so it touches only new rows, and
      // also advances lastSeq past non-matching rows.
      const topped = this.get<{ c: number; m: number }>(
        "SELECT COUNT(*) AS c, (SELECT COALESCE(MAX(seq), 0) FROM ledger_entries) AS m FROM ledger_entries WHERE seq > ? AND (kind LIKE '%.blocked' OR kind LIKE '%.denied') AND json_extract(payload, '$.agent_id') = ? AND ts >= ?",
        cached.lastSeq,
        args.agentId,
        dayStart,
      );
      cached.count += topped?.c ?? 0;
      cached.lastSeq = topped?.m ?? cached.lastSeq;
    }
    if (cached.count >= DAILY_DENIAL_CAP) {
      if (this.railCapLogged.get(args.agentId) !== day) {
        this.railCapLogged.set(args.agentId, day);
        append("stripe_spt.blocks_capped", {
          rail: "stripe_spt",
          mandate_id: args.mandateId,
          agent_id: args.agentId,
          scope: "day",
          period_start: dayStart,
          cap: DAILY_DENIAL_CAP,
        });
      }
      return;
    }
    // Do not bump the in-memory count here: the append lands in the ledger
    // after `lastSeq`, so the next call's top-up counts it exactly once
    // together with any rows other writers added.
    append(args.kind, args.payload);
  }

  private finish(
    reservationId: string,
    status: "settled" | "released" | "charged_full",
    chargedMicros: number,
    usage: Usage | null,
    details?: Record<string, unknown>,
  ): SettleEvent {
    if (!Number.isSafeInteger(chargedMicros)) {
      throw new Error("chargedMicros must be an integer");
    }
    return this.tx(() => {
      const row = this.get<ReservationRow>(
        "SELECT * FROM reservations WHERE id = ?",
        reservationId,
      );
      if (!row) throw new Error(`unknown reservation: ${reservationId}`);
      if (row.status !== "reserved") {
        throw new Error(`reservation ${reservationId} is already ${row.status}`);
      }
      const overrun = chargedMicros > row.reserved_micros ? 1 : 0;
      const now = this.now();
      this.run(
        "UPDATE reservations SET charged_micros = ?, status = ?, overrun = ?, settled_ms = ? WHERE id = ?",
        chargedMicros,
        status,
        overrun,
        now,
        reservationId,
      );
      const ev: SettleEvent = {
        reservationId,
        mandateId: row.mandate_id,
        agentId: row.agent_id,
        model: row.model,
        provider: row.provider,
        reservedMicros: row.reserved_micros,
        chargedMicros,
        usage,
        outcome: status,
        overrun: overrun === 1,
        ts: new Date(now).toISOString(),
        rail: row.rail === "x402" ? "x402" : row.rail === "stripe_spt" ? "stripe_spt" : "llm",
        approvalId: row.approval_id ?? null,
        ...(details ? { details } : {}),
      };
      if (this.afterSettleInTx) this.afterSettleInTx(this.db, ev);
      return ev;
    });
  }

  settle(reservationId: string, usage: Usage | null, chargedMicros: number, details?: Record<string, unknown>): SettleEvent {
    return this.finish(reservationId, "settled", chargedMicros, usage, details);
  }

  release(reservationId: string, details?: Record<string, unknown>): SettleEvent {
    return this.finish(reservationId, "released", 0, null, details);
  }

  chargeFull(reservationId: string, details?: Record<string, unknown>): SettleEvent {
    const row = this.get<ReservationRow>(
      "SELECT * FROM reservations WHERE id = ?",
      reservationId,
    );
    if (!row) throw new Error(`unknown reservation: ${reservationId}`);
    return this.finish(reservationId, "charged_full", row.reserved_micros, null, details);
  }

  /**
   * Re-books a charged_full x402 or stripe_spt reservation once the upstream
   * has settled the question the gateway could not answer at payment time:
   * the payment did not move (release, charged 0) or it settled late (settled,
   * charged the reserved amount).
   *
   * Only a charged_full row on the x402 or stripe_spt rail may be reconciled,
   * and only once: a released or settled row throws. Like finish(), the row
   * update and the new signed settle entry happen in one transaction, for the
   * same reservation_id, so auditRail (which keeps the LAST entry per
   * reservation) agrees with the row. The details always carry
   * reconciled_from.
   */
  reconcileCharged(
    reservationId: string,
    to: { outcome: "released" } | { outcome: "settled"; chargedMicros: number },
    details: Record<string, unknown>,
  ): SettleEvent {
    return this.tx(() => {
      const row = this.get<ReservationRow>(
        "SELECT * FROM reservations WHERE id = ?",
        reservationId,
      );
      if (!row) throw new Error(`unknown reservation: ${reservationId}`);
      if (row.rail !== "x402" && row.rail !== "stripe_spt") {
        throw new Error(`reservation ${reservationId} is not on the x402 rail or the stripe_spt rail`);
      }
      if (row.status !== "charged_full") {
        throw new Error(`reservation ${reservationId} is already ${row.status}`);
      }
      let chargedMicros: number;
      let status: "released" | "settled";
      if (to.outcome === "released") {
        chargedMicros = 0;
        status = "released";
      } else {
        chargedMicros = to.chargedMicros;
        status = "settled";
        if (
          !Number.isSafeInteger(chargedMicros) ||
          chargedMicros < 0 ||
          chargedMicros > row.reserved_micros
        ) {
          throw new Error(
            `chargedMicros must be an integer from 0 to ${row.reserved_micros}`,
          );
        }
      }
      const now = this.now();
      this.run(
        "UPDATE reservations SET charged_micros = ?, status = ?, overrun = 0, settled_ms = ? WHERE id = ?",
        chargedMicros,
        status,
        now,
        reservationId,
      );
      const ev: SettleEvent = {
        reservationId,
        mandateId: row.mandate_id,
        agentId: row.agent_id,
        model: row.model,
        provider: row.provider,
        reservedMicros: row.reserved_micros,
        chargedMicros,
        usage: null,
        outcome: status,
        overrun: false,
        ts: new Date(now).toISOString(),
        rail: row.rail === "stripe_spt" ? "stripe_spt" : "x402",
        approvalId: row.approval_id ?? null,
        details: { ...details, reconciled_from: "charged_full" },
      };
      if (this.afterSettleInTx) this.afterSettleInTx(this.db, ev);
      return ev;
    });
  }

  /**
   * Reservations left open by a crashed gateway stay counted (fail closed).
   * This books them at their full reserved amount so they appear in the
   * ledger; it never releases them, because the upstream may have billed.
   */
  sweepStale(maxAgeMs: number): SettleEvent[] {
    const cutoff = this.now() - maxAgeMs;
    const ids = this.db
      .prepare("SELECT id FROM reservations WHERE status = 'reserved' AND created_ms < ?")
      .all(cutoff) as Array<{ id: string }>;
    const out: SettleEvent[] = [];
    for (const { id } of ids) {
      try {
        out.push(this.chargeFull(id));
      } catch {
        // settled concurrently by its own request; nothing to do
      }
    }
    return out;
  }

  /**
   * What reserve() counts against the budget right now: amounts settled in the
   * current budget period plus every open hold. Used to explain a refusal.
   */
  committedInPeriod(mandateId: string, now = this.now()): number {
    const policy = this.getPolicy(mandateId);
    const since = periodStartMs(policy?.budgetPeriod, now);
    const settled =
      this.get<{ s: number }>(
        "SELECT COALESCE(SUM(charged_micros), 0) AS s FROM reservations WHERE mandate_id = ? AND status IN ('settled','charged_full') AND created_ms >= ?",
        mandateId,
        since,
      )?.s ?? 0;
    const held =
      this.get<{ s: number }>(
        "SELECT COALESCE(SUM(reserved_micros), 0) AS s FROM reservations WHERE mandate_id = ? AND status = 'reserved'",
        mandateId,
      )?.s ?? 0;
    return settled + held;
  }

  spent(mandateId: string): {
    settledMicros: number;
    reservedMicros: number;
    committedMicros: number;
  } {
    const settled =
      this.get<{ s: number }>(
        "SELECT COALESCE(SUM(charged_micros), 0) AS s FROM reservations WHERE mandate_id = ? AND status IN ('settled','charged_full')",
        mandateId,
      )?.s ?? 0;
    const reserved =
      this.get<{ s: number }>(
        "SELECT COALESCE(SUM(reserved_micros), 0) AS s FROM reservations WHERE mandate_id = ? AND status = 'reserved'",
        mandateId,
      )?.s ?? 0;
    return {
      settledMicros: settled,
      reservedMicros: reserved,
      committedMicros: settled + reserved,
    };
  }

  /**
   * Charged amounts of settled payments to one payee on one rail since sinceMs,
   * for the 30-day median price check of the payee guard.
   */
  settledAmounts(mandateId: string, rail: RailName, provider: string, sinceMs: number, opts: { excludePriceBasis?: string } = {}): number[] {
    const rows = this.db
      .prepare(
        "SELECT charged_micros AS c FROM reservations WHERE mandate_id = ? AND rail = ? AND provider = ? AND status = 'settled' AND created_ms >= ? AND COALESCE(price_basis, '') <> ? ORDER BY created_ms DESC LIMIT 10000",
      )
      .all(mandateId, rail, provider, sinceMs, opts.excludePriceBasis ?? "\u0000") as Array<{ c: number }>;
    return rows.map((r) => r.c);
  }

  /** The underlying connection, so a ledger can share the settle transaction. */
  get database(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
