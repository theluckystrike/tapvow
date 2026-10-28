// Regression tests for the security fixes in src/rail.ts, src/guard.ts,
// src/local-facilitator.ts and src/demo-server.ts. Each test drives the real
// gateway against a real resource server on 127.0.0.1 and the local facilitator.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway, auditRail } from "@mandate/llm-rail";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { createX402Rail, type X402RailOptions } from "../src/rail.js";
import { createPaymentGuard } from "../src/guard.js";
import { startLocalFacilitator } from "../src/local-facilitator.js";
import { startPaidResource, type PaidResource } from "../src/demo-server.js";
import type { Approver, PaymentGuard } from "../src/types.js";
import {
  NETWORK,
  allowlistGuard,
  baseMandate,
  closeServer,
  listen,
  openTestRail,
  postJson,
  signTestMandate,
  tokenWallet,
} from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-x402-review-"));
  dirs.push(d);
  return d;
}

interface Route {
  path: string;
  price: string;
  body: unknown;
}

interface BuildOptions {
  id: string;
  routes?: Route[];
  budget?: string;
  perCallCap?: string;
  approvalThreshold?: string;
  approver?: Approver;
  /** A plain guard, or "payment-guard" to use the real createPaymentGuard. */
  guard?: PaymentGuard | "payment-guard";
  allowPrivateNetwork?: boolean;
  maxTimeoutSeconds?: number;
  verifySettlement?: X402RailOptions["verifySettlement"];
  withResource?: boolean;
  payerBalance?: bigint;
}

async function buildStack(opts: BuildOptions) {
  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({
    id: `mdt_${opts.id}`,
    budget: { total: opts.budget ?? "5.00", period: "lifetime" },
    per_call_cap: opts.perCallCap ?? "1.00",
    approval_threshold: opts.approvalThreshold ?? "1.00",
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "llm", id: "anthropic" },
      { rail: "x402", id: `${NETWORK}:${payee.account.address}` },
    ],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail, trusted } = openTestRail(join(tmp(), `${opts.id}.db`), signed, issuer.publicKey);
  const facilitator = await startLocalFacilitator({
    networks: [NETWORK],
    balances: { [payer.account.address]: opts.payerBalance ?? 10_000_000n, [payee.account.address]: 0n },
  });
  const routes = opts.routes ?? [];
  const wantsResource = opts.withResource ?? routes.length > 0;
  const resource: PaidResource | null = wantsResource
    ? await startPaidResource({
        facilitatorUrl: facilitator.url,
        network: NETWORK,
        payTo: payee.account.address,
        routes,
      })
    : null;
  const guard =
    opts.guard === "payment-guard"
      ? createPaymentGuard({ rail, networks: [NETWORK] })
      : opts.guard ?? allowlistGuard([payee.account.address]);
  const x402 = createX402Rail({
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard,
    ...(opts.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: opts.allowPrivateNetwork } : {}),
    ...(opts.approver ? { approver: opts.approver } : {}),
    ...(opts.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}),
    ...(opts.verifySettlement ? { verifySettlement: opts.verifySettlement } : {}),
  });
  const gateway = createGateway({
    store: rail.store,
    upstreams: {},
    routes: { "POST /v1/x402/fetch": x402.handler },
  });
  const port = await listen(gateway);
  const key = rail.issueAgentKey("agent-01");
  return {
    payer,
    payee,
    mandate,
    rail,
    trusted,
    facilitator,
    resource,
    x402,
    base: `http://127.0.0.1:${port}`,
    key,
    async close() {
      await closeServer(gateway);
      if (resource) await resource.close();
      await facilitator.close();
      rail.close();
    },
  };
}
type Stack = Awaited<ReturnType<typeof buildStack>>;

function callPaid(stack: Stack, url: string) {
  return postJson(stack.base, "/v1/x402/fetch", { authorization: `Bearer ${stack.key}` }, { url });
}

interface HandMade {
  origin: string;
  requests: number;
  signatureSeen: boolean;
  close(): Promise<void>;
}

/** A tiny resource that answers every request with a hand-made 402 header. */
function startHandMade402(header: string): Promise<HandMade> {
  const state = { requests: 0, signatureSeen: false };
  const server: Server = createServer((req, res) => {
    state.requests += 1;
    if (req.headers["payment-signature"] !== undefined || req.headers["x-payment"] !== undefined) {
      state.signatureSeen = true;
    }
    res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": header });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        get requests() {
          return state.requests;
        },
        get signatureSeen() {
          return state.signatureSeen;
        },
        close: () => closeServer(server),
      });
    });
  });
}

/** A resource that 402s, then answers the paid retry 200 with a bogus tx hash. */
function startBadSettlementResource(header402: string): Promise<HandMade> {
  const state = { requests: 0, signatureSeen: false };
  const server: Server = createServer((req, res) => {
    state.requests += 1;
    const signature = req.headers["payment-signature"] ?? req.headers["x-payment"];
    if (!signature) {
      res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": header402 });
      res.end("{}");
      return;
    }
    state.signatureSeen = true;
    const settle = encodePaymentResponseHeader({
      success: true,
      transaction: "0xdead",
      network: NETWORK as Network,
    });
    res.writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": settle });
    res.end(JSON.stringify({ data: "paid" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        get requests() {
          return state.requests;
        },
        get signatureSeen() {
          return state.signatureSeen;
        },
        close: () => closeServer(server),
      });
    });
  });
}

/** Copies the exact 402 the real demo server emits, so encoding is not guessed. */
async function captureRequired(resource: PaidResource, path = "/data"): Promise<PaymentRequired> {
  const res = await fetch(`${resource.origin}${path}`);
  assert.equal(res.status, 402);
  const header = res.headers.get("PAYMENT-REQUIRED");
  assert.ok(header, "the real 402 carries a PAYMENT-REQUIRED header");
  return decodePaymentRequiredHeader(header);
}

function modifiedHeader(base: PaymentRequired, mutate: (req: PaymentRequirements) => void): string {
  const clone = structuredClone(base) as PaymentRequired;
  mutate(clone.accepts[0]!);
  return encodePaymentRequiredHeader(clone);
}

test("fix 1: a 402 asking for a string, over-long, zero or negative window is refused unsigned", async () => {
  const stack = await buildStack({
    id: "review_window",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    allowPrivateNetwork: true,
  });
  try {
    const required = await captureRequired(stack.resource!);
    assert.equal(required.accepts[0]!.maxTimeoutSeconds, 300);

    const cases: Array<{ label: string; mutate: (r: PaymentRequirements) => void }> = [
      {
        label: 'string "60"',
        mutate: (r) => {
          (r as { maxTimeoutSeconds: unknown }).maxTimeoutSeconds = "60";
        },
      },
      { label: "301 over the 300s limit", mutate: (r) => (r.maxTimeoutSeconds = 301) },
      { label: "0", mutate: (r) => (r.maxTimeoutSeconds = 0) },
      { label: "-5", mutate: (r) => (r.maxTimeoutSeconds = -5) },
    ];

    for (const c of cases) {
      const handmade = await startHandMade402(modifiedHeader(required, c.mutate));
      try {
        const r = await callPaid(stack, `${handmade.origin}/data`);
        assert.equal(r.status, 403, `${c.label}: ${r.text}`);
        const body = JSON.parse(r.text) as { error: { type: string; code: string } };
        assert.equal(body.error.type, "mandate_denied", c.label);
        assert.equal(body.error.code, "authorization_window_too_long", c.label);
        assert.equal(r.headers["x-mandate-tx-hash"], undefined, c.label);
        assert.equal(handmade.signatureSeen, false, `${c.label}: nothing may be signed`);
        assert.equal(handmade.requests, 1, `${c.label}: there must be no paid retry`);
      } finally {
        await handmade.close();
      }
    }

    assert.equal(stack.facilitator.token.transfers.length, 0, "no money may move");
    assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
    assert.equal(stack.rail.ledger.entries().filter((e) => e.kind === "x402.settle").length, 0);
  } finally {
    await stack.close();
  }
});

test("fix 2: permit2 and extra paymentFlow requirements are filtered out entirely", async () => {
  const stack = await buildStack({
    id: "review_flows",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    allowPrivateNetwork: true,
  });
  try {
    const required = await captureRequired(stack.resource!);
    const cases: Array<{ label: string; mutate: (r: PaymentRequirements) => void }> = [
      { label: "permit2", mutate: (r) => (r.extra.assetTransferMethod = "permit2") },
      { label: "paymentFlow", mutate: (r) => (r.extra.paymentFlow = "escrow") },
    ];

    for (const c of cases) {
      const handmade = await startHandMade402(modifiedHeader(required, c.mutate));
      try {
        const r = await callPaid(stack, `${handmade.origin}/data`);
        assert.notEqual(r.status, 200, `${c.label}: ${r.text}`);
        assert.equal(r.headers["x-mandate-tx-hash"], undefined, c.label);
        assert.equal(handmade.signatureSeen, false, `${c.label}: nothing may be signed`);
      } finally {
        await handmade.close();
      }
    }

    assert.equal(stack.facilitator.token.transfers.length, 0, "no money may move");
    assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
    assert.equal(stack.rail.ledger.entries().filter((e) => e.kind === "x402.settle").length, 0);
  } finally {
    await stack.close();
  }
});

test("fix 3: by default loopback and link-local targets are refused with host_not_allowed", async () => {
  let hits = 0;
  const target = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  });
  const port = await listen(target);
  // No allowPrivateNetwork option: the rail default must apply.
  const stack = await buildStack({ id: "review_private" });
  try {
    const loopback = await callPaid(stack, `http://127.0.0.1:${port}/x`);
    assert.equal(loopback.status, 403, loopback.text);
    assert.equal((JSON.parse(loopback.text) as { error: { code: string } }).error.code, "host_not_allowed");
    assert.equal(loopback.headers["x-mandate-tx-hash"], undefined);
    assert.equal(hits, 0, "the loopback target must receive no request");

    const linkLocal = await callPaid(stack, "http://169.254.169.254/latest/meta-data");
    assert.equal(linkLocal.status, 403, linkLocal.text);
    assert.equal((JSON.parse(linkLocal.text) as { error: { code: string } }).error.code, "host_not_allowed");
    assert.equal(hits, 0, "the link-local target must receive no request");
  } finally {
    await closeServer(target);
    await stack.close();
  }
});

test("fix 4: settlement verification books charged_full on failure and records the source", async () => {
  const cases = [
    { mode: "false", verifySettlement: async () => false },
    { mode: "true", verifySettlement: async () => true },
    { mode: "absent", verifySettlement: undefined },
  ] as const;

  for (const c of cases) {
    const stack = await buildStack({
      id: `review_verify_${c.mode}`,
      routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
      allowPrivateNetwork: true,
      ...(c.verifySettlement ? { verifySettlement: c.verifySettlement } : {}),
    });
    try {
      const r = await callPaid(stack, `${stack.resource!.origin}/data`);
      const settles = stack.rail.ledger.entries().filter((e) => e.kind === "x402.settle");
      assert.equal(settles.length, 1, c.mode);
      const payload = settles[0]!.payload as { outcome: string; details: Record<string, unknown> };

      if (c.mode === "false") {
        assert.equal(r.status, 502, r.text);
        assert.equal(payload.outcome, "charged_full");
        assert.equal(payload.details.settlement_verified, false);
        assert.match(String(payload.details.tx_hash_reported), /^0x[0-9a-f]{64}$/i);
        assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 10_000);
        assert.equal(stack.facilitator.token.transfers.length, 1);
      } else if (c.mode === "true") {
        assert.equal(r.status, 200, r.text);
        assert.equal(payload.outcome, "settled");
        assert.equal(payload.details.settlement_verified, true);
        assert.equal(payload.details.tx_hash_source, "chain");
        assert.match(String(r.headers["x-mandate-tx-hash"]), /^0x[0-9a-f]{64}$/i);
      } else {
        assert.equal(r.status, 200, r.text);
        assert.equal(payload.outcome, "settled");
        assert.equal(payload.details.settlement_verified, false);
        assert.equal(payload.details.tx_hash_source, "resource_server");
      }
    } finally {
      await stack.close();
    }
  }
});

test("fix 5: a reported transaction that is not a 32-byte hash is never booked as settled", async () => {
  const stack = await buildStack({
    id: "review_bad_tx",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    allowPrivateNetwork: true,
  });
  try {
    const required = await captureRequired(stack.resource!);
    const handmade = await startBadSettlementResource(encodePaymentRequiredHeader(required));
    try {
      const r = await callPaid(stack, `${handmade.origin}/data`);
      assert.equal(handmade.signatureSeen, true, "the rail must have signed the paid retry");

      const settles = stack.rail.ledger.entries().filter((e) => e.kind === "x402.settle");
      assert.equal(settles.length, 1);
      const payload = settles[0]!.payload as { outcome: string; details: Record<string, unknown> };
      assert.equal(payload.outcome, "charged_full");
      assert.equal(payload.details.unconfirmed, true);
      assert.equal(payload.details.tx_hash, null);
      assert.equal(r.headers["x-mandate-tx-hash"], undefined);
      assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 10_000);
    } finally {
      await handmade.close();
    }
  } finally {
    await stack.close();
  }
});

test("fix 6: the query string never reaches the ledger or the approval summary", async () => {
  const summaries: string[] = [];
  const approver: Approver = {
    async request(req) {
      summaries.push(req.summary);
      return { decision: "approved", requestId: "apr_query_test_1", decidedBy: "mike" };
    },
  };
  const stack = await buildStack({
    id: "review_query",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    approvalThreshold: "0.005",
    approver,
    allowPrivateNetwork: true,
  });
  try {
    const r = await callPaid(stack, `${stack.resource!.origin}/data?api_key=SECRET123`);
    assert.equal(r.status, 200, r.text);
    assert.equal(summaries.length, 1);
    assert.ok(!summaries[0]!.includes("SECRET123"), "approval summary leaked the query string");
    assert.ok(!summaries[0]!.includes("?"), "approval summary kept a query separator");

    const entries = stack.rail.ledger.entries();
    assert.ok(!JSON.stringify(entries).includes("SECRET123"), "the ledger leaked the query string");

    const settle = entries.find((e) => e.kind === "x402.settle");
    assert.ok(settle);
    const details = (settle!.payload as { details: { resource: string; resource_query_sha256: string } }).details;
    assert.ok(!details.resource.includes("?"), "details.resource kept the query string");
    assert.match(details.resource_query_sha256, /^[0-9a-f]{64}$/);
  } finally {
    await stack.close();
  }
});

test("fix 7: an approver that throws is treated as an approval_denied", async () => {
  const approver: Approver = {
    async request() {
      throw new Error("approval channel is down");
    },
  };
  const stack = await buildStack({
    id: "review_approver_throw",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    approvalThreshold: "0.005",
    approver,
    allowPrivateNetwork: true,
  });
  try {
    const r = await callPaid(stack, `${stack.resource!.origin}/data`);
    assert.equal(r.status, 403, r.text);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "approval_denied");
    assert.equal(stack.facilitator.token.transfers.length, 0, "nothing may be signed");
    assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
  } finally {
    await stack.close();
  }
});

test("fix 8: an approved decision with an empty requestId is treated as approval_denied", async () => {
  const approver: Approver = {
    async request() {
      return { decision: "approved", requestId: "" };
    },
  };
  const stack = await buildStack({
    id: "review_approver_empty_id",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    approvalThreshold: "0.005",
    approver,
    allowPrivateNetwork: true,
  });
  try {
    const r = await callPaid(stack, `${stack.resource!.origin}/data`);
    assert.equal(r.status, 403, r.text);
    assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "approval_denied");
    assert.equal(stack.facilitator.token.transfers.length, 0, "nothing may be signed");
    assert.equal(stack.rail.store.spent(stack.mandate.id).committedMicros, 0);
  } finally {
    await stack.close();
  }
});

test("fix 9: the payee guard's median cannot be ratcheted by 3x steps", async () => {
  const stack = await buildStack({
    id: "review_ratchet",
    routes: [
      { path: "/a", price: "$0.01", body: { a: true } },
      { path: "/b", price: "$0.03", body: { b: true } },
      { path: "/c", price: "$0.09", body: { c: true } },
    ],
    budget: "5.00",
    perCallCap: "1.00",
    approvalThreshold: "1.00",
    allowPrivateNetwork: true,
    guard: "payment-guard",
  });
  try {
    const first = await callPaid(stack, `${stack.resource!.origin}/a`);
    assert.equal(first.status, 200, first.text);

    // 0.03 is exactly 3x the 0.01 first payment, so it passes against the median.
    const second = await callPaid(stack, `${stack.resource!.origin}/b`);
    assert.equal(second.status, 200, second.text);

    // 0.09 would be 3x the 0.03 payment, but that median-priced payment is left
    // out, so the reference is still 0.01 and 0.09 is refused.
    const third = await callPaid(stack, `${stack.resource!.origin}/c`);
    assert.equal(third.status, 403, third.text);
    assert.equal((JSON.parse(third.text) as { error: { code: string } }).error.code, "amount_out_of_bounds");

    assert.equal(stack.facilitator.token.transfers.length, 2, "only the first two payments may move money");
    assert.equal(stack.rail.store.spent(stack.mandate.id).settledMicros, 40_000);
  } finally {
    await stack.close();
  }
});

test("fix 10: auditRail fails when a settled reservation is flipped to released in SQLite", async () => {
  const stack = await buildStack({
    id: "review_audit",
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
    allowPrivateNetwork: true,
  });
  try {
    const r = await callPaid(stack, `${stack.resource!.origin}/data`);
    assert.equal(r.status, 200, r.text);

    const settle = stack.rail.ledger.entries().find((e) => e.kind === "x402.settle");
    assert.ok(settle);
    const reservationId = (settle!.payload as { reservation_id: string }).reservation_id;

    const before = auditRail(stack.rail.store, stack.rail.ledger, stack.mandate.id, stack.trusted);
    assert.equal(before.ok, true, before.ok ? "" : before.reason);

    stack.rail.store.database
      .prepare("UPDATE reservations SET status = 'released' WHERE id = ?")
      .run(reservationId);

    const after = auditRail(stack.rail.store, stack.rail.ledger, stack.mandate.id, stack.trusted);
    assert.equal(after.ok, false, "audit must fail after the status is edited directly");
    if (after.ok) throw new Error("audit unexpectedly passed");
    assert.match(after.reason, /status/);
  } finally {
    await stack.close();
  }
});
