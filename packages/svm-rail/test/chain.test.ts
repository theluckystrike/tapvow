import { describe, expect, test } from "vitest";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { rpcSolanaChain, checkNetworkGenesis, SOLANA_DEVNET_GENESIS_HASH, SOLANA_MAINNET_GENESIS_HASH } from "../src/chain.js";
import { NETWORK, PAYEE, USDC_MINT } from "./helpers.js";

const PAYER = "4pfvnqqv8wSp6BjCSu59siFZCnTwa3ZTkmFNpb5Y77PQ";

function rpc(networkFee: unknown = null): {
  getLatestBlockhash(): { send(): Promise<unknown> };
  getTransaction(): { send(): Promise<unknown> };
  getSignaturesForAddress(): { send(): Promise<unknown[]> };
} {
  return {
    getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
    getTransaction: () => ({ send: async () => networkFee }),
    getSignaturesForAddress: () => ({ send: async () => [] }),
  };
}

function transaction(meta: Record<string, unknown>): Record<string, unknown> {
  return { transaction: { message: { instructions: [] } }, meta: { err: null, slot: 1, ...meta } };
}

const FACTS = {
  network: NETWORK,
  mint: USDC_MINT,
  payTo: PAYEE,
  amountAtomic: "10000",
  payer: PAYER,
};

describe("the balance delta fallback", () => {
  test("accepts a transaction that debits the payer and credits the payee", async () => {
    const chain = rpc(
      transaction({
        preTokenBalances: [
          { accountIndex: 0, owner: PAYER, mint: USDC_MINT, uiTokenAmount: { amount: "20000" } },
          { accountIndex: 1, owner: PAYEE, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 0, owner: PAYER, mint: USDC_MINT, uiTokenAmount: { amount: "10000" } },
          { accountIndex: 1, owner: PAYEE, mint: USDC_MINT, uiTokenAmount: { amount: "10000" } },
        ],
      }),
    );

    expect(await rpcSolanaChain(chain).verifyTransfer("sig", FACTS)).toMatchObject({ status: "success" });
  });

  test("refuses a transaction that credits the payee without debiting the payer", async () => {
    const chain = rpc(
      transaction({
        preTokenBalances: [
          { accountIndex: 1, owner: PAYEE, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        ],
        postTokenBalances: [
          { accountIndex: 1, owner: PAYEE, mint: USDC_MINT, uiTokenAmount: { amount: "10000" } },
        ],
      }),
    );

    expect(await rpcSolanaChain(chain).verifyTransfer("sig", FACTS)).toMatchObject({ status: "mismatch" });
  });
});

interface SignatureEntry {
  signature: string;
  blockTime: number;
}

async function destinationFor(): Promise<string> {
  const [destination] = await findAssociatedTokenPda({
    mint: USDC_MINT as never,
    owner: PAYEE as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return String(destination);
}

function transferTransaction(destination: string): Record<string, unknown> {
  return {
    transaction: {
      message: {
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                mint: USDC_MINT,
                destination,
                authority: PAYER,
                tokenAmount: { amount: "10000" },
              },
            },
          },
        ],
      },
    },
    meta: { err: null, slot: 1 },
  };
}

function pagedSignatures(entries: SignatureEntry[]) {
  return (_address: string, config?: unknown) => ({
    send: async () => {
      const { limit = 20, before } = (config ?? {}) as { limit?: number; before?: string };
      const start = before === undefined ? 0 : entries.findIndex((entry) => entry.signature === before) + 1;
      return entries.slice(start, start + limit);
    },
  });
}

const sinceMs = Date.now() - 60_000;
const recentSeconds = Math.floor(Date.now() / 1000);

describe("findTransfer scans the payer history safely", () => {
  test("pages past the first twenty signatures", async () => {
    const destination = await destinationFor();
    const entries: SignatureEntry[] = Array.from({ length: 26 }, (_, index) => ({
      signature: `signature-${index}`,
      blockTime: recentSeconds,
    }));
    const target = entries[24]!.signature;
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: (signature: string) => ({
        send: async () =>
          signature === target ? transferTransaction(destination) : null,
      }),
      getSignaturesForAddress: pagedSignatures(entries),
    };

    expect(await rpcSolanaChain(chain).findTransfer({ ...FACTS, sinceMs })).toEqual({ kind: "found", signature: target });
  });

  test("retries one failed read with backoff", async () => {
    const destination = await destinationFor();
    const entries: SignatureEntry[] = [
      { signature: "newer", blockTime: recentSeconds },
      { signature: "target", blockTime: recentSeconds },
    ];
    let attempts = 0;
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: (signature: string) => ({
        send: async () => {
          if (signature !== "target") return null;
          attempts += 1;
          if (attempts === 1) throw new Error("rpc hiccup");
          return transferTransaction(destination);
        },
      }),
      getSignaturesForAddress: pagedSignatures(entries),
    };

    expect(
      await rpcSolanaChain(chain, { retryAttempts: 3, retryBaseDelayMs: 1 }).findTransfer({
        ...FACTS,
        sinceMs,
      }),
    ).toEqual({ kind: "found", signature: "target" });
    expect(attempts).toBe(2);
  });

  test("keeps looking after one signature that never reads", async () => {
    const destination = await destinationFor();
    const entries: SignatureEntry[] = [
      { signature: "broken", blockTime: recentSeconds },
      { signature: "target", blockTime: recentSeconds },
    ];
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: (signature: string) => ({
        send: async () => {
          if (signature === "broken") throw new Error("rpc down");
          if (signature === "target") return transferTransaction(destination);
          return null;
        },
      }),
      getSignaturesForAddress: pagedSignatures(entries),
    };

    expect(
      await rpcSolanaChain(chain, { retryAttempts: 2, retryBaseDelayMs: 1 }).findTransfer({
        ...FACTS,
        sinceMs,
      }),
    ).toEqual({ kind: "found", signature: "target" });
  });

  test("retries a failed signature page read", async () => {
    const destination = await destinationFor();
    const entries: SignatureEntry[] = [{ signature: "target", blockTime: recentSeconds }];
    let pageAttempts = 0;
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: (signature: string) => ({
        send: async () => (signature === "target" ? transferTransaction(destination) : null),
      }),
      getSignaturesForAddress: (_address: string, config?: unknown) => ({
        send: async () => {
          pageAttempts += 1;
          if (pageAttempts === 1) throw new Error("page hiccup");
          return pagedSignatures(entries)(_address, config).send();
        },
      }),
    };

    expect(
      await rpcSolanaChain(chain, { retryAttempts: 3, retryBaseDelayMs: 1 }).findTransfer({
        ...FACTS,
        sinceMs,
      }),
    ).toEqual({ kind: "found", signature: "target" });
    expect(pageAttempts).toBe(2);
  });

  test("stops at the scan cap and reports it", async () => {
    const destination = await destinationFor();
    const entries: SignatureEntry[] = Array.from({ length: 10 }, (_, index) => ({
      signature: `signature-${index}`,
      blockTime: recentSeconds,
    }));
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: (signature: string) => ({
        send: async () =>
          signature === entries[7]!.signature ? transferTransaction(destination) : null,
      }),
      getSignaturesForAddress: pagedSignatures(entries),
    };
    const scans: Array<{ scanned: number; capped: boolean }> = [];

    const result = await rpcSolanaChain(chain, {
      searchLimit: 5,
      onScan: (info) => scans.push(info),
    }).findTransfer({ ...FACTS, sinceMs });

    expect(result).toEqual({ kind: "incomplete", capped: true, timedOut: false });
    expect(scans).toEqual([{ scanned: 5, capped: true }]);
  });
});

describe("the history scan deadline", () => {
  test("stops the scan when the deadline passes and reports it", async () => {
    const entries: SignatureEntry[] = Array.from({ length: 10 }, (_, index) => ({
      signature: `signature-${index}`,
      blockTime: recentSeconds,
    }));
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: () => ({
        send: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return null;
        },
      }),
      getSignaturesForAddress: pagedSignatures(entries),
    };
    const scans: Array<{ scanned: number; capped: boolean; timedOut?: boolean }> = [];

    const result = await rpcSolanaChain(chain, {
      pageSize: 1,
      searchLimit: 20,
      scanTimeoutMs: 40,
      onScan: (info) => scans.push(info),
    }).findTransfer({ ...FACTS, sinceMs });

    expect(result).toEqual({ kind: "incomplete", capped: false, timedOut: true });
    expect(scans).toHaveLength(1);
    expect(scans[0]!.timedOut).toBe(true);
    expect(scans[0]!.scanned).toBeLessThan(entries.length);
  });
});

describe("the network genesis check", () => {
  // Fixtures are the exact values the live RPCs return.
  const DEVNET_RPC_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const MAINNET_RPC_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const DEVNET_NETWORK = `solana:${DEVNET_RPC_GENESIS.slice(0, 32)}`;
  const MAINNET_NETWORK = `solana:${MAINNET_RPC_GENESIS.slice(0, 32)}`;

  test("the constants are the full 44 character RPC values", () => {
    expect(SOLANA_DEVNET_GENESIS_HASH).toBe(DEVNET_RPC_GENESIS);
    expect(SOLANA_MAINNET_GENESIS_HASH).toBe(MAINNET_RPC_GENESIS);
  });

  test("accepts a devnet network on the real devnet genesis hash", () => {
    expect(() => checkNetworkGenesis([DEVNET_NETWORK], DEVNET_RPC_GENESIS)).not.toThrow();
  });

  test("accepts a mainnet network on the real mainnet genesis hash", () => {
    expect(() => checkNetworkGenesis([MAINNET_NETWORK], MAINNET_RPC_GENESIS)).not.toThrow();
  });

  test("refuses a wrong genesis hash that shares the devnet prefix", () => {
    const wrong = `${DEVNET_RPC_GENESIS.slice(0, 32)}xxxxxxxxxxxx`;
    expect(() => checkNetworkGenesis([DEVNET_NETWORK], wrong)).toThrow(
      /not a supported devnet or mainnet network/,
    );
  });

  test("refuses a mainnet RPC on a devnet network", () => {
    expect(() => checkNetworkGenesis([DEVNET_NETWORK], SOLANA_MAINNET_GENESIS_HASH)).toThrow(
      /does not match the configured network/,
    );
  });

  test("refuses a devnet RPC on a mainnet network", () => {
    expect(() => checkNetworkGenesis([MAINNET_NETWORK], SOLANA_DEVNET_GENESIS_HASH)).toThrow(
      /does not match the configured network/,
    );
  });

  test("refuses a genesis hash that is neither devnet nor mainnet", () => {
    expect(() => checkNetworkGenesis([DEVNET_NETWORK], "test-validator-genesis")).toThrow(
      /not a supported devnet or mainnet network/,
    );
  });

  test("refuses a rail that mixes two networks on one RPC", () => {
    expect(() => checkNetworkGenesis([DEVNET_NETWORK, MAINNET_NETWORK], SOLANA_DEVNET_GENESIS_HASH)).toThrow(
      /does not match the configured network/,
    );
  });

  test("refuses a rail with no configured network", () => {
    expect(() => checkNetworkGenesis([], SOLANA_DEVNET_GENESIS_HASH)).toThrow(/no Solana network is configured/);
  });

  function genesisRpc(value: unknown) {
    return {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getGenesisHash: () => ({ send: async () => value }),
      getTransaction: () => ({ send: async () => null }),
      getSignaturesForAddress: () => ({ send: async () => [] }),
    };
  }

  test("the adapter reads the genesis hash from the RPC", async () => {
    const adapter = rpcSolanaChain(genesisRpc(SOLANA_MAINNET_GENESIS_HASH));
    if (!adapter.getGenesisHash) throw new Error("the adapter has no genesis read");

    expect(await adapter.getGenesisHash()).toBe(SOLANA_MAINNET_GENESIS_HASH);
  });

  test("the adapter refuses an empty genesis hash from the RPC", async () => {
    const adapter = rpcSolanaChain(genesisRpc(""));
    if (!adapter.getGenesisHash) throw new Error("the adapter has no genesis read");

    await expect(adapter.getGenesisHash()).rejects.toThrow(/no genesis hash/);
  });
});

describe("the settle read asks for finalized", () => {
  function recordingRpc(reads: Array<unknown>): {
    calls: Array<{ signature: string; commitment: string }>;
    chain: {
      getLatestBlockhash(): { send(): Promise<unknown> };
      getTransaction(signature: string, config: unknown): { send(): Promise<unknown> };
      getSignaturesForAddress(): { send(): Promise<unknown[]> };
    };
  } {
    const calls: Array<{ signature: string; commitment: string }> = [];
    let index = 0;
    return {
      calls,
      chain: {
        getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
        getTransaction: (signature: string, config: unknown) => {
          const commitment = String((config as { commitment?: string } | undefined)?.commitment ?? "");
          calls.push({ signature, commitment });
          const read = reads[Math.min(index, reads.length - 1)];
          index += 1;
          return { send: async () => read };
        },
        getSignaturesForAddress: () => ({ send: async () => [] }),
      },
    };
  }

  test("asks the RPC for a finalized transaction", async () => {
    const destination = await destinationFor();
    const { calls, chain } = recordingRpc([transferTransaction(destination)]);

    const result = await rpcSolanaChain(chain).verifyTransfer("sig", FACTS);

    expect(result).toMatchObject({ status: "success" });
    expect(calls).toEqual([{ signature: "sig", commitment: "finalized" }]);
  });

  test("waits for a transaction that finalizes after a delay", async () => {
    const destination = await destinationFor();
    // Three pending reads are more than the old 3 attempt, ~300 ms budget allowed.
    const { calls, chain } = recordingRpc([null, null, null, transferTransaction(destination)]);

    const result = await rpcSolanaChain(chain, {
      retryAttempts: 3,
      retryBaseDelayMs: 1,
      settleTimeoutMs: 2_000,
      settleRetryBaseDelayMs: 5,
    }).verifyTransfer("sig", FACTS);

    expect(result).toMatchObject({ status: "success" });
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.commitment === "finalized")).toBe(true);
  });

  test("stops at the settle deadline and stays pending", async () => {
    const { calls, chain } = recordingRpc([null]);
    const started = Date.now();

    const result = await rpcSolanaChain(chain, {
      settleTimeoutMs: 60,
      settleRetryBaseDelayMs: 5,
    }).verifyTransfer("sig", FACTS);

    expect(result).toMatchObject({ status: "pending" });
    expect(calls.length).toBeGreaterThan(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("does not retry a failure the chain already reported", async () => {
    const { calls, chain } = recordingRpc([{ meta: { err: { InstructionError: [0, "Custom"] } } }]);

    const result = await rpcSolanaChain(chain, { retryAttempts: 3, retryBaseDelayMs: 1 }).verifyTransfer(
      "sig",
      FACTS,
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(1);
  });

  test("the early history check keeps confirmed", async () => {
    const destination = await destinationFor();
    const commitments: string[] = [];
    const chain = {
      getLatestBlockhash: () => ({ send: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }) }),
      getTransaction: (_signature: string, config: unknown) => {
        commitments.push(String((config as { commitment?: string } | undefined)?.commitment ?? ""));
        return { send: async () => transferTransaction(destination) };
      },
      getSignaturesForAddress: pagedSignatures([{ signature: "target", blockTime: recentSeconds }]),
    };

    expect(await rpcSolanaChain(chain).findTransfer({ ...FACTS, sinceMs })).toEqual({ kind: "found", signature: "target" });
    expect(commitments).toEqual(["confirmed"]);
  });
});
