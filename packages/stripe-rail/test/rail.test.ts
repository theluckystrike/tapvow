import { test, after } from "node:test";
import assert from "node:assert/strict";
import { auditRail } from "@mandate/llm-rail";
import { StripeClient, type StripeSptApprover } from "../src/index.js";
import {
  ACCOUNT,
  FAKE_KEY,
  SELLER,
  SPT,
  account,
  balance,
  cleanupDirs,
  fakeStripe,
  json,
  makeStack,
  paymentIntent,
  token,
} from "./helpers.js";

after(cleanupDirs);

test("refuses a live-mode account or live key before any money call", async () => {
  const fake = fakeStripe((call) =>
    call.path === "/v1/balance" ? balance(true) : json({ error: { message: "must not be called" } }, 500),
  );
  const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
  await assert.rejects(client.assertTestMode(), /livemode/);
  assert.equal(client.isTestModeVerified, false);
  await assert.rejects(client.getToken(SPT), /assertTestMode/);

  const live = new StripeClient("sk_live_abcdef", { fetch: fake.fetch });
  await assert.rejects(live.assertTestMode(), /sk_test_ or rk_test_/);
  assert.equal(fake.calls.length, 1, "a live key must be refused without a network call");

  const restrictedLive = new StripeClient("rk_live_abcdef", { fetch: fake.fetch });
  await assert.rejects(restrictedLive.assertTestMode(), /sk_test_ or rk_test_/);
  assert.equal(fake.calls.length, 1, "a restricted live key must also be refused without a network call");

  const noLivemode = fakeStripe((call) =>
    call.path === "/v1/balance" ? json({ object: "balance", available: [] }) : json({}, 500),
  );
  const missing = new StripeClient(FAKE_KEY, { fetch: noLivemode.fetch });
  await assert.rejects(missing.assertTestMode(), /livemode/);
  assert.equal(missing.isTestModeVerified, false);

  const liveToken = await makeStack({
    id: "mdt_stripe_live_token",
    token: token({ livemode: true }),
  });
  const refused = await liveToken.stripe.payWithSpt(liveToken.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "live_mode_token");
  assert.equal(liveToken.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
});

test("60 cent SPT settle lands in the same hash chain after llm.settle and x402.settle", async () => {
  const stack = await makeStack({ id: "mdt_stripe_chain" });
  const llm = stack.rail.store.reserve({
    mandateId: stack.mandate.id,
    agentId: "agent-01",
    model: "gpt-4o",
    provider: "openai",
    amountMicros: 1000,
    rail: "llm",
  });
  assert.ok(llm.ok);
  stack.rail.store.settle(llm.reservationId, null, 800);
  const x = stack.rail.store.reserve({
    mandateId: stack.mandate.id,
    agentId: "agent-01",
    model: "x402:eip155:84532:0xabc",
    provider: "0xabc",
    amountMicros: 500,
    rail: "x402",
    payeeVerifiedBy: "allowlist",
  });
  assert.ok(x.ok);
  stack.rail.store.settle(x.reservationId, null, 400);

  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, true);
  assert.equal(paid.chargedMicros, 600_000);

  const entries = stack.rail.ledger.entries();
  const kinds = entries.map((e) => e.kind);
  const iLlm = kinds.indexOf("llm.settle");
  const iX = kinds.indexOf("x402.settle");
  const iS = kinds.indexOf("stripe_spt.settle");
  assert.ok(iLlm >= 0 && iX > iLlm && iS > iX, `order was ${kinds.join(",")}`);

  const payload = entries[iS]!.payload as {
    rail: string;
    outcome: string;
    charged_micros: number;
    reserved_micros: number;
    payee: string;
    asset: string;
    details: { payment_intent: string; charge: string; spt: string; livemode: boolean };
  };
  assert.equal(payload.rail, "stripe_spt");
  assert.equal(payload.outcome, "settled");
  assert.equal(payload.charged_micros, 600_000);
  assert.equal(payload.reserved_micros, 600_000);
  assert.equal(payload.payee, ACCOUNT);
  assert.equal(payload.asset, "stripe_spt:usd");
  assert.equal(payload.details.payment_intent, "pi_test_0001");
  assert.equal(payload.details.charge, "ch_test_0001");
  assert.equal(payload.details.spt, SPT);
  assert.equal(payload.details.livemode, false);

  assert.ok(stack.rail.ledger.verify(stack.rail.trustedLedgerKeys).ok);
  const audit = auditRail(stack.rail.store, stack.rail.ledger, stack.mandate.id, stack.rail.trustedLedgerKeys);
  assert.ok(audit.ok, audit.ok ? "" : audit.reason);
});

test("the budget is shared: an SPT charge reduces what the LLM rail can spend", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_budget_shared",
    mandate: { budget: { total: "0.02", period: "lifetime" }, per_call_cap: "0.02", approval_threshold: "0.02" },
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 1, currency: "usd" });
  assert.equal(paid.ok, true);
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 10_000);

  const llm = stack.rail.store.reserve({
    mandateId: stack.mandate.id,
    agentId: "agent-01",
    model: "gpt-4o",
    provider: "openai",
    amountMicros: 15_000,
    rail: "llm",
  });
  assert.equal(llm.ok, false);
  if (!llm.ok) assert.equal(llm.code, "budget_exceeded");
});

test("a local over-cap refusal against usage_limits never reaches Stripe", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_over_cap",
    token: token({ usage_details: { amount_captured: { currency: "usd", value: 40 } } }),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 61, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) {
    assert.equal(paid.code, "token_cap_exceeded");
    assert.match(paid.reason, /remaining spt limit of 60 cents/);
  }
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
  assert.equal(stack.rail.ledger.entries().filter((e) => e.kind === "stripe_spt.blocked").length, 1);
});

test("a revoked token is refused locally with a signed blocked entry", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_revoked",
    token: token({ deactivated_reason: "revoked", deactivated_at: 1792385312 }),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "token_deactivated");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
  const blocked = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.blocked");
  assert.ok(blocked);
  assert.equal((blocked.payload as { code: string }).code, "token_deactivated");
});

test("a 4xx PaymentIntent error releases the reservation", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_4xx",
    paymentIntent: () =>
      json(
        {
          error: {
            type: "invalid_request_error",
            code: "amount_too_small",
            message: "Amount must convert to at least 50 cents.",
          },
        },
        400,
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "amount_too_small");
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; charged_micros: number; details: { reason: string } };
  assert.equal(payload.outcome, "released");
  assert.equal(payload.charged_micros, 0);
  assert.equal(payload.details.reason, "amount_too_small");
  assert.ok(auditRail(stack.rail.store, stack.rail.ledger, stack.mandate.id, stack.rail.trustedLedgerKeys).ok);
});

test("a 5xx charges the full reservation", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_5xx",
    paymentIntent: () => json({ error: { type: "api_error", code: "api_error", message: "upstream down" } }, 500),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; charged_micros: number };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.charged_micros, 600_000);
  assert.ok(auditRail(stack.rail.store, stack.rail.ledger, stack.mandate.id, stack.rail.trustedLedgerKeys).ok);
});

test("reconcileCharged re-books a charged_full stripe_spt row", async () => {
  const stack = await makeStack({ id: "mdt_stripe_reconcile" });
  const reserved = stack.rail.store.reserve({
    mandateId: stack.mandate.id,
    agentId: "agent-01",
    model: "stripe_spt:usd",
    provider: ACCOUNT,
    amountMicros: 600_000,
    rail: "stripe_spt",
    payeeVerifiedBy: "allowlist",
  });
  assert.ok(reserved.ok);
  stack.rail.store.chargeFull(reserved.reservationId);
  const reconciled = stack.rail.store.reconcileCharged(
    reserved.reservationId,
    { outcome: "settled", chargedMicros: 600_000 },
    { payment_intent: "pi_reconciled" },
  );
  assert.equal(reconciled.rail, "stripe_spt");
  const latest = stack.rail.ledger
    .entries()
    .filter((e) => e.kind === "stripe_spt.settle" && (e.payload as { reservation_id: string }).reservation_id === reserved.reservationId)
    .at(-1);
  assert.ok(latest);
  assert.equal((latest.payload as { details: { reconciled_from: string } }).details.reconciled_from, "charged_full");
  assert.ok(auditRail(stack.rail.store, stack.rail.ledger, stack.mandate.id, stack.rail.trustedLedgerKeys).ok);
});

test("a transport timeout charges the full reservation and leaks no key", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_timeout",
    fetchHandler: (call) => {
      if (call.path === "/v1/balance") return balance(false);
      if (call.path === "/v1/account") return account();
      if (call.method === "GET" && call.path.endsWith("/spt_test_throw")) {
        throw new Error(`simulated timeout with ${FAKE_KEY}`);
      }
      if (call.method === "GET" && call.path.startsWith("/v1/shared_payment/granted_tokens/")) {
        return json(token({ shared_metadata: { tapvow_mandate_id: "mdt_stripe_timeout" } }));
      }
      throw new Error(`simulated timeout with ${FAKE_KEY}`);
    },
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);

  await assert.rejects(stack.client.getToken("spt_test_throw"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(FAKE_KEY));
    assert.match(err.message, /\[REDACTED\]/);
    return true;
  });
  const serialized = JSON.stringify(stack.rail.ledger.entries());
  assert.ok(!serialized.includes(FAKE_KEY), "ledger must never contain the key");

  // A real AbortSignal.timeout fires while the PaymentIntent request is open.
  const aborted = await makeStack({
    id: "mdt_stripe_abort",
    clientTimeoutMs: 50,
    fetchHandler: (call) => {
      if (call.path === "/v1/balance") return balance(false);
      if (call.path === "/v1/account") return account();
      if (call.method === "GET" && call.path.startsWith("/v1/shared_payment/granted_tokens/")) {
        return json(token({ shared_metadata: { tapvow_mandate_id: "mdt_stripe_abort" } }));
      }
      if (call.method === "POST" && call.path === "/v1/payment_intents") {
        return new Promise<Response>((_resolve, reject) => {
          const signal = call.signal;
          if (!signal) {
            reject(new Error("no signal"));
            return;
          }
          // Keep the loop alive: AbortSignal.timeout's own timer is unref'd.
          const keepAlive = setInterval(() => {}, 10);
          const fail = (reason: unknown): void => {
            clearInterval(keepAlive);
            reject(reason);
          };
          if (signal.aborted) {
            fail(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => fail(signal.reason));
        });
      }
      return json({}, 500);
    },
  });
  const timedOut = await aborted.stripe.payWithSpt(aborted.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.code, "payment_unconfirmed");
  assert.equal(aborted.rail.store.spent(aborted.mandate.id).settledMicros, 600_000);

  // The response headers arrive, then the body stream aborts.
  const bodyAborted = await makeStack({
    id: "mdt_stripe_body_abort",
    clientTimeoutMs: 500,
    fetchHandler: (call) => {
      if (call.path === "/v1/balance") return balance(false);
      if (call.path === "/v1/account") return account();
      if (call.method === "GET" && call.path.startsWith("/v1/shared_payment/granted_tokens/")) {
        return json(token({ shared_metadata: { tapvow_mandate_id: "mdt_stripe_body_abort" } }));
      }
      if (call.method === "POST" && call.path === "/v1/payment_intents") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body stream aborted"));
            },
          }),
          { status: 200, headers: { "request-id": "req_test_body" } },
        );
      }
      return json({}, 500);
    },
  });
  const bodyFailed = await bodyAborted.stripe.payWithSpt(bodyAborted.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(bodyFailed.ok, false);
  if (!bodyFailed.ok) assert.equal(bodyFailed.code, "payment_unconfirmed");
  assert.equal(bodyAborted.rail.store.spent(bodyAborted.mandate.id).settledMicros, 600_000);
});

test("the PaymentIntent carries the reservation id as its Idempotency-Key", async () => {
  const stack = await makeStack({ id: "mdt_stripe_idem" });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  const call = stack.fake.calls.find((c) => c.path === "/v1/payment_intents");
  assert.ok(call);
  assert.equal(call.headers["idempotency-key"], paid.reservationId);
  assert.equal(call.headers["stripe-version"], "2026-09-30.preview");
  assert.match(call.headers.authorization ?? "", /^Basic /);
  assert.equal(call.form.get("payment_method_data[shared_payment_granted_token]"), SPT);
  assert.equal(call.form.get("metadata[tapvow_reservation_id]"), paid.reservationId);
  assert.equal(call.form.get("amount"), "60");
  assert.equal(call.form.get("currency"), "usd");
  assert.equal(call.form.get("confirm"), "true");
});

test("the payee allowlist checks the Stripe account id, not the token profile", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_payee",
    token: token({ agent_details: { network_business_profile: "profile_test_unknown" } }),
    mandate: {
      allowed_payees: [
        { rail: "llm", id: "openai" },
        { rail: "stripe_spt", id: "acct_a_different_account" },
      ],
    },
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) {
    assert.equal(paid.code, "payee_not_allowed");
    assert.match(paid.reason, new RegExp(ACCOUNT));
  }
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
});

test("a token bound to another mandate is refused with token_not_bound", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_bound",
    token: token({ shared_metadata: { tapvow_mandate_id: "mdt_someone_else" } }),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "token_not_bound");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
});

test("a token bound to another agent is refused with token_not_bound", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_bound_agent",
    token: token({ shared_metadata: { tapvow_agent_id: "agent-other" } }),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "token_not_bound");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
});

test("a token with no shared_metadata at all is refused with token_not_bound", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_no_metadata",
    fetchHandler: (call) => {
      if (call.path === "/v1/balance") return balance(false);
      if (call.path === "/v1/account") return account();
      if (call.method === "GET" && call.path.startsWith("/v1/shared_payment/granted_tokens/")) {
        return json(token({ shared_metadata: null }));
      }
      return json({}, 400);
    },
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "token_not_bound");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
});

test("an agent key for another mandate is refused with mandate_mismatch", async () => {
  const stack = await makeStack({ id: "mdt_stripe_mandate_check" });
  const paid = await stack.stripe.payWithSpt(
    { agentId: "agent-01", mandateId: "mdt_some_other_mandate" },
    { sptId: SPT, amountCents: 60, currency: "usd" },
  );
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "mandate_mismatch");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
});

test("a mandate without the stripe_spt rail is blocked with rail_not_allowed", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_no_rail",
    mandate: {
      rails: ["llm"],
      allowed_payees: [{ rail: "llm", id: "openai" }],
      budget: { total: "5.00", period: "lifetime" },
      per_call_cap: "1.00",
      approval_threshold: "1.00",
    },
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "rail_not_allowed");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  const blocked = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.blocked");
  assert.ok(blocked);
  assert.equal((blocked.payload as { code: string }).code, "rail_not_allowed");
});

test("recordDeactivation appends the signed deactivation entry", async () => {
  const stack = await makeStack({ id: "mdt_stripe_deactivated" });
  stack.stripe.recordDeactivation({
    sptId: SPT,
    deactivatedReason: "revoked",
    deactivatedAt: 1792385312,
    eventId: "evt_test_1",
    source: "event",
  });
  const entry = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.deactivated");
  assert.ok(entry);
  assert.deepEqual(entry.payload, {
    spt_id: SPT,
    deactivated_reason: "revoked",
    deactivated_at: 1792385312,
    event_id: "evt_test_1",
    source: "event",
  });
  stack.stripe.recordDeactivation({
    sptId: SPT,
    deactivatedReason: "consumed",
    deactivatedAt: 1792385400,
    source: "retrieve",
  });
  const latest = stack.rail.ledger.entries().filter((e) => e.kind === "stripe_spt.deactivated").at(-1);
  assert.ok(latest);
  assert.equal((latest.payload as { event_id: string | null }).event_id, null);

  const deactivated = () => stack.rail.ledger.entries().filter((e) => e.kind === "stripe_spt.deactivated");
  const beforeReplay = deactivated().length;
  const replay = stack.stripe.recordDeactivation({
    sptId: SPT,
    deactivatedReason: "revoked",
    deactivatedAt: 1792385312,
    eventId: "evt_test_1",
    source: "event",
  });
  assert.equal(replay.seq, entry.seq, "a replayed event id returns the first entry");
  assert.equal(deactivated().length, beforeReplay, "a replayed event id signs nothing new");
  assert.ok(stack.rail.ledger.verify(stack.rail.trustedLedgerKeys).ok);
});

test("approval: an approved SPT call settles, a denied one signs only the blocked entry", async () => {
  for (const decision of ["approved", "denied"] as const) {
    const calls: string[] = [];
    const approver: StripeSptApprover = {
      async request(req) {
        calls.push(`${req.rail}:${req.payee}:${req.amountMicros}`);
        return { decision, requestId: "apr_stripe_1", decidedBy: "mike" };
      },
    };
    const stack = await makeStack({
      id: `mdt_stripe_approval_${decision}`,
      mandate: { approval_threshold: "0.01" },
      approver,
    });
    const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `stripe_spt:${ACCOUNT}:600000`);
    if (decision === "approved") {
      assert.equal(paid.ok, true);
      assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
    } else {
      assert.equal(paid.ok, false);
      if (!paid.ok) assert.equal(paid.code, "approval_denied");
      assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
      assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
      const entries = stack.rail.ledger.entries();
      const blocked = entries.filter((e) => e.kind === "stripe_spt.blocked");
      assert.equal(blocked.length, 1);
      assert.equal((blocked[0]!.payload as { code: string }).code, "approval_denied");
      assert.equal(entries.filter((e) => e.kind === "stripe_spt.settle").length, 0);
    }
  }
});

test("a 4xx error body containing the key is redacted before it reaches the ledger", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_redact",
    paymentIntent: () =>
      json(
        {
          error: {
            type: "invalid_request_error",
            code: "card_declined",
            message: `declined using ${FAKE_KEY}`,
          },
        },
        402,
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) {
    assert.ok(!paid.reason.includes(FAKE_KEY));
    assert.match(paid.reason, /\[REDACTED\]/);
  }
  assert.ok(!JSON.stringify(stack.rail.ledger.entries()).includes(FAKE_KEY));
});

test("a missing token retrieval is blocked without moving money", async () => {
  const stack = await makeStack({ id: "mdt_stripe_missing", token: null });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "token_retrieve_failed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
});

test("the seller label is a display detail, never the payee id", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_seller_label",
    token: token({ agent_details: null }),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, true);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as {
    payee: string;
    details: { seller_label: string; agent_profile: string | null };
  };
  assert.equal(payload.payee, ACCOUNT);
  assert.equal(payload.details.seller_label, SELLER);
  assert.equal(payload.details.agent_profile, null);
});

test("a payment in a currency other than the mandate currency is refused before Stripe", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_gbp",
    token: token({ usage_limits: { currency: "gbp", expires_at: 4_102_444_800, max_amount: 100 } }),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "gbp" });
  assert.equal(paid.ok, false);
  if (!paid.ok) {
    assert.equal(paid.code, "currency_not_allowed");
    assert.match(paid.reason, /USD/);
    assert.match(paid.reason, /gbp/);
  }
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
  assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
});

test("a 4xx with a string error.payment_intent charges full", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_4xx_string_pi",
    paymentIntent: () =>
      json(
        {
          error: {
            type: "invalid_request_error",
            code: "payment_intent_unexpected_state",
            message: "unexpected state",
            payment_intent: "pi_unexpanded",
          },
        },
        402,
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; details: { reason: string } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.reason, "unparsed_payment_intent");
});

test("a 4xx with a processing error.payment_intent charges full", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_4xx_processing",
    paymentIntent: (call) =>
      json(
        {
          error: {
            type: "invalid_request_error",
            code: "payment_intent_processing",
            message: "processing",
            payment_intent: paymentIntent({
              status: "processing",
              metadata: { tapvow_reservation_id: call.form.get("metadata[tapvow_reservation_id]") },
            }),
          },
        },
        402,
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; details: { reason: string } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.reason, "payment_intent_unconfirmed");
});

test("a 4xx with a succeeded error.payment_intent settles", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_4xx_succeeded",
    paymentIntent: (call) =>
      json(
        {
          error: {
            type: "invalid_request_error",
            code: "payment_intent_succeeded",
            message: "succeeded",
            payment_intent: paymentIntent({
              metadata: { tapvow_reservation_id: call.form.get("metadata[tapvow_reservation_id]") },
            }),
          },
        },
        402,
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, true);
  assert.equal(paid.chargedMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  assert.equal((settle.payload as { outcome: string }).outcome, "settled");
});

test("a 2xx PaymentIntent that is not settled charges full", async () => {
  for (const status of ["requires_action", "processing"] as const) {
    const stack = await makeStack({
      id: `mdt_stripe_2xx_${status}`,
      paymentIntent: (call) =>
        json(
          paymentIntent({
            status,
            amount_received: 0,
            metadata: { tapvow_reservation_id: call.form.get("metadata[tapvow_reservation_id]") },
          }),
        ),
    });
    const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
    assert.equal(paid.ok, false);
    if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
    assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
    const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
    assert.ok(settle);
    assert.equal((settle.payload as { outcome: string }).outcome, "charged_full");
  }
});

test("a succeeded PaymentIntent in another currency is charged full", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_pi_currency",
    paymentIntent: (call) =>
      json(
        paymentIntent({
          currency: "eur",
          metadata: { tapvow_reservation_id: call.form.get("metadata[tapvow_reservation_id]") },
        }),
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; details: { reason: string; currency: string } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.reason, "currency_mismatch");
  assert.equal(payload.details.currency, "eur");
});

test("rail blocks are capped at 1000 per agent per day plus one marker", async () => {
  const stack = await makeStack({ id: "mdt_stripe_block_cap" });
  for (let i = 0; i < 1005; i++) {
    const paid = await stack.stripe.payWithSpt(stack.auth, {
      sptId: "not-an-spt",
      amountCents: 60,
      currency: "usd",
    });
    assert.equal(paid.ok, false);
  }
  const entries = stack.rail.ledger.entries();
  assert.equal(entries.filter((e) => e.kind === "stripe_spt.blocked").length, 1000);
  assert.equal(entries.filter((e) => e.kind === "stripe_spt.blocks_capped").length, 1);
  const first = entries.find((e) => e.kind === "stripe_spt.blocked");
  assert.ok(first);
  const payload = first.payload as { spt_id: string | null; spt_id_length: number };
  assert.equal(payload.spt_id, null);
  assert.equal(payload.spt_id_length, "not-an-spt".length);
});

test("a block never signs an unbounded currency or agent id", async () => {
  const stack = await makeStack({ id: "mdt_stripe_block_bounds" });
  const longCurrency = "x".repeat(100_000);
  const paid = await stack.stripe.payWithSpt(stack.auth, {
    sptId: "not-an-spt",
    amountCents: 60,
    currency: longCurrency,
  });
  assert.equal(paid.ok, false);
  const blocked = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.blocked");
  assert.ok(blocked);
  const payload = blocked.payload as { currency: string | null; currency_length: number };
  assert.equal(payload.currency, null);
  assert.equal(payload.currency_length, longCurrency.length);
  assert.ok(Buffer.byteLength(JSON.stringify(blocked.payload), "utf8") < 1024, "the signed payload stays under 1 KB");

  const longAgent = "a".repeat(200);
  const paid2 = await stack.stripe.payWithSpt(
    { agentId: longAgent, mandateId: stack.mandate.id },
    { sptId: "not-an-spt", amountCents: 60, currency: "usd" },
  );
  assert.equal(paid2.ok, false);
  if (!paid2.ok) assert.equal(paid2.code, "invalid_request");
  const blocked2 = stack.rail.ledger.entries().filter((e) => e.kind === "stripe_spt.blocked").at(-1);
  assert.ok(blocked2);
  const payload2 = blocked2.payload as { agent_id: string; agent_id_length: number };
  assert.equal(payload2.agent_id, "<invalid>");
  assert.equal(payload2.agent_id_length, longAgent.length);
  assert.ok(Buffer.byteLength(JSON.stringify(blocked2.payload), "utf8") < 1024, "the signed payload stays under 1 KB");
});

test("a non-string agent id is invalid_request, not a throw, and signs one blocked entry", async () => {
  const stack = await makeStack({ id: "mdt_stripe_nostring_agent" });
  const paid = await stack.stripe.payWithSpt(
    { agentId: undefined as unknown as string, mandateId: stack.mandate.id },
    { sptId: SPT, amountCents: 60, currency: "usd" },
  );
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "invalid_request");
  const blocked = stack.rail.ledger.entries().filter((e) => e.kind === "stripe_spt.blocked");
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0]!.payload as { agent_id: string }).agent_id, "<invalid>");
  assert.equal(stack.fake.calls.filter((c) => c.path === "/v1/payment_intents").length, 0);
});

test("recordDeactivation returns the first entry for a repeated event id", async () => {
  const stack = await makeStack({ id: "mdt_stripe_deactivation_dedupe" });
  const first = stack.stripe.recordDeactivation({
    sptId: SPT,
    deactivatedReason: "revoked",
    deactivatedAt: 1792385312,
    eventId: "evt_dedupe",
    source: "event",
  });
  const second = stack.stripe.recordDeactivation({
    sptId: SPT,
    deactivatedReason: "expired",
    deactivatedAt: 1792385400,
    eventId: "evt_dedupe",
    source: "retrieve",
  });
  assert.equal(second.seq, first.seq);
  assert.deepEqual(second.payload, first.payload);
  assert.equal(stack.rail.ledger.entries().filter((e) => e.kind === "stripe_spt.deactivated").length, 1);
});

test("recordDeactivation rejects a 100000-character event id and signs nothing", async () => {
  const stack = await makeStack({ id: "mdt_stripe_deactivation_long_event" });
  const before = stack.rail.ledger.entries().length;
  assert.throws(
    () =>
      stack.stripe.recordDeactivation({
        sptId: SPT,
        deactivatedReason: "revoked",
        deactivatedAt: 1792385312,
        eventId: "e".repeat(100_000),
        source: "event",
      }),
    /eventId must be a string of 1 to 255 characters/,
  );
  assert.equal(stack.rail.ledger.entries().length, before, "an invalid event id signs no deactivation entry");
});

test("a succeeded PaymentIntent with livemode true is charged full", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_pi_livemode",
    paymentIntent: (call) =>
      json(
        paymentIntent({
          livemode: true,
          metadata: { tapvow_reservation_id: call.form.get("metadata[tapvow_reservation_id]") },
        }),
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; details: { reason: string } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.reason, "payment_intent_mismatch");
});

test("a succeeded PaymentIntent bound to another reservation is charged full", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_pi_reservation",
    paymentIntent: () => json(paymentIntent({ metadata: { tapvow_reservation_id: "res_somewhere_else" } })),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; details: { reason: string } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.reason, "payment_intent_mismatch");
});

test("a succeeded PaymentIntent with a different amount is charged full", async () => {
  const stack = await makeStack({
    id: "mdt_stripe_pi_amount",
    paymentIntent: (call) =>
      json(
        paymentIntent({
          amount: 61,
          amount_received: 61,
          metadata: { tapvow_reservation_id: call.form.get("metadata[tapvow_reservation_id]") },
        }),
      ),
  });
  const paid = await stack.stripe.payWithSpt(stack.auth, { sptId: SPT, amountCents: 60, currency: "usd" });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.code, "payment_unconfirmed");
  assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 600_000);
  const settle = stack.rail.ledger.entries().find((e) => e.kind === "stripe_spt.settle");
  assert.ok(settle);
  const payload = settle.payload as { outcome: string; details: { reason: string } };
  assert.equal(payload.outcome, "charged_full");
  assert.equal(payload.details.reason, "payment_intent_mismatch");
});
