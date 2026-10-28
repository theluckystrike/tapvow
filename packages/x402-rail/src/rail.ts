// The x402 payment rail behind the TapVow gateway.
//
// Agents never hold a wallet. An agent calls the gateway with its virtual key
// (mk_...) and a URL; the gateway fetches the URL with @x402/fetch, checks the
// 402 payment against the same signed mandate the LLM rail uses, reserves the
// money atomically, signs the EIP-3009 authorization with the gateway's own
// account, retries, reads the settlement, and books the payment in the shared
// signed ledger.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { Network, PaymentRequirements } from "@x402/core/types";
import type { LocalAccount } from "viem";
import type { GovernedRail } from "@mandate/llm-rail";
import { formatUsd } from "@mandate/core";
import type { Approver, PaymentAsk, PaymentGuard } from "./types.js";
import { createPinnedFetch, defaultResolveHost } from "./pinned-fetch.js";
import type { ResolveHost } from "./pinned-fetch.js";
import { isPrivateAddress } from "./private-address.js";

export interface X402RailOptions {
  rail: GovernedRail;
  /** The gateway's wallet. Agents never see it. */
  account: LocalAccount;
  /** CAIP-2 network ids, e.g. ["eip155:84532"]. */
  networks: string[];
  /** Payee binding plus amount bounds, checked before anything is signed. */
  guard: PaymentGuard;
  /** Telegram-style step-up approval, consulted only when the store asks. */
  approver?: Approver;
  /** Base fetch. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Refuse requirements asking for a longer authorization window. Default 300. */
  maxTimeoutSeconds?: number;
  /** Cap on the resource body relayed to the agent. Default 1 MiB. */
  maxResponseBytes?: number;
  /**
   * Allow fetching loopback, private and link-local addresses. Default false,
   * so an agent cannot use the gateway to read internal services. Tests and
   * local demos set it.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Total deadline in milliseconds for the pinned fetch, covering connect,
   * headers and body. Default 30000. Ignored when a base fetch is supplied.
   */
  fetchTimeoutMs?: number;
  /**
   * Resolve a host for the private-address check, used by both the early check
   * and the default pinned fetch. Defaults to node:dns. The pinned fetch's own
   * check is the authority; the early check only supplies the denial message.
   */
  resolve?: ResolveHost;
  /**
   * Whether an address must be refused, used by both the early check and the
   * default pinned fetch. Defaults to the shared isPrivateAddress policy.
   */
  isBlocked?: (address: string) => boolean;
  /**
   * Optional on-chain check of a settlement before it is booked as settled.
   * Without it the tx hash is the one the resource server reported, and the
   * ledger says so (settlement_verified false).
   */
  verifySettlement?: (txHash: string, facts: { network: string; asset: string; payer: string; payTo: string; amountAtomic: string; nonce: string }) => Promise<boolean>;
}

export interface X402FetchInput {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface PayResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface X402Rail {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  pay(
    auth: { agentId: string; mandateId: string },
    input: X402FetchInput,
  ): Promise<PayResult>;
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const FORWARD_HEADERS = new Set(["accept", "content-type", "user-agent"]);

interface SignedFacts {
  nonce: string;
  validBefore: string;
  asset: string;
  payTo: string;
  network: string;
  amountAtomic: string;
}

interface Denial {
  status: number;
  code: string;
  reason: string;
}

interface BlockedAsk {
  resource: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
}

export function createX402Rail(opts: X402RailOptions): X402Rail {
  const store = opts.rail.store;
  const ledger = opts.rail.ledger;
  const account = opts.account;
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 300;
  const maxResponseBytes = opts.maxResponseBytes ?? 1024 * 1024;
  const networks = new Set(opts.networks);
  const allowPrivate = opts.allowPrivateNetwork === true;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 30000;
  const isBlocked = opts.isBlocked ?? isPrivateAddress;
  const resolveHost: ResolveHost = opts.resolve ?? defaultResolveHost;
  const baseFetch = opts.fetch ?? createPinnedFetch({ allowPrivate, timeoutMs: fetchTimeoutMs, resolve: resolveHost, isBlocked });

  function remainingMicros(mandateId: string): number | null {
    const policy = store.getPolicy(mandateId);
    if (!policy) return null;
    return policy.budgetMicros - store.spent(mandateId).committedMicros;
  }

  function mandateHeaders(
    mandateId: string,
    chargedMicros: number | null,
    txHash: string | null,
  ): Record<string, string> {
    const headers: Record<string, string> = { "X-Mandate-Rail": "x402" };
    if (txHash) headers["X-Mandate-Tx-Hash"] = txHash;
    if (chargedMicros != null) headers["X-Mandate-Charged-Micros"] = String(chargedMicros);
    const remaining = remainingMicros(mandateId);
    if (remaining != null) headers["X-Mandate-Remaining-Micros"] = String(remaining);
    return headers;
  }

  function appendBlocked(auth: { agentId: string; mandateId: string }, ask: BlockedAsk | null, code: string, reason: string): void {
    if (!ask) return;
    ledger.append("x402.blocked", {
      mandate_id: auth.mandateId,
      agent_id: auth.agentId,
      resource: ask.resource,
      network: ask.network,
      asset: ask.asset,
      pay_to: ask.payTo,
      amount_atomic: ask.amount,
      code,
      reason,
    });
  }

  function deniedResult(
    auth: { agentId: string; mandateId: string },
    denial: Denial,
    ask: BlockedAsk | null,
  ): PayResult {
    appendBlocked(auth, ask, denial.code, denial.reason);
    const headers = mandateHeaders(auth.mandateId, null, null);
    return {
      status: denial.status,
      headers,
      body: JSON.stringify({ error: { type: "mandate_denied", code: denial.code, message: denial.reason } }),
    };
  }

  async function pay(
    auth: { agentId: string; mandateId: string },
    input: X402FetchInput,
  ): Promise<PayResult> {
    const url = input.url;
    const method = input.method ?? "GET";

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      const headers = mandateHeaders(auth.mandateId, null, null);
      return { status: 400, headers, body: JSON.stringify({ error: { type: "invalid_request_error", message: "url must be an absolute http(s) URL" } }) };
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      const headers = mandateHeaders(auth.mandateId, null, null);
      return { status: 400, headers, body: JSON.stringify({ error: { type: "invalid_request_error", message: "only http and https URLs are allowed" } }) };
    }

    if (!allowPrivate) {
      const blocked = await privateHostReason(parsedUrl.hostname, resolveHost, isBlocked);
      if (blocked) {
        const headers = mandateHeaders(auth.mandateId, null, null);
        return { status: 403, headers, body: JSON.stringify({ error: { type: "mandate_denied", code: "host_not_allowed", message: blocked } }) };
      }
    }
    // The ledger and the approval text keep the origin and path only; a query
    // string can carry secrets, so it is stored as a hash.
    const resourceLabel = parsedUrl.origin + parsedUrl.pathname;
    const querySha256 = parsedUrl.search ? createHash("sha256").update(parsedUrl.search).digest("hex") : null;

    const forwardHeaders: Record<string, string> = {};
    if (input.headers) {
      for (const [name, value] of Object.entries(input.headers)) {
        if (FORWARD_HEADERS.has(name.toLowerCase())) forwardHeaders[name.toLowerCase()] = value;
      }
    }

    let reservationId: string | null = null;
    let amountMicros = 0;
    let payeeBasis: "allowlist" | "binding" = "allowlist";
    let priceBasis = "";
    let referenceMicros: number | null = null;
    let bindingHash: string | null = null;
    let approvalRequestId: string | null = null;
    let signed: SignedFacts | null = null;
    let denial: Denial | null = null;
    let blockedAsk: BlockedAsk | null = null;

    const client = new x402Client();
    client.setSpendControls(false);
    client.registerPolicy((_version, requirements) =>
      requirements.filter((r) => {
        const extra = (r.extra ?? {}) as Record<string, unknown>;
        // Only plain EIP-3009 transfers; Permit2 and other flows sign different data.
        return (
          r.scheme === "exact" &&
          networks.has(r.network) &&
          (extra.assetTransferMethod === undefined || extra.assetTransferMethod === "eip3009") &&
          extra.paymentFlow === undefined
        );
      }),
    );
    for (const network of opts.networks) {
      client.register(network as Network, new ExactEvmScheme(account));
    }

    let expected: { amount: string; payTo: string } | null = null;
    client.onBeforePaymentCreation(async (context) => {
      const req: PaymentRequirements = context.selectedRequirements;
      // At most one payment per agent call: a second 402 after a paid retry must
      // never produce a second signature or overwrite the first reservation.
      if (reservationId !== null || signed !== null) {
        denial = { status: 403, code: "second_payment_refused", reason: "only one payment is allowed per call" };
        return { abort: true, reason: denial.reason };
      }
      blockedAsk = { resource: resourceLabel, network: req.network, asset: req.asset, payTo: req.payTo, amount: req.amount };

      // The 402 body is not schema-checked by the client, so "60" (a string)
      // would compare as a number here but concatenate in the signer.
      const window = req.maxTimeoutSeconds as unknown;
      if (typeof window !== "number" || !Number.isInteger(window) || window <= 0 || window > maxTimeoutSeconds) {
        denial = {
          status: 403,
          code: "authorization_window_too_long",
          reason: `requirement asks for an authorization window of ${JSON.stringify(window)} seconds (limit ${maxTimeoutSeconds})`,
        };
        return { abort: true, reason: denial.reason };
      }

      const ask: PaymentAsk = {
        resourceUrl: url,
        network: req.network,
        asset: req.asset,
        payTo: req.payTo,
        amount: req.amount,
      };
      const guardResult = await opts.guard(ask);
      if (!guardResult.ok) {
        denial = { status: 403, code: guardResult.code, reason: guardResult.reason };
        return { abort: true, reason: guardResult.reason };
      }

      const requirementMicros = Number(req.amount);
      if (!Number.isSafeInteger(requirementMicros) || BigInt(requirementMicros) !== BigInt(guardResult.amountMicros)) {
        denial = {
          status: 403,
          code: "amount_mismatch",
          reason: `guard approved ${guardResult.amountMicros} micros but the requirement asks for ${req.amount}`,
        };
        return { abort: true, reason: denial.reason };
      }

      payeeBasis = guardResult.payeeBasis;
      priceBasis = guardResult.priceBasis;
      referenceMicros = guardResult.referenceMicros;
      bindingHash = guardResult.bindingHash ?? null;

      const reserveArgs = {
        mandateId: auth.mandateId,
        agentId: auth.agentId,
        model: `x402:${req.network}:${req.asset.toLowerCase()}`,
        provider: req.payTo.toLowerCase(),
        amountMicros: guardResult.amountMicros,
        rail: "x402" as const,
        payeeVerifiedBy: guardResult.payeeBasis,
        priceBasis: guardResult.priceBasis,
      };
      let reserved = store.reserve(reserveArgs);
      if (!reserved.ok && reserved.code === "approval_required" && opts.approver) {
        let decision: { decision: string; requestId: string; decidedBy?: string };
        try {
          decision = await opts.approver.request({
          mandateId: auth.mandateId,
          agentId: auth.agentId,
          rail: "x402",
          payee: req.payTo.toLowerCase(),
          amountMicros: guardResult.amountMicros,
          summary: `Pay ${formatUsd(guardResult.amountMicros)} USDC to ${req.payTo} for ${resourceLabel}`,
          });
        } catch {
          decision = { decision: "denied", requestId: "" };
        }
        if (decision.decision === "approved" && typeof decision.requestId === "string" && decision.requestId.length > 0) {
          approvalRequestId = decision.requestId;
          reserved = store.reserve({
            ...reserveArgs,
            approval: { requestId: decision.requestId, decidedBy: decision.decidedBy ?? "approver" },
          });
        } else if (decision.decision === "timeout") {
          denial = { status: 403, code: "approval_timeout", reason: "approval timed out" };
          return { abort: true, reason: denial.reason };
        } else {
          denial = { status: 403, code: "approval_denied", reason: "approval denied" };
          return { abort: true, reason: denial.reason };
        }
      }
      if (!reserved.ok) {
        denial = { status: reserved.status, code: reserved.code, reason: reserved.reason };
        return { abort: true, reason: reserved.reason };
      }

      reservationId = reserved.reservationId;
      amountMicros = guardResult.amountMicros;
      expected = { amount: req.amount, payTo: req.payTo.toLowerCase() };
      return undefined;
    });

    client.onAfterPaymentCreation(async (context) => {
      const payload = context.paymentPayload;
      const authorization = payload.payload.authorization as {
        nonce: string;
        validBefore: string;
        validAfter?: string;
        value?: string;
        to?: string;
      };
      signed = {
        nonce: authorization.nonce,
        validBefore: authorization.validBefore,
        asset: payload.accepted.asset,
        payTo: payload.accepted.payTo,
        network: payload.accepted.network,
        amountAtomic: payload.accepted.amount,
      };
      // The signature must move exactly the reserved amount to the checked payee.
      // Throwing here stops the paid retry; the reservation is then charged in
      // full because a signature exists.
      const exp = expected as { amount: string; payTo: string } | null;
      if (
        !exp ||
        String(authorization.value) !== exp.amount ||
        String(authorization.to).toLowerCase() !== exp.payTo ||
        payload.accepted.amount !== exp.amount ||
        payload.accepted.payTo.toLowerCase() !== exp.payTo
      ) {
        throw new Error("signed authorization does not match the reserved payment");
      }
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      let validBefore: bigint;
      try {
        validBefore = BigInt(authorization.validBefore);
      } catch {
        throw new Error("signed authorization has no valid validBefore");
      }
      if (validBefore > nowSec + BigInt(maxTimeoutSeconds) + 60n) {
        throw new Error("signed authorization is valid for longer than the allowed window");
      }
    });

    const wrappedFetch = wrapFetchWithPayment(baseFetch, client);

    // No redirects: the pinned fetch never follows one, so a 3xx is returned as
    // is and the URL the guard checked stays the URL that is paid. The redirect
    // option covers any caller-supplied fetch that would otherwise follow one.
    const init: RequestInit = { method, headers: forwardHeaders, redirect: "error" };
    if (method !== "GET" && input.body !== undefined) init.body = input.body;

    const details = (txHash: string | null, unconfirmed: boolean): Record<string, unknown> => {
      const facts = signed!;
      return {
        tx_hash: txHash,
        network: facts.network,
        pay_to: facts.payTo,
        payer: account.address,
        asset: facts.asset,
        resource: resourceLabel,
        resource_query_sha256: querySha256,
        amount_atomic: facts.amountAtomic,
        nonce: facts.nonce,
        valid_before: facts.validBefore,
        payee_basis: payeeBasis,
        price_basis: priceBasis,
        reference_micros: referenceMicros,
        binding_hash: bindingHash,
        approval_request_id: approvalRequestId,
        ...(unconfirmed ? { unconfirmed: true } : {}),
      };
    };

    let response: Response | null = null;
    let thrown: unknown = null;
    try {
      response = await wrappedFetch(url, init);
    } catch (err) {
      thrown = err;
    }

    if (thrown !== null) {
      const denialNow = denial as Denial | null;
      if (signed && reservationId) {
        // A signature exists, so the payee may still settle it before valid_before.
        const event = store.chargeFull(reservationId, details(null, true));
        return {
          status: 502,
          headers: mandateHeaders(auth.mandateId, event.chargedMicros, null),
          body: JSON.stringify({ error: { type: "mandate_unconfirmed", message: "payment was signed but settlement could not be confirmed" } }),
        };
      }
      if (denialNow) {
        return deniedResult(auth, denialNow, blockedAsk);
      }
      if (reservationId) store.release(reservationId, { reason: "signing_failed" });
      const headers = mandateHeaders(auth.mandateId, 0, null);
      return {
        status: 502,
        headers,
        body: JSON.stringify({ error: { type: "payment_error", message: "the x402 payment could not be created" } }),
      };
    }

    const res = response!;
    if (signed && reservationId) {
      // From here a signature is out. Any error books the full amount with
      // the signed facts (fail closed), never leaves the reservation open.
      try {
        return await finishPaid(res);
      } catch {
        const event = store.chargeFull(reservationId, details(null, true));
        return {
          status: 502,
          headers: mandateHeaders(auth.mandateId, event.chargedMicros, null),
          body: JSON.stringify({ error: { type: "mandate_unconfirmed", message: "payment was signed but settlement could not be confirmed" } }),
        };
      }
    }
    const body = await readCapped(res, maxResponseBytes);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";

    if (!signed && denial) {
      // A hook aborted the payment but the client returned the 402 instead of throwing.
      if (reservationId) store.release(reservationId, { reason: "not_signed" });
      return deniedResult(auth, denial as Denial, blockedAsk);
    }
    if (signed && !reservationId) {
      throw new Error("payment signed without a reservation");
    }
    if (!signed || !reservationId) {
      // No payment was attempted: relay with no charge and no ledger entry.
      if (reservationId) store.release(reservationId, { reason: "not_signed" });
      return {
        status: res.status,
        headers: { "content-type": contentType, ...mandateHeaders(auth.mandateId, 0, null) },
        body,
      };
    }

    throw new Error("unreachable: paid responses are finished in finishPaid");

    async function finishPaid(res: Response): Promise<PayResult> {
    const rid = reservationId as string;
    const body = await readCapped(res, maxResponseBytes);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const settlement = decodeSettlement(res.headers);
    const base = { "content-type": contentType };
    if (res.ok && settlement?.success && typeof settlement.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) {
      const facts = signed as SignedFacts;
      let verified: boolean | null = null;
      if (opts.verifySettlement) {
        try {
          verified = await opts.verifySettlement(settlement.transaction, {
            network: facts.network, asset: facts.asset, payer: account.address, payTo: facts.payTo, amountAtomic: facts.amountAtomic, nonce: facts.nonce,
          });
        } catch {
          verified = false;
        }
      }
      if (verified === false) {
        const event = store.chargeFull(rid, { ...details(null, true), tx_hash_reported: settlement.transaction, settlement_verified: false });
        return { status: 502, headers: { ...base, ...mandateHeaders(auth.mandateId, event.chargedMicros, null) }, body: JSON.stringify({ error: { type: "mandate_unconfirmed", message: "the reported transaction could not be verified on chain" } }) };
      }
      const event = store.settle(rid, null, amountMicros, {
        ...details(settlement.transaction, false),
        settlement_verified: verified === true,
        tx_hash_source: verified === true ? "chain" : "resource_server",
      });
      return {
        status: res.status,
        headers: { ...base, ...mandateHeaders(auth.mandateId, event.chargedMicros, settlement.transaction) },
        body,
      };
    }

    // Signed but not settled: fail closed, the authorization may still settle.
    const event = store.chargeFull(rid, details(null, true));
    return {
      status: res.status,
      headers: { ...base, ...mandateHeaders(auth.mandateId, event.chargedMicros, null) },
      body,
    };
    }
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = bearerToken(req);
    const auth = key ? store.authenticate(key) : null;
    if (!auth) {
      sendJson(res, 401, { error: { type: "invalid_key", message: "invalid or missing API key" } });
      req.resume();
      return;
    }

    const read = await readBody(req, MAX_REQUEST_BODY_BYTES);
    if (read.kind === "tooLarge") {
      sendJson(res, 413, { error: { type: "invalid_request_error", message: "request body exceeds limit" } });
      req.destroy();
      return;
    }

    let input: X402FetchInput;
    try {
      const parsed = JSON.parse(read.buf.toString("utf8")) as Partial<X402FetchInput>;
      if (typeof parsed.url !== "string") throw new Error("missing url");
      if (parsed.method !== undefined && parsed.method !== "GET" && parsed.method !== "POST") {
        throw new Error("method must be GET or POST");
      }
      if (parsed.headers !== undefined && (typeof parsed.headers !== "object" || parsed.headers === null)) {
        throw new Error("headers must be an object");
      }
      if (parsed.body !== undefined && typeof parsed.body !== "string") {
        throw new Error("body must be a string");
      }
      input = parsed as X402FetchInput;
    } catch (err) {
      sendJson(res, 400, {
        error: { type: "invalid_request_error", message: err instanceof Error ? err.message : "invalid request body" },
      });
      return;
    }

    let result: PayResult;
    try {
      result = await pay(auth, input);
    } catch {
      sendJson(res, 500, { error: { type: "internal_error", message: "internal error" } });
      return;
    }
    const payload = Buffer.from(result.body, "utf8");
    res.writeHead(result.status, { ...result.headers, "content-length": String(payload.length) });
    res.end(payload);
  }

  return { handler, pay };
}

/** Why a host must not be fetched, or null. Resolves names and checks every address. */
async function privateHostReason(
  hostname: string,
  resolve: ResolveHost,
  isBlocked: (address: string) => boolean,
): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await resolve(host)).map((a) => a.address);
    } catch {
      return `host ${hostname} does not resolve`;
    }
  }
  for (const a of addrs) {
    if (isBlocked(a)) return `host ${hostname} resolves to a private, loopback or link-local address`;
  }
  return null;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.length >= room) {
        chunks.push(value.subarray(0, room));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeSettlement(headers: Headers): { success: boolean; transaction?: string } | null {
  const raw = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return null;
  try {
    return decodePaymentResponseHeader(raw);
  } catch {
    return null;
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

type ReadResult = { kind: "ok"; buf: Buffer } | { kind: "tooLarge" };

function readBody(req: IncomingMessage, maxBytes: number): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      length += chunk.length;
      if (length > maxBytes) {
        done = true;
        resolve({ kind: "tooLarge" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve({ kind: "ok", buf: Buffer.concat(chunks) });
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}
