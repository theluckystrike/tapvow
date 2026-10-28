import { afterEach, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import type { GovernedRail } from "@mandate/llm-rail";
import { createSvmPaymentGuard } from "../src/guard.js";
import { createSvmRail } from "../src/rail.js";
import { reconcileSvm } from "../src/reconcile.js";
import {
  baseMandate,
  FakeChain,
  fakeScheme,
  NETWORK,
  openTestRail,
  OTHER_PAYEE,
  PAYEE,
  requirements,
  signTestMandate,
  signature,
  testSigner,
  tmpDir,
  USDC_MINT,
} from "./helpers.js";

type Mode = "live" | "reconcile";
type RouteName = "a" | "b" | "c";

interface RouteSpec {
  amount: string;
  payTo: string;
  signature: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSeller(args: {
  chain: FakeChain;
  payer: string;
  mode: Mode;
  routes: Record<RouteName, RouteSpec>;
}) {
  const bRecorded = deferred();
  const bGate = deferred();
  const recorded = new Set<RouteName>();

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const route = new URL(request.url).pathname.replace(/^\//, "") as RouteName;
    const spec = args.routes[route];
    if (!spec) return new Response("not found", { status: 404 });

    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      const required = {
        x402Version: 2,
        resource: { url: request.url },
        accepts: [requirements({ amount: spec.amount, payTo: spec.payTo })],
      };
      return new Response("", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
      });
    }

    if (!recorded.has(route)) {
      recorded.add(route);
      expect(args.chain.transfers.has(spec.signature)).toBe(false);
      args.chain.record(spec.signature, {
        network: NETWORK,
        mint: USDC_MINT,
        payTo: spec.payTo,
        amountAtomic: spec.amount,
        payer: args.payer,
      });
    }

    if (route === "b") {
      bRecorded.resolve();
      await bGate.promise;
      if (args.mode === "reconcile") throw new TypeError("transport loss after fake debit");
    }

    const settle: SettleResponse =
      route === "a"
        ? { success: true, transaction: args.routes.b.signature, network: NETWORK }
        : { success: true, transaction: spec.signature, network: NETWORK };
    const body = JSON.stringify({ paid: true, route });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle),
      },
    });
  };

  return {
    fetchImpl,
    bRecorded: bRecorded.promise,
    releaseB: () => bGate.resolve(),
  };
}

function reservationIdFor(rail: GovernedRail, amountMicros: number): string {
  const row = rail.store.database
    .prepare(
      "SELECT id FROM reservations WHERE mandate_id = ? AND rail = 'x402' AND reserved_micros = ? ORDER BY created_ms DESC LIMIT 1",
    )
    .get(rail.mandate.id, amountMicros) as { id: string } | undefined;
  if (!row) throw new Error(`no reservation for ${amountMicros} micros`);
  return row.id;
}

function reservationStatus(rail: GovernedRail, id: string): string {
  const row = rail.store.database
    .prepare("SELECT status FROM reservations WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!row) throw new Error(`no reservation ${id}`);
  return row.status;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function runCase(mode: Mode): Promise<void> {
  const dir = tmpDir();
  dirs.push(dir);
  const payer = await testSigner();
  const chain = new FakeChain();
  const { issuer, signed } = signTestMandate(
    baseMandate({
      budget: { total: "0.03", period: "lifetime" },
      per_call_cap: "0.03",
      approval_threshold: "0.03",
      allowed_payees: [
        { rail: "x402", id: `${NETWORK}:${PAYEE}` },
        { rail: "x402", id: `${NETWORK}:${OTHER_PAYEE}` },
      ],
    }),
  );
  const { rail } = openTestRail(join(dir, "rail.db"), signed, issuer.publicKey);

  const routes: Record<RouteName, RouteSpec> = {
    a: { amount: "10000", payTo: PAYEE, signature: signature(41) },
    b: { amount: "20000", payTo: OTHER_PAYEE, signature: signature(42) },
    c: { amount: "20000", payTo: PAYEE, signature: signature(43) },
  };
  const seller = createSeller({ chain, payer: String(payer.address), mode, routes });
  const svm = createSvmRail({
    rail,
    signer: payer,
    networks: [NETWORK],
    guard: createSvmPaymentGuard({ rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 }),
    chain,
    scheme: () => fakeScheme(payer),
    fetch: seller.fetchImpl,
    allowPrivateNetwork: true,
  });
  const auth = { agentId: "agent-01", mandateId: rail.mandate.id };
  const bPromise = svm.pay(auth, { url: "http://127.0.0.1:9/b" });

  try {
    await Promise.race([
      seller.bRecorded,
      bPromise.then((result) => { throw new Error(`B stopped before fake debit: ${result.status} ${result.body}`); }),
    ]);
    const bReservationId = reservationIdFor(rail, 20_000);

    const aResult = await svm.pay(auth, { url: "http://127.0.0.1:9/a" });
    expect(aResult.status).toBe(502);
    expect(rail.store.spent(rail.mandate.id).committedMicros).toBe(30_000);
    expect(reservationStatus(rail, bReservationId)).not.toBe("released");

    seller.releaseB();
    const bResult = await bPromise;
    const report = mode === "reconcile" ? await reconcileSvm(rail, chain) : null;
    const bStatus = reservationStatus(rail, bReservationId);
    const committedBeforeNext = rail.store.spent(rail.mandate.id).committedMicros;
    const cResult = await svm.pay(auth, { url: "http://127.0.0.1:9/c" });
    const debit = [...chain.transfers.values()]
      .filter((record) => record.status === "success")
      .reduce((total, record) => total + BigInt(record.amountAtomic), 0n);

    expect(bStatus, `committed=${committedBeforeNext}; fake debit=${debit}; next=${cResult.status}`).toBe("charged_full");
    expect(committedBeforeNext).toBe(30_000);
    expect(cResult.status).toBe(402);
    expect(debit).toBeLessThanOrEqual(30_000n);
    expect(bResult.status).toBe(mode === "reconcile" ? 502 : 403);
    expect(JSON.parse(bResult.body).error.type).toBe("mandate_unconfirmed");
    if (report) {
      expect(report.results.find((result) => result.reservationId === bReservationId)?.result).toBe("pending");
    }
  } finally {
    seller.releaseB();
    await bPromise.catch(() => undefined);
    rail.close();
  }
}

describe("replay accounting", () => {
  test("a false settlement for route a never releases route b's real payment", async () => {
    await runCase("live");
  });

  test("reconcile retains route b after transport loss and an unbound replay response", async () => {
    await runCase("reconcile");
  });
});

test("an unrelated failed response ID cannot free the budget of a paid request", async () => {
  const dir = tmpDir();
  dirs.push(dir);
  const payer = await testSigner();
  const chain = new FakeChain();
  const { issuer, signed } = signTestMandate(baseMandate({
    budget: { total: "0.01", period: "lifetime" },
    per_call_cap: "0.01",
    approval_threshold: "0.01",
    allowed_payees: [
      { rail: "x402", id: `${NETWORK}:${PAYEE}` },
      { rail: "x402", id: `${NETWORK}:${OTHER_PAYEE}` },
    ],
  }));
  const { rail } = openTestRail(join(dir, "rail.db"), signed, issuer.publicKey);
  const unrelatedFailed = signature(79);
  chain.record(unrelatedFailed, {
    network: NETWORK, mint: USDC_MINT, payTo: OTHER_PAYEE,
    amountAtomic: "999", payer: String(payer.address),
  }, "failed", false);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const first = new URL(request.url).pathname === "/first";
    const payTo = first ? PAYEE : OTHER_PAYEE;
    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      return new Response("", { status: 402, headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
          x402Version: 2, resource: { url: request.url }, accepts: [requirements({ payTo })],
        }),
      } });
    }
    const actual = signature(first ? 77 : 78);
    expect(chain.transfers.has(actual)).toBe(false);
    chain.record(actual, {
      network: NETWORK, mint: USDC_MINT, payTo,
      amountAtomic: "10000", payer: String(payer.address),
    });
    return new Response(JSON.stringify({ paid: true }), { status: 200, headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true, transaction: first ? unrelatedFailed : actual, network: NETWORK,
      }),
    } });
  };
  const svm = createSvmRail({
    rail, signer: payer, networks: [NETWORK], chain, fetch: fetchImpl,
    scheme: () => fakeScheme(payer), allowPrivateNetwork: true,
    guard: createSvmPaymentGuard({ rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 }),
  });
  const call = (name: string) => svm.pay(
    { agentId: "agent-01", mandateId: rail.mandate.id }, { url: `http://127.0.0.1:9/${name}` },
  );
  try {
    const first = await call("first");
    const committedBeforeNext = rail.store.spent(rail.mandate.id).committedMicros;
    const next = await call("next");
    expect(committedBeforeNext).toBe(10_000);
    expect(first.status).toBe(502);
    expect(JSON.parse(first.body).error.code).toBe("unbound_failed_signature");
    expect(next.status).toBe(402);
    const debit = [...chain.transfers.values()].filter((record) => record.status === "success")
      .reduce((total, record) => total + BigInt(record.amountAtomic), 0n);
    expect(debit).toBe(10_000n);
  } finally {
    rail.close();
  }
});
