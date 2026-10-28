import { afterEach, describe, expect, test, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { TransactionSigner } from "@solana/kit";
import { generateSigner } from "@mandate/core";
import { openGovernedRail } from "@mandate/llm-rail";
import { createSvmPaymentGuard } from "../src/guard.js";
import { assertAcceptedMatchesRequirements, createSvmRail } from "../src/rail.js";
import { reconcileSvm } from "../src/reconcile.js";
import type { Approver, TransferFacts } from "../src/types.js";
import {
  baseMandate,
  EXPLORER,
  FakeChain,
  fakeScheme,
  fakeSeller,
  NETWORK,
  openTestRail,
  OTHER_PAYEE,
  PAYEE,
  requirements,
  reservationStatus,
  signTestMandate,
  signature,
  testSigner,
  tmpDir,
  USDC_MINT,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface SetupOptions {
  amount?: string;
  payTo?: string;
  mandate?: Parameters<typeof baseMandate>[0];
  approver?: Approver;
  facilitatorError?: boolean;
  settleSignature?: string;
  genesisHash?: string;
  maxResponseBytes?: number;
  responseBody?: string;
  redirectTo?: string;
  /** Database file to share with a second rail. Defaults to a fresh file per setup. */
  dbPath?: string;
}

async function setup(options: SetupOptions = {}) {
  const dir = tmpDir();
  dirs.push(dir);
  const payer: TransactionSigner = await testSigner();
  const chain = new FakeChain();
  if (options.genesisHash) chain.genesisHash = options.genesisHash;
  const { issuer, signed } = signTestMandate(baseMandate(options.mandate));
  const { rail } = openTestRail(options.dbPath ?? join(dir, "rail.db"), signed, issuer.publicKey);
  const requirement = requirements({
    ...(options.amount ? { amount: options.amount } : {}),
    ...(options.payTo ? { payTo: options.payTo } : {}),
  });
  const settleSignature = options.settleSignature ?? signature();
  const fetch = fakeSeller({
    requirement,
    settle: { success: true, transaction: settleSignature, network: NETWORK },
    ...(options.facilitatorError ? { facilitatorError: true } : {}),
    ...(options.responseBody !== undefined ? { body: options.responseBody } : {}),
    ...(options.redirectTo ? { redirectTo: options.redirectTo } : {}),
  });
  const svm = createSvmRail({
    rail,
    signer: payer,
    networks: [NETWORK],
    guard: createSvmPaymentGuard({ rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 }),
    chain,
    scheme: () => fakeScheme(payer),
    fetch,
    allowPrivateNetwork: true,
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.approver ? { approver: options.approver } : {}),
  });
  const call = () =>
    svm.pay(
      { agentId: "agent-01", mandateId: rail.mandate.id },
      { url: "http://127.0.0.1:9/policy-check" },
    );
  const facts = (): TransferFacts => ({
    network: requirement.network,
    mint: requirement.asset,
    payTo: requirement.payTo,
    amountAtomic: requirement.amount,
    payer: payer.address,
  });
  return { rail, chain, payer, requirement, settleSignature, call, facts, dir };
}

describe("SVM rail payment guard", () => {
  test("success books the payment, settles the hold and moves the balance once", async () => {
    const s = await setup();
    const before = s.chain.balance;
    s.chain.record(s.settleSignature, s.facts());

    const result = await s.call();

    expect(result.status).toBe(200);
    expect(result.headers["X-Mandate-Rail"]).toBe("x402-svm");
    expect(result.headers["X-Mandate-Tx-Signature"]).toBe(s.settleSignature);
    expect(s.chain.balance).toBe(before - 10_000n);
    expect(reservationStatus(s.rail, 10_000)).toBe("settled");
    const settles = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settles).toHaveLength(1);
    expect((settles[0]!.payload as any).details.tx_signature).toBe(s.settleSignature);
    expect((settles[0]!.payload as any).details.settlement_verified).toBe(true);
    expect(EXPLORER + s.settleSignature).toContain(s.settleSignature);
  });

  test("a blocked payee is refused before any signature and no money moves", async () => {
    const s = await setup({ payTo: OTHER_PAYEE });
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe("payee_not_allowed");
    expect(s.chain.balance).toBe(before);
    expect(s.chain.transfers.size).toBe(0);
    expect(reservationStatus(s.rail, 10_000)).toBeNull();
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.svm.blocked")).toBe(true);
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.settle")).toBe(false);
  });

  test("the per-call cap is refused and no money moves", async () => {
    const s = await setup({
      amount: "2000000",
      mandate: { per_call_cap: "1.00", budget: { total: "5.00", period: "lifetime" } },
    });
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(402);
    expect(JSON.parse(result.body).error.code).toBe("per_call_cap");
    expect(s.chain.balance).toBe(before);
    expect(s.chain.transfers.size).toBe(0);
    expect(reservationStatus(s.rail, 2_000_000)).toBeNull();
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.settle")).toBe(false);
  });

  test("an approval timeout releases the hold and no money moves", async () => {
    const approver: Approver = {
      async request() {
        return { decision: "timeout", requestId: "req_timeout_0001" };
      },
    };
    const s = await setup({
      amount: "2000000",
      mandate: { per_call_cap: "5.00", approval_threshold: "1.00" },
      approver,
    });
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe("approval_timeout");
    expect(s.chain.balance).toBe(before);
    expect(s.chain.transfers.size).toBe(0);
    expect(reservationStatus(s.rail, 2_000_000)).toBe("released");
    const released = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released");
    expect(released).toHaveLength(1);
    expect((released[0]!.payload as any).charged_micros).toBe(0);
  });

  test("a facilitator error after signing books the full amount as unconfirmed", async () => {
    const s = await setup({ facilitatorError: true });
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(502);
    expect(JSON.parse(result.body).error.type).toBe("mandate_unconfirmed");
    expect(JSON.parse(result.body).error.code).toBe("facilitator_error");
    expect(s.chain.balance).toBe(before);
    expect(s.chain.transfers.size).toBe(0);
    expect(reservationStatus(s.rail, 10_000)).toBe("charged_full");
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(10_000);
    const booked = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "charged_full");
    expect(booked).toHaveLength(1);
    expect((booked[0]!.payload as any).details.unconfirmed).toBe(true);
    expect((booked[0]!.payload as any).details.unconfirmed_reason).toBe("facilitator_error");
    expect(typeof (booked[0]!.payload as any).details.expires_at_ms).toBe("number");
  });

  test("delayed approval cannot make a freshly signed unknown payment look expired", async () => {
    const started = Date.now();
    let clock = started;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const approver: Approver = {
      async request() {
        // Approval returns after the old bookingAt + 300s + 150s deadline.
        // x402 creates the signed payment only after this hook returns.
        clock = started + 600_000;
        return { decision: "approved", requestId: "req_delayed_approval" };
      },
    };
    const s = await setup({
      amount: "2000000", mandate: { per_call_cap: "5.00", approval_threshold: "1.00" },
      approver, facilitatorError: true,
    });
    const result = await s.call();
    expect(result.status).toBe(502);
    expect(reservationStatus(s.rail, 2_000_000)).toBe("charged_full");
    const booked = s.rail.ledger.entries().find((entry) => entry.kind === "x402.settle" &&
      (entry.payload as any).outcome === "charged_full");
    expect((booked!.payload as any).details.expires_at_ms).toBeLessThan(clock);

    const uncertain = await reconcileSvm(s.rail, s.chain);
    expect(uncertain.results[0]?.result).toBe("pending");
    expect(uncertain.releasedMicros).toBe(0);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(2_000_000);

    // The signature can still land after signing. Reconcile books it exactly
    // once instead of silently forgetting a payment whose hold was released.
    s.chain.record(s.settleSignature, s.facts());
    const landed = await reconcileSvm(s.rail, s.chain);
    expect(landed.results[0]?.result).toBe("settled");
    expect(landed.confirmedMicros).toBe(2_000_000);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(2_000_000);
  });

  test("a transfer that lands after a facilitator error settles the one unconfirmed booking", async () => {
    const s = await setup({ facilitatorError: true });
    const before = s.chain.balance;

    const first = await s.call();
    expect(first.status).toBe(502);
    expect(reservationStatus(s.rail, 10_000)).toBe("charged_full");
    expect(s.chain.balance).toBe(before);

    // The seller submits the signed transaction after the error response.
    s.chain.record(s.settleSignature, s.facts(), "success", true, Date.now() - 1_000);
    const report = await reconcileSvm(s.rail, s.chain);

    expect(report.results[0]).toMatchObject({ result: "settled", signature: s.settleSignature });
    expect(s.chain.balance).toBe(before - 10_000n);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(10_000);
    const settled = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
  });

  test("a redirect after signing books the full amount as unconfirmed and keeps no release", async () => {
    const s = await setup({ redirectTo: "https://seller.example/moved" });
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(502);
    expect(JSON.parse(result.body).error.code).toBe("redirect_after_signing");
    expect(s.chain.balance).toBe(before);
    expect(reservationStatus(s.rail, 10_000)).toBe("charged_full");
    expect(
      s.rail.ledger
        .entries()
        .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released"),
    ).toHaveLength(0);
    const booked = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "charged_full");
    expect((booked[0]!.payload as any).details.unconfirmed_reason).toBe("redirect_after_signing");
  });

  test("a capped history scan after signing charges full instead of releasing", async () => {
    const s = await setup({ facilitatorError: true });
    const before = s.chain.balance;
    s.chain.findIncomplete = { capped: true, timedOut: false };

    const result = await s.call();

    expect(result.status).toBe(502);
    expect(JSON.parse(result.body).error.code).toBe("history_scan_incomplete");
    expect(s.chain.balance).toBe(before);
    expect(reservationStatus(s.rail, 10_000)).toBe("charged_full");
    const booked = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "charged_full");
    expect((booked[0]!.payload as any).details.scan_capped).toBe(true);
    expect(
      s.rail.ledger
        .entries()
        .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released"),
    ).toHaveLength(0);
  });

  test("an RPC timeout before signing refuses the call and no money moves", async () => {
    const s = await setup();
    s.chain.preflightError = new Error("getLatestBlockhash timed out after 15000 ms");
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error.code).toBe("rpc_unavailable");
    expect(s.chain.balance).toBe(before);
    expect(s.chain.transfers.size).toBe(0);
    expect(reservationStatus(s.rail, 10_000)).toBeNull();
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.settle")).toBe(false);
  });

  test("a mandate bound to one store is refused by another database", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const ledgerSigner = generateSigner("gateway-test");
    const { issuer, signed } = signTestMandate(baseMandate());
    const first = openGovernedRail({
      dbPath: join(dir, "first.db"),
      signedMandate: signed,
      trustedIssuerKey: issuer.publicKey,
      ledgerSigner: ledgerSigner.signer,
    });
    const storeId = first.store.storeId;
    first.close();

    // The old test opened a second rail with a fresh ledger key, so it failed
    // on a ledger signature mismatch and never tested the database binding.
    // The binding that holds is store_id, with one shared ledger key.
    const bound = signTestMandate(baseMandate({ store_id: storeId }));
    expect(() =>
      openGovernedRail({
        dbPath: join(dir, "second.db"),
        signedMandate: bound.signed,
        trustedIssuerKey: bound.issuer.publicKey,
        ledgerSigner: ledgerSigner.signer,
      }),
    ).toThrow(/bound to store/);
  });

  test("a replayed on-chain signature is refused and the unbound second booking stays charged", async () => {
    const s = await setup();
    const before = s.chain.balance;
    s.chain.record(s.settleSignature, s.facts());

    const first = await s.call();
    expect(first.status).toBe(200);
    expect(s.chain.balance).toBe(before - 10_000n);

    const second = await s.call();

    expect(second.status).toBe(403);
    expect(JSON.parse(second.body).error.code).toBe("replayed_signature");
    expect(s.chain.balance).toBe(before - 10_000n);
    const settled = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    const released = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released");
    expect(released).toHaveLength(0);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(20_000);
  });

  test("a replay found on the chain is refused when the facilitator sends no settlement header", async () => {
    const s = await setup({ facilitatorError: true });
    const before = s.chain.balance;
    s.chain.record(s.settleSignature, s.facts());

    const first = await s.call();
    expect(first.status).toBe(502);
    const settledAfterFirst = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settledAfterFirst).toHaveLength(1);
    expect((settledAfterFirst[0]!.payload as any).details.tx_signature_source).toBe("chain");
    expect(s.chain.balance).toBe(before - 10_000n);
    // Money moved behind a 502. The budget must show exactly that one charge.
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(10_000);

    const second = await s.call();

    expect(second.status).toBe(403);
    expect(JSON.parse(second.body).error.code).toBe("replayed_signature");
    expect(s.chain.balance).toBe(before - 10_000n);
    const settled = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(20_000);
    const released = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released");
    expect(released).toHaveLength(0);
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.settle" &&
      (entry.payload as any).outcome === "charged_full")).toBe(true);
  });

  test("a settle that stays pending past the deadline is booked unconfirmed, not released", async () => {
    const s = await setup();
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(502);
    expect(JSON.parse(result.body).error.type).toBe("mandate_unconfirmed");
    expect(s.chain.balance).toBe(before);
    expect(reservationStatus(s.rail, 10_000)).toBe("charged_full");
    const booked = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "charged_full");
    expect(booked).toHaveLength(1);
    expect((booked[0]!.payload as any).details.tx_signature).toBe(s.settleSignature);
    expect((booked[0]!.payload as any).details.unconfirmed).toBe(true);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("two concurrent settles of one signature settle exactly one", async () => {
    const s = await setup();
    const before = s.chain.balance;
    s.chain.record(s.settleSignature, s.facts());
    let release!: () => void;
    s.chain.verifyGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = s.call();
    const second = s.call();
    while (s.chain.verifyStarted < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    const [a, b] = await Promise.all([first, second]);

    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const denied = a.status === 403 ? a : b;
    expect(JSON.parse(denied.body).error.code).toBe("replayed_signature");
    expect(s.chain.balance).toBe(before - 10_000n);
    const settled = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    expect(s.rail.store.spent(s.rail.mandate.id).committedMicros).toBe(20_000);
    const released = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released");
    expect(released).toHaveLength(0);
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.settle" &&
      (entry.payload as any).outcome === "charged_full")).toBe(true);
  });

  test("a transfer older than the search window is not booked and the hold stays charged", async () => {
    const s = await setup({ facilitatorError: true });
    const before = s.chain.balance;
    s.chain.record(s.settleSignature, s.facts(), "success", false, Date.now() - 60 * 60 * 1000);

    const result = await s.call();

    expect(result.status).toBe(502);
    expect(s.chain.balance).toBe(before);
    // A completed scan that found no match is not proof of no payment after a
    // signature exists, so the booking stays charged for reconcile.
    expect(reservationStatus(s.rail, 10_000)).toBe("charged_full");
    expect(
      s.rail.ledger
        .entries()
        .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled"),
    ).toHaveLength(0);
  });

  test("the rail refuses to run when the RPC genesis hash does not match the devnet network", async () => {
    const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const s = await setup({ genesisHash: MAINNET_GENESIS_HASH });
    const before = s.chain.balance;

    const result = await s.call();

    expect(result.status).toBe(503);
    expect(JSON.parse(result.body).error.code).toBe("network_mismatch");
    expect(s.chain.balance).toBe(before);
    expect(s.chain.transfers.size).toBe(0);
    expect(reservationStatus(s.rail, 10_000)).toBeNull();
    expect(s.rail.ledger.entries().some((entry) => entry.kind === "x402.settle")).toBe(false);
  });

  test("a paid body cut by the cap is reported as truncated in the result and the ledger", async () => {
    const fullBody = "x".repeat(4096);
    const s = await setup({ maxResponseBytes: 100, responseBody: fullBody });
    s.chain.record(s.settleSignature, s.facts());

    const result = await s.call();

    expect(result.status).toBe(200);
    expect(result.headers["X-Mandate-Truncated"]).toBe(String(fullBody.length));
    expect(result.body).toHaveLength(100);
    const settled = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    const details = (settled[0]!.payload as any).details;
    expect(details.truncated).toBe(true);
    expect(details.full_bytes).toBe(fullBody.length);
    expect(details.delivered_bytes).toBe(100);
  });

  test("a paid body within the cap carries no truncation marker", async () => {
    const s = await setup({ maxResponseBytes: 4096 });
    s.chain.record(s.settleSignature, s.facts());

    const result = await s.call();

    expect(result.status).toBe(200);
    expect(result.headers["X-Mandate-Truncated"]).toBeUndefined();
    const settled = s.rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect((settled[0]!.payload as any).details.truncated).toBeUndefined();
  });

  test("a signed transaction for another payee is refused and the hold is released", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const payer = await testSigner();
    const chain = new FakeChain();
    const { issuer, signed } = signTestMandate(baseMandate());
    const { rail } = openTestRail(join(dir, "rail.db"), signed, issuer.publicKey);
    const requirement = requirements();
    const original = fakeScheme(payer);
    const badScheme = {
      ...original,
      async createPaymentPayload(version: number, req: typeof requirement) {
        const transaction = await original.createPaymentPayload(version, req);
        void transaction;
        return {
          x402Version: version,
          payload: {
            transaction: await (await import("./helpers.js")).buildPaymentTransaction({
              payer,
              mint: req.asset,
              payTo: OTHER_PAYEE,
              amountAtomic: req.amount,
              feePayer: String(req.extra.feePayer),
            }),
          },
        };
      },
    };
    const risky = createSvmRail({
      rail,
      signer: payer,
      networks: [NETWORK],
      guard: createSvmPaymentGuard({ rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 }),
      chain,
      scheme: () => badScheme,
      fetch: fakeSeller({ requirement }),
      allowPrivateNetwork: true,
    });
    const result = await risky.pay(
      { agentId: "agent-01", mandateId: rail.mandate.id },
      { url: "http://127.0.0.1:9/policy-check" },
    );

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe("signed_transaction_mismatch");
    expect(chain.balance).toBe(100_000_000n);
    expect(reservationStatus(rail, 10_000)).toBe("released");
  });
});

describe("SVM payment guard pins the mint and the payee", () => {
  test("the guard rejects an asset that is not the devnet USDC mint", async () => {
    const s = await setup();
    const guard = createSvmPaymentGuard({ rail: s.rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 });

    const result = await guard({
      resourceUrl: "https://seller.example/policy-check",
      network: NETWORK,
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: PAYEE,
      amount: "10000",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("asset_not_allowed");
  });

  test("the guard rejects a payee that differs by one character's case", async () => {
    const s = await setup();
    const guard = createSvmPaymentGuard({ rail: s.rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 });
    const caseVariant = PAYEE.replace("W", "w");
    expect(caseVariant).not.toBe(PAYEE);

    const result = await guard({
      resourceUrl: "https://seller.example/policy-check",
      network: NETWORK,
      asset: USDC_MINT,
      payTo: caseVariant,
      amount: "10000",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("payee_not_allowed");
  });
});

describe("the accepted requirement echo", () => {
  test("refuses an accepted requirement that differs from the approved one", () => {
    const approved = requirements();

    expect(() => assertAcceptedMatchesRequirements(approved, approved)).not.toThrow();
    expect(() => assertAcceptedMatchesRequirements({ ...approved, amount: "99" }, approved)).toThrow(/amount/);
    expect(() => assertAcceptedMatchesRequirements({ ...approved, payTo: OTHER_PAYEE }, approved)).toThrow(/payTo/);
    expect(() =>
      assertAcceptedMatchesRequirements({ ...approved, extra: { feePayer: PAYEE } }, approved),
    ).toThrow(/fee payer/);
  });
});
