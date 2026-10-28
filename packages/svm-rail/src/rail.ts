// The Solana x402 rail behind the TapVow gateway.
//
// Agents never hold a Solana key. An agent calls the gateway with its virtual
// key and a URL. The gateway fetches the URL, checks the 402 payment against
// the signed mandate, reserves the worst-case cost in the budget store, signs a
// partially signed SPL TransferChecked transaction, lets the facilitator add
// the fee-payer signature and submit it, then reads the signature on devnet and
// books the payment in the shared signed ledger.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { Network, PaymentRequirements } from "@x402/core/types";
import type { ClientSvmSigner } from "@x402/svm";
import type { GovernedRail } from "@mandate/llm-rail";
import { formatUsd } from "@mandate/core";
import { createPinnedFetch, defaultResolveHost } from "@mandate/x402-rail/pinned-fetch";
import type { ResolveHost } from "@mandate/x402-rail/pinned-fetch";
import { isPrivateAddress } from "@mandate/x402-rail/private-address";
import type { Approver, PaymentAsk, PaymentGuard, SolanaChain } from "./types.js";
import { checkNetworkGenesis } from "./chain.js";
import { decodePaymentTransaction, type DecodedPayment } from "./transaction.js";

export interface PaymentScheme {
  scheme: string;
  createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<{ x402Version: number; payload: Record<string, unknown> }>;
}

export type SchemeFactory = (signer: ClientSvmSigner) => PaymentScheme;

export interface SvmRailOptions {
  rail: GovernedRail;
  /** The gateway's Solana signer. Agents never see it. */
  signer: ClientSvmSigner;
  /** Defaults to signer.address. */
  payerAddress?: string;
  /** CAIP-2 Solana network ids, e.g. ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]. */
  networks: string[];
  /** Payee allowlist plus amount bounds, checked before anything is signed. */
  guard: PaymentGuard;
  /** Reads one transaction signature, or finds one for a payer. */
  chain: SolanaChain;
  /** Optional RPC URL for the exact scheme (mint metadata and blockhash). */
  rpcUrl?: string;
  /** Override the exact scheme, used by tests. */
  scheme?: SchemeFactory;
  approver?: Approver;
  fetch?: typeof fetch;
  /** Refuse requirements asking for a longer authorization window. Default 300. */
  maxTimeoutSeconds?: number;
  /** Allow the payer to also pay the network fee. Off by default. */
  allowPayerAsFeePayer?: boolean;
  /** Cap on the resource body relayed to the agent. Default 1 MiB. */
  maxResponseBytes?: number;
  allowPrivateNetwork?: boolean;
  fetchTimeoutMs?: number;
  resolve?: ResolveHost;
  isBlocked?: (address: string) => boolean;
  now?: () => number;
}

export interface SvmFetchInput {
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

export interface SvmRail {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  pay(auth: { agentId: string; mandateId: string }, input: SvmFetchInput): Promise<PayResult>;
}

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const FORWARD_HEADERS = new Set(["accept", "content-type", "user-agent"]);
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

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

interface DeliveryInfo {
  truncated: boolean;
  deliveredBytes: number;
  fullBytes: number | null;
}

/**
 * The payload echo must name exactly the requirement the guard approved. Today
 * the x402 client copies both from one object, so this is defence in depth. A
 * library change that lets them differ must not sign one transfer and verify
 * another.
 */
export function assertAcceptedMatchesRequirements(
  accepted: PaymentRequirements,
  approved: PaymentRequirements,
): void {
  for (const field of ["scheme", "network", "asset", "payTo", "amount"] as const) {
    if (accepted[field] !== approved[field]) {
      throw new Error(`the payment accepted ${field} differs from the approved requirement`);
    }
  }
  const acceptedFeePayer = String((accepted.extra ?? {}).feePayer);
  const approvedFeePayer = String((approved.extra ?? {}).feePayer);
  if (acceptedFeePayer !== approvedFeePayer) {
    throw new Error("the payment accepted fee payer differs from the approved requirement");
  }
}

export function createSvmRail(opts: SvmRailOptions): SvmRail {
  const store = opts.rail.store;
  const ledger = opts.rail.ledger;
  const signer = opts.signer;
  const payer = opts.payerAddress ?? String(signer.address);
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 300;
  const maxResponseBytes = opts.maxResponseBytes ?? 1024 * 1024;
  const networks = new Set(opts.networks);
  const allowPrivate = opts.allowPrivateNetwork === true;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 30000;
  const isBlocked = opts.isBlocked ?? isPrivateAddress;
  const resolveHost: ResolveHost = opts.resolve ?? defaultResolveHost;
  const baseFetch =
    opts.fetch ??
    createPinnedFetch({ allowPrivate, timeoutMs: fetchTimeoutMs, resolve: resolveHost, isBlocked });
  const schemeFactory: SchemeFactory =
    opts.scheme ?? ((s) => new ExactSvmScheme(s, opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : undefined));

  // The rail must be on the chain its network ids name. Read the RPC genesis
  // hash once, at start, and refuse every call until the check passes.
  const networkCheck = (async (): Promise<void> => {
    if (!opts.chain.getGenesisHash) return;
    const genesisHash = await opts.chain.getGenesisHash();
    checkNetworkGenesis(opts.networks, genesisHash);
  })();
  networkCheck.catch(() => {
    // The rejection is reported to the caller by pay(). This only stops an
    // unhandled rejection when no call is made.
  });

  function remainingMicros(mandateId: string): number | null {
    const policy = store.getPolicy(mandateId);
    if (!policy) return null;
    return policy.budgetMicros - store.spent(mandateId).committedMicros;
  }

  function mandateHeaders(
    mandateId: string,
    chargedMicros: number | null,
    signature: string | null,
  ): Record<string, string> {
    const headers: Record<string, string> = { "X-Mandate-Rail": "x402-svm" };
    if (signature) headers["X-Mandate-Tx-Signature"] = signature;
    if (chargedMicros != null) headers["X-Mandate-Charged-Micros"] = String(chargedMicros);
    const remaining = remainingMicros(mandateId);
    if (remaining != null) headers["X-Mandate-Remaining-Micros"] = String(remaining);
    return headers;
  }

  function appendBlocked(
    auth: { agentId: string; mandateId: string },
    ask: BlockedAsk | null,
    code: string,
    reason: string,
  ): void {
    if (!ask) return;
    ledger.append("x402.svm.blocked", {
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
    return {
      status: denial.status,
      headers: mandateHeaders(auth.mandateId, null, null),
      body: JSON.stringify({ error: { type: "mandate_denied", code: denial.code, message: denial.reason } }),
    };
  }

  /** True when a different reservation already booked this on-chain signature. */
  function signatureBooked(signature: string, reservationId: string): boolean {
    for (const entry of ledger.entries()) {
      if (entry.kind !== "x402.settle") continue;
      const payload = entry.payload as Record<string, unknown>;
      if (payload.reservation_id === reservationId) continue;
      const details = payload.details as Record<string, unknown> | undefined;
      if (details?.tx_signature === signature) return true;
    }
    return false;
  }

  async function pay(
    auth: { agentId: string; mandateId: string },
    input: SvmFetchInput,
  ): Promise<PayResult> {
    const url = input.url;
    const method = input.method ?? "GET";

    try {
      await networkCheck;
    } catch (err) {
      return {
        status: 503,
        headers: mandateHeaders(auth.mandateId, null, null),
        body: JSON.stringify({
          error: {
            type: "mandate_denied",
            code: "network_mismatch",
            message: `the rail refuses to run: ${errorMessage(err)}`,
          },
        }),
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        status: 400,
        headers: mandateHeaders(auth.mandateId, null, null),
        body: JSON.stringify({ error: { type: "invalid_request_error", message: "url must be an absolute http(s) URL" } }),
      };
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        status: 400,
        headers: mandateHeaders(auth.mandateId, null, null),
        body: JSON.stringify({ error: { type: "invalid_request_error", message: "only http and https URLs are allowed" } }),
      };
    }

    if (!allowPrivate) {
      const blocked = await privateHostReason(parsedUrl.hostname, resolveHost, isBlocked);
      if (blocked) {
        return {
          status: 403,
          headers: mandateHeaders(auth.mandateId, null, null),
          body: JSON.stringify({ error: { type: "mandate_denied", code: "host_not_allowed", message: blocked } }),
        };
      }
    }

    const resourceLabel = parsedUrl.origin + parsedUrl.pathname;
    const querySha256 = parsedUrl.search
      ? createHash("sha256").update(parsedUrl.search).digest("hex")
      : null;

    const forwardHeaders: Record<string, string> = {};
    if (input.headers) {
      for (const [name, value] of Object.entries(input.headers)) {
        if (FORWARD_HEADERS.has(name.toLowerCase())) forwardHeaders[name.toLowerCase()] = value;
      }
    }

    let reservationId: string | null = null;
    let reservedAtMs = 0;
    let amountMicros = 0;
    let payeeBasis: "allowlist" | "binding" = "allowlist";
    let priceBasis = "";
    let referenceMicros: number | null = null;
    let bindingHash: string | null = null;
    let approvalRequestId: string | null = null;
    let decoded: DecodedPayment | null = null;
    let requirements: PaymentRequirements | null = null;
    let denial: Denial | null = null;
    let blockedAsk: BlockedAsk | null = null;
    let delivery: DeliveryInfo | null = null;

    const client = new x402Client();
    client.setSpendControls(false);
    client.registerPolicy((_version, accepts) =>
      accepts.filter((r) => {
        const extra = (r.extra ?? {}) as Record<string, unknown>;
        return (
          r.scheme === "exact" &&
          networks.has(r.network) &&
          typeof extra.feePayer === "string" &&
          extra.paymentFlow === undefined
        );
      }),
    );
    for (const network of opts.networks) {
      client.register(network as Network, schemeFactory(signer) as never);
    }

    client.onBeforePaymentCreation(async (context) => {
      const req = context.selectedRequirements as PaymentRequirements;
      if (reservationId !== null || decoded !== null) {
        denial = { status: 403, code: "second_payment_refused", reason: "only one payment is allowed per call" };
        return { abort: true, reason: denial.reason };
      }
      blockedAsk = {
        resource: resourceLabel,
        network: req.network,
        asset: req.asset,
        payTo: req.payTo,
        amount: req.amount,
      };

      const window = req.maxTimeoutSeconds as unknown;
      if (typeof window !== "number" || !Number.isInteger(window) || window <= 0 || window > maxTimeoutSeconds) {
        denial = {
          status: 403,
          code: "authorization_window_too_long",
          reason: `requirement asks for an authorization window of ${JSON.stringify(window)} seconds (limit ${maxTimeoutSeconds})`,
        };
        return { abort: true, reason: denial.reason };
      }

      const feePayer = (req.extra ?? {}).feePayer;
      if (typeof feePayer !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(feePayer)) {
        denial = { status: 403, code: "bad_fee_payer", reason: "the requirement has no valid Solana fee payer" };
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

      // An RPC that cannot answer must not be asked to settle our signature.
      try {
        await opts.chain.preflight();
      } catch (err) {
        denial = {
          status: 503,
          code: "rpc_unavailable",
          reason: `the Solana RPC is not reachable, so no payment was signed: ${errorMessage(err)}`,
        };
        return { abort: true, reason: denial.reason };
      }

      payeeBasis = guardResult.payeeBasis;
      priceBasis = guardResult.priceBasis;
      referenceMicros = guardResult.referenceMicros;
      bindingHash = guardResult.bindingHash ?? null;
      requirements = req;

      const bookingAtMs = Date.now();
      const reserveArgs = {
        mandateId: auth.mandateId,
        agentId: auth.agentId,
        model: `x402:${req.network}:${req.asset}`,
        provider: req.payTo,
        amountMicros: guardResult.amountMicros,
        rail: "x402" as const,
        payeeVerifiedBy: guardResult.payeeBasis,
        priceBasis: guardResult.priceBasis,
        // Persist the facts a crash sweep needs. If the gateway dies after this
        // reservation and before any settle, sweepStale books these facts with
        // chargeFull so reconcile can still verify the payment.
        bookingDetails: {
          network: req.network,
          asset: req.asset,
          pay_to: req.payTo,
          payer,
          fee_payer: String((req.extra ?? {}).feePayer),
          amount_atomic: req.amount,
          resource: resourceLabel,
          reserved_at_ms: bookingAtMs,
          expires_at_ms: bookingAtMs + maxTimeoutSeconds * 1000 + 150_000,
          unconfirmed: true,
        },
      };
      let reserved = store.reserve(reserveArgs);
      if (!reserved.ok && reserved.code === "approval_required" && opts.approver) {
        // Hold the worst-case cost while a human decides. A timeout releases it.
        const holdId = `hold_${randomUUID().replace(/-/g, "")}`;
        const held = store.reserve({
          ...reserveArgs,
          approval: { requestId: holdId, decidedBy: "approval_hold" },
        });
        if (!held.ok) {
          denial = { status: held.status, code: held.code, reason: held.reason };
          return { abort: true, reason: held.reason };
        }
        reservationId = held.reservationId;
        reservedAtMs = bookingAtMs;
        amountMicros = guardResult.amountMicros;
        let decision: { decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string };
        try {
          decision = await opts.approver.request({
            mandateId: auth.mandateId,
            agentId: auth.agentId,
            rail: "x402",
            payee: req.payTo,
            amountMicros: guardResult.amountMicros,
            summary: `Pay ${formatUsd(guardResult.amountMicros)} USDC to ${req.payTo} for ${resourceLabel}`,
          });
        } catch {
          decision = { decision: "denied", requestId: "" };
        }
        if (decision.decision === "approved" && decision.requestId.length > 0) {
          approvalRequestId = decision.requestId;
          store.recordApproval({
            mandateId: auth.mandateId,
            agentId: auth.agentId,
            rail: "x402",
            provider: req.payTo,
            model: `x402:${req.network}:${req.asset}`,
            amountMicros: guardResult.amountMicros,
            decision: "approved",
            requestId: decision.requestId,
            decidedBy: decision.decidedBy ?? "approver",
          });
        } else {
          if (decision.requestId.length > 0) {
            store.recordApproval({
              mandateId: auth.mandateId,
              agentId: auth.agentId,
              rail: "x402",
              provider: req.payTo,
              model: `x402:${req.network}:${req.asset}`,
              amountMicros: guardResult.amountMicros,
              decision: decision.decision,
              requestId: decision.requestId,
              decidedBy: decision.decidedBy ?? "approver",
            });
          }
          store.release(reservationId, { reason: decision.decision === "timeout" ? "approval_timeout" : "approval_denied" });
          reservationId = null;
          denial =
            decision.decision === "timeout"
              ? { status: 403, code: "approval_timeout", reason: "approval timed out" }
              : { status: 403, code: "approval_denied", reason: "approval denied" };
          return { abort: true, reason: denial.reason };
        }
      } else if (!reserved.ok) {
        denial = { status: reserved.status, code: reserved.code, reason: reserved.reason };
        return { abort: true, reason: reserved.reason };
      } else {
        reservationId = reserved.reservationId;
        reservedAtMs = bookingAtMs;
        amountMicros = guardResult.amountMicros;
      }
      return undefined;
    });

    client.onAfterPaymentCreation(async (context) => {
      const payload = context.paymentPayload;
      const transaction = payload.payload.transaction;
      const accepted = payload.accepted as PaymentRequirements;
      if (typeof transaction !== "string") {
        throw new Error("payment payload has no Solana transaction");
      }
      try {
        const approved = requirements;
        if (!approved) throw new Error("no approved payment requirement");
        assertAcceptedMatchesRequirements(accepted, approved);
        decoded = await decodePaymentTransaction(transaction, {
          payer,
          mint: approved.asset,
          payTo: approved.payTo,
          amountAtomic: approved.amount,
          feePayer: String((approved.extra ?? {}).feePayer),
          allowPayerAsFeePayer: opts.allowPayerAsFeePayer === true,
        });
      } catch (err) {
        // The fee payer has not signed, so this transaction cannot land. Release.
        if (reservationId) {
          store.release(reservationId, { reason: "signed_transaction_mismatch" });
          reservationId = null;
        }
        denial = { status: 403, code: "signed_transaction_mismatch", reason: errorMessage(err) };
        throw err;
      }
    });

    const wrappedFetch = wrapFetchWithPayment(baseFetch, client);

    const init: RequestInit = { method, headers: forwardHeaders, redirect: "manual" };
    if (method !== "GET" && input.body !== undefined) init.body = input.body;

    const details = (signature: string | null, unconfirmed: boolean): Record<string, unknown> => {
      const facts = decoded as DecodedPayment;
      const requirement = requirements as PaymentRequirements | null;
      if (!requirement) throw new Error("no payment requirements were selected");
      const bookedAtMs = reservedAtMs > 0 ? reservedAtMs : Date.now();
      return {
        tx_signature: signature,
        payer_signature: facts.payerSignature,
        network: requirement.network,
        pay_to: requirement.payTo,
        payer,
        fee_payer: String((requirement.extra ?? {}).feePayer),
        asset: requirement.asset,
        resource: resourceLabel,
        resource_query_sha256: querySha256,
        amount_atomic: requirement.amount,
        payee_basis: payeeBasis,
        price_basis: priceBasis,
        reference_micros: referenceMicros,
        binding_hash: bindingHash,
        approval_request_id: approvalRequestId,
        reserved_at_ms: bookedAtMs,
        expires_at_ms: bookedAtMs + maxTimeoutSeconds * 1000 + 150_000,
        ...(unconfirmed ? { unconfirmed: true } : {}),
        ...(delivery?.truncated
          ? {
              truncated: true,
              delivered_bytes: delivery.deliveredBytes,
              full_bytes: delivery.fullBytes,
            }
          : {}),
      };
    };

    const truncatedHeaders = (): Record<string, string> =>
      delivery?.truncated
        ? { "X-Mandate-Truncated": delivery.fullBytes == null ? "unknown" : String(delivery.fullBytes) }
        : {};

    // A manual redirect is handed back to the caller, so the Location header
    // must go with the status. The rail never follows it.
    const redirectHeaders = (res: Response): Record<string, string> => {
      const location = res.headers.get("location");
      return location ? { location } : {};
    };

    // Both settlement paths use this function. The replay check and the chain
    // check are the same for a facilitator signature and a signature found in
    // the payer history. One invariant, one place.
    const settleVerified = async (args: {
      auth: { agentId: string; mandateId: string };
      rid: string;
      signature: string;
      source: "facilitator" | "chain";
      requirement: PaymentRequirements;
      status: number;
      contentType: string;
      body: string;
      redirectHeaders?: Record<string, string>;
    }): Promise<PayResult> => {
      const replayDenied = (): PayResult => {
        store.release(args.rid, { reason: "replayed_signature" });
        appendBlocked(args.auth, blockedAsk, "replayed_signature", "the on-chain signature was already booked for another call");
        return {
          status: 403,
          headers: { ...mandateHeaders(args.auth.mandateId, 0, null), "content-type": "application/json" },
          body: JSON.stringify({
            error: {
              type: "mandate_denied",
              code: "replayed_signature",
              message: "the on-chain signature was already booked for another call",
            },
          }),
        };
      };
      if (signatureBooked(args.signature, args.rid)) return replayDenied();
      const check = await opts.chain.verifyTransfer(args.signature, {
        network: args.requirement.network,
        mint: args.requirement.asset,
        payTo: args.requirement.payTo,
        amountAtomic: args.requirement.amount,
        payer,
      });
      if (check.status === "success") {
        // The signature claim and the settle commit together. A duplicate key
        // means a concurrent call settled this signature first, so this hold
        // is released and the call is refused.
        const event = store.settleClaimed(
          args.rid,
          null,
          amountMicros,
          {
            ...details(args.signature, false),
            settlement_verified: true,
            settlement_commitment: "finalized",
            tx_signature_source: args.source,
          },
          { mandateId: args.auth.mandateId, txSignature: args.signature },
        );
        if (!event) return replayDenied();
        return {
          status: args.status,
          headers: {
            "content-type": args.contentType,
            ...(args.status >= 300 && args.status < 400 ? args.redirectHeaders ?? {} : {}),
            ...truncatedHeaders(),
            ...mandateHeaders(args.auth.mandateId, event.chargedMicros, args.signature),
          },
          body: args.body,
        };
      }
      if (check.status === "failed") {
        store.release(args.rid, { reason: "settlement_failed", tx_signature: args.signature, chain_reason: check.reason });
        appendBlocked(args.auth, blockedAsk, "settlement_failed", check.reason);
        return {
          status: 402,
          headers: { "content-type": "application/json", ...mandateHeaders(args.auth.mandateId, 0, null) },
          body: JSON.stringify({
            error: { type: "mandate_denied", code: "settlement_failed", message: "the Solana transfer failed on chain" },
          }),
        };
      }
      // A confirmed signature that we cannot read, or a different transfer, is
      // uncertain money. Fail closed and let reconcile decide.
      const event = store.chargeFull(args.rid, {
        ...details(args.signature, true),
        chain_reason: check.reason,
        chain_status: check.status,
      });
      return {
        status: 502,
        headers: { "content-type": args.contentType, ...mandateHeaders(args.auth.mandateId, event.chargedMicros, null) },
        body: JSON.stringify({
          error: { type: "mandate_unconfirmed", message: "payment was signed but settlement could not be verified" },
        }),
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
      if (decoded && reservationId) {
        // The request may have reached the facilitator. A payer signature
        // exists, so book the full amount and reconcile the signature later.
        const event = store.chargeFull(reservationId, details(null, true));
        return {
          status: 502,
          headers: mandateHeaders(auth.mandateId, event.chargedMicros, null),
          body: JSON.stringify({
            error: { type: "mandate_unconfirmed", message: "payment was signed but settlement could not be confirmed" },
          }),
        };
      }
      if (reservationId) store.release(reservationId, { reason: "signing_failed" });
      if (denial) return deniedResult(auth, denial, blockedAsk);
      return {
        status: 502,
        headers: mandateHeaders(auth.mandateId, 0, null),
        body: JSON.stringify({ error: { type: "payment_error", message: "the x402 payment could not be created" } }),
      };
    }

    const res = response as Response;
    const read = await readCapped(res, maxResponseBytes);
    const body = read.body;
    delivery = read;
    if (read.truncated) {
      console.warn(
        `svm-rail: response body truncated for reservation ${reservationId ?? "unpaid"}: delivered ${read.deliveredBytes} of ${read.fullBytes ?? "unknown"} bytes`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";

    if (!decoded || !reservationId) {
      if (reservationId) store.release(reservationId, { reason: "not_signed" });
      if (denial) return deniedResult(auth, denial, blockedAsk);
      return {
        status: res.status,
        headers: {
          "content-type": contentType,
          ...redirectHeaders(res),
          ...truncatedHeaders(),
          ...mandateHeaders(auth.mandateId, 0, null),
        },
        body,
      };
    }

    const rid = reservationId as string;
    const settlement = decodeSettlement(res.headers);
    const settledSignature =
      settlement?.success && typeof settlement.transaction === "string" && SIGNATURE_RE.test(settlement.transaction)
        ? settlement.transaction
        : null;

    if (settledSignature) {
      return settleVerified({
        auth,
        rid,
        signature: settledSignature,
        source: "facilitator",
        requirement: requirements as unknown as PaymentRequirements,
        status: res.status,
        contentType,
        body,
        redirectHeaders: redirectHeaders(res),
      });
    }

    // No successful settlement header. A signed transaction is already in the
    // seller's hands, so a facilitator error or a redirect is not proof that no
    // money moved. Search the payer history. A found transfer settles. A scan
    // that completed with no match, a scan that did not finish, and a scan that
    // failed all book the full amount as unconfirmed for reconcile. None of
    // them releases the hold.
    const requirement = requirements as unknown as PaymentRequirements;
    const reservationStartMs = reservedAtMs > 0 ? reservedAtMs : Date.now();
    let search: Awaited<ReturnType<SolanaChain["findTransfer"]>> | undefined;
    try {
      search = await opts.chain.findTransfer({
        network: requirement.network,
        mint: requirement.asset,
        payTo: requirement.payTo,
        amountAtomic: requirement.amount,
        payer,
        // Cover the authorization window plus the blockhash lifetime, not a
        // fixed five minutes. A clock skew smaller than the margin is safe.
        sinceMs: reservationStartMs - (maxTimeoutSeconds + 150) * 1000 - 60_000,
      });
    } catch {
      search = undefined;
    }
    if (search !== undefined && search.kind === "found") {
      return settleVerified({
        auth,
        rid,
        signature: search.signature,
        source: "chain",
        requirement,
        status: res.status,
        contentType,
        body,
        redirectHeaders: redirectHeaders(res),
      });
    }
    const unconfirmedReason =
      search === undefined
        ? "chain_unreadable"
        : search.kind === "incomplete"
          ? "history_scan_incomplete"
          : res.status >= 300 && res.status < 400
            ? "redirect_after_signing"
            : "facilitator_error";
    const event = store.chargeFull(rid, {
      ...details(null, true),
      unconfirmed_reason: unconfirmedReason,
      ...(search !== undefined && search.kind === "incomplete"
        ? { scan_capped: search.capped, scan_timed_out: search.timedOut }
        : {}),
    });
    return {
      status: 502,
      headers: {
        "content-type": contentType,
        ...truncatedHeaders(),
        ...mandateHeaders(auth.mandateId, event.chargedMicros, null),
      },
      body: JSON.stringify({
        error: {
          type: "mandate_unconfirmed",
          code: unconfirmedReason,
          message: "payment was signed but settlement could not be verified",
        },
      }),
    };
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

    let input: SvmFetchInput;
    try {
      const parsed = JSON.parse(read.buf.toString("utf8")) as Partial<SvmFetchInput>;
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
      input = parsed as SvmFetchInput;
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

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 240);
}

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

async function readCapped(res: Response, maxBytes: number): Promise<DeliveryInfo & { body: string }> {
  const declared = Number(res.headers.get("content-length"));
  const declaredBytes = Number.isFinite(declared) && declared >= 0 ? declared : null;
  if (!res.body) return { body: "", truncated: false, deliveredBytes: 0, fullBytes: declaredBytes };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.length > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return {
    body: Buffer.concat(chunks).toString("utf8"),
    truncated,
    deliveredBytes: total,
    fullBytes: declaredBytes ?? (truncated ? null : total),
  };
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
