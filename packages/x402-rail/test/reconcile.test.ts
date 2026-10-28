// reconcileX402 revisits an x402 booking the gateway charged in full without a
// confirmed settlement. Against a fake AuthorizationChain it must release an
// authorization that expired unused at the pinned block, book one that settled
// late as settled (with the real tx hash), leave anything undecided pending, and
// never release a used authorization or write when the RPC errors. Every fact
// is read at one pinned block, the network is checked against the client's
// chain id, and an edited ledger is refused. reconcileReport does the same
// against a ledger database opened READ ONLY and writes nothing next to it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, custom } from "viem";
import { auditRail, BudgetStore, type GovernedRail } from "@mandate/llm-rail";
import {
  openReportDatabase,
  reconcileReport,
  reconcileX402,
  redactError,
  registerRedactionSecrets,
  viemAuthorizationChain,
  type AuthorizationChain,
  type AuthorizationTx,
  type ChainBlock,
} from "../src/reconcile.js";
import { NETWORK, baseMandate, openTestRail, signTestMandate } from "./helpers.js";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const NONCE = `0x${"ab".repeat(32)}`;
const VALID_BEFORE = 2_000_000_000;
const AMOUNT_ATOMIC = "10000";
const MICROS = 10_000;
const TX = `0x${"cd".repeat(32)}`;
const CHAIN_ID = 84532;
const BLOCK_HASH = `0x${"ef".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"fe".repeat(32)}`;

function blk(
  number: bigint,
  timestamp: number,
  tag: ChainBlock["tag"],
  over: Partial<ChainBlock> = {},
): ChainBlock {
  return { number, timestamp, hash: BLOCK_HASH, tag, ...over };
}

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tapvow-rec-"));
  dirs.push(d);
  return d;
}

// A typed open for the runtime-only readOnly option (@types/node 22.10 lacks it).
interface SqliteOpenOptions {
  open?: boolean;
  readOnly?: boolean;
}
function openReadOnly(path: string): DatabaseSync {
  const options: SqliteOpenOptions = { open: true, readOnly: true };
  return new DatabaseSync(path, options);
}

/** DatabaseSync.isTransaction is runtime-only in @types/node 22.10. */
function inTransaction(store: BudgetStore): boolean {
  return (store.database as unknown as { isTransaction: boolean }).isTransaction;
}

function openRail(): { rail: GovernedRail; trusted: Record<string, string>; dbPath: string } {
  const dbPath = join(tmp(), "rail.db");
  const { issuer, signed } = signTestMandate(baseMandate());
  const { rail, trusted } = openTestRail(dbPath, signed, issuer.publicKey);
  return { rail, trusted, dbPath };
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

interface FakeChain extends AuthorizationChain {
  used: boolean;
  /** When set, the state is used only at or after this block (a node that lags). */
  usedAtBlock: bigint | null;
  tx: AuthorizationTx | null;
  /** The pinned block returned by latestBlock(). */
  block: ChainBlock;
  chainIdValue: number;
  failAuth: Error | null;
  failBlock: Error | null;
  failBlockHash: Error | null;
  failChainId: Error | null;
  failTx: Error | null;
  blockHashValue: string | null;
  blockHashQueries: bigint[];
  authQueries: number;
  authBlocks: bigint[];
  txFromTimestamps: number[];
  canceled: boolean;
}

function makeChain(over: Partial<FakeChain> = {}): FakeChain {
  const chain: FakeChain = {
    used: false,
    usedAtBlock: null,
    tx: null,
    block: blk(100n, VALID_BEFORE - 10, "safe"),
    chainIdValue: CHAIN_ID,
    failAuth: null,
    failBlock: null,
    failBlockHash: null,
    failChainId: null,
    failTx: null,
    blockHashValue: null,
    blockHashQueries: [],
    authQueries: 0,
    authBlocks: [],
    txFromTimestamps: [],
    canceled: false,
    async latestBlock() {
      if (chain.failBlock) throw chain.failBlock;
      return chain.block;
    },
    async blockHash(blockNumber) {
      chain.blockHashQueries.push(blockNumber);
      if (chain.failBlockHash) throw chain.failBlockHash;
      return chain.blockHashValue ?? chain.block.hash;
    },
    async chainId() {
      if (chain.failChainId) throw chain.failChainId;
      return chain.chainIdValue;
    },
    async authorizationUsed(_asset, _authorizer, _nonce, blockNumber) {
      chain.authQueries += 1;
      chain.authBlocks.push(blockNumber);
      if (chain.failAuth) throw chain.failAuth;
      if (chain.usedAtBlock !== null) return blockNumber >= chain.usedAtBlock;
      return chain.used;
    },
    async findAuthorizationTx(_asset, _authorizer, _nonce, fromTimestamp) {
      chain.txFromTimestamps.push(fromTimestamp);
      if (chain.failTx) throw chain.failTx;
      return chain.tx;
    },
    async findAuthorizationCanceled() {
      return chain.canceled;
    },
    ...over,
  };
  return chain;
}

function tx(over: Partial<AuthorizationTx> = {}): AuthorizationTx {
  return { txHash: TX, from: PAYER, to: PAY_TO, value: BigInt(AMOUNT_ATOMIC), status: "success", ...over };
}

function rpcBlock(number: string, timestamp: string): unknown {
  return {
    number,
    hash: BLOCK_HASH,
    parentHash: BLOCK_HASH,
    nonce: "0x0000000000000000",
    sha3Uncles: BLOCK_HASH,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: BLOCK_HASH,
    stateRoot: BLOCK_HASH,
    receiptsRoot: BLOCK_HASH,
    miner: PAYER,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp,
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x0",
  };
}

test("expired unused is released, signed ledger follows, audit passes, spent drops", async () => {
  const { rail, trusted } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: false, block: blk(200n, VALID_BEFORE + 100, "safe") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]!.reservationId, rid);
    assert.equal(report.results[0]!.result, "released");
    assert.equal(report.releasedMicros, MICROS);
    assert.equal(report.confirmedMicros, 0);
    assert.equal(report.blockTag, "safe");

    const settles = settlesFor(rail, rid);
    assert.equal(settles.length, 2, "chargeFull plus reconcile are both signed");
    const last = settles[settles.length - 1]!.payload as {
      outcome: string;
      charged_micros: number;
      details: Record<string, unknown>;
    };
    assert.equal(last.outcome, "released");
    assert.equal(last.charged_micros, 0);
    assert.equal(last.details.reconciled_from, "charged_full");
    assert.equal(last.details.reason, "authorization_expired_unused");
    assert.equal(last.details.checked_block_time, VALID_BEFORE + 100);
    assert.equal(last.details.checked_block_number, "200");
    assert.equal(last.details.checked_block_tag, "safe");

    const audit = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
    assert.equal(audit.ok, true, audit.ok ? "" : audit.reason);
    if (!audit.ok) throw new Error("audit unexpectedly failed");
    assert.equal(audit.settledMicros, 0);
    assert.equal(rail.store.spent(rail.mandate.id).settledMicros, 0);
    console.log("# reconcile expired-unused: released");
  } finally {
    rail.close();
  }
});

test("an unused authorization before valid_before stays pending", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE - 10, "safe") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "pending");
    assert.equal(report.releasedMicros, 0);
    assert.equal(settlesFor(rail, rid).length, 1, "no reconcile entry is written for a pending booking");
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as {
      status: string;
    };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile not-yet-expired: pending");
  } finally {
    rail.close();
  }
});

test("inside the grace window stays pending", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    // valid_before + 60 (default grace) is not yet reached.
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 30, "safe") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "pending");
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as {
      status: string;
    };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile grace-window: pending");
  } finally {
    rail.close();
  }
});

test("exactly at the grace edge (valid_before + grace) stays pending", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 60, "safe") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "pending", "the comparison is strict");
    assert.equal(settlesFor(rail, rid).length, 1);
    console.log("# reconcile grace-edge: pending");
  } finally {
    rail.close();
  }
});

test("a latest-12 pin never releases, but may still settle", async () => {
  const { rail } = openRail();
  try {
    const unused = book(rail);
    rail.store.chargeFull(unused, details());
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "latest-12") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "pending");
    assert.match(report.results[0]!.reason ?? "", /safe or finalized/);
    assert.equal(report.releasedMicros, 0);
    assert.equal(settlesFor(rail, unused).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(unused) as {
      status: string;
    };
    assert.equal(row.status, "charged_full");

    const used = book(rail);
    rail.store.chargeFull(used, details({ nonce: `0x${"cd".repeat(32)}` }));
    const settling = makeChain({ used: true, tx: tx(), block: blk(2n, VALID_BEFORE + 100, "latest-12") });
    const settledReport = await reconcileX402(rail, settling);
    const settled = settledReport.results.find((r) => r.reservationId === used);
    assert.equal(settled?.result, "settled", "a latest-12 pin may still book a settled payment");
    console.log("# reconcile latest-12: release pending, settle allowed");
  } finally {
    rail.close();
  }
});

test("a release is refused when the pinned block hash changed before the write", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({
      used: false,
      block: blk(1n, VALID_BEFORE + 100, "safe"),
      blockHashValue: OTHER_BLOCK_HASH,
    });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error");
    assert.match(report.results[0]!.reason ?? "", /pinned block changed/);
    assert.equal(report.releasedMicros, 0);
    assert.deepEqual(chain.blockHashQueries, [1n], "the pinned block is re-read before the write");
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status, charged_micros FROM reservations WHERE id = ?").get(rid) as {
      status: string;
      charged_micros: number;
    };
    assert.equal(row.status, "charged_full");
    assert.equal(row.charged_micros, MICROS);
    console.log("# reconcile hash-changed: error, untouched");
  } finally {
    rail.close();
  }
});

test("a failing pinned block re-read turns the release into an error and leaves the row charged_full", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({
      used: false,
      block: blk(1n, VALID_BEFORE + 100, "safe"),
      failBlockHash: new Error("getBlock to https://rpc.example/key failed"),
    });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error");
    assert.match(report.results[0]!.reason ?? "", /<rpc>/);
    assert.equal(report.releasedMicros, 0);
    assert.deepEqual(chain.blockHashQueries, [1n], "the pinned block is re-read before the write");
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status, charged_micros FROM reservations WHERE id = ?").get(rid) as {
      status: string;
      charged_micros: number;
    };
    assert.equal(row.status, "charged_full");
    assert.equal(row.charged_micros, MICROS);
    console.log("# reconcile fail-block-hash: error, untouched");
  } finally {
    rail.close();
  }
});

test("a cancelled authorization is a distinct mismatch, never a release", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: true, tx: null, canceled: true, block: blk(1n, VALID_BEFORE + 100, "safe") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "mismatch");
    assert.match(report.results[0]!.reason ?? "", /cancelled/);
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as {
      status: string;
    };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile cancelled: mismatch, untouched");
  } finally {
    rail.close();
  }
});

test("a negative graceSeconds is refused", async () => {
  const { rail, dbPath } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });

    await assert.rejects(reconcileX402(rail, chain, { graceSeconds: -1 }), /graceSeconds/);
    await assert.rejects(reconcileX402(rail, chain, { graceSeconds: Number.NaN }), /graceSeconds/);
    assert.equal(settlesFor(rail, rid).length, 1);
  } finally {
    rail.close();
  }
  const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
  await assert.rejects(reconcileReport(dbPath, chain, { graceSeconds: -1 }), /graceSeconds/);
  console.log("# reconcile negative-grace: refused");
});

test("redactError removes wss, scheme-less keyed hosts and configured secrets", () => {
  const wss = redactError(new Error("wss://base-sepolia.g.alchemy.com/v2/KEY123 failed"));
  assert.match(wss, /<rpc>/);
  assert.doesNotMatch(wss, /KEY123|alchemy\.com/);

  const host = redactError(new Error("base-mainnet.infura.io/v3/KEY456 failed"));
  assert.match(host, /<rpc>/);
  assert.doesNotMatch(host, /KEY456|infura\.io/);

  registerRedactionSecrets("https://rpc.vendor.example/v1/TOPSECRET");
  const configured = redactError(new Error("rpc.vendor.example/v1/TOPSECRET failed"));
  assert.doesNotMatch(configured, /TOPSECRET|vendor\.example/);
  console.log("# reconcile redaction: wss, scheme-less and configured");
});

test("an old pinned block inside the grace window is pending although the tip is past it", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    // The pinned block is old and its node shows the authorization unused. An
    // unused read plus a newer tip would have released in the old code; the
    // pinned block alone decides.
    const chain = makeChain({
      used: false,
      block: blk(50n, VALID_BEFORE + 10, "safe"),
    });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "pending");
    assert.equal(report.releasedMicros, 0);
    assert.equal(settlesFor(rail, rid).length, 1);
    console.log("# reconcile old-pinned-block: pending");
  } finally {
    rail.close();
  }
});

test("the state is read at the pinned block, not at a later one", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    // Unused before block 100, used from block 100 on. The run reads at 100.
    const chain = makeChain({
      usedAtBlock: 100n,
      block: blk(100n, VALID_BEFORE + 100, "safe"),
      tx: tx(),
    });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "settled", "a used authorization is never released");
    assert.deepEqual(chain.authBlocks, [100n]);
    assert.equal(settlesFor(rail, rid).length, 2);
    console.log("# reconcile pinned-block-state: settled");
  } finally {
    rail.close();
  }
});

test("a used authorization with a matching transfer is settled with the tx hash", async () => {
  const { rail, trusted } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: true, tx: tx(), block: blk(9n, VALID_BEFORE + 100, "finalized") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "settled");
    assert.equal(report.results[0]!.txHash, TX);
    assert.equal(report.confirmedMicros, MICROS);
    assert.equal(report.releasedMicros, 0);
    assert.equal(report.blockTag, "finalized");

    const row = rail.store.database.prepare("SELECT created_ms FROM reservations WHERE id = ?").get(rid) as {
      created_ms: number;
    };
    assert.deepEqual(
      chain.txFromTimestamps,
      [Math.min(Math.floor(row.created_ms / 1000), VALID_BEFORE) - 900],
      "the scan starts one margin before the booking",
    );

    const settles = settlesFor(rail, rid);
    assert.equal(settles.length, 2);
    const last = settles[settles.length - 1]!.payload as {
      outcome: string;
      charged_micros: number;
      details: Record<string, unknown>;
    };
    assert.equal(last.outcome, "settled");
    assert.equal(last.charged_micros, MICROS);
    assert.equal(last.details.tx_hash, TX);
    assert.equal(last.details.tx_hash_source, "chain");
    assert.equal(last.details.settlement_verified, true);
    assert.equal(last.details.reason, "settled_late");
    assert.equal(last.details.reconciled_from, "charged_full");

    const audit = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
    assert.equal(audit.ok, true, audit.ok ? "" : audit.reason);
    if (!audit.ok) throw new Error("audit unexpectedly failed");
    assert.equal(audit.settledMicros, MICROS);
    assert.equal(rail.store.spent(rail.mandate.id).settledMicros, MICROS);
    console.log("# reconcile settled-late: settled");
  } finally {
    rail.close();
  }
});

for (const [name, broken] of [
  ["amount", tx({ value: BigInt(AMOUNT_ATOMIC) + 1n })],
  ["payer", tx({ from: OTHER })],
  ["recipient", tx({ to: OTHER })],
  ["status", tx({ status: "reverted" as const })],
] as const) {
  test(`a used authorization whose transfer has a wrong ${name} is a mismatch and stays charged_full`, async () => {
    const { rail, trusted } = openRail();
    try {
      const rid = book(rail);
      rail.store.chargeFull(rid, details());
      const chain = makeChain({ used: true, tx: broken, block: blk(1n, VALID_BEFORE + 100, "safe") });

      const report = await reconcileX402(rail, chain);
      assert.equal(report.results[0]!.result, "mismatch");
      assert.equal(report.releasedMicros, 0);
      assert.equal(report.confirmedMicros, 0);
      assert.equal(settlesFor(rail, rid).length, 1, "a used authorization is never re-booked on a mismatch");
      const row = rail.store.database.prepare("SELECT status, charged_micros FROM reservations WHERE id = ?").get(rid) as {
        status: string;
        charged_micros: number;
      };
      assert.equal(row.status, "charged_full");
      assert.equal(row.charged_micros, MICROS);
      const audit = auditRail(rail.store, rail.ledger, rail.mandate.id, trusted);
      assert.equal(audit.ok, true, audit.ok ? "" : audit.reason);
      console.log(`# reconcile mismatch-${name}: mismatch`);
    } finally {
      rail.close();
    }
  });
}

test("a used authorization with no transaction found is a mismatch", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: true, tx: null, block: blk(1n, VALID_BEFORE + 100, "safe") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "mismatch");
    assert.match(report.results[0]!.reason ?? "", /not found/);
    assert.equal(settlesFor(rail, rid).length, 1);
    console.log("# reconcile used-no-tx: mismatch");
  } finally {
    rail.close();
  }
});

test("a reserved amount that differs from the signed amount is a mismatch", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details({ amount_atomic: "10001" }));
    const chain = makeChain({
      used: true,
      tx: tx({ value: 10_001n }),
      block: blk(1n, VALID_BEFORE + 100, "safe"),
    });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "mismatch");
    assert.match(report.results[0]!.reason ?? "", /reserved amount/);
    assert.equal(settlesFor(rail, rid).length, 1);
    console.log("# reconcile amount-vs-reserved: mismatch");
  } finally {
    rail.close();
  }
});

for (const [name, network, chainId] of [
  ["another chain", "eip155:8453", CHAIN_ID],
  ["a malformed network", "base-sepolia", CHAIN_ID],
] as const) {
  test(`a booking with ${name} is a mismatch and stays charged_full`, async () => {
    const { rail } = openRail();
    try {
      const rid = book(rail);
      rail.store.chargeFull(rid, details({ network }));
      const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe"), chainIdValue: chainId });

      const report = await reconcileX402(rail, chain);
      assert.equal(report.results[0]!.result, "mismatch");
      assert.equal(report.releasedMicros, 0);
      assert.equal(settlesFor(rail, rid).length, 1);
      const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as { status: string };
      assert.equal(row.status, "charged_full");
      console.log(`# reconcile network-${name}: mismatch`);
    } finally {
      rail.close();
    }
  });
}

test("an RPC error leaves the booking untouched and is redacted", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ failAuth: new Error("fetch failed for https://sepolia.base.org/rpc?apikey=SECRET") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error");
    assert.match(report.results[0]!.reason ?? "", /<rpc>/);
    assert.doesNotMatch(report.results[0]!.reason ?? "", /SECRET/);
    assert.equal(report.releasedMicros, 0);
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as {
      status: string;
    };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile rpc-error: error");
  } finally {
    rail.close();
  }
});

test("a failing block read leaves every booking untouched", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ failBlock: new Error("getBlock to https://rpc.example/key failed") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error");
    assert.match(report.results[0]!.reason ?? "", /<rpc>/);
    assert.equal(report.blockTag, undefined);
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as { status: string };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile fail-block-read: error");
  } finally {
    rail.close();
  }
});

test("a getBlock that fails four times with a transport error makes the plan an error", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    let failedBlockReads = 0;
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === "eth_blockNumber") return "0x100";
          const tag = String((params as unknown[] | undefined)?.[0]);
          if (method === "eth_getBlockByNumber") {
            if (tag === "0x100") return rpcBlock("0x100", "0xffffffff");
            failedBlockReads += 1;
            throw new Error("HTTP 429 Too Many Requests");
          }
          throw new Error(`unexpected RPC method ${method}`);
        },
      }),
    });
    const real = viemAuthorizationChain(client);
    const chain: AuthorizationChain = {
      latestBlock: async () => blk(400n, VALID_BEFORE + 100, "safe"),
      blockHash: async () => BLOCK_HASH,
      chainId: async () => CHAIN_ID,
      authorizationUsed: async () => true,
      findAuthorizationTx: (asset, authorizer, nonce, fromTimestamp, validBefore, pinnedBlockNumber, expected) =>
        real.findAuthorizationTx(asset, authorizer, nonce, fromTimestamp, validBefore, pinnedBlockNumber, expected),
    };

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error", "a transport error stays retryable, not a pruned scan");
    assert.equal(failedBlockReads, 4, "viem makes four attempts before the transport error escapes");
    assert.equal(report.releasedMicros, 0);
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as { status: string };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile transport-error-mid-read: error");
  } finally {
    rail.close();
  }
});

test("a failing transaction search is an error and leaves the row untouched", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({
      used: true,
      failTx: new Error("getLogs to https://rpc.example/key failed"),
      block: blk(1n, VALID_BEFORE + 100, "safe"),
    });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error");
    assert.equal(settlesFor(rail, rid).length, 1);
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as { status: string };
    assert.equal(row.status, "charged_full");
    console.log("# reconcile fail-tx-search: error");
  } finally {
    rail.close();
  }
});

test("a failing chain id read is an error and leaves the row untouched", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ failChainId: new Error("eth_chainId to https://rpc.example/key failed") });

    const report = await reconcileX402(rail, chain);
    assert.equal(report.results[0]!.result, "error");
    assert.equal(settlesFor(rail, rid).length, 1);
    console.log("# reconcile fail-chain-id: error");
  } finally {
    rail.close();
  }
});

test("running reconcile twice changes nothing the second time", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });

    const first = await reconcileX402(rail, chain);
    assert.equal(first.results[0]!.result, "released");
    const afterFirst = settlesFor(rail, rid).length;

    const second = await reconcileX402(rail, chain);
    assert.equal(second.results.length, 0, "a released booking is no longer a candidate");
    assert.equal(second.releasedMicros, 0);
    assert.equal(settlesFor(rail, rid).length, afterFirst, "no entry is written the second time");
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as {
      status: string;
    };
    assert.equal(row.status, "released");
    console.log("# reconcile twice: idempotent");
  } finally {
    rail.close();
  }
});

test("two concurrent runs both finish and release exactly once", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });

    const [a, b] = await Promise.all([reconcileX402(rail, chain), reconcileX402(rail, chain)]);
    const results = [...a.results, ...b.results];
    assert.equal(results.length, 2, "both runs returned their report");
    assert.equal(results.filter((r) => r.result === "released").length, 1);
    assert.equal(results.filter((r) => r.result === "skipped").length, 1);
    assert.equal(a.releasedMicros + b.releasedMicros, MICROS, "the totals are not double counted");
    assert.equal(settlesFor(rail, rid).length, 2, "the row is written exactly once");
    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as { status: string };
    assert.equal(row.status, "released");
    console.log("# reconcile concurrent: released once, skipped once");
  } finally {
    rail.close();
  }
});

test("settled, released, llm and confirmed bookings are never touched", async () => {
  const { rail } = openRail();
  try {
    const settledRid = book(rail);
    rail.store.settle(settledRid, null, MICROS, details());
    const releasedRid = book(rail);
    rail.store.release(releasedRid, { reason: "not_signed" });
    const llmRid = book(rail, "llm");
    rail.store.chargeFull(llmRid, { reason: "upstream_gone" });
    // A charged_full x402 row whose details are NOT unconfirmed is not a candidate.
    const confirmedRid = book(rail);
    rail.store.chargeFull(confirmedRid, { reason: "manual_charge" });

    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
    const report = await reconcileX402(rail, chain);
    assert.deepEqual(report.results, [], "none of these bookings is a reconcile candidate");
    for (const id of [settledRid, releasedRid, llmRid, confirmedRid]) {
      const entries = rail.ledger.entries().filter(
        (e) => e.kind.endsWith(".settle") && (e.payload as { reservation_id: string }).reservation_id === id,
      );
      assert.equal(entries.length, 1, `no extra settle entry for ${id}`);
    }
    assert.equal(rail.store.spent(rail.mandate.id).settledMicros, MICROS + MICROS + MICROS);
    console.log("# reconcile non-candidates: untouched");
  } finally {
    rail.close();
  }
});

test("reconcileX402 refuses to run when the ledger does not verify", async () => {
  const { rail } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    // Edit the charged amount through SQL: the row no longer matches the signed entry.
    rail.store.database
      .prepare("UPDATE reservations SET charged_micros = 1 WHERE id = ?")
      .run(rid);
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });

    await assert.rejects(reconcileX402(rail, chain), /ledger audit failed/);
    assert.equal(settlesFor(rail, rid).length, 1, "a refused run writes nothing");
    console.log("# reconcile unverified-ledger: refused");
  } finally {
    rail.close();
  }
});

test("readTransaction leaves isTransaction false after a throw", () => {
  const store = new BudgetStore(join(tmp(), "store.db"));
  try {
    assert.equal(inTransaction(store), false);
    assert.throws(
      () =>
        store.readTransaction(() => {
          assert.equal(inTransaction(store), true);
          throw new Error("read failed");
        }),
      /read failed/,
    );
    assert.equal(inTransaction(store), false, "the rollback closes the transaction");
  } finally {
    store.close();
  }
  console.log("# readTransaction throw: rolled back");
});

test("a nested readTransaction throws while the outer transaction stays open", () => {
  const store = new BudgetStore(join(tmp(), "store.db"));
  try {
    const result = store.readTransaction(() => {
      assert.equal(inTransaction(store), true);
      assert.throws(
        () => store.readTransaction(() => "inner"),
        /cannot start a transaction within a transaction/,
      );
      assert.equal(inTransaction(store), true, "the outer transaction is still open");
      return "outer";
    });
    assert.equal(result, "outer");
    assert.equal(inTransaction(store), false, "the outer transaction commits");
  } finally {
    store.close();
  }
  console.log("# readTransaction nested: inner refused, outer open");
});

test("reconcileReport refuses a ledger with a hot journal", async () => {
  const { rail, dbPath } = openRail();
  const rid = book(rail);
  rail.store.chargeFull(rid, details());
  rail.close();
  writeFileSync(`${dbPath}-journal`, "hot");
  const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
  await assert.rejects(reconcileReport(dbPath, chain), /hot journal/);
  console.log("# reconcile hot-journal: refused");
});

test("a ledger that changed during the report is refused", () => {
  const { rail, dbPath } = openRail();
  const rid = book(rail);
  rail.store.chargeFull(rid, details());
  rail.close();

  const opened = openReportDatabase(dbPath);
  try {
    appendFileSync(dbPath, "x");
    assert.throws(() => opened.assertUnchanged(), /the ledger changed during the report/);
  } finally {
    opened.db.close();
    opened.cleanup();
  }
  console.log("# reconcile report-changed: refused");
});

test("a ledger that keeps changing while it is copied is refused", async () => {
  const { rail, dbPath } = openRail();
  const rid = book(rail);
  rail.store.chargeFull(rid, details());
  rail.close();
  // Force the copy path and give the writer a file large enough to overlap.
  writeFileSync(`${dbPath}-wal`, "");
  appendFileSync(dbPath, Buffer.alloc(8 * 1024 * 1024));

  const script = `
    const fs = require("node:fs");
    const path = ${JSON.stringify(dbPath)};
    process.stdout.write("ready\\n");
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      try { const now = new Date(); fs.utimesSync(path, now, now); } catch {}
    }
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout!, "data");
  try {
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
    await assert.rejects(reconcileReport(dbPath, chain), /kept changing/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  console.log("# reconcile report-kept-changing: refused");
});

test("reconcileReport on a closed database reports the same and writes nothing", async () => {
  const { rail, trusted, dbPath } = openRail();
  const rid = book(rail);
  rail.store.chargeFull(rid, details());
  rail.close();

  const dir = join(dbPath, "..");
  const before = readFileSync(dbPath);
  const beforeListing = readdirSync(dir).sort();
  const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
  const report = await reconcileReport(dbPath, chain, { trusted });

  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.reservationId, rid);
  assert.equal(report.results[0]!.result, "released");
  assert.equal(report.releasedMicros, MICROS);

  const after = readFileSync(dbPath);
  assert.equal(Buffer.compare(before, after), 0, "the read-only report must not write to the database file");
  assert.deepEqual(readdirSync(dir).sort(), beforeListing, "the report must not create sidecar files");

  const check = openReadOnly(dbPath);
  try {
    const row = check.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as { status: string };
    assert.equal(row.status, "charged_full", "the row is untouched by the report");
  } finally {
    check.close();
  }
  console.log("# reconcile report-readonly: released");
});

test("reconcileReport refuses a ledger it cannot verify when a trusted key is given", async () => {
  const { rail, trusted, dbPath } = openRail();
  const rid = book(rail);
  rail.store.chargeFull(rid, details());
  rail.close();

  // Tamper with a signed entry through SQL: the chain no longer verifies.
  const raw = new DatabaseSync(dbPath);
  raw.exec("UPDATE ledger_entries SET payload = '{\"tampered\":true}' WHERE seq = 1");
  raw.close();

  const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
  await assert.rejects(reconcileReport(dbPath, chain, { trusted }), /ledger verify failed/);
  console.log("# reconcile report-verify: refused a tampered ledger");
});

test("reconcileReport reads a live writer's ledger from a consistent copy", async () => {
  const { rail, trusted, dbPath } = openRail();
  try {
    const rid = book(rail);
    rail.store.chargeFull(rid, details());
    const dir = join(dbPath, "..");
    const beforeListing = readdirSync(dir).sort();
    const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });

    const report = await reconcileReport(dbPath, chain, { trusted });
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]!.reservationId, rid);
    assert.equal(report.results[0]!.result, "released");
    assert.equal(report.releasedMicros, MICROS);
    assert.deepEqual(readdirSync(dir).sort(), beforeListing, "the report leaves the live ledger directory unchanged");

    const row = rail.store.database.prepare("SELECT status FROM reservations WHERE id = ?").get(rid) as {
      status: string;
    };
    assert.equal(row.status, "charged_full", "the live row is untouched by the report");
    console.log("# reconcile report-live-writer: released");
  } finally {
    rail.close();
  }
});

test("reconcileReport skips a row that disagrees with the signed settle entry", async () => {
  const { rail, trusted, dbPath } = openRail();
  const rid = book(rail);
  rail.store.chargeFull(rid, details());
  const chain = makeChain({ used: false, block: blk(1n, VALID_BEFORE + 100, "safe") });
  const released = await reconcileX402(rail, chain);
  assert.equal(released.results[0]!.result, "released");
  rail.close();

  // Flip the unsigned row back to charged_full. The last signed entry still
  // says released, so the row must not be reported as a candidate.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`UPDATE reservations SET status = 'charged_full', charged_micros = ${MICROS} WHERE id = '${rid}'`);
  raw.close();

  const report = await reconcileReport(dbPath, chain, { trusted });
  assert.deepEqual(report.results, [], "the unsigned row is not trusted");
  assert.equal(report.releasedMicros, 0);
  console.log("# reconcile report-tampered-row: skipped");
});
