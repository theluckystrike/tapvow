// reconcileCharged re-books a charged_full x402 reservation after the chain has
// settled the question: released (authorization expired unused) or settled
// (charged late). It writes a new signed x402.settle entry for the same
// reservation_id, so auditRail keeps the last entry and spent() follows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner, signMandate, type Mandate } from "@mandate/core";
import { openGovernedRail, auditRail, type GovernedRail } from "../src/mandate.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-reconcile-"));
  dirs.push(d);
  return d;
}

const NETWORK = "eip155:84532";
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const NONCE = `0x${"ab".repeat(32)}`;
const VALID_BEFORE = 2_000_000_000;
const AMOUNT_ATOMIC = "10000";
const MICROS = 10_000;

function openRail(): { rail: GovernedRail; trusted: Record<string, string> } {
  const issuer = generateSigner("rc-issuer");
  const ledgerSigner = generateSigner("rc-ledger");
  const mandate: Mandate = {
    mandate_version: "0.1",
    type: "IntentMandate",
    id: "mdt_reconcile_0001",
    issuer: { id: "rc-issuer", public_key: issuer.publicKey },
    agents: ["agent-01"],
    natural_language_description: "reconcile test",
    currency: "USD",
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "x402", id: `${NETWORK}:${PAY_TO}` },
    ],
    rate_limit: { max_calls: 1000, window_seconds: 60 },
    approval_threshold: "1.00",
    rails: ["llm", "x402"],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
  const signed = signMandate(mandate, issuer.signer);
  const rail = openGovernedRail({
    dbPath: join(tmp(), "rail.db"),
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: ledgerSigner.signer,
  });
  return { rail, trusted: { [ledgerSigner.signer.keyId]: ledgerSigner.publicKey } };
}

function details(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tx_hash: null,
    network: NETWORK,
    pay_to: PAY_TO,
    payer: PAYER,
    asset: ASSET,
    amount_atomic: AMOUNT_ATOMIC,
    nonce: NONCE,
    valid_before: String(VALID_BEFORE),
    unconfirmed: true,
    ...over,
  };
}

function book(rail: GovernedRail, kind: "x402" | "llm" = "x402"): string {
  const x402 = kind === "x402";
  const r = rail.store.reserve({
    mandateId: rail.mandate.id,
    agentId: "agent-01",
    model: x402 ? `x402:${NETWORK}:${ASSET}` : "gpt-4o",
    provider: x402 ? PAY_TO : "openai",
    amountMicros: MICROS,
    ...(x402 ? { rail: "x402" as const, payeeVerifiedBy: "allowlist" as const } : {}),
  });
  assert.ok(r.ok, "reserve failed");
  return r.reservationId;
}

function settlesFor(rail: GovernedRail, reservationId: string) {
  return rail.ledger
    .entries()
    .filter(
      (e) => e.kind === "x402.settle" && (e.payload as { reservation_id: string }).reservation_id === reservationId,
    );
}

test("released: audit passes, the last ledger entry is released/0, spent drops", () => {
  const { rail, trusted } = openRail();
  try {
    const rid = book(rail, "x402");
    rail.store.chargeFull(rid, details());

    const before = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
    assert.equal(before.ok, true, before.ok ? "" : before.reason);
    assert.equal(rail.store.spent(rail.mandate.id).settledMicros, MICROS);

    const ev = rail.store.reconcileCharged(
      rid,
      { outcome: "released" },
      { reason: "authorization_expired_unused", nonce: NONCE, valid_before: String(VALID_BEFORE), checked_block_time: VALID_BEFORE + 100 },
    );
    assert.equal(ev.outcome, "released");
    assert.equal(ev.chargedMicros, 0);
    assert.equal(ev.rail, "x402");
    assert.equal(ev.details?.reconciled_from, "charged_full");
    assert.equal(ev.details?.reason, "authorization_expired_unused");

    const settles = settlesFor(rail, rid);
    assert.equal(settles.length, 2, "chargeFull plus reconcile must both be signed");
    const last = settles[settles.length - 1]!.payload as { outcome: string; charged_micros: number; details: Record<string, unknown> };
    assert.equal(last.outcome, "released");
    assert.equal(last.charged_micros, 0);
    assert.equal(last.details.reconciled_from, "charged_full");

    const after = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
    assert.equal(after.ok, true, after.ok ? "" : after.reason);
    if (!after.ok) throw new Error("audit unexpectedly failed");
    assert.equal(after.settledMicros, 0);
    assert.equal(rail.store.spent(rail.mandate.id).settledMicros, 0);

    // Editing the row back to charged_full by SQL, after the reconcile, must be
    // caught: the last signed entry says released.
    rail.store.database.prepare("UPDATE reservations SET status = 'charged_full' WHERE id = ?").run(rid);
    const tampered = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
    assert.equal(tampered.ok, false, "audit must fail after the row is edited back");
    if (tampered.ok) throw new Error("audit unexpectedly passed");
    assert.match(tampered.reason, /status/);
    console.log("# reconcile store released-then-edited: audit fails after SQL flip");
  } finally {
    rail.close();
  }
});

test("settled late: the row becomes settled and audit still passes", () => {
  const { rail, trusted } = openRail();
  try {
    const rid = book(rail, "x402");
    rail.store.chargeFull(rid, details());
    const ev = rail.store.reconcileCharged(
      rid,
      { outcome: "settled", chargedMicros: MICROS },
      { reason: "settled_late", tx_hash: `0x${"cd".repeat(32)}`, tx_hash_source: "chain", settlement_verified: true, checked_block_time: VALID_BEFORE },
    );
    assert.equal(ev.outcome, "settled");
    assert.equal(ev.chargedMicros, MICROS);

    const after = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
    assert.equal(after.ok, true, after.ok ? "" : after.reason);
    if (!after.ok) throw new Error("audit unexpectedly failed");
    assert.equal(after.settledMicros, MICROS);
    assert.equal(rail.store.spent(rail.mandate.id).settledMicros, MICROS);
    console.log("# reconcile store settled-late: settled, audit passes");
  } finally {
    rail.close();
  }
});

test("only a charged_full x402 row reconciles, and only once", () => {
  const { rail } = openRail();
  try {
    // An llm booking may never be reconciled.
    const llmRid = book(rail, "llm");
    rail.store.chargeFull(llmRid, { reason: "upstream_gone" });
    assert.throws(() => rail.store.reconcileCharged(llmRid, { outcome: "released" }, {}), /not on the x402 rail/);

    const rid = book(rail, "x402");
    rail.store.chargeFull(rid, details());
    assert.throws(
      () => rail.store.reconcileCharged(rid, { outcome: "settled", chargedMicros: MICROS + 1 }, {}),
      /chargedMicros/,
    );
    // A failed validation must not consume the row.
    const ok = rail.store.reconcileCharged(rid, { outcome: "released" }, {});
    assert.equal(ok.outcome, "released");
    // Already reconciled.
    assert.throws(() => rail.store.reconcileCharged(rid, { outcome: "released" }, {}), /already released/);
    console.log("# reconcile store guards: rail, amount and once-only enforced");
  } finally {
    rail.close();
  }
});
