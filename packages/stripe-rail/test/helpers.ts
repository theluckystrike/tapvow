import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate, type SignedMandate } from "@mandate/core";
import { openGovernedRail, type GovernedRail } from "@mandate/llm-rail";
import { StripeClient, createStripeSptRail, type StripeSptRail, type StripeSptApprover } from "../src/index.js";

export const FAKE_KEY = "sk_test_FAKEKEY12345";
export const PROFILE = "profile_test_61U92KWAstyE3VYhXA6U91t01FSQ3ByrZzKJOCR0y5ey";
export const SELLER = "tapvow_test_seller";
export const ACCOUNT = "acct_test_0001";
export const SPT = "spt_Test00000001";

const dirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapvow-spt-"));
  dirs.push(dir);
  return dir;
}

export function cleanupDirs(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}

export interface FakeCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  form: URLSearchParams;
  signal: AbortSignal | null;
}

export interface FakeStripe {
  fetch: typeof fetch;
  calls: FakeCall[];
}

export function fakeStripe(handler: (call: FakeCall) => Response | Promise<Response>): FakeStripe {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === "string" ? init.body : "";
    const call: FakeCall = {
      method: init?.method ?? "GET",
      url,
      path: parsed.pathname,
      headers,
      body,
      form: new URLSearchParams(body),
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_test_1", ...headers },
  });
}

export function balance(livemode: boolean): Response {
  return json({ object: "balance", livemode, available: [{ amount: 1000, currency: "eur" }] });
}

export function account(): Response {
  return json({ object: "account", id: ACCOUNT, livemode: false });
}

export function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SPT,
    object: "shared_payment.granted_token",
    agent_details: { network_business_profile: PROFILE },
    created: 1792385289,
    deactivated_at: null,
    deactivated_reason: null,
    livemode: false,
    payment_method_details: null,
    shared_metadata: { tapvow_probe: "step7" },
    usage_details: { amount_captured: { currency: "usd", value: 0 } },
    usage_limits: { currency: "usd", expires_at: 4_102_444_800, max_amount: 100 },
    ...overrides,
  };
}

export function paymentIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pi_test_0001",
    object: "payment_intent",
    status: "succeeded",
    amount: 60,
    amount_received: 60,
    currency: "usd",
    livemode: false,
    latest_charge: "ch_test_0001",
    ...overrides,
  };
}

/** Binds a token to a mandate id without overwriting a caller's explicit binding. */
function bindToken(body: Record<string, unknown>, mandateId: string): Record<string, unknown> {
  const metadata =
    typeof body.shared_metadata === "object" && body.shared_metadata !== null
      ? (body.shared_metadata as Record<string, unknown>)
      : {};
  return { ...body, shared_metadata: { tapvow_mandate_id: mandateId, ...metadata } };
}

export function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_stripe_test_0001",
    agents: ["agent-01"],
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    approval_threshold: "1.00",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "x402", id: "eip155:84532:0xabc" },
      { rail: "stripe_spt", id: ACCOUNT },
    ],
    rails: ["llm", "x402", "stripe_spt"],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function signTestMandate(mandate: Mandate): { signed: SignedMandate; issuer: ReturnType<typeof generateSigner> } {
  const issuer = generateSigner("owner-test");
  const withKey: Mandate = { ...mandate, issuer: { id: "michael", public_key: issuer.publicKey } };
  return { issuer, signed: signMandate(withKey, issuer.signer) };
}

export interface Stack {
  rail: GovernedRail;
  stripe: StripeSptRail;
  client: StripeClient;
  fake: FakeStripe;
  auth: { agentId: string; mandateId: string };
  mandate: Mandate;
}

export async function makeStack(opts: {
  id: string;
  mandate?: Partial<Mandate>;
  token?: Record<string, unknown> | null;
  balanceLivemode?: boolean;
  paymentIntent?: (call: FakeCall) => Response | Promise<Response>;
  fetchHandler?: (call: FakeCall) => Response | Promise<Response>;
  approver?: StripeSptApprover;
  clientTimeoutMs?: number;
}): Promise<Stack> {
  const dir = tempDir();
  const mandate = baseMandate({ id: opts.id, ...(opts.mandate ?? {}) });
  const { signed, issuer } = signTestMandate(mandate);
  const ledgerSigner = generateSigner("gateway-test");
  const rail = openGovernedRail({
    dbPath: join(dir, "budget.db"),
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: ledgerSigner.signer,
  });
  const agentKey = rail.issueAgentKey("agent-01");
  const auth = rail.store.authenticate(agentKey);
  if (!auth) throw new Error("test key did not authenticate");
  const boundToken = opts.token === null ? null : bindToken(opts.token ?? token(), mandate.id);

  const fake = fakeStripe(async (call) => {
    if (opts.fetchHandler) return opts.fetchHandler(call);
    if (call.path === "/v1/balance") return balance(opts.balanceLivemode ?? false);
    if (call.path === "/v1/account") return account();
    if (call.method === "GET" && call.path.startsWith("/v1/shared_payment/granted_tokens/")) {
      return boundToken === null
        ? json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such token" } }, 404)
        : json(boundToken);
    }
    if (call.method === "POST" && call.path === "/v1/payment_intents") {
      if (opts.paymentIntent) return opts.paymentIntent(call);
      const cents = Number(call.form.get("amount") ?? 60);
      const rid = call.form.get("metadata[tapvow_reservation_id]");
      return json(
        paymentIntent({
          amount: cents,
          amount_received: cents,
          ...(rid ? { metadata: { tapvow_reservation_id: rid } } : {}),
        }),
      );
    }
    return json({ error: { type: "invalid_request_error", code: "unexpected_call", message: call.path } }, 400);
  });
  const client = new StripeClient(FAKE_KEY, {
    fetch: fake.fetch,
    ...(opts.clientTimeoutMs !== undefined ? { timeoutMs: opts.clientTimeoutMs } : {}),
  });
  await client.assertTestMode();
  const stripe = createStripeSptRail({
    rail,
    client,
    sellerLabel: SELLER,
    ...(opts.approver ? { approver: opts.approver } : {}),
  });
  return { rail, stripe, client, fake, auth, mandate };
}
