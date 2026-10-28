import type { Dialect } from "./estimate.js";

/** Upstream providers the gateway can route to. Each one speaks one dialect. */
export type Provider = "openai" | "anthropic" | "nebius";

/**
 * The wire dialect of each provider. Nebius Token Factory is OpenAI-compatible,
 * so its models are served on the chat completions route and forwarded to the
 * Nebius upstream instead of the OpenAI one.
 */
export const PROVIDER_DIALECT: Record<Provider, Dialect> = {
  openai: "openai",
  anthropic: "anthropic",
  nebius: "openai",
};

export interface ModelPrice {
  provider: Provider;
  inPerMTok: number;
  outPerMTok: number;
  cacheReadPerMTok?: number;
  /** Anthropic prompt-cache writes. 1.25x input for 5 min TTL, 2x for 1 h. Billed at the 1 h rate to err high. */
  cacheWritePerMTok?: number;
  /** Long-context tier: when input tokens exceed thresholdTokens the whole call bills at these rates. */
  longContext?: { thresholdTokens: number; inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };
  /** The most output tokens the model can produce in one call (provider documentation). */
  maxOutputTokens: number;
  /** The output bound used when a request sends no max_tokens. See the rule in the comment above PRICING. */
  defaultOutputTokens: number;
}

// Output limits. maxOutputTokens is the model's documented maximum output per
// call (OpenAI model pages, Anthropic models overview; 32000 for the deepseek
// lock is the output limit in its OpenCode provider config). A requested
// max_tokens above it is clamped to it, both for the reservation and in the
// body sent upstream, so the reservation stays a true upper bound.
// defaultOutputTokens is used when a request sends no max_tokens. The rule is
// the largest power of two (or the model limit) whose output costs at most
// 0.05 USD at the list output price, and never less than 1024.
export const PRICING: Record<string, ModelPrice> = {
  "gpt-4o": { provider: "openai", inPerMTok: 2.5, outPerMTok: 10.0, cacheReadPerMTok: 1.25, maxOutputTokens: 16384, defaultOutputTokens: 4096 },
  "gpt-4o-mini": { provider: "openai", inPerMTok: 0.15, outPerMTok: 0.6, cacheReadPerMTok: 0.075, maxOutputTokens: 16384, defaultOutputTokens: 16384 },
  "gpt-4.1": { provider: "openai", inPerMTok: 2.0, outPerMTok: 8.0, cacheReadPerMTok: 0.5, maxOutputTokens: 32768, defaultOutputTokens: 4096 },
  "gpt-4.1-mini": { provider: "openai", inPerMTok: 0.4, outPerMTok: 1.6, cacheReadPerMTok: 0.1, maxOutputTokens: 32768, defaultOutputTokens: 16384 },
  "claude-sonnet-4-5": {
    provider: "anthropic", inPerMTok: 3.0, outPerMTok: 15.0, cacheReadPerMTok: 0.3, cacheWritePerMTok: 6.0,
    longContext: { thresholdTokens: 200_000, inPerMTok: 6.0, outPerMTok: 22.5, cacheReadPerMTok: 0.6, cacheWritePerMTok: 12.0 },
    maxOutputTokens: 64000, defaultOutputTokens: 2048,
  },
  "claude-haiku-4-5": { provider: "anthropic", inPerMTok: 1.0, outPerMTok: 5.0, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.0, maxOutputTokens: 64000, defaultOutputTokens: 8192 },
  // The 5-series rows were added on 23 Oct 2026 from the Anthropic model table
  // (input and output per MTok, 1M context, 128K output). Cache writes use 2x
  // input (the 1 h rate, to err high), like the rows above. Cache reads use the
  // documented rate or 10% of input, whichever is higher. Claude Haiku 5.5 bills
  // 0.10 / 0.50 up to 100K input tokens and 0.50 / 2.50 above; its cache read
  // rate was not in the source, so cached input bills at the input rate.
  "claude-opus-5-5": { provider: "anthropic", inPerMTok: 4.0, outPerMTok: 20.0, cacheReadPerMTok: 0.4, cacheWritePerMTok: 8.0, maxOutputTokens: 128000, defaultOutputTokens: 2048 },
  "claude-opus-5": { provider: "anthropic", inPerMTok: 5.0, outPerMTok: 25.0, cacheReadPerMTok: 0.5, cacheWritePerMTok: 10.0, maxOutputTokens: 128000, defaultOutputTokens: 1024 },
  "claude-sonnet-5-5": { provider: "anthropic", inPerMTok: 2.0, outPerMTok: 10.0, cacheReadPerMTok: 0.2, cacheWritePerMTok: 4.0, maxOutputTokens: 128000, defaultOutputTokens: 4096 },
  "claude-sonnet-5": { provider: "anthropic", inPerMTok: 2.0, outPerMTok: 10.0, cacheReadPerMTok: 0.2, cacheWritePerMTok: 4.0, maxOutputTokens: 128000, defaultOutputTokens: 4096 },
  "claude-haiku-5-5": {
    provider: "anthropic", inPerMTok: 0.1, outPerMTok: 0.5, cacheWritePerMTok: 0.2,
    longContext: { thresholdTokens: 100_000, inPerMTok: 0.5, outPerMTok: 2.5, cacheWritePerMTok: 1.0 },
    maxOutputTokens: 128000, defaultOutputTokens: 65536,
  },
  "claude-opus-4-1": { provider: "anthropic", inPerMTok: 15.0, outPerMTok: 75.0, cacheReadPerMTok: 1.5, cacheWritePerMTok: 30.0, maxOutputTokens: 32000, defaultOutputTokens: 1024 },
  // deepseek/deepseek-v4.1-flash-1017 is billed through an OpenAI-dialect model
  // lock. The catalog's discounted list rates (0.08 in / 0.50 out / 0.008 cache
  // read) under-count: on the 16 dogfood calls of 18 Oct 2026 the upstream's own
  // usage.cost billed cache-miss input at 0.15 USD/M and output at 0.60 USD/M
  // (a call with 13758 input, 0 cached and 97 output cost exactly 0.0021219 USD),
  // and cache reads at no more than 0.005 USD/M. Per token class the table takes
  // the higher of the catalog rate and the rate implied by that reported cost:
  // 0.15 in, 0.60 out, and 0.008 stays for cache reads (catalog 0.008 > implied
  // 0.005). Settling at the upstream usage.cost when it is higher covers any
  // remaining gap.
  "deepseek/deepseek-v4.1-flash-1017": { provider: "openai", inPerMTok: 0.15, outPerMTok: 0.6, cacheReadPerMTok: 0.008, maxOutputTokens: 32000, defaultOutputTokens: 32000 },
  // Nebius Token Factory, read on 23 Oct 2026 from the public catalog that
  // feeds the Token Factory models and prices pages (NEBIUS_PRICING_SOURCES).
  // USD per 1M tokens, base ("cheap") flavor, the only flavor listed that day.
  // Nebius publishes no per-model output limit, so maxOutputTokens is a gateway
  // bound of 32768 (requests above it are clamped, which keeps the reservation
  // a true upper bound); defaultOutputTokens follows the 0.05 USD rule above.
  // Rows without a cached price bill cached input at the full input price.
  "nvidia/nemotron-3-super-120b-a12b": { provider: "nebius", inPerMTok: 0.3, outPerMTok: 0.9, cacheReadPerMTok: 0.06, maxOutputTokens: 32768, defaultOutputTokens: 32768 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { provider: "nebius", inPerMTok: 1.0, outPerMTok: 3.0, cacheReadPerMTok: 0.12, maxOutputTokens: 32768, defaultOutputTokens: 16384 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { provider: "nebius", inPerMTok: 0.06, outPerMTok: 0.24, maxOutputTokens: 32768, defaultOutputTokens: 32768 },
  "nvidia/Nemotron-3_5-Lightning": { provider: "nebius", inPerMTok: 0.06, outPerMTok: 0.24, maxOutputTokens: 32768, defaultOutputTokens: 32768 },
  "moonshotai/Kimi-K2.7-Code": { provider: "nebius", inPerMTok: 0.95, outPerMTok: 4.0, cacheReadPerMTok: 0.15, maxOutputTokens: 32768, defaultOutputTokens: 8192 },
  "deepseek-ai/DeepSeek-V4-Flash-0731": { provider: "nebius", inPerMTok: 0.14, outPerMTok: 0.28, cacheReadPerMTok: 0.01, maxOutputTokens: 32768, defaultOutputTokens: 32768 },
  "openai/gpt-oss-120b": { provider: "nebius", inPerMTok: 0.15, outPerMTok: 0.6, maxOutputTokens: 32768, defaultOutputTokens: 32768 },
};

/** The Nebius Token Factory models in the price table, NVIDIA Nemotron first. */
export const NEBIUS_MODELS: readonly string[] = Object.keys(PRICING).filter((m) => PRICING[m]!.provider === "nebius");

/** The model that `tapvow init --provider nebius` writes into the client files. */
export const NEBIUS_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

const NEBIUS_CATALOG = "https://tokenfactory.nebius.com/api/public/models_info";

/** Where each Nebius price came from, and when it was read. */
export const NEBIUS_PRICING_SOURCES: Record<string, { url: string; date: string }> = Object.fromEntries(
  NEBIUS_MODELS.map((m) => [m, { url: NEBIUS_CATALOG, date: "2026-10-23" }]),
);

/** Output bounds for a priced model, or null for an unknown model. */
export function outputLimits(model: string): { max: number; default: number } | null {
  if (!Object.prototype.hasOwnProperty.call(PRICING, model)) return null;
  const price = PRICING[model]!;
  return { max: price.maxOutputTokens, default: price.defaultOutputTokens };
}

export const PRICING_SOURCE = {
  openai: "https://openai.com/api/pricing/",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  nebius: NEBIUS_CATALOG,
  recorded: "2026-10-18, Claude 5-series and Nebius rows 2026-10-23",
} as const;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Input tokens written to a prompt cache (Anthropic cache_creation_input_tokens). Part of inputTokens. */
  cacheWriteTokens?: number;
  /** Reasoning tokens, informational: already counted in outputTokens. */
  reasoningTokens?: number;
}

function tokenCount(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n);
}

/**
 * What the price table bills for the given usage. The result is rounded up with
 * Math.ceil, so it is never below the exact cost for those token counts.
 */
export function costMicros(model: string, u: Usage): number {
  const base = PRICING[model];
  if (!base) throw new Error(`unknown model: ${model}`);
  const input = tokenCount(u.inputTokens);
  const lc = base.longContext;
  const tier = lc && input > lc.thresholdTokens ? { ...base, ...lc } : base;
  const cacheRead = tier.cacheReadPerMTok ?? tier.inPerMTok;
  const cacheWrite = Math.max(tier.cacheWritePerMTok ?? tier.inPerMTok, tier.inPerMTok);
  const cached = Math.min(tokenCount(u.cachedInputTokens), input);
  const written = Math.min(tokenCount(u.cacheWriteTokens ?? 0), input - cached);
  const plain = input - cached - written;
  const output = tokenCount(u.outputTokens);
  // Integer math in pico-USD per token, so the sum never picks up float noise
  // (with 0.06 USD/M rates, two float sums of the same tokens could round up to
  // different micros, and a reservation could end 1 micro below the charge).
  const pico =
    plain * picoRate(tier.inPerMTok) +
    cached * picoRate(cacheRead) +
    written * picoRate(cacheWrite) +
    output * picoRate(tier.outPerMTok);
  if (!Number.isSafeInteger(pico)) {
    return Math.ceil(plain * tier.inPerMTok + cached * cacheRead + written * cacheWrite + output * tier.outPerMTok);
  }
  return Math.floor((pico + 999_999) / 1_000_000);
}

/** A USD-per-1M-token rate as an integer number of pico-USD per token. Rates have at most 6 decimals. */
export function picoRate(perMTok: number): number {
  const scaled = Math.round(perMTok * 1_000_000);
  if (Math.abs(scaled - perMTok * 1_000_000) > 1e-6 * Math.max(1, Math.abs(scaled))) {
    throw new Error(`price ${perMTok} has more than 6 decimals`);
  }
  return scaled;
}

/**
 * Worst case for a call whose input is at most maxInputTokens and output at
 * most maxOutputTokens: every input token billed at the highest input rate the
 * model has (a cache write), at the long-context tier when the bound crosses it.
 */
export function worstCaseMicros(model: string, maxInputTokens: number, maxOutputTokens: number, mayWriteCache = true): number {
  return costMicros(model, {
    inputTokens: maxInputTokens,
    outputTokens: maxOutputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: mayWriteCache ? maxInputTokens : 0,
  });
}

export interface Settlement {
  chargedMicros: number;
  tableMicros: number;
  upstreamCostMicros: number | null;
  basis: "price_table" | "upstream_cost";
}

/**
 * Reconciles the price table with what the upstream says it billed. The table is
 * a floor, so the upstream cost can only raise the charge, never lower it: some
 * upstreams report a placeholder cost (Nous returned a constant 0.00005 USD in
 * Aug 2026), and a real cost at or below the table is already covered.
 *
 * upstreamCostMicros is the upstream USD cost scaled to micro-USD and rounded
 * up. The tiny epsilon absorbs float noise such as 0.0021219 * 1e6 =
 * 2121.9000000000005; the guard then adds one if rounding still came out below
 * the exact scaled cost, so it never rounds down.
 */
export function settleMicros(
  model: string,
  usage: Usage,
  upstreamCostUsd: number | null,
): Settlement {
  const tableMicros = costMicros(model, usage);
  let upstreamCostMicros: number | null = null;
  if (typeof upstreamCostUsd === "number" && Number.isFinite(upstreamCostUsd) && upstreamCostUsd >= 0) {
    const scaled = upstreamCostUsd * 1e6;
    let micros = Math.ceil(scaled - 1e-6);
    if (micros < scaled - 0.001) micros += 1;
    // A cost too large to store as a safe integer is clamped to 1,000,000 USD,
    // which still exhausts any budget instead of throwing mid-settlement.
    upstreamCostMicros = Number.isSafeInteger(micros) && micros <= 1e12 ? micros : 1e12;
  }
  const chargedMicros = Math.max(tableMicros, upstreamCostMicros ?? 0);
  const basis: Settlement["basis"] =
    upstreamCostMicros != null && upstreamCostMicros > tableMicros ? "upstream_cost" : "price_table";
  return { chargedMicros, tableMicros, upstreamCostMicros, basis };
}
