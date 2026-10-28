// Minimal Stripe client for the Shared Payment Token rail.
//
// The key is passed in as a string and never placed in a URL, log line or
// error message. Every response body and thrown message is redacted before it
// leaves this module. Only a test-mode key is accepted, and only after
// GET /v1/balance has confirmed livemode:false in this client.
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_VERSION = "2026-09-30.preview";
export const DEFAULT_STRIPE_BASE_URL = "https://api.stripe.com";

const SECRET_RE = /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g;

/** Replaces any Stripe secret-shaped text with [REDACTED]. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "[REDACTED]");
}

/** Redacts every string in a parsed JSON value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [key: string]: FormValue };

export interface StripeResponse {
  status: number;
  ok: boolean;
  body: unknown;
  requestId: string | null;
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface StripeClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Override the pinned preview API version (tests only). */
  apiVersion?: string;
}

export interface GrantedToken {
  id: string;
  object: string;
  livemode?: boolean;
  agent_details?: { network_business_profile?: string | null } | null;
  shared_metadata?: Record<string, unknown> | null;
  created?: number;
  deactivated_at?: number | null;
  deactivated_reason?: string | null;
  usage_details?: { amount_captured?: { currency?: string; value?: number } } | null;
  usage_limits?: { currency?: string; expires_at?: number | null; max_amount?: number } | null;
  [key: string]: unknown;
}

export interface PaymentIntent {
  id: string;
  object?: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  livemode?: boolean;
  metadata?: Record<string, unknown> | null;
  latest_charge?: string | null;
  [key: string]: unknown;
}

export class StripeClient {
  readonly #key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiVersion: string;
  private testModeVerified = false;
  private accountIdValue: string | null = null;

  constructor(key: string, opts: StripeClientOptions = {}) {
    if (typeof key !== "string" || key.length === 0) throw new Error("Stripe key is required");
    this.#key = key;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_STRIPE_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.apiVersion = opts.apiVersion ?? STRIPE_VERSION;
  }

  /** True once assertTestMode() has passed for this client. */
  get isTestModeVerified(): boolean {
    return this.testModeVerified;
  }

  /** The acct_ id the verified key belongs to, or null before assertTestMode() passes. */
  get accountId(): string | null {
    return this.accountIdValue;
  }

  /** Never print the key, even via util.inspect or JSON.stringify. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "StripeClient { key: [REDACTED] }";
  }

  toJSON(): { key: string } {
    return { key: "[REDACTED]" };
  }

  /**
   * GET /v1/balance, then GET /v1/account. Refuses a wrong key prefix before
   * any network call, refuses a response whose livemode is not exactly false,
   * and refuses to go on when the key cannot read the account id.
   */
  async assertTestMode(): Promise<void> {
    if (!this.#key.startsWith("sk_test_") && !this.#key.startsWith("rk_test_")) {
      throw new Error("Refusing Stripe call: key must start with sk_test_ or rk_test_");
    }
    const res = await this.send("GET", "/v1/balance", undefined, undefined, { skipVersion: true, skipTestGuard: true });
    if (!res.ok) {
      throw new Error(`Refusing Stripe call: balance check returned HTTP ${res.status}`);
    }
    const livemode = isRecord(res.body) ? res.body.livemode : undefined;
    if (livemode !== false) {
      throw new Error("Refusing Stripe call: the account did not report livemode:false");
    }
    const account = await this.send("GET", "/v1/account", undefined, undefined, { skipTestGuard: true });
    if (!account.ok) {
      throw new Error(`Refusing Stripe call: account check returned HTTP ${account.status}`);
    }
    const id = isRecord(account.body) && typeof account.body.id === "string" ? account.body.id : null;
    if (id === null || !id.startsWith("acct_")) {
      throw new Error("Refusing Stripe call: the key cannot read the acct_ account id");
    }
    this.accountIdValue = id;
    this.testModeVerified = true;
  }

  /** Any authenticated request after assertTestMode(). */
  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, FormValue>,
    opts: StripeRequestOptions = {},
  ): Promise<StripeResponse> {
    this.requireTestMode();
    return this.send(method, path, params, opts);
  }

  async getToken(sptId: string): Promise<StripeResponse> {
    return this.request("GET", `/v1/shared_payment/granted_tokens/${encodeURIComponent(sptId)}`);
  }

  async createPaymentIntent(
    args: { amountCents: number; currency: string; sptId: string; metadata?: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeResponse> {
    const params: Record<string, FormValue> = {
      amount: args.amountCents,
      currency: args.currency,
      "payment_method_data[shared_payment_granted_token]": args.sptId,
      confirm: true,
    };
    for (const [k, v] of Object.entries(args.metadata ?? {})) params[`metadata[${k}]`] = v;
    return this.request("POST", "/v1/payment_intents", params, { idempotencyKey });
  }

  async createGrantedToken(args: {
    paymentMethod?: string;
    currency: string;
    maxAmount: number;
    expiresAt?: number;
    customer?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeResponse> {
    const params: Record<string, FormValue> = {
      payment_method: args.paymentMethod ?? "pm_card_visa",
      "usage_limits[currency]": args.currency.toLowerCase(),
      "usage_limits[max_amount]": args.maxAmount,
    };
    if (args.expiresAt !== undefined) params["usage_limits[expires_at]"] = args.expiresAt;
    if (args.customer !== undefined) params.customer = args.customer;
    for (const [k, v] of Object.entries(args.metadata ?? {})) params[`shared_metadata[${k}]`] = v;
    return this.request("POST", "/v1/test_helpers/shared_payment/granted_tokens", params);
  }

  async revokeToken(sptId: string): Promise<StripeResponse> {
    return this.request(
      "POST",
      `/v1/test_helpers/shared_payment/granted_tokens/${encodeURIComponent(sptId)}/revoke`,
    );
  }

  async listEvents(args: { type?: string; createdGte?: number; limit?: number }): Promise<StripeResponse> {
    const params: Record<string, FormValue> = {};
    if (args.type !== undefined) params.type = args.type;
    if (args.createdGte !== undefined) params["created[gte]"] = args.createdGte;
    if (args.limit !== undefined) params.limit = args.limit;
    return this.request("GET", "/v1/events", params);
  }

  /**
   * Every webhook endpoint, following has_more with starting_after. A list
   * that is still not finished after 20 pages throws, so a caller that must
   * inspect all endpoints never passes on a partial answer. A 2xx page whose
   * body is not a Stripe list (missing object:"list" or a non-array data)
   * throws instead of being read as an empty list, so the guard fails closed.
   */
  async listWebhookEndpoints(): Promise<StripeResponse> {
    const data: unknown[] = [];
    let startingAfter: string | null = null;
    for (let page = 0; page < 20; page++) {
      const params: Record<string, FormValue> = { limit: 100 };
      if (startingAfter !== null) params.starting_after = startingAfter;
      const res = await this.request("GET", "/v1/webhook_endpoints", params);
      if (!res.ok) return res;
      if (!isRecord(res.body) || res.body.object !== "list" || !Array.isArray(res.body.data)) {
        throw new Error("GET /v1/webhook_endpoints: a 2xx response was not a webhook endpoint list");
      }
      const body = res.body;
      const items = body.data as unknown[];
      data.push(...items);
      if (body.has_more !== true) {
        return { status: res.status, ok: res.ok, body: { object: "list", data, has_more: false }, requestId: res.requestId };
      }
      const last = items.at(-1);
      const id = isRecord(last) && typeof last.id === "string" ? last.id : null;
      if (id === null) {
        throw new Error("GET /v1/webhook_endpoints: has_more is true but the page had no id to continue from");
      }
      startingAfter = id;
    }
    throw new Error("GET /v1/webhook_endpoints: still has_more after 20 pages");
  }

  private requireTestMode(): void {
    if (!this.testModeVerified) {
      throw new Error("Refusing Stripe call: assertTestMode() must pass first");
    }
  }

  private async send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, FormValue>,
    opts: StripeRequestOptions = {},
    internal: { skipVersion?: boolean; skipTestGuard?: boolean } = {},
  ): Promise<StripeResponse> {
    if (!internal.skipTestGuard) this.requireTestMode();

    const query = method === "GET" && params ? encodeForm(params) : "";
    const url = this.baseUrl + path + (query ? `?${query}` : "");
    const headers: Record<string, string> = {
      authorization: "Basic " + Buffer.from(`${this.#key}:`, "utf8").toString("base64"),
      accept: "application/json",
      ...(internal.skipVersion ? {} : { "stripe-version": this.apiVersion }),
      ...(opts.headers ?? {}),
    };
    let body: string | undefined;
    if (method !== "GET" && params) {
      body = encodeForm(params);
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redactSecrets(`Stripe request failed: ${message}`));
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      parsed = { error: { type: "invalid_response", message: redactSecrets(text) } };
    }
    return {
      status: res.status,
      ok: res.ok,
      body: redactDeep(parsed),
      requestId: res.headers.get("request-id"),
    };
  }
}

/**
 * Returns the ids of webhook endpoints this test charge must not run against.
 * An endpoint counts as enabled unless its status is exactly "disabled"
 * (fail closed, including a missing status). It is unsafe when it listens for
 * "*" or for any payment_intent., charge. or shared_payment. event, when its
 * enabled_events is not an array, and when the list entry is not an object
 * (a null or string entry is counted as unsafe rather than skipped).
 */
export function unsafeWebhookEndpoints(list: unknown[]): string[] {
  const unsafe: string[] = [];
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) {
      unsafe.push(`<endpoint ${index}>`);
      continue;
    }
    if (item.status === "disabled") continue;
    const id = typeof item.id === "string" ? item.id : `<endpoint ${index}>`;
    const events = item.enabled_events;
    if (!Array.isArray(events)) {
      unsafe.push(id);
      continue;
    }
    const matches = events.some(
      (event) =>
        typeof event === "string" &&
        (event === "*" ||
          event.startsWith("payment_intent.") ||
          event.startsWith("charge.") ||
          event.startsWith("shared_payment.")),
    );
    if (matches) unsafe.push(id);
  }
  return unsafe;
}

/** Encodes a flat or bracket-nested object as application/x-www-form-urlencoded. */
export function encodeForm(params: Record<string, FormValue>, prefix = ""): string {
  const pairs: string[] = [];
  const add = (name: string, value: FormValue): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) add(`${name}[]`, item);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) add(name ? `${name}[${k}]` : k, v as FormValue);
      return;
    }
    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) add(prefix ? `${prefix}[${k}]` : k, v);
  return pairs.join("&");
}

/**
 * Verifies a Stripe-Signature header: one or more v1 HMAC-SHA256 signatures of
 * "<t>.<payload>" with the endpoint secret, compared in constant time, with a
 * 300 second tolerance.
 */
export function verifyStripeSignature(args: {
  payload: string | Buffer;
  signatureHeader: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  try {
    if (typeof args.secret !== "string" || args.secret.length < 16 || !args.secret.startsWith("whsec_")) {
      return false;
    }
    const tolerance = args.toleranceSeconds ?? 300;
    const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    let timestamp: number | null = null;
    let timestamps = 0;
    const signatures: string[] = [];
    for (const part of args.signatureHeader.split(",")) {
      const match = /^\s*([a-z0-9]+)=([^\s]+)\s*$/i.exec(part);
      if (!match) continue;
      const key = match[1]!;
      const value = match[2]!;
      if (key === "t") {
        timestamps++;
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) timestamp = parsed;
      } else if (key === "v1") {
        // Buffer.from(hex) stops at the first non-hex character, so only a
        // full 64 character lowercase hex value is a v1 signature.
        if (/^[0-9a-f]{64}$/.test(value)) signatures.push(value);
      }
    }
    if (timestamps > 1) return false;
    if (timestamp === null || signatures.length === 0) return false;
    if (Math.abs(now - timestamp) > tolerance) return false;

    const payload = typeof args.payload === "string" ? args.payload : args.payload.toString("utf8");
    const expected = createHmac("sha256", args.secret).update(`${timestamp}.${payload}`, "utf8").digest();
    for (const sig of signatures) {
      const given = Buffer.from(sig, "hex");
      if (given.length !== expected.length) continue;
      if (timingSafeEqual(given, expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const verifyWebhookSignature = verifyStripeSignature;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
