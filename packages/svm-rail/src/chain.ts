// The real Solana chain adapter. It reads one transaction signature through
// jsonParsed RPC and checks the TransferChecked instruction against the facts
// the rail signed. All calls have a deadline, so a stuck RPC cannot hold a
// budget reservation open forever.
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { ChainVerification, SolanaChain, TransferFacts, TransferSearch } from "./types.js";

export interface SolanaRpcLike {
  getLatestBlockhash(): { send(options?: unknown): Promise<unknown> };
  getGenesisHash?(): { send(options?: unknown): Promise<unknown> };
  getTransaction(signature: string, config: unknown): { send(options?: unknown): Promise<unknown> };
  getSignaturesForAddress(address: string, config?: unknown): { send(options?: unknown): Promise<unknown> };
}

/** Full genesis hash of Solana devnet, as getGenesisHash returns it. */
export const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Full genesis hash of Solana mainnet beta, as getGenesisHash returns it. */
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * The CAIP-2 Solana id uses the first 32 characters of the genesis hash, not
 * the full 44 characters the RPC returns. A network id such as
 * "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" must match that prefix.
 */
export const SOLANA_CAIP2_REFERENCE_LENGTH = 32;

const KNOWN_GENESIS_HASHES = new Set([SOLANA_DEVNET_GENESIS_HASH, SOLANA_MAINNET_GENESIS_HASH]);

/**
 * Throws unless the RPC genesis hash is a known network and every configured
 * CAIP-2 network id names that same hash. A rail on the wrong chain must not
 * start, because every history lookup would miss.
 */
export function checkNetworkGenesis(networks: readonly string[], genesisHash: string): void {
  if (!KNOWN_GENESIS_HASHES.has(genesisHash)) {
    throw new Error(`the RPC genesis hash ${genesisHash} is not a supported devnet or mainnet network`);
  }
  if (networks.length === 0) throw new Error("no Solana network is configured");
  const reference = genesisHash.slice(0, SOLANA_CAIP2_REFERENCE_LENGTH);
  for (const network of networks) {
    const expected = network.startsWith("solana:") ? network.slice("solana:".length) : "";
    if (expected !== reference) {
      throw new Error(`the RPC genesis hash ${genesisHash} does not match the configured network ${network}`);
    }
  }
}

export interface RpcChainOptions {
  timeoutMs?: number;
  /** Cap on signatures read backwards when no transaction id is known. Default 200. */
  searchLimit?: number;
  /** Signatures asked for per page. Default 20. */
  pageSize?: number;
  /** Attempts for one read before it is treated as an error. Default 3. */
  retryAttempts?: number;
  /** First backoff delay in ms. Each retry doubles it. Default 100. */
  retryBaseDelayMs?: number;
  /**
   * Total time to wait for a finalized settle read. Finality lags
   * confirmation by about 13 s on Solana. Default 30000.
   */
  settleTimeoutMs?: number;
  /** First backoff delay for the finalized settle read in ms. Default 250. */
  settleRetryBaseDelayMs?: number;
  /** Overall deadline for one payer history scan. Default 15000. */
  scanTimeoutMs?: number;
  /** Called with the scan count when the search ends. */
  onScan?: (info: { scanned: number; capped: boolean; timedOut?: boolean }) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SEARCH_MARGIN_MS = 120_000;
/** Hard cap on signatures read backwards in one search. */
export const MAX_SIGNATURE_SCAN = 200;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
/** Overall deadline for one history scan. A slow RPC must not hold a call open. */
export const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
/** Bounded wait for finalized evidence. Solana finalizes about 13 s after confirmation. */
export const FINALIZED_SETTLE_TIMEOUT_MS = 30_000;
const FINALIZED_RETRY_BASE_DELAY_MS = 250;
const FINALIZED_RETRY_MAX_DELAY_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(
  read: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read();
    } catch (err) {
      last = err;
      if (attempt + 1 < attempts && baseDelayMs > 0) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function redactRpcError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw
    .replace(/\b(?:https?|wss?):\/\/[^\s)"'`]+/gi, "<rpc>")
    .slice(0, 240);
  return message.length > 0 ? `${name}: ${message}` : name;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function expectedDestinations(mint: string, payTo: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    const [ata] = await findAssociatedTokenPda({
      mint: mint as never,
      owner: payTo as never,
      tokenProgram: tokenProgram as never,
    });
    out.add(String(ata));
  }
  return out;
}

/** True when a parsed instruction is the expected transfer. */
async function hasExpectedTransfer(tx: Record<string, unknown>, facts: TransferFacts): Promise<boolean> {
  const destinations = await expectedDestinations(facts.mint, facts.payTo);
  const message = asRecord(asRecord(tx.transaction).message);
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  for (const raw of instructions) {
    const instruction = asRecord(raw);
    const program = typeof instruction.program === "string" ? instruction.program : "";
    if (program !== "spl-token" && program !== "spl-token-2022") continue;
    const parsed = asRecord(instruction.parsed);
    if (parsed.type !== "transferChecked") continue;
    const info = asRecord(parsed.info);
    const tokenAmount = asRecord(info.tokenAmount);
    const amount = typeof tokenAmount.amount === "string" ? tokenAmount.amount : "";
    const mint = typeof info.mint === "string" ? info.mint : "";
    const destination = typeof info.destination === "string" ? info.destination : "";
    const authority = typeof info.authority === "string" ? info.authority : "";
    if (mint !== facts.mint) continue;
    if (amount !== facts.amountAtomic) continue;
    if (authority !== facts.payer) continue;
    if (!destinations.has(destination)) continue;
    return true;
  }
  // Some RPC providers omit parsed instructions. The token balance delta is a
  // weaker check but still ties the mint and the payee to the transaction. It
  // must also show the payer debited, or a transfer from another agent that
  // shares the gateway key would pass as this call's payment.
  const meta = asRecord(tx.meta);
  const pre = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
  let payerDebited = false;
  for (const raw of pre) {
    const entry = asRecord(raw);
    if (entry.owner !== facts.payer || entry.mint !== facts.mint) continue;
    const index = entry.accountIndex;
    const after = post.find((candidate) => asRecord(candidate).accountIndex === index);
    const beforeAmount = asRecord(entry.uiTokenAmount).amount;
    const afterAmount = asRecord(asRecord(after).uiTokenAmount).amount;
    if (typeof beforeAmount !== "string" || typeof afterAmount !== "string") continue;
    if (BigInt(beforeAmount) - BigInt(afterAmount) === BigInt(facts.amountAtomic)) {
      payerDebited = true;
      break;
    }
  }
  if (!payerDebited) return false;
  for (const raw of post) {
    const entry = asRecord(raw);
    if (entry.owner !== facts.payTo || entry.mint !== facts.mint) continue;
    const index = entry.accountIndex;
    const before = pre.find((candidate) => asRecord(candidate).accountIndex === index);
    const beforeAmount = asRecord(asRecord(before).uiTokenAmount).amount;
    const afterAmount = asRecord(entry.uiTokenAmount).amount;
    if (typeof beforeAmount !== "string" || typeof afterAmount !== "string") continue;
    if (BigInt(afterAmount) - BigInt(beforeAmount) === BigInt(facts.amountAtomic)) return true;
  }
  return false;
}

export function rpcSolanaChain(rpc: SolanaRpcLike, options: RpcChainOptions = {}): SolanaChain {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const searchLimit = Math.min(
    Math.max(1, Math.floor(options.searchLimit ?? MAX_SIGNATURE_SCAN)),
    MAX_SIGNATURE_SCAN,
  );
  const pageSize = Math.max(1, Math.min(Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE), searchLimit));
  const retryAttempts = Math.max(1, Math.floor(options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS));
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const settleTimeoutMs = Math.max(0, options.settleTimeoutMs ?? FINALIZED_SETTLE_TIMEOUT_MS);
  const settleRetryBaseDelayMs = Math.max(1, options.settleRetryBaseDelayMs ?? FINALIZED_RETRY_BASE_DELAY_MS);
  const scanTimeoutMs = Math.max(0, options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS);

  async function readTransfer(
    signature: string,
    facts: TransferFacts,
    commitment: "confirmed" | "finalized",
  ): Promise<ChainVerification> {
    let result: unknown;
    try {
      result = await withTimeout(
        rpc
          .getTransaction(signature, {
            encoding: "jsonParsed",
            commitment,
            maxSupportedTransactionVersion: 0,
          })
          .send(),
        timeoutMs,
        "getTransaction",
      );
    } catch (err) {
      return { status: "error", reason: redactRpcError(err) };
    }
    if (result === null || result === undefined) {
      return {
        status: "pending",
        reason:
          commitment === "finalized"
            ? "the transaction is not finalized yet"
            : "the transaction is not confirmed yet",
      };
    }
    const record = asRecord(result);
    const meta = asRecord(record.meta);
    if (meta.err !== null && meta.err !== undefined) {
      return { status: "failed", reason: "the transaction failed on chain" };
    }
    try {
      if (await hasExpectedTransfer(record, facts)) return { status: "success", slot: Number(meta.slot ?? 0) };
    } catch (err) {
      return { status: "error", reason: redactRpcError(err) };
    }
    return { status: "mismatch", reason: "the transaction does not contain the signed transfer" };
  }

  async function getGenesisHash(): Promise<string> {
    if (!rpc.getGenesisHash) throw new Error("the RPC client cannot read a genesis hash");
    const result = await withTimeout(rpc.getGenesisHash().send(), timeoutMs, "getGenesisHash");
    if (typeof result !== "string" || result.length === 0) {
      throw new Error("the RPC returned no genesis hash");
    }
    return result;
  }

  // The final settle must read a transaction that cannot be dropped with its
  // fork. Finality lags confirmation by about 13 s, so poll with backoff up to
  // a bounded deadline. A read that stays pending past the deadline is handed
  // to the unconfirmed booking path, never released as if no money moved.
  async function verifyTransfer(signature: string, facts: TransferFacts): Promise<ChainVerification> {
    const deadline = Date.now() + settleTimeoutMs;
    let delay = settleRetryBaseDelayMs;
    let check = await readTransfer(signature, facts, "finalized");
    while (
      (check.status === "pending" || check.status === "error") &&
      Date.now() < deadline
    ) {
      const remaining = deadline - Date.now();
      const wait = Math.min(delay, remaining);
      if (wait > 0) await sleep(wait);
      check = await readTransfer(signature, facts, "finalized");
      delay = Math.min(delay * 2, FINALIZED_RETRY_MAX_DELAY_MS);
    }
    return check;
  }

  return {
    async preflight(): Promise<void> {
      await withTimeout(rpc.getLatestBlockhash().send(), timeoutMs, "getLatestBlockhash");
    },
    getGenesisHash,
    verifyTransfer,
    async findTransfer(facts: TransferFacts & { sinceMs: number; deadlineMs?: number }): Promise<TransferSearch> {
      let before: string | undefined;
      let scanned = 0;
      let capped = false;
      let timedOut = false;
      const deadline = facts.deadlineMs ?? Date.now() + scanTimeoutMs;

      // The history scan is an early check. It uses confirmed so the search
      // stays fast; the final settle re-reads the chosen signature at finalized.
      async function verifyWithRetry(signature: string): Promise<ChainVerification> {
        let check = await readTransfer(signature, facts, "confirmed");
        for (let attempt = 1; attempt < retryAttempts && check.status === "error"; attempt += 1) {
          if (retryBaseDelayMs > 0) await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
          check = await readTransfer(signature, facts, "confirmed");
        }
        return check;
      }

      while (scanned < searchLimit && !timedOut) {
        if (Date.now() > deadline) {
          timedOut = true;
          break;
        }
        const limit = Math.min(pageSize, searchLimit - scanned);
        const config: Record<string, unknown> = { limit };
        if (before !== undefined) config.before = before;
        let signatures: unknown;
        try {
          signatures = await withRetries(
            () =>
              withTimeout(
                rpc.getSignaturesForAddress(facts.payer, config).send(),
                timeoutMs,
                "getSignaturesForAddress",
              ),
            retryAttempts,
            retryBaseDelayMs,
          );
        } catch (err) {
          throw new Error(redactRpcError(err));
        }
        if (!Array.isArray(signatures) || signatures.length === 0) break;
        let lastSignature = "";
        let reachedOld = false;
        for (const raw of signatures) {
          if (Date.now() > deadline) {
            timedOut = true;
            break;
          }
          const entry = asRecord(raw);
          const signature = typeof entry.signature === "string" ? entry.signature : "";
          if (signature.length === 0) continue;
          lastSignature = signature;
          scanned += 1;
          const blockTime = typeof entry.blockTime === "number" ? entry.blockTime * 1000 : null;
          if (blockTime !== null && blockTime < facts.sinceMs - SEARCH_MARGIN_MS) {
            reachedOld = true;
            break;
          }
          const check = await verifyWithRetry(signature);
          if (check.status === "success") {
            options.onScan?.({ scanned, capped: false });
            return { kind: "found", signature };
          }
        }
        if (reachedOld || timedOut) break;
        if (signatures.length < limit) break;
        if (scanned >= searchLimit) {
          capped = true;
          break;
        }
        if (lastSignature.length === 0) break;
        before = lastSignature;
      }
      options.onScan?.({ scanned, capped, ...(timedOut ? { timedOut: true } : {}) });
      // The caller must not read "cap hit" or "deadline hit" as "no transfer".
      if (capped || timedOut) return { kind: "incomplete", capped, timedOut };
      return { kind: "none" };
    },
  };
}
