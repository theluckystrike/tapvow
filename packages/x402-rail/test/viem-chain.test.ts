// The real viemAuthorizationChain adapter over a stubbed JSON-RPC transport.
// It must pin the safe block (with the documented fallbacks), pass the pinned
// block number to authorizationState, derive a fromBlock for the log scan, and
// accept only the Transfer in the receipt that matches the signed payee and
// amount (a batch transaction can carry several).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, getAddress, pad, toHex, type Address, type PublicClient } from "viem";
import { viemAuthorizationChain } from "../src/reconcile.js";

const ASSET = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const PAYER = getAddress("0x1111111111111111111111111111111111111111");
const PAY_TO = getAddress("0x2222222222222222222222222222222222222222");
const OTHER = getAddress("0x3333333333333333333333333333333333333333");
const NONCE = `0x${"ab".repeat(32)}` as const;
const TX = `0x${"cd".repeat(32)}` as const;
const ZERO32 = `0x${"00".repeat(32)}` as const;
const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const AUTH_USED_SIG = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5" as const;
const AUTH_CANCELED_SIG = "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81" as const;
const BLOOM = `0x${"00".repeat(256)}` as const;

type Handler = (params: unknown[]) => unknown;

function stubClient(handlers: Record<string, Handler>): {
  client: PublicClient;
  calls: Array<{ method: string; params: unknown[] }>;
} {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const list = (params ?? []) as unknown[];
      calls.push({ method, params: list });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected RPC method ${method}`);
      return handler(list);
    },
  });
  return { client: createPublicClient({ transport }) as PublicClient, calls };
}

function rawBlock(number: `0x${string}`, timestamp: `0x${string}`): unknown {
  return {
    number,
    hash: ZERO32,
    parentHash: ZERO32,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO32,
    logsBloom: BLOOM,
    transactionsRoot: ZERO32,
    stateRoot: ZERO32,
    receiptsRoot: ZERO32,
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

function rawLog(over: Record<string, unknown>): unknown {
  return {
    address: ASSET,
    topics: [],
    data: "0x",
    blockNumber: "0x100",
    transactionHash: TX,
    transactionIndex: "0x0",
    logIndex: "0x0",
    blockHash: ZERO32,
    removed: false,
    ...over,
  };
}

function addrTopic(address: Address): `0x${string}` {
  return pad(address, { size: 32 });
}

test("latestBlock pins the safe tag and its number", async () => {
  const { client } = stubClient({
    eth_getBlockByNumber: (params) =>
      params[0] === "safe" ? rawBlock("0x10", "0x64") : (() => { throw new Error(`no tag ${String(params[0])}`); })(),
  });
  const block = await viemAuthorizationChain(client).latestBlock();
  assert.deepEqual(block, { number: 16n, timestamp: 100, hash: ZERO32, tag: "safe" });
});

test("latestBlock falls back to finalized when safe is unsupported", async () => {
  const { client } = stubClient({
    eth_getBlockByNumber: (params) =>
      params[0] === "finalized" ? rawBlock("0xf", "0x63") : (() => { throw new Error("unsupported"); })(),
  });
  const block = await viemAuthorizationChain(client).latestBlock();
  assert.deepEqual(block, { number: 15n, timestamp: 99, hash: ZERO32, tag: "finalized" });
});

test("latestBlock falls back to latest minus 12 when neither tag works", async () => {
  const { client } = stubClient({
    eth_getBlockByNumber: (params) => {
      if (params[0] === "latest") return rawBlock("0x20", "0x100");
      if (params[0] === "0x14") return rawBlock("0x14", "0xe0");
      throw new Error("unsupported");
    },
  });
  const block = await viemAuthorizationChain(client).latestBlock();
  assert.deepEqual(block, { number: 20n, timestamp: 224, hash: ZERO32, tag: "latest-12" });
});

test("authorizationUsed reads at the pinned block and decodes the bool", async () => {
  const { client, calls } = stubClient({
    eth_call: () => toHex(1n, { size: 32 }),
  });
  const used = await viemAuthorizationChain(client).authorizationUsed(ASSET, PAYER, NONCE, 42n);
  assert.equal(used, true);
  assert.match(JSON.stringify(calls[calls.length - 1]), /0x2a/, "the pinned block number is sent");
});

test("findAuthorizationTx derives the fromBlock and picks the matching Transfer", async () => {
  const { client, calls } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => {
      if (params[0] === "0x0") return rawBlock("0x0", "0x3e8");
      if (params[0] === "0x100") return rawBlock("0x100", "0x7d0");
      throw new Error("unexpected block");
    },
    eth_getLogs: () => [rawLog({ topics: [AUTH_USED_SIG, addrTopic(PAYER), NONCE] })],
    eth_getTransactionReceipt: () => ({
      transactionHash: TX,
      transactionIndex: "0x0",
      blockHash: ZERO32,
      blockNumber: "0x100",
      from: PAYER,
      to: ASSET,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [
        rawLog({ topics: [TRANSFER_SIG, addrTopic(PAYER), addrTopic(OTHER)], data: toHex(999n, { size: 32 }), logIndex: "0x1" }),
        rawLog({ topics: [TRANSFER_SIG, addrTopic(PAYER), addrTopic(PAY_TO)], data: toHex(10_000n, { size: 32 }), logIndex: "0x2" }),
      ],
      logsBloom: BLOOM,
      status: "0x1",
      type: "0x2",
      effectiveGasPrice: "0x1",
    }),
  });

  const found = await viemAuthorizationChain(client).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    2_000,
    2_000,
    0x180n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.ok(found);
  assert.equal(found.txHash, TX);
  assert.equal(found.from.toLowerCase(), PAYER.toLowerCase());
  assert.equal(found.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(found.value, 10_000n);
  assert.equal(found.status, "success");

  const logsCall = calls.find((c) => c.method === "eth_getLogs");
  const request = logsCall?.params[0] as { fromBlock?: string; toBlock?: string } | undefined;
  assert.equal(request?.fromBlock, "0x100", "the derived block is the floor for the scan");
  assert.equal(request?.toBlock, "0x100", "the scan stops at the valid_before block, below the pinned block");
});

test("findAuthorizationTx honors an explicit fromBlock floor", async () => {
  const { client, calls } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => (params[0] === "0x0" ? rawBlock("0x0", "0x3e8") : rawBlock("0x100", "0x7d0")),
    eth_getLogs: () => [],
  });
  const found = await viemAuthorizationChain(client, { fromBlock: 0x50 }).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    0,
    2_000,
    0x100n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.equal(found, null);
  const logsCall = calls.find((c) => c.method === "eth_getLogs");
  const request = logsCall?.params[0] as { fromBlock?: string } | undefined;
  assert.equal(request?.fromBlock, "0x50");
});

test("a pruned region above an explicit fromBlock starts the scan at the floor", async () => {
  const earliest = 0x80n;
  const blockTs = 0x7d0n; // 2000, the timestamp of the earliest available block
  const hex = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;
  const { client, calls } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => {
      const tag = String(params[0]);
      const number = tag === "latest" ? 0x100n : BigInt(tag);
      if (number < earliest) throw new Error("pruned history unavailable");
      return rawBlock(hex(number), hex(blockTs + (number - earliest)));
    },
    eth_getLogs: () => [rawLog({ topics: [AUTH_USED_SIG, addrTopic(PAYER), NONCE] })],
    eth_getTransactionReceipt: () => ({
      transactionHash: TX,
      transactionIndex: "0x0",
      blockHash: ZERO32,
      blockNumber: "0x100",
      from: PAYER,
      to: ASSET,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [rawLog({ topics: [TRANSFER_SIG, addrTopic(PAYER), addrTopic(PAY_TO)], data: toHex(10_000n, { size: 32 }) })],
      logsBloom: BLOOM,
      status: "0x1",
      type: "0x2",
      effectiveGasPrice: "0x1",
    }),
  });

  const found = await viemAuthorizationChain(client, { fromBlock: 0x50 }).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    2_000,
    2_000,
    0x100n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.ok(found, "a pruned node still finds the authorization");
  assert.equal(found.txHash, TX);
  const logsCall = calls.find((c) => c.method === "eth_getLogs");
  const request = logsCall?.params[0] as { fromBlock?: string; toBlock?: string } | undefined;
  assert.equal(request?.fromBlock, "0x50", "the scan starts at the explicit floor, not above it");
  assert.equal(request?.toBlock, "0x80", "the upper bound still reaches above the pruned region");
});

test("a pruned block with no explicit fromBlock asks for one instead of guessing", async () => {
  const earliest = 0x90n;
  const hex = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;
  const { client } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => {
      const tag = String(params[0]);
      const number = tag === "latest" ? 0x100n : BigInt(tag);
      if (number < earliest) throw new Error("pruned history unavailable");
      return rawBlock(hex(number), hex(0x7d0n + (number - earliest)));
    },
    eth_getLogs: () => [],
  });

  await assert.rejects(
    viemAuthorizationChain(client).findAuthorizationTx(ASSET, PAYER, NONCE, 2_000, 2_000, 0x100n, {
      to: PAY_TO,
      value: 10_000n,
    }),
    /the node has pruned history below block .* pass fromBlock/,
  );
});

test("findAuthorizationTx binary-searches a long chain and bounds the scan", async () => {
  const ts = (n: bigint): bigint => 1_000_000n + n * 12n;
  const hex = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;
  const { client, calls } = stubClient({
    eth_blockNumber: () => "0x3e8",
    eth_getBlockByNumber: (params) => {
      const tag = String(params[0]);
      const number = tag === "latest" ? 0x3e8n : BigInt(tag);
      return rawBlock(hex(number), hex(ts(number)));
    },
    eth_getLogs: () => [],
  });

  const fromTimestamp = Number(ts(500n)) + 6;
  const validBefore = Number(ts(900n));
  const found = await viemAuthorizationChain(client).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    fromTimestamp,
    validBefore,
    1_000n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.equal(found, null);
  const logsCall = calls.find((c) => c.method === "eth_getLogs");
  const request = logsCall?.params[0] as { fromBlock?: string; toBlock?: string } | undefined;
  assert.equal(request?.fromBlock, "0x1f4", "the block just before the timestamp between 500 and 501");
  assert.equal(request?.toBlock, "0x384", "bounded by the block at valid_before, not the tip");
  assert.ok(
    calls.filter((c) => c.method === "eth_getBlockByNumber").length > 10,
    "the binary search visits several blocks",
  );
});

test("logChunkSize 100 over a 250-block range sends exactly three getLogs ranges", async () => {
  const ts = (n: bigint): bigint => 1_000n + n * 12n;
  const hex = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;
  const { client, calls } = stubClient({
    eth_blockNumber: () => "0x3e8",
    eth_getBlockByNumber: (params) => {
      const tag = String(params[0]);
      const number = tag === "latest" ? 0x3e8n : BigInt(tag);
      return rawBlock(hex(number), hex(ts(number)));
    },
    eth_getLogs: () => [],
  });

  const found = await viemAuthorizationChain(client, { logChunkSize: 100 }).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    Number(ts(0n)),
    Number(ts(249n)),
    0x3e8n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.equal(found, null);
  const ranges = calls
    .filter((c) => c.method === "eth_getLogs")
    .map((c) => {
      const request = c.params[0] as { fromBlock: string; toBlock: string };
      return `${request.fromBlock}-${request.toBlock}`;
    });
  assert.deepEqual(ranges, ["0x0-0x63", "0x64-0xc7", "0xc8-0xf9"], "250 blocks in three chunks of 100");
});

test("findAuthorizationCanceled returns true when the cancel log is in the scanned range", async () => {
  const { client } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => rawBlock(String(params[0]) as `0x${string}`, "0x7d0"),
    eth_getLogs: () => [rawLog({ topics: [AUTH_CANCELED_SIG, addrTopic(PAYER), NONCE] })],
  });
  const chain = viemAuthorizationChain(client);
  const canceled = await chain.findAuthorizationCanceled!(ASSET, PAYER, NONCE, 2_000, 2_000, 0x100n);
  assert.equal(canceled, true);
});

test("findAuthorizationCanceled returns false when no cancel log is found", async () => {
  const { client } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => rawBlock(String(params[0]) as `0x${string}`, "0x7d0"),
    eth_getLogs: () => [],
  });
  const chain = viemAuthorizationChain(client);
  const canceled = await chain.findAuthorizationCanceled!(ASSET, PAYER, NONCE, 2_000, 2_000, 0x100n);
  assert.equal(canceled, false);
});

test("findAuthorizationTx returns the fallback when no Transfer matches", async () => {
  const { client } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => rawBlock(String(params[0]) as `0x${string}`, "0x7d0"),
    eth_getLogs: () => [rawLog({ topics: [AUTH_USED_SIG, addrTopic(PAYER), NONCE] })],
    eth_getTransactionReceipt: () => ({
      transactionHash: TX,
      transactionIndex: "0x0",
      blockHash: ZERO32,
      blockNumber: "0x100",
      from: PAYER,
      to: ASSET,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [
        rawLog({ topics: [TRANSFER_SIG, addrTopic(PAYER), addrTopic(OTHER)], data: toHex(999n, { size: 32 }) }),
      ],
      logsBloom: BLOOM,
      status: "0x1",
      type: "0x2",
      effectiveGasPrice: "0x1",
    }),
  });

  const found = await viemAuthorizationChain(client).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    2_000,
    2_000,
    0x100n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.ok(found, "the adapter returns the transaction facts for the caller to reject");
  assert.equal(found.to.toLowerCase(), OTHER.toLowerCase());
  assert.equal(found.value, 999n);
});

test("findAuthorizationTx reports a reverted receipt", async () => {
  const { client } = stubClient({
    eth_blockNumber: () => "0x100",
    eth_getBlockByNumber: (params) => rawBlock(String(params[0]) as `0x${string}`, "0x7d0"),
    eth_getLogs: () => [rawLog({ topics: [AUTH_USED_SIG, addrTopic(PAYER), NONCE] })],
    eth_getTransactionReceipt: () => ({
      transactionHash: TX,
      transactionIndex: "0x0",
      blockHash: ZERO32,
      blockNumber: "0x100",
      from: PAYER,
      to: ASSET,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [rawLog({ topics: [TRANSFER_SIG, addrTopic(PAYER), addrTopic(PAY_TO)], data: toHex(10_000n, { size: 32 }) })],
      logsBloom: BLOOM,
      status: "0x0",
      type: "0x2",
      effectiveGasPrice: "0x1",
    }),
  });

  const found = await viemAuthorizationChain(client).findAuthorizationTx(
    ASSET,
    PAYER,
    NONCE,
    2_000,
    2_000,
    0x100n,
    { to: PAY_TO, value: 10_000n },
  );
  assert.ok(found);
  assert.equal(found.status, "reverted");
});

test("an empty log scan from a node behind the pinned block is an error", async () => {
  const { client } = stubClient({
    eth_blockNumber: () => "0x50",
    eth_getBlockByNumber: (params) => rawBlock(String(params[0]) as `0x${string}`, "0x7d0"),
    eth_getLogs: () => [],
  });

  await assert.rejects(
    viemAuthorizationChain(client).findAuthorizationTx(ASSET, PAYER, NONCE, 2_000, 2_000, 0x100n, {
      to: PAY_TO,
      value: 10_000n,
    }),
    /node is behind the pinned block/,
  );
});

test("chainId is read once and cached", async () => {
  const { client, calls } = stubClient({ eth_chainId: () => "0x14a34" });
  const chain = viemAuthorizationChain(client);
  assert.equal(await chain.chainId(), 84532);
  assert.equal(await chain.chainId(), 84532);
  assert.equal(calls.filter((c) => c.method === "eth_chainId").length, 1);
});
