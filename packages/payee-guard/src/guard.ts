import { formatUsd } from "@mandate/core";
import { addressKey, type X402Allowlist } from "./allowlist.js";
import {
  fetchBinding as defaultFetchBinding,
  verifyBinding,
  type PayeeBinding,
} from "./binding.js";
import { USDC } from "./constants.js";
import { isIssuedAtValid, type BindingFreshnessStore } from "./freshness.js";

export interface PaymentAsk {
  resourceUrl: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

export type GuardCode =
  | "bad_request"
  | "network_not_allowed"
  | "asset_not_allowed"
  | "payee_not_allowed"
  | "payee_binding_invalid"
  | "binding_rolled_back"
  | "amount_out_of_bounds";

export type GuardResult =
  | {
      ok: true;
      amountMicros: number;
      payeeBasis: "allowlist" | "binding";
      priceBasis: "quote" | "median_30d" | "first_payment";
      referenceMicros: number | null;
      bindingHash?: string;
    }
  | { ok: false; code: GuardCode; reason: string };

export interface GuardOptions {
  allowlist: X402Allowlist;
  networks: string[];
  multiplier?: number;
  firstPaymentMaxMicros?: number;
  median30d: (payeeKey: string) => number | null;
  fetchBinding?: (
    origin: string,
  ) => Promise<{ ok: true; doc: unknown } | { ok: false; reason: string }>;
  now?: () => number;
  bindingFreshness?: BindingFreshnessStore;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INT_RE = /^[1-9]\d*$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const DEFAULT_MULTIPLIER = 3;
const DEFAULT_FIRST_PAYMENT_MAX_MICROS = 50_000;

function deny(code: GuardCode, reason: string): GuardResult {
  return { ok: false, code, reason };
}

function isCanonicalAmount(v: unknown): v is string {
  if (typeof v !== "string" || !INT_RE.test(v)) return false;
  return BigInt(v) <= MAX_SAFE;
}

export async function checkPayment(ask: PaymentAsk, opts: GuardOptions): Promise<GuardResult> {
  // a. resourceUrl parses as http/https.
  let resource: URL;
  try {
    resource = new URL(ask.resourceUrl);
  } catch {
    return deny("bad_request", `resourceUrl is not a valid URL: ${JSON.stringify(ask.resourceUrl)}`);
  }
  if (resource.protocol !== "http:" && resource.protocol !== "https:") {
    return deny("bad_request", `resourceUrl must use http or https, got ${resource.protocol}`);
  }

  // b. network is enabled by the operator.
  if (!opts.networks.includes(ask.network)) {
    return deny("network_not_allowed", `network ${ask.network} is not enabled`);
  }

  // c. asset is USDC on that network.
  const expectedAsset = USDC[ask.network];
  if (typeof ask.asset !== "string" || expectedAsset === undefined || ask.asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    return deny("asset_not_allowed", `asset ${ask.asset} is not USDC on ${ask.network}`);
  }

  // d. payTo and amount are well-formed.
  if (typeof ask.payTo !== "string" || !ADDRESS_RE.test(ask.payTo) || ask.payTo.toLowerCase() === ZERO_ADDRESS) {
    return deny("bad_request", `payTo ${JSON.stringify(ask.payTo)} is not a valid non-zero address`);
  }
  if (!isCanonicalAmount(ask.amount)) {
    return deny("bad_request", `amount ${JSON.stringify(ask.amount)} is not a positive integer string`);
  }
  const amountMicros = Number(ask.amount);

  // Bad configuration must not switch the bounds off (amount > NaN is false).
  const multiplier = opts.multiplier ?? DEFAULT_MULTIPLIER;
  const firstPaymentMaxMicros = opts.firstPaymentMaxMicros ?? DEFAULT_FIRST_PAYMENT_MAX_MICROS;
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isSafeInteger(firstPaymentMaxMicros) || firstPaymentMaxMicros < 0) {
    return deny("bad_request", "guard misconfigured: multiplier and firstPaymentMaxMicros must be positive numbers");
  }

  // e. payee must be in the allowlist, or bound to the resource origin.
  const origin = resource.origin;
  const payeeKey = addressKey(ask.network, ask.payTo);

  let payeeBasis: "allowlist" | "binding" | null = null;
  let bindingHash: string | undefined;
  let matchedBindingEntry:
    | { payee: PayeeBinding["payees"][number]; binding: PayeeBinding }
    | undefined;

  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(resource.hostname);
  if (opts.allowlist.addresses.has(payeeKey)) {
    // Plain http lets anyone on the path rewrite the 402, so only loopback may use it.
    if (resource.protocol !== "https:" && !loopback) {
      return deny("bad_request", `resource ${origin} must use https`);
    }
    payeeBasis = "allowlist";
  } else {
    const bindingEntries = opts.allowlist.bindings.filter((b) => b.origin === origin);
    if (bindingEntries.length > 0) {
      const fetchBinding = opts.fetchBinding ?? defaultFetchBinding;
      const now = opts.now ? opts.now() : Date.now();

      let fetched: { ok: true; doc: unknown } | { ok: false; reason: string };
      try {
        fetched = await fetchBinding(origin);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return deny("payee_binding_invalid", `payee binding fetch failed: ${message}`);
      }
      if (!fetched.ok) {
        return deny("payee_binding_invalid", fetched.reason);
      }

      // Several pinned keys for one origin allow key rotation; any one may sign.
      let verified: ReturnType<typeof verifyBinding> = { ok: false, reason: "no pinned key" };
      for (const entry of bindingEntries) {
        verified = verifyBinding(fetched.doc, entry.publicKey, origin, now);
        if (verified.ok) break;
      }
      if (!verified.ok) {
        return deny("payee_binding_invalid", verified.reason);
      }

      // An older binding replayed after the payee rotated would otherwise be
      // accepted until it expires. Only a binding that verified may move the
      // stored value; an equal issued_at is not a rollback.
      if (opts.bindingFreshness) {
        const newest = opts.bindingFreshness.newestIssuedAt(origin);
        // A stored value that does not parse is corrupt: Date.parse is NaN, so
        // without this check no later rollback would ever be blocked. Block
        // rather than repair here, because the binding under review has not
        // been accepted yet; record() overwrites the corrupt row the next time
        // a verified binding is recorded.
        if (newest !== null && !isIssuedAtValid(newest)) {
          return deny(
            "binding_rolled_back",
            `payee binding for ${origin} cannot be checked: the stored freshness value ${JSON.stringify(newest)} is invalid (it does not parse as a date), so a replay cannot be ruled out`,
          );
        }
        if (newest !== null && Date.parse(newest) > Date.parse(verified.binding.issued_at)) {
          return deny(
            "binding_rolled_back",
            `payee binding for ${origin} was issued at ${verified.binding.issued_at}, older than the newest binding seen for that origin at ${newest}`,
          );
        }
        opts.bindingFreshness.record(origin, verified.binding.issued_at);
      }

      const match = verified.binding.payees.find(
        (p) =>
          p.network === ask.network &&
          p.asset.toLowerCase() === ask.asset.toLowerCase() &&
          p.pay_to.toLowerCase() === ask.payTo.toLowerCase(),
      );
      if (!match) {
        return deny(
          "payee_not_allowed",
          `payTo ${ask.payTo} on ${ask.network} is not listed in the signed payee binding for ${origin}`,
        );
      }
      payeeBasis = "binding";
      bindingHash = verified.hash;
      matchedBindingEntry = { payee: match, binding: verified.binding };
    } else {
      return deny(
        "payee_not_allowed",
        `payTo ${ask.payTo} on ${ask.network} is not in the mandate allowlist, and origin ${origin} has no pinned payee binding`,
      );
    }
  }

  // f. amount must be within bounds of a price reference.

  if (matchedBindingEntry) {
    const quotes = matchedBindingEntry.payee.quotes ?? [];
    const quote = quotes.find((q) => q.path === resource.pathname);
    // A payee that signs quotes must quote this exact path; /report/ or //report
    // must not escape the /report quote by falling back to the median.
    if (!quote && quotes.length > 0) {
      return deny(
        "amount_out_of_bounds",
        `the signed binding for ${origin} quotes prices but has no quote for path ${resource.pathname}`,
      );
    }
    if (quote) {
      const referenceMicros = Number(quote.amount);
      if (amountMicros > multiplier * referenceMicros) {
        return deny(
          "amount_out_of_bounds",
          `amount ${formatUsd(amountMicros)} USDC is more than ${multiplier}x the quoted price ${formatUsd(referenceMicros)} USDC for ${ask.resourceUrl}`,
        );
      }
      return {
        ok: true,
        amountMicros,
        payeeBasis: payeeBasis!,
        priceBasis: "quote",
        referenceMicros,
        ...(bindingHash !== undefined ? { bindingHash } : {}),
      };
    }
  }

  const median = opts.median30d(payeeKey);
  if (typeof median === "number" && Number.isFinite(median) && median > 0) {
    if (amountMicros > multiplier * median) {
      return deny(
        "amount_out_of_bounds",
        `amount ${formatUsd(amountMicros)} USDC is more than ${multiplier}x the 30-day median ${formatUsd(median)} USDC for payee ${ask.payTo}`,
      );
    }
    return {
      ok: true,
      amountMicros,
      payeeBasis: payeeBasis!,
      priceBasis: "median_30d",
      referenceMicros: median,
      ...(bindingHash !== undefined ? { bindingHash } : {}),
    };
  }

  if (amountMicros > firstPaymentMaxMicros) {
    return deny(
      "amount_out_of_bounds",
      `amount ${formatUsd(amountMicros)} USDC is above the ${formatUsd(firstPaymentMaxMicros)} USDC first-payment limit for payee ${ask.payTo} (no quote and no 30-day history)`,
    );
  }
  return {
    ok: true,
    amountMicros,
    payeeBasis: payeeBasis!,
    priceBasis: "first_payment",
    referenceMicros: null,
    ...(bindingHash !== undefined ? { bindingHash } : {}),
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.ceil((sorted[mid - 1]! + sorted[mid]!) / 2);
}
