// The Stripe Shared Payment Token rail behind the TapVow gateway.
//
// Agents never hold a Stripe key. The gateway checks a granted SPT against the
// same signed mandate, budget store and ledger as the LLM and x402 rails,
// reserves the amount atomically, and books the real PaymentIntent in the
// signed hash chain.
import type { GovernedRail } from "@mandate/llm-rail";
import { formatUsd, type LedgerEntry } from "@mandate/core";
import type { GrantedToken, PaymentIntent, StripeClient, StripeResponse } from "./stripe.js";
import { redactSecrets } from "./stripe.js";

export interface StripeSptApprover {
  request(req: {
    mandateId: string;
    agentId: string;
    rail: "stripe_spt";
    payee: string;
    amountMicros: number;
    summary: string;
  }): Promise<{ decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string }>;
}

export interface StripeSptRailOptions {
  rail: GovernedRail;
  client: StripeClient;
  /** Display label written into settlement details. Never used as an allowlist id. */
  sellerLabel: string;
  /** Telegram-style step-up approval, consulted only when the store asks. */
  approver?: StripeSptApprover;
  now?: () => number;
}

export interface PayWithSptInput {
  sptId: string;
  amountCents: number;
  currency: string;
}

export type PayWithSptResult =
  | {
      ok: true;
      status: number;
      reservationId: string;
      paymentIntentId: string;
      chargedMicros: number;
      sptId: string;
    }
  | {
      ok: false;
      status: number;
      code: string;
      reason: string;
      reservationId?: string;
    };

export interface DeactivationInput {
  sptId: string;
  deactivatedReason: string;
  deactivatedAt: number;
  eventId?: string | null;
  source: "event" | "retrieve";
}

export interface StripeSptRail {
  payWithSpt(
    auth: { agentId: string; mandateId: string },
    input: PayWithSptInput,
  ): Promise<PayWithSptResult>;
  recordDeactivation(input: DeactivationInput): LedgerEntry;
}

export function createStripeSptRail(opts: StripeSptRailOptions): StripeSptRail {
  const store = opts.rail.store;
  const ledger = opts.rail.ledger;
  const mandate = opts.rail.mandate;
  const client = opts.client;
  const now = opts.now ?? (() => Date.now());

  function block(
    auth: { agentId: string; mandateId: string },
    input: Partial<PayWithSptInput>,
    payee: string | null,
    code: string,
    reason: string,
    status = 403,
  ): PayWithSptResult {
    const safeReason = redactSecrets(reason);
    const rawSptId = typeof input.sptId === "string" ? input.sptId : null;
    const safeSptId =
      code !== "invalid_request" && rawSptId !== null && /^spt_[A-Za-z0-9]{1,64}$/.test(rawSptId) ? rawSptId : null;
    // Never sign an unbounded or non-string id into the ledger: fall back to a
    // fixed placeholder so every invalid id shares one cap bucket.
    const rawAgentId = typeof auth.agentId === "string" ? auth.agentId : null;
    const agentId = rawAgentId !== null && rawAgentId.length >= 1 && rawAgentId.length <= 128 ? rawAgentId : "<invalid>";
    const rawMandateId = typeof auth.mandateId === "string" ? auth.mandateId : null;
    const mandateId =
      rawMandateId !== null && rawMandateId.length >= 1 && rawMandateId.length <= 128 ? rawMandateId : "<invalid>";
    const rawCurrency = typeof input.currency === "string" ? input.currency : null;
    const currency = rawCurrency !== null && /^[a-z]{3}$/.test(rawCurrency.toLowerCase()) ? rawCurrency.toLowerCase() : null;
    store.recordRailBlock(
      {
        kind: "stripe_spt.blocked",
        mandateId,
        agentId,
        payload: {
          mandate_id: mandateId,
          mandate_id_length: rawMandateId === null ? null : rawMandateId.length,
          agent_id: agentId,
          agent_id_length: rawAgentId === null ? null : rawAgentId.length,
          spt_id: safeSptId,
          spt_id_length: rawSptId === null ? null : rawSptId.length,
          amount_cents: typeof input.amountCents === "number" ? input.amountCents : null,
          currency,
          currency_length: rawCurrency === null ? null : rawCurrency.length,
          payee,
          code,
          reason: safeReason,
        },
      },
      (kind, payload) => ledger.append(kind, payload),
    );
    return { ok: false, status, code, reason: safeReason };
  }

  function allowedSptPayees(): string[] {
    return mandate.allowed_payees.filter((p) => p.rail === "stripe_spt").map((p) => p.id);
  }

  function settlementMismatch(
    candidate: PaymentIntent,
    input: PayWithSptInput,
    mandateCurrency: string,
    reservationId: string,
  ): { reason: string; fields: Record<string, unknown> } | null {
    if (typeof candidate.currency !== "string" || candidate.currency.toLowerCase() !== mandateCurrency) {
      return {
        reason: "currency_mismatch",
        fields: { currency: candidate.currency ?? null, expected_currency: mandateCurrency },
      };
    }
    if (candidate.livemode === true) {
      return { reason: "payment_intent_mismatch", fields: { livemode: true } };
    }
    const metadata = candidate.metadata;
    const boundReservation =
      typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>).tapvow_reservation_id
        : undefined;
    if (boundReservation !== reservationId) {
      return {
        reason: "payment_intent_mismatch",
        fields: { reservation_id: boundReservation ?? null, expected_reservation_id: reservationId },
      };
    }
    if (candidate.amount !== input.amountCents) {
      return {
        reason: "payment_intent_mismatch",
        fields: { amount: candidate.amount ?? null, expected_amount: input.amountCents },
      };
    }
    return null;
  }

  function piDetails(
    pi: PaymentIntent | null,
    sptId: string,
    response: StripeResponse | null,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      payment_intent: pi?.id ?? null,
      charge: typeof pi?.latest_charge === "string" ? pi.latest_charge : null,
      spt: sptId,
      livemode: false,
      request_id: response?.requestId ?? null,
      status: typeof pi?.status === "string" ? pi.status : null,
      ...extra,
    };
  }

  function chargedMicrosFrom(pi: PaymentIntent | null, fallbackMicros: number): { micros: number; source: string } {
    for (const [field, source] of [
      ["amount_received", "amount_received"],
      ["amount", "amount"],
    ] as const) {
      const cents = pi?.[field];
      if (typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0) {
        const micros = cents * 10_000;
        if (Number.isSafeInteger(micros)) return { micros, source };
      }
    }
    return { micros: fallbackMicros, source: "reserved" };
  }

  async function payWithSpt(
    auth: { agentId: string; mandateId: string },
    input: PayWithSptInput,
  ): Promise<PayWithSptResult> {
    // The auth shape is checked first: a non-string agent or mandate id must be
    // a clean invalid_request, never an exception from binding it to SQLite.
    if (
      typeof auth.agentId !== "string" ||
      auth.agentId.length === 0 ||
      auth.agentId.length > 128 ||
      typeof auth.mandateId !== "string" ||
      auth.mandateId.length === 0 ||
      auth.mandateId.length > 128
    ) {
      return block(auth, input, null, "invalid_request", "agentId and mandateId must be strings of at most 128 characters", 400);
    }
    if (!client.isTestModeVerified) {
      return block(auth, input, null, "test_mode_required", "Stripe test mode has not been verified in this process", 403);
    }
    if (auth.mandateId !== mandate.id) {
      return block(auth, input, null, "mandate_mismatch", "the agent key does not belong to this rail's mandate", 403);
    }
    if (
      typeof input.sptId !== "string" ||
      !/^spt_[A-Za-z0-9]{1,64}$/.test(input.sptId) ||
      !Number.isSafeInteger(input.amountCents) ||
      input.amountCents <= 0 ||
      typeof input.currency !== "string" ||
      !/^[a-z]{3}$/.test(input.currency.toLowerCase())
    ) {
      return block(auth, input, null, "invalid_request", "sptId, a positive amountCents and a 3-letter currency are required", 400);
    }
    const currency = input.currency.toLowerCase();
    const mandateCurrency = mandate.currency.toLowerCase();
    if (currency !== mandateCurrency) {
      return block(
        auth,
        input,
        null,
        "currency_not_allowed",
        `the mandate is in ${mandate.currency} and this payment is in ${currency}`,
        403,
      );
    }
    const amountMicros = input.amountCents * 10_000;
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
      return block(auth, input, null, "invalid_request", "amountCents is too large", 400);
    }

    const policy = store.getPolicy(auth.mandateId);
    if (policy && (!policy.rails || !policy.rails.includes("stripe_spt"))) {
      return block(auth, input, null, "rail_not_allowed", "mandate does not cover the stripe_spt rail", 403);
    }

    // 1. Retrieve the token. The local checks below are the first wall; Stripe's
    // own usage_limits are the second.
    let tokenResponse: StripeResponse;
    try {
      tokenResponse = await client.getToken(input.sptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return block(auth, input, null, "token_retrieve_failed", redactSecrets(message), 502);
    }
    const token = asToken(tokenResponse.body);
    if (!tokenResponse.ok || !token) {
      return block(
        auth,
        input,
        null,
        "token_retrieve_failed",
        `could not retrieve ${input.sptId} (HTTP ${tokenResponse.status})`,
        502,
      );
    }
    if (token.id !== input.sptId) {
      return block(auth, input, null, "token_mismatch", "retrieved token id does not match the requested spt", 403);
    }
    if (token.livemode !== false) {
      return block(auth, input, null, "live_mode_token", "refusing a token that is not in test mode", 403);
    }

    const profile = token.agent_details?.network_business_profile;
    const agentProfile = typeof profile === "string" && profile.length > 0 ? profile : null;
    // The money always goes to the account behind this client's key, so that
    // account is the payee. The token's business profile is issued by the
    // agent and is only a display detail.
    const payee = client.accountId;
    if (payee === null) {
      return block(auth, input, null, "payee_not_allowed", "the Stripe account could not be identified", 403);
    }
    const sharedMetadata =
      typeof token.shared_metadata === "object" && token.shared_metadata !== null
        ? (token.shared_metadata as Record<string, unknown>)
        : {};
    if (sharedMetadata.tapvow_mandate_id !== auth.mandateId) {
      return block(auth, input, payee, "token_not_bound", "the spt is not bound to this mandate", 403);
    }
    const boundAgent = sharedMetadata.tapvow_agent_id;
    if (boundAgent !== undefined && boundAgent !== null && boundAgent !== "" && boundAgent !== auth.agentId) {
      return block(auth, input, payee, "token_not_bound", "the spt is bound to another agent", 403);
    }
    const payeeDetails = { seller_label: opts.sellerLabel, agent_profile: agentProfile };
    const allowed = allowedSptPayees();
    if (!allowed.includes(payee)) {
      return block(auth, input, payee, "payee_not_allowed", `payee ${payee} is not allowed`, 403);
    }

    if (token.deactivated_reason != null) {
      return block(
        auth,
        input,
        payee,
        "token_deactivated",
        `spt ${input.sptId} is deactivated (${String(token.deactivated_reason)})`,
        403,
      );
    }
    const limits = token.usage_limits;
    if (!limits || typeof limits.max_amount !== "number" || !Number.isSafeInteger(limits.max_amount)) {
      return block(auth, input, payee, "token_invalid", "spt has no usable usage_limits.max_amount", 403);
    }
    if (typeof limits.currency !== "string" || limits.currency.toLowerCase() !== currency) {
      return block(
        auth,
        input,
        payee,
        "currency_mismatch",
        `spt currency ${String(limits.currency)} does not match ${currency}`,
        403,
      );
    }
    if (typeof limits.expires_at === "number" && now() / 1000 >= limits.expires_at) {
      return block(auth, input, payee, "token_expired", `spt ${input.sptId} expired`, 403);
    }
    const captured = token.usage_details?.amount_captured?.value;
    const capturedValue = typeof captured === "number" && Number.isSafeInteger(captured) && captured >= 0 ? captured : 0;
    if (input.amountCents > limits.max_amount - capturedValue) {
      return block(
        auth,
        input,
        payee,
        "token_cap_exceeded",
        `amount ${input.amountCents} cents exceeds the remaining spt limit of ${limits.max_amount - capturedValue} cents`,
        403,
      );
    }

    // 2. Reserve atomically on the shared budget.
    const reserveArgs = {
      mandateId: auth.mandateId,
      agentId: auth.agentId,
      model: `stripe_spt:${currency}`,
      provider: payee,
      amountMicros,
      rail: "stripe_spt" as const,
      payeeVerifiedBy: "allowlist" as const,
    };
    let reserved = store.reserve(reserveArgs);
    let approvalRequestId: string | null = null;
    if (!reserved.ok && reserved.code === "approval_required" && opts.approver) {
      let decision: { decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string };
      try {
        decision = await opts.approver.request({
          mandateId: auth.mandateId,
          agentId: auth.agentId,
          rail: "stripe_spt",
          payee,
          amountMicros,
          summary: `Pay ${formatUsd(amountMicros)} USD with a Stripe SPT to ${payee}`,
        });
      } catch {
        decision = { decision: "denied", requestId: "" };
      }
      if (decision.decision === "approved" && decision.requestId.length > 0) {
        approvalRequestId = decision.requestId;
        reserved = store.reserve({
          ...reserveArgs,
          approval: { requestId: decision.requestId, decidedBy: decision.decidedBy ?? "approver" },
        });
      } else if (decision.decision === "timeout") {
        return block(auth, input, payee, "approval_timeout", "approval timed out", 403);
      } else {
        return block(auth, input, payee, "approval_denied", "approval denied", 403);
      }
    }
    if (!reserved.ok) {
      return block(auth, input, payee, reserved.code, reserved.reason, reserved.status);
    }
    const reservationId = reserved.reservationId;
    const approvalDetails = approvalRequestId ? { approval_request_id: approvalRequestId } : {};

    // 3. Charge the token. The reservation id is the idempotency key.
    let response: StripeResponse | null = null;
    let transportError: string | null = null;
    try {
      response = await client.createPaymentIntent(
        {
          amountCents: input.amountCents,
          currency,
          sptId: input.sptId,
          metadata: { tapvow_reservation_id: reservationId },
        },
        reservationId,
      );
    } catch (err) {
      transportError = redactSecrets(err instanceof Error ? err.message : String(err));
    }

    if (transportError !== null) {
      store.chargeFull(
        reservationId,
        piDetails(null, input.sptId, null, {
          ...approvalDetails,
          ...payeeDetails,
          unconfirmed: true,
          reason: "transport_error",
          error: transportError,
        }),
      );
      return {
        ok: false,
        status: 502,
        code: "payment_unconfirmed",
        reason: "the Stripe payment could not be confirmed",
        reservationId,
      };
    }

    const res = response as StripeResponse;
    const body = asRecord(res.body);
    const pi = body && body.object === "payment_intent" ? (body as PaymentIntent) : null;
    const error = body && body.error !== undefined ? asRecord(body.error) : null;
    const errorCode = typeof error?.code === "string" ? error.code : typeof error?.type === "string" ? error.type : null;
    const errorMessage = redactSecrets(
      typeof error?.message === "string" ? error.message : `Stripe returned HTTP ${res.status}`,
    );
    const rawPiInError = error?.payment_intent;
    const piPresent = rawPiInError !== undefined && rawPiInError !== null;
    const piInError = piPresent ? asPaymentIntent(rawPiInError) : null;
    const candidate = pi ?? piInError;

    if (res.status >= 200 && res.status < 300) {
      if (candidate?.status === "succeeded") {
        const mismatch = settlementMismatch(candidate, input, mandateCurrency, reservationId);
        if (mismatch) {
          store.chargeFull(
            reservationId,
            piDetails(candidate, input.sptId, res, {
              ...approvalDetails,
              ...payeeDetails,
              unconfirmed: true,
              reason: mismatch.reason,
              ...mismatch.fields,
            }),
          );
          return {
            ok: false,
            status: 502,
            code: "payment_unconfirmed",
            reason: "the Stripe PaymentIntent did not match this payment",
            reservationId,
          };
        }
        const charge = chargedMicrosFrom(candidate, amountMicros);
        const event = store.settle(
          reservationId,
          null,
          charge.micros,
          piDetails(candidate, input.sptId, res, {
            ...approvalDetails,
            ...payeeDetails,
            amount_source: charge.source,
          }),
        );
        return {
          ok: true,
          status: 200,
          reservationId,
          paymentIntentId: candidate.id,
          chargedMicros: event.chargedMicros,
          sptId: input.sptId,
        };
      }
      store.chargeFull(
        reservationId,
        piDetails(candidate, input.sptId, res, {
          ...approvalDetails,
          ...payeeDetails,
          unconfirmed: true,
          reason: "payment_not_settled",
          status: candidate?.status ?? null,
        }),
      );
      return {
        ok: false,
        status: 502,
        code: "payment_unconfirmed",
        reason: "Stripe returned a PaymentIntent that is not settled",
        reservationId,
      };
    }

    if (res.status >= 400 && res.status < 500) {
      // Only error.payment_intent tells us money may have moved. A hard-coded
      // error code list would go stale, so the HTTP class and this object decide.
      if (piInError && piInError.status === "succeeded") {
        const mismatch = settlementMismatch(piInError, input, mandateCurrency, reservationId);
        if (mismatch) {
          store.chargeFull(
            reservationId,
            piDetails(piInError, input.sptId, res, {
              ...approvalDetails,
              ...payeeDetails,
              unconfirmed: true,
              reason: mismatch.reason,
              error_code: errorCode,
              ...mismatch.fields,
            }),
          );
          return {
            ok: false,
            status: 502,
            code: "payment_unconfirmed",
            reason: "the Stripe PaymentIntent did not match this payment",
            reservationId,
          };
        }
        const charge = chargedMicrosFrom(piInError, amountMicros);
        const event = store.settle(
          reservationId,
          null,
          charge.micros,
          piDetails(piInError, input.sptId, res, {
            ...approvalDetails,
            ...payeeDetails,
            amount_source: charge.source,
            error_code: errorCode,
          }),
        );
        return {
          ok: true,
          status: 200,
          reservationId,
          paymentIntentId: piInError.id,
          chargedMicros: event.chargedMicros,
          sptId: input.sptId,
        };
      }
      // Release only when no PaymentIntent is present, or when it is
      // definitively dead. Anything else may still move money.
      if (piInError && (piInError.status === "requires_payment_method" || piInError.status === "canceled")) {
        store.release(reservationId, {
          reason: errorCode ?? `http_${res.status}`,
          payment_intent: piInError.id,
          spt: input.sptId,
          request_id: res.requestId,
          status: piInError.status,
        });
        return {
          ok: false,
          status: res.status,
          code: errorCode ?? "payment_failed",
          reason: errorMessage,
          reservationId,
        };
      }
      if (piPresent) {
        store.chargeFull(
          reservationId,
          piDetails(piInError, input.sptId, res, {
            ...approvalDetails,
            ...payeeDetails,
            unconfirmed: true,
            reason: piInError === null ? "unparsed_payment_intent" : "payment_intent_unconfirmed",
            error_code: errorCode,
            status: piInError?.status ?? null,
          }),
        );
        return {
          ok: false,
          status: 502,
          code: "payment_unconfirmed",
          reason:
            piInError === null
              ? "Stripe reported a PaymentIntent that could not be read"
              : "the Stripe payment is not settled",
          reservationId,
        };
      }
      store.release(reservationId, {
        reason: errorCode ?? `http_${res.status}`,
        payment_intent: null,
        spt: input.sptId,
        request_id: res.requestId,
        status: null,
      });
      return {
        ok: false,
        status: res.status,
        code: errorCode ?? "payment_failed",
        reason: errorMessage,
        reservationId,
      };
    }

    // 3xx, 5xx and anything unexpected: fail closed, the charge may have moved.
    store.chargeFull(
      reservationId,
      piDetails(candidate, input.sptId, res, {
        ...approvalDetails,
        ...payeeDetails,
        unconfirmed: true,
        reason: res.status >= 500 ? "stripe_server_error" : "unexpected_http_status",
        error_code: errorCode,
      }),
    );
    return {
      ok: false,
      status: 502,
      code: "payment_unconfirmed",
      reason: "the Stripe payment could not be confirmed",
      reservationId,
    };
  }

  function recordDeactivation(input: DeactivationInput): LedgerEntry {
    if (typeof input.sptId !== "string" || !/^spt_[A-Za-z0-9]{1,64}$/.test(input.sptId)) {
      throw new Error("recordDeactivation: sptId must be an spt_ id of at most 68 characters");
    }
    if (!["consumed", "expired", "resolved", "revoked"].includes(input.deactivatedReason)) {
      throw new Error("recordDeactivation: deactivatedReason must be consumed, expired, resolved or revoked");
    }
    if (!Number.isSafeInteger(input.deactivatedAt)) {
      throw new Error("recordDeactivation: deactivatedAt must be a safe integer");
    }
    if (
      input.eventId !== undefined &&
      input.eventId !== null &&
      (typeof input.eventId !== "string" || input.eventId.length < 1 || input.eventId.length > 255)
    ) {
      throw new Error("recordDeactivation: eventId must be a string of 1 to 255 characters");
    }
    // A replayed webhook inside the signature window must not sign twice. Look
    // up the one entry by seq instead of parsing the whole ledger.
    if (typeof input.eventId === "string" && input.eventId.length > 0) {
      const row = store.database
        .prepare(
          "SELECT seq FROM ledger_entries WHERE kind = 'stripe_spt.deactivated' AND json_extract(payload, '$.event_id') = ? LIMIT 1",
        )
        .get(input.eventId) as { seq: number } | undefined;
      if (row) {
        const entry = ledger.entries(row.seq, 1)[0];
        if (entry) return entry;
      }
    }
    return ledger.append("stripe_spt.deactivated", {
      spt_id: input.sptId,
      deactivated_reason: input.deactivatedReason,
      deactivated_at: input.deactivatedAt,
      event_id: input.eventId ?? null,
      source: input.source,
    });
  }

  return { payWithSpt, recordDeactivation };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asToken(value: unknown): GrantedToken | null {
  const record = asRecord(value);
  if (!record || record.object !== "shared_payment.granted_token" || typeof record.id !== "string") return null;
  return record as unknown as GrantedToken;
}

function asPaymentIntent(value: unknown): PaymentIntent | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return null;
  return record as unknown as PaymentIntent;
}
