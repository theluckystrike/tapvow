import { afterEach, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { reconcileSvm, releaseSvmBooking } from "../src/reconcile.js";
import type { GovernedRail } from "@mandate/llm-rail";
import type { TransferFacts } from "../src/types.js";
import {
  baseMandate,
  FakeChain,
  NETWORK,
  openTestRail,
  PAYEE,
  signTestMandate,
  signature,
  tmpDir,
  USDC_MINT,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openRail(): GovernedRail {
  const dir = tmpDir();
  dirs.push(dir);
  const { issuer, signed } = signTestMandate(baseMandate());
  return openTestRail(join(dir, "rail.db"), signed, issuer.publicKey).rail;
}

function details(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: NETWORK,
    asset: USDC_MINT,
    pay_to: PAYEE,
    amount_atomic: "10000",
    payer: "4pfvnqqv8wSp6BjCSu59siFZCnTwa3ZTkmFNpb5Y77PQ",
    unconfirmed: true,
    ...overrides,
  };
}

function bookChargeFull(rail: GovernedRail, extra: Record<string, unknown> = {}): string {
  const reserved = rail.store.reserve({
    mandateId: rail.mandate.id,
    agentId: "agent-01",
    model: `x402:${NETWORK}:${USDC_MINT}`,
    provider: PAYEE,
    amountMicros: 10_000,
    rail: "x402",
    payeeVerifiedBy: "allowlist",
  });
  if (!reserved.ok) throw new Error(reserved.reason);
  rail.store.chargeFull(reserved.reservationId, details(extra));
  return reserved.reservationId;
}

function transfer(chain: FakeChain, sig: string): void {
  chain.record(sig, {
    network: NETWORK,
    mint: USDC_MINT,
    payTo: PAYEE,
    amountAtomic: "10000",
    payer: "4pfvnqqv8wSp6BjCSu59siFZCnTwa3ZTkmFNpb5Y77PQ",
  });
}

describe("reconcileSvm", () => {
  test("a confirmed matching signature settles the charged_full booking", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(9);
    transfer(chain, sig);
    const id = bookChargeFull(rail, { tx_signature: sig });

    const report = await reconcileSvm(rail, chain);

    expect(report.results).toEqual([{ reservationId: id, result: "settled", signature: sig }]);
    expect(report.confirmedMicros).toBe(10_000);
    const settled = rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    expect((settled[0]!.payload as any).details.settlement_verified).toBe(true);
  });

  test("a failed transaction releases the booking", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(10);
    chain.record(
      sig,
      {
        network: NETWORK,
        mint: USDC_MINT,
        payTo: PAYEE,
        amountAtomic: "10000",
        payer: "4pfvnqqv8wSp6BjCSu59siFZCnTwa3ZTkmFNpb5Y77PQ",
      },
      "failed",
      false,
    );
    const id = bookChargeFull(rail, { tx_signature: sig });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]?.result).toBe("released");
    expect(report.releasedMicros).toBe(10_000);
    const released = rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released");
    expect(released).toHaveLength(1);
    expect((released[0]!.payload as any).charged_micros).toBe(0);
  });

  test("an RPC error leaves the booking untouched", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    chain.verifyError = new Error("getTransaction timed out after 15000 ms");
    const id = bookChargeFull(rail, { tx_signature: signature(11) });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]?.result).toBe("error");
    expect(report.results[0]?.reservationId).toBe(id);
    expect(
      rail.ledger.entries().filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled"),
    ).toHaveLength(0);
    expect(
      rail.ledger.entries().filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released"),
    ).toHaveLength(0);
  });

  test("one throwing chain read does not abort the whole pass", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    chain.verifyThrow = new Error("the chain object threw");
    const first = bookChargeFull(rail, { tx_signature: signature(21) });
    const second = bookChargeFull(rail, { tx_signature: signature(22) });

    const report = await reconcileSvm(rail, chain);

    expect(report.results).toHaveLength(2);
    expect(report.results.map((result) => result.reservationId).sort()).toEqual([first, second].sort());
    expect(report.results.every((result) => result.result === "error")).toBe(true);
    expect(report.releasedMicros).toBe(0);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(20_000);
  });

  test("a signature already settled for another reservation releases the replay", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(12);
    transfer(chain, sig);

    const first = rail.store.reserve({
      mandateId: rail.mandate.id,
      agentId: "agent-01",
      model: `x402:${NETWORK}:${USDC_MINT}`,
      provider: PAYEE,
      amountMicros: 10_000,
      rail: "x402",
      payeeVerifiedBy: "allowlist",
    });
    if (!first.ok) throw new Error(first.reason);
    rail.store.settle(first.reservationId, null, 10_000, details({ tx_signature: sig, unconfirmed: false }));

    const id = bookChargeFull(rail, { tx_signature: sig });
    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "released" });
    expect(report.releasedMicros).toBe(10_000);
    const settled = rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
  });

  test("an unknown signature is found from the payer history and settled", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(13);
    transfer(chain, sig);
    const id = bookChargeFull(rail);

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toEqual({ reservationId: id, result: "settled", signature: sig });
    expect(report.confirmedMicros).toBe(10_000);
  });

  test("a still pending signature stays charged_full", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const id = bookChargeFull(rail, { tx_signature: signature(14) });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "pending" });
    expect(report.releasedMicros).toBe(0);
    expect(report.confirmedMicros).toBe(0);
  });

  test("a complete empty scan after wall-clock expiry retains the booking and budget", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const id = bookChargeFull(rail, { expires_at_ms: Date.now() - 1000 });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "pending" });
    expect(report.releasedMicros).toBe(0);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
    expect(rail.ledger.entries().filter((entry) => entry.kind === "x402.settle" &&
      (entry.payload as any).outcome === "released")).toHaveLength(0);
  });

  test("a pending signed payment after wall-clock expiry remains booked through a cluster stall", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(15);
    const id = bookChargeFull(rail, { tx_signature: sig, expires_at_ms: Date.now() - 1000 });

    const first = await reconcileSvm(rail, chain);
    expect(first.results[0]).toMatchObject({ reservationId: id, result: "pending" });
    expect(first.releasedMicros).toBe(0);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);

    // Blocks resume and the still-valid signed transaction lands. Its budget
    // was never made available for another purchase during the stall.
    transfer(chain, sig);
    const second = await reconcileSvm(rail, chain);
    expect(second.results[0]).toMatchObject({ reservationId: id, result: "settled", signature: sig });
    expect(second.confirmedMicros).toBe(10_000);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
    expect(rail.ledger.entries().filter((entry) => entry.kind === "x402.settle" &&
      (entry.payload as any).outcome === "released")).toHaveLength(0);
  });

  test("a mismatched signature after wall-clock expiry is not proof of cancellation", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(16);
    chain.record(sig, {
      network: NETWORK, mint: USDC_MINT, payTo: PAYEE, amountAtomic: "99",
      payer: "4pfvnqqv8wSp6BjCSu59siFZCnTwa3ZTkmFNpb5Y77PQ",
    });
    const id = bookChargeFull(rail, { tx_signature: sig, expires_at_ms: Date.now() - 1000 });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "mismatch" });
    expect(report.releasedMicros).toBe(0);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("a booking before its expiry stays charged_full", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const id = bookChargeFull(rail, { expires_at_ms: Date.now() + 60_000 });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "pending" });
    expect(report.releasedMicros).toBe(0);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("refuses a pass when the RPC is on another chain", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    chain.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    const id = bookChargeFull(rail, { expires_at_ms: Date.now() - 1000 });

    await expect(reconcileSvm(rail, chain)).rejects.toThrow(/does not match the configured network/);

    const row = rail.store.database
      .prepare("SELECT status, charged_micros FROM reservations WHERE id = ?")
      .get(id) as { status: string; charged_micros: number };
    expect(row.status).toBe("charged_full");
    expect(row.charged_micros).toBe(10_000);
  });

  test("the operator release command writes a signed ledger entry", async () => {
    const rail = openRail();
    const id = bookChargeFull(rail);

    const result = releaseSvmBooking(rail, id, {
      operator: "ops@tapvow.example",
      note: "the facilitator never submitted the transaction",
      now: () => 1_760_000_000_000,
    });

    expect(result).toEqual({ reservationId: id, releasedMicros: 10_000 });
    const row = rail.store.database
      .prepare("SELECT status, charged_micros FROM reservations WHERE id = ?")
      .get(id) as { status: string; charged_micros: number };
    expect(row.status).toBe("released");
    expect(row.charged_micros).toBe(0);
    const released = rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "released");
    expect(released).toHaveLength(1);
    expect((released[0]!.payload as any).details.reason).toBe("operator_release");
    expect((released[0]!.payload as any).details.operator).toBe("ops@tapvow.example");
    expect((released[0]!.payload as any).details.released_at_ms).toBe(1_760_000_000_000);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(0);
  });

  test("the operator release command refuses a booking that is not charged_full", async () => {
    const rail = openRail();
    const id = bookChargeFull(rail);
    releaseSvmBooking(rail, id, { operator: "ops@tapvow.example" });

    expect(() => releaseSvmBooking(rail, id, { operator: "ops@tapvow.example" })).toThrow(/released/);
  });

  test("an incomplete payer history scan never releases an expired booking", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    chain.findIncomplete = { capped: true, timedOut: false };
    const id = bookChargeFull(rail, { expires_at_ms: Date.now() - 1000 });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "error" });
    expect(report.releasedMicros).toBe(0);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
    const row = rail.store.database
      .prepare("SELECT status, charged_micros FROM reservations WHERE id = ?")
      .get(id) as { status: string; charged_micros: number };
    expect(row.status).toBe("charged_full");
    expect(row.charged_micros).toBe(10_000);
  });

  test("a timed out payer history scan never releases an expired booking", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    chain.findIncomplete = { capped: false, timedOut: true };
    const id = bookChargeFull(rail, { expires_at_ms: Date.now() - 1000 });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "error" });
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("an unreadable result at expiry keeps the booking charged full", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    chain.verifyError = new Error("getTransaction timed out after 15000 ms");
    const id = bookChargeFull(rail, {
      tx_signature: signature(31),
      expires_at_ms: Date.now() - 1000,
    });

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "error" });
    expect(report.releasedMicros).toBe(0);
    const row = rail.store.database
      .prepare("SELECT status, charged_micros FROM reservations WHERE id = ?")
      .get(id) as { status: string; charged_micros: number };
    expect(row.status).toBe("charged_full");
    expect(row.charged_micros).toBe(10_000);
  });

  test("a signature charged full on another reservation is treated as booked", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(32);
    transfer(chain, sig);
    const other = bookChargeFull(rail, { tx_signature: sig });
    const id = bookChargeFull(rail);

    const report = await reconcileSvm(rail, chain);

    const outcome = report.results.find((result) => result.reservationId === id);
    expect(outcome).toMatchObject({ reservationId: id, result: "released" });
    expect(report.releasedMicros).toBe(10_000);
    const otherRow = rail.store.database
      .prepare("SELECT status FROM reservations WHERE id = ?")
      .get(other) as { status: string };
    // The first booking keeps the one transfer; the second is released.
    expect(otherRow.status).toBe("settled");
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("a live settle that wins the claim makes reconcile release its booking", async () => {
    const rail = openRail();
    const base = new FakeChain();
    const sig = signature(33);
    transfer(base, sig);
    const id = bookChargeFull(rail, { expires_at_ms: Date.now() + 60_000 });

    // Between the reconcile pre-check and the settle, a live retry settles the
    // same on-chain signature. The atomic claim must let exactly one win.
    const racing: FakeChain = base;
    const original = racing.verifyTransfer.bind(racing);
    racing.verifyTransfer = async (signatureValue: string, facts: TransferFacts) => {
      const reserved = rail.store.reserve({
        mandateId: rail.mandate.id,
        agentId: "agent-01",
        model: `x402:${NETWORK}:${USDC_MINT}`,
        provider: PAYEE,
        amountMicros: 10_000,
        rail: "x402",
        payeeVerifiedBy: "allowlist",
      });
      if (!reserved.ok) throw new Error(reserved.reason);
      const event = rail.store.settleClaimed(
        reserved.reservationId,
        null,
        10_000,
        { tx_signature: signatureValue, settlement_verified: true },
        { mandateId: rail.mandate.id, txSignature: signatureValue },
      );
      expect(event).not.toBeNull();
      return original(signatureValue, facts);
    };

    const report = await reconcileSvm(rail, racing);

    expect(report.results[0]).toMatchObject({ reservationId: id, result: "released" });
    expect(report.releasedMicros).toBe(10_000);
    expect(report.confirmedMicros).toBe(0);
    const settled = rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    // The live settle booked its own 10,000. The reconcile booking is released,
    // so the one transfer is never counted twice.
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("a swept abandoned x402 booking keeps its facts and can reconcile", async () => {
    const rail = openRail();
    const chain = new FakeChain();
    const sig = signature(34);
    transfer(chain, sig);
    const reserved = rail.store.reserve({
      mandateId: rail.mandate.id,
      agentId: "agent-01",
      model: `x402:${NETWORK}:${USDC_MINT}`,
      provider: PAYEE,
      amountMicros: 10_000,
      rail: "x402",
      payeeVerifiedBy: "allowlist",
      bookingDetails: details({ expires_at_ms: Date.now() + 60_000 }),
    });
    if (!reserved.ok) throw new Error(reserved.reason);

    const swept = rail.store.sweepStale(-1);
    expect(swept).toHaveLength(1);
    expect(swept[0]!.outcome).toBe("charged_full");
    expect((swept[0]!.details as any).payer).toBe("4pfvnqqv8wSp6BjCSu59siFZCnTwa3ZTkmFNpb5Y77PQ");

    const report = await reconcileSvm(rail, chain);

    expect(report.results[0]).toMatchObject({ reservationId: reserved.reservationId, result: "settled" });
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(10_000);
  });

  test("the signature claim is per mandate, so another mandate can book the same signature", () => {
    const rail = openRail();
    const sig = signature(35);
    const policy = rail.store.getPolicy(rail.mandate.id);
    if (!policy) throw new Error("policy missing");
    const otherMandateId = "mdt_svm_other_0002";
    rail.store.upsertMandate({ ...policy, mandateId: otherMandateId });

    const first = rail.store.reserve({
      mandateId: rail.mandate.id,
      agentId: "agent-01",
      model: `x402:${NETWORK}:${USDC_MINT}`,
      provider: PAYEE,
      amountMicros: 10_000,
      rail: "x402",
      payeeVerifiedBy: "allowlist",
    });
    const second = rail.store.reserve({
      mandateId: otherMandateId,
      agentId: "agent-01",
      model: `x402:${NETWORK}:${USDC_MINT}`,
      provider: PAYEE,
      amountMicros: 10_000,
      rail: "x402",
      payeeVerifiedBy: "allowlist",
    });
    if (!first.ok || !second.ok) throw new Error("reserve failed");

    const a = rail.store.settleClaimed(
      first.reservationId,
      null,
      10_000,
      { tx_signature: sig },
      { mandateId: rail.mandate.id, txSignature: sig },
    );
    const b = rail.store.settleClaimed(
      second.reservationId,
      null,
      10_000,
      { tx_signature: sig },
      { mandateId: otherMandateId, txSignature: sig },
    );

    // F9 boundary. Uniqueness is (mandate_id, tx_signature), not the signature
    // alone. One database per mandate is the deployment answer.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});
