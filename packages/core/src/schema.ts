import { canonicalize } from "./canonical.js";
import { parseUsd } from "./money.js";
import { signBytes, verifyBytes, type Signer } from "./keys.js";

export type Rail = "llm" | "x402" | "stripe_spt" | "card";
export type BudgetPeriod = "lifetime" | "day" | "month";

export interface Issuer {
  id: string;
  public_key: string;
}

export interface Budget {
  total: string;
  period: BudgetPeriod;
}

export interface Payee {
  rail: Rail;
  id: string;
}

export interface RateLimit {
  max_calls: number;
  window_seconds: number;
}

export interface Mandate {
  mandate_version: "0.1";
  type: "IntentMandate";
  id: string;
  issuer: Issuer;
  agents: string[];
  natural_language_description: string;
  currency: "USD";
  budget: Budget;
  per_call_cap: string;
  allowed_payees: Payee[];
  rate_limit: RateLimit;
  approval_threshold: string;
  rails: Rail[];
  not_before: string;
  expires_at: string;
  created_at: string;
  /** Optional signed binding to one budget database's store id. */
  store_id?: string;
}

export interface SignedMandate {
  mandate: Mandate;
  signature: string;
  key_id: string;
}

const RAILS: readonly Rail[] = ["llm", "x402", "stripe_spt", "card"];
const PERIODS: readonly BudgetPeriod[] = ["lifetime", "day", "month"];
const ROOT_KEYS = new Set([
  "mandate_version",
  "type",
  "id",
  "issuer",
  "agents",
  "natural_language_description",
  "currency",
  "budget",
  "per_call_cap",
  "allowed_payees",
  "rate_limit",
  "approval_threshold",
  "rails",
  "not_before",
  "expires_at",
  "created_at",
  "store_id",
]);

const USD_RE = /^\d{1,9}(\.\d{1,6})?$/;
const ID_RE = /^mdt_[A-Za-z0-9_-]{8,64}$/;
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STORE_ID_RE = /^st_[A-Za-z0-9_-]{16,64}$/;
const PUBKEY_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/; // 32 bytes, canonical last char
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const MANDATE_SIGNING_PREFIX = "mandate/v0.1\n";
const RAIL_LIST = RAILS.join(", ");

// Date.parse("2026-02-31T00:00:00Z") rolls over to 3 March instead of failing,
// so require the parsed date to print back to the same calendar fields.
function isRealDate(v: string): boolean {
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 19) === v.slice(0, 19);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUsd(v: unknown): v is string {
  return typeof v === "string" && USD_RE.test(v);
}

function isRail(v: unknown): v is Rail {
  return typeof v === "string" && (RAILS as readonly string[]).includes(v);
}

function isPeriod(v: unknown): v is BudgetPeriod {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v);
}

function cpLen(s: string): number {
  return [...s].length;
}

function checkUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, prefix: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${prefix}${key}: unknown field`);
  }
}

const ISSUER_KEYS = new Set(["id", "public_key"]);
const BUDGET_KEYS = new Set(["total", "period"]);
const PAYEE_KEYS = new Set(["rail", "id"]);
const RATE_KEYS = new Set(["max_calls", "window_seconds"]);

export function validateMandate(
  input: unknown,
): { ok: true; mandate: Mandate } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["mandate: must be an object"] };
  }
  const m = input;

  checkUnknownKeys(m, ROOT_KEYS, "", errors);

  if (m.mandate_version !== "0.1") errors.push('mandate_version: must be "0.1"');
  if (m.type !== "IntentMandate") errors.push('type: must be "IntentMandate"');
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    errors.push("id: must match ^mdt_[A-Za-z0-9_-]{8,64}$");
  }

  if (!isRecord(m.issuer)) {
    errors.push("issuer: must be an object");
  } else {
    const iss = m.issuer;
    checkUnknownKeys(iss, ISSUER_KEYS, "issuer.", errors);
    if (typeof iss.id !== "string" || cpLen(iss.id) < 1 || cpLen(iss.id) > 128) {
      errors.push("issuer.id: must be a string of 1..128 characters");
    }
    if (typeof iss.public_key !== "string" || !PUBKEY_RE.test(iss.public_key)) {
      errors.push("issuer.public_key: must be a 43-character base64url string");
    }
  }

  if (!Array.isArray(m.agents) || m.agents.length < 1 || m.agents.length > 1000) {
    errors.push("agents: must be an array of 1..1000 items");
  } else {
    const seen = new Set<string>();
    m.agents.forEach((a, i) => {
      if (typeof a !== "string" || !AGENT_RE.test(a)) {
        errors.push(`agents[${i}]: must match ^[A-Za-z0-9._-]{1,64}$`);
      } else if (seen.has(a)) {
        errors.push(`agents[${i}]: duplicate value`);
      } else {
        seen.add(a);
      }
    });
  }

  if (
    typeof m.natural_language_description !== "string" ||
    cpLen(m.natural_language_description) < 1 ||
    cpLen(m.natural_language_description) > 2000
  ) {
    errors.push("natural_language_description: must be a string of 1..2000 characters");
  }

  if (m.currency !== "USD") errors.push('currency: must be "USD"');

  if (!isRecord(m.budget)) {
    errors.push("budget: must be an object");
  } else {
    const b = m.budget;
    checkUnknownKeys(b, BUDGET_KEYS, "budget.", errors);
    if (!isUsd(b.total)) errors.push("budget.total: must be a USD string");
    if (!isPeriod(b.period)) errors.push(`budget.period: must be one of ${PERIODS.join(", ")}`);
  }

  if (!isUsd(m.per_call_cap)) errors.push("per_call_cap: must be a USD string");

  if (!Array.isArray(m.allowed_payees) || m.allowed_payees.length < 1 || m.allowed_payees.length > 500) {
    errors.push("allowed_payees: must be an array of 1..500 items");
  } else {
    m.allowed_payees.forEach((p, i) => {
      if (!isRecord(p)) {
        errors.push(`allowed_payees[${i}]: must be an object`);
        return;
      }
      checkUnknownKeys(p, PAYEE_KEYS, `allowed_payees[${i}].`, errors);
      if (!isRail(p.rail)) errors.push(`allowed_payees[${i}].rail: must be one of ${RAIL_LIST}`);
      if (typeof p.id !== "string" || cpLen(p.id) < 1 || cpLen(p.id) > 256) {
        errors.push(`allowed_payees[${i}].id: must be a string of 1..256 characters`);
      }
    });
  }

  if (!isRecord(m.rate_limit)) {
    errors.push("rate_limit: must be an object");
  } else {
    const r = m.rate_limit;
    checkUnknownKeys(r, RATE_KEYS, "rate_limit.", errors);
    if (
      typeof r.max_calls !== "number" ||
      !Number.isInteger(r.max_calls) ||
      r.max_calls < 1 ||
      r.max_calls > 1_000_000
    ) {
      errors.push("rate_limit.max_calls: must be an integer of 1..1000000");
    }
    if (
      typeof r.window_seconds !== "number" ||
      !Number.isInteger(r.window_seconds) ||
      r.window_seconds < 1 ||
      r.window_seconds > 86_400
    ) {
      errors.push("rate_limit.window_seconds: must be an integer of 1..86400");
    }
  }

  if (!isUsd(m.approval_threshold)) errors.push("approval_threshold: must be a USD string");

  if (!Array.isArray(m.rails) || m.rails.length < 1 || m.rails.length > 10) {
    errors.push("rails: must be an array of 1..10 items");
  } else {
    const seen = new Set<string>();
    m.rails.forEach((r, i) => {
      if (!isRail(r)) {
        errors.push(`rails[${i}]: must be one of ${RAIL_LIST}`);
      } else if (seen.has(r)) {
        errors.push(`rails[${i}]: duplicate value`);
      } else {
        seen.add(r);
      }
    });
  }

  for (const field of ["not_before", "expires_at", "created_at"] as const) {
    const v = m[field];
    if (typeof v !== "string" || !TS_RE.test(v) || !isRealDate(v)) {
      errors.push(`${field}: must be an RFC3339 UTC timestamp ending in Z`);
    }
  }

  if (m.store_id !== undefined && (typeof m.store_id !== "string" || !STORE_ID_RE.test(m.store_id))) {
    errors.push("store_id: must match ^st_[A-Za-z0-9_-]{16,64}$");
  }

  // Semantic rules, applied only when the underlying fields are well-formed.
  const budgetTotal = isRecord(m.budget) ? m.budget.total : undefined;
  if (isUsd(budgetTotal)) {
    const total = parseUsd(budgetTotal);
    if (isUsd(m.per_call_cap) && parseUsd(m.per_call_cap) > total) {
      errors.push("per_call_cap: must not exceed budget.total");
    }
    if (isUsd(m.approval_threshold) && parseUsd(m.approval_threshold) > total) {
      errors.push("approval_threshold: must not exceed budget.total");
    }
  }

  if (
    typeof m.expires_at === "string" &&
    typeof m.not_before === "string" &&
    TS_RE.test(m.expires_at) &&
    TS_RE.test(m.not_before)
  ) {
    const expires = Date.parse(m.expires_at);
    const notBefore = Date.parse(m.not_before);
    if (!Number.isNaN(expires) && !Number.isNaN(notBefore) && expires <= notBefore) {
      errors.push("expires_at: must be after not_before");
    }
  }

  if (Array.isArray(m.rails) && Array.isArray(m.allowed_payees)) {
    const railSet = new Set(m.rails.filter(isRail));
    m.allowed_payees.forEach((p, i) => {
      if (isRecord(p) && isRail(p.rail) && !railSet.has(p.rail)) {
        errors.push(`allowed_payees[${i}].rail: not listed in rails`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, mandate: input as unknown as Mandate };
}

export function signMandate(m: Mandate, signer: Signer): SignedMandate {
  const message = new TextEncoder().encode(MANDATE_SIGNING_PREFIX + canonicalize(m));
  const signature = signBytes(signer.privateKey, message);
  return { mandate: m, signature, key_id: signer.keyId };
}

export function verifySignedMandate(
  s: unknown,
  trustedPublicKey: string,
): { ok: true; mandate: Mandate } | { ok: false; reason: string } {
  if (!isRecord(s)) return { ok: false, reason: "document: must be an object" };
  const result = validateMandate(s.mandate);
  if (!result.ok) return { ok: false, reason: result.errors.join("; ") };
  const mandate = result.mandate;
  if (typeof s.signature !== "string") return { ok: false, reason: "signature: must be a string" };
  if (typeof s.key_id !== "string") return { ok: false, reason: "key_id: must be a string" };
  if (mandate.issuer.public_key !== trustedPublicKey) {
    return { ok: false, reason: "issuer.public_key does not match the trusted key" };
  }
  const message = new TextEncoder().encode(MANDATE_SIGNING_PREFIX + canonicalize(mandate));
  if (!verifyBytes(trustedPublicKey, message, s.signature)) {
    return { ok: false, reason: "signature verification failed" };
  }
  return { ok: true, mandate };
}

export const EXAMPLE_MANDATE: Mandate = {
  mandate_version: "0.1",
  type: "IntentMandate",
  id: "mdt_example0001",
  issuer: {
    id: "example-issuer",
    public_key: "A".repeat(43),
  },
  agents: Array.from({ length: 10 }, (_, i) => `agent-${String(i + 1).padStart(2, "0")}`),
  natural_language_description:
    "Allow these agents to buy model inference and settle x402 payments within the budget.",
  currency: "USD",
  budget: { total: "5.00", period: "lifetime" },
  per_call_cap: "0.50",
  allowed_payees: [
    { rail: "llm", id: "openai" },
    { rail: "llm", id: "anthropic" },
  ],
  rate_limit: { max_calls: 60, window_seconds: 60 },
  approval_threshold: "1.00",
  rails: ["llm", "x402"],
  not_before: "2026-10-18T00:00:00Z",
  expires_at: "2026-11-17T00:00:00Z",
  created_at: "2026-10-18T00:00:00Z",
};
