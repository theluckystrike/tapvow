import http from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate, type SignedMandate } from "@mandate/core";
import { openGovernedRail, type GovernedRail } from "@mandate/llm-rail";
import type { PaymentGuard } from "../src/types.js";

export const NETWORK = "eip155:84532";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

export function tokenWallet(): { account: LocalAccount; privateKey: `0x${string}` } {
  const privateKey = generatePrivateKey();
  return { account: privateKeyToAccount(privateKey), privateKey };
}

/** Inline allowlist guard: the payee must be in the list, amount is taken as-is. */
export function allowlistGuard(
  payees: string[],
  priceBasis = "first_payment",
  referenceMicros: number | null = null,
): PaymentGuard {
  const allowed = new Set(payees.map((p) => p.toLowerCase()));
  return async (ask) => {
    if (!allowed.has(ask.payTo.toLowerCase())) {
      return { ok: false, code: "payee_not_allowed", reason: `payee ${ask.payTo} is not allowed` };
    }
    return {
      ok: true,
      amountMicros: Number(ask.amount),
      payeeBasis: "allowlist",
      priceBasis,
      referenceMicros,
    };
  };
}

export function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_x402_test_0001",
    agents: ["agent-01"],
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    approval_threshold: "1.00",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "llm", id: "anthropic" },
    ],
    rails: ["llm", "x402"],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function signTestMandate(mandate: Mandate, issuerId = "owner-test"): { issuer: ReturnType<typeof generateSigner>; signed: SignedMandate } {
  const issuer = generateSigner(issuerId);
  const withKey: Mandate = { ...mandate, issuer: { id: "michael", public_key: issuer.publicKey } };
  return { issuer, signed: signMandate(withKey, issuer.signer) };
}

export function openTestRail(
  dbPath: string,
  signed: SignedMandate,
  issuerPublicKey: string,
): { rail: GovernedRail; trusted: Record<string, string> } {
  const ledgerSigner = generateSigner("gateway-test");
  const rail = openGovernedRail({
    dbPath,
    signedMandate: signed,
    trustedIssuerKey: issuerPublicKey,
    ledgerSigner: ledgerSigner.signer,
  });
  return { rail, trusted: { [ledgerSigner.signer.keyId]: ledgerSigner.publicKey } };
}

export function request(
  method: string,
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResult> {
  const url = new URL(baseUrl + path);
  const payload = body === undefined ? undefined : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: payload
          ? { ...headers, "content-length": String(payload.length) }
          : headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function postJson(baseUrl: string, path: string, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  return request("POST", baseUrl, path, { ...headers, "content-type": "application/json" }, JSON.stringify(body));
}

export function getJson(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return request("GET", baseUrl, path, headers);
}

export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
