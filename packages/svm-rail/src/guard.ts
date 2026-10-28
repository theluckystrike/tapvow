// Builds the payment guard for the Solana rail from a signed mandate and the
// shared budget store. Payees are base58 addresses; amounts are USDC atomic
// units, the same integer the ledger stores.
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

export function createSvmPaymentGuard(args: {
  rail: GovernedRail;
  networks: string[];
  multiplier?: number;
  firstPaymentMaxMicros?: number;
  fetchBinding?: GuardOptions["fetchBinding"];
  now?: () => number;
  bindingFreshness?: BindingFreshnessStore;
}): PaymentGuard {
  const mandate = args.rail.mandate;
  const parsed = parseX402Allowlist(mandate.allowed_payees);
  if (!parsed.ok) throw new Error(`mandate x402 payees are invalid: ${parsed.errors.join("; ")}`);
  const now = args.now ?? (() => Date.now());
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
      median30d: (payeeKey) => {
        const payTo = payeeKey.slice(payeeKey.lastIndexOf(":") + 1);
        return median(
          args.rail.store.settledAmounts(mandate.id, "x402", payTo, now() - 30 * DAY_MS, {
            excludePriceBasis: "median_30d",
          }),
        );
      },
    });
}
