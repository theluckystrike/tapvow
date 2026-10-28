// Builds the step 5 payment guard from a signed mandate and the shared budget
// store: payTo must be in the mandate allowlist or a pinned signed binding,
// and the amount must stay within N x the quoted price or the 30-day median.
import {
  checkPayment,
  median,
  parseX402Allowlist,
  SqliteBindingFreshness,
  type BindingFreshnessStore,
  type GuardOptions,
} from "@mandate/payee-guard";
import type { GovernedRail } from "@mandate/llm-rail";
import type { PaymentGuard } from "./types.js";

const DAY_MS = 86_400_000;

export function createPaymentGuard(args: {
  rail: GovernedRail;
  networks: string[];
  multiplier?: number;
  firstPaymentMaxMicros?: number;
  fetchBinding?: GuardOptions["fetchBinding"];
  now?: () => number;
  /** Defaults to a store on the rail's SQLite connection. */
  bindingFreshness?: BindingFreshnessStore;
}): PaymentGuard {
  const mandate = args.rail.mandate;
  const parsed = parseX402Allowlist(mandate.allowed_payees);
  if (!parsed.ok) throw new Error(`mandate x402 payees are invalid: ${parsed.errors.join("; ")}`);
  const now = args.now ?? (() => Date.now());
  // The rail always holds the budget store's SQLite connection, so the newest
  // binding per origin survives a restart.
  const bindingFreshness =
    args.bindingFreshness ?? new SqliteBindingFreshness(args.rail.store.database);
  return (ask) =>
    checkPayment(ask, {
      allowlist: parsed.allowlist,
      networks: args.networks,
      ...(args.multiplier !== undefined ? { multiplier: args.multiplier } : {}),
      ...(args.firstPaymentMaxMicros !== undefined ? { firstPaymentMaxMicros: args.firstPaymentMaxMicros } : {}),
      ...(args.fetchBinding ? { fetchBinding: args.fetchBinding } : {}),
      now,
      bindingFreshness,
      // The store keeps the bare lowercase address; the guard asks with
      // "eip155:<chain>:<address>". Payments that were themselves priced
      // against the median are left out, so a payee cannot ratchet the
      // reference up by 3x on every call. The reference stays anchored to
      // first payments (under the first-payment cap) and signed quotes.
      median30d: (payeeKey) => {
        const payTo = payeeKey.slice(payeeKey.lastIndexOf(":") + 1).toLowerCase();
        return median(args.rail.store.settledAmounts(mandate.id, "x402", payTo, now() - 30 * DAY_MS, { excludePriceBasis: "median_30d" }));
      },
    });
}
