// Reconciles x402 payments the gateway booked as charged_full without a
// confirmed settlement.
//
// When a payment authorization is signed but settlement is not confirmed, the
// rail books the full amount with details.unconfirmed = true (fail closed). The
// authorization may then expire unused on chain (money never moved) or settle
// late through the facilitator (money moved but the ledger has no tx hash).
// reconcileX402 revisits those bookings against the chain and either releases
// them or books them as settled, in both cases appending a new signed
// x402.settle entry for the same reservation.
//
// Every fact of one run is read at ONE pinned block (safe, then finalized, then
// latest minus 12). A booking is only released from a safe or finalized block,
// and only after that block's hash is still the same immediately before the
// write; a latest-12 pin can still book a late settlement but never releases.
// The chain time of that block, not the local clock and not the tip of some
// other node, decides whether an authorization has expired. Any RPC error
// leaves the booking untouched; a used authorization is never released. Every
// ledger read is verified against the trusted keys first.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BlockNotFoundError,
  decodeEventLog,
  erc20Abi,
  getAddress,
  parseAbiItem,
  type Log,
  type PublicClient,
} from "viem";
import { eip3009ABI } from "@x402/evm";
import { Ledger, type LedgerEntry } from "@mandate/core";
import { auditRail, type GovernedRail } from "@mandate/llm-rail";

/** The result of a settlement transaction, as reconcile needs it. */
export interface AuthorizationTx {
  txHash: string;
  from: string;
  to: string;
  value: bigint;
  status: "success" | "reverted";
}

/** A pinned block: the number, its chain time, its hash and which tag produced it. */
export interface ChainBlock {
  number: bigint;
  timestamp: number;
  hash: string;
  tag: "safe" | "finalized" | "latest-12";
}

/**
 * The chain facts reconcile looks at. A fake is easy to write for tests; the
 * real one (viemAuthorizationChain) reads the USDC contract.
 */
export interface AuthorizationChain {
  /**
   * One block for the whole run: "safe" when the RPC supports it, else
   * "finalized", else "latest" minus 12 blocks. A booking is only released
   * from a safe or finalized block; everything else is read at this same block
   * number, so a lagging or load-balanced node cannot mix facts.
   */
  latestBlock(): Promise<ChainBlock>;
  /** The hash of the pinned block, re-read immediately before a release. */
  blockHash(blockNumber: bigint): Promise<string>;
  /** The chain id this client is connected to, compared with details.network. */
  chainId(): Promise<number>;
  /** ERC-20/EIP-3009 authorizationState(asset, authorizer, nonce) at blockNumber. */
  authorizationUsed(asset: string, authorizer: string, nonce: string, blockNumber: bigint): Promise<boolean>;
  /**
   * The transaction that consumed the authorization, scanning between the block
   * derived from fromTimestamp and the smaller of validBefore's block and the
   * pinned block. expected is the signed payee and amount: the returned
   * Transfer must match them (a batch may carry several).
   */
  findAuthorizationTx(
    asset: string,
    authorizer: string,
    nonce: string,
    fromTimestamp: number,
    validBefore: number,
    pinnedBlockNumber: bigint,
    expected: { to: string; value: bigint },
  ): Promise<AuthorizationTx | null>;
  /**
   * True when the authorization was cancelled on chain. Optional so a minimal
   * fake still works; without it a cancellation stays a mismatch.
   */
  findAuthorizationCanceled?(
    asset: string,
    authorizer: string,
    nonce: string,
    fromTimestamp: number,
    validBefore: number,
    pinnedBlockNumber: bigint,
  ): Promise<boolean>;
}

export type ReconcileResult = "released" | "settled" | "pending" | "mismatch" | "error" | "skipped";

export interface ReconcileOutcome {
  reservationId: string;
  result: ReconcileResult;
  reason?: string;
  txHash?: string;
}

export interface ReconcileReport {
  results: ReconcileOutcome[];
  /** Micros released back to the budget by this run. */
  releasedMicros: number;
  /** Micros confirmed as settled (money moved late) by this run. */
  confirmedMicros: number;
  /** Which block tag the run pinned its facts to, when it got a block. */
  blockTag?: ChainBlock["tag"];
}

export interface ReconcileOptions {
  /** An unused authorization is only released once the pinned block is this many
   * seconds past valid_before. Default 60. */
  graceSeconds?: number;
  /**
   * Public keys (by key id) trusted to verify the ledger, for reconcileReport.
   * reconcileX402 uses the rail's own keys instead. Without a key the report is
   * advisory and says so.
   */
  trusted?: Record<string, string>;
}

export interface ViemAuthorizationChainOptions {
  /** A floor for the AuthorizationUsed scan; the derived block is used when newer. */
  fromBlock?: bigint | number;
  /** An absolute cap on the scan; the run's valid_before bound is used when smaller. */
  toBlock?: bigint | number;
  /** How many blocks one eth_getLogs call covers. Default 1000. */
  logChunkSize?: number;
  /** The configured RPC URL, so its parts are redacted from every error. */
  rpcUrl?: string;
}

const AUTHORIZATION_USED = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);

const AUTHORIZATION_CANCELED = parseAbiItem(
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
);

/**
 * Extra seconds before a booking is scanned backwards. Wider than the
 * authorization window because created_ms comes from the gateway clock, which
 * may run ahead of chain time.
 */
const SCAN_MARGIN_SECONDS = 900;

const KNOWN_RPC_SECRETS = new Set<string>();

/** Test-only: forget every registered secret so one test cannot depend on another. */
export function resetRedactionSecretsForTests(): void {
  KNOWN_RPC_SECRETS.clear();
}

/** Add a value, and its percent-decoded form, so an encoded key is still found. */
function addRedactionSecret(value: string | null | undefined): void {
  if (!value) return;
  KNOWN_RPC_SECRETS.add(value);
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) KNOWN_RPC_SECRETS.add(decoded);
  } catch {
    // not valid percent-encoding; the literal form is enough
  }
}

/**
 * A path segment is a credential when it is long, or a short mixed
 * letters-and-digits token. Ordinary words such as "base" or "mainnet" stay
 * readable, so a later "database is locked" is not damaged.
 */
function isCredentialPathSegment(segment: string): boolean {
  if (segment.length === 0 || /^v\d+$/i.test(segment)) return false;
  if (segment.length >= 16) return true;
  return segment.length >= 8 && /[a-z]/i.test(segment) && /\d/.test(segment);
}

/** Register a configured RPC URL so no part of it is ever printed. */
export function registerRedactionSecrets(...urls: string[]): void {
  for (const url of urls) {
    if (url.length === 0) continue;
    KNOWN_RPC_SECRETS.add(url);
    try {
      const parsed = new URL(url);
      addRedactionSecret(parsed.hostname);
      addRedactionSecret(parsed.username);
      addRedactionSecret(parsed.password);
      for (const value of parsed.searchParams.values()) addRedactionSecret(value);
      for (const segment of parsed.pathname.split("/")) {
        if (isCredentialPathSegment(segment)) addRedactionSecret(segment);
      }
    } catch {
      for (const segment of url.split("/")) {
        if (isCredentialPathSegment(segment)) addRedactionSecret(segment);
      }
    }
  }
}

/** A short, URL-free description of an error, for reports and stdout. */
export function redactError(err: unknown): string {
  const name = err instanceof Error && err.name ? err.name : "Error";
  const raw = err instanceof Error ? err.message : String(err);
  let message = raw
    .replace(/\b(?:https?|wss?):\/\/[^\s)"'`]+/gi, "<rpc>")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s)"'`]+/gi, "<rpc>");
  for (const secret of KNOWN_RPC_SECRETS) {
    if (secret.length >= 4 && message.includes(secret)) message = message.split(secret).join("<rpc>");
  }
  return message.length > 0 ? `${name}: ${message}` : name;
}

/** True for a block that the node does not have, whether viem wrapped the
 * answer as BlockNotFoundError or the RPC reported a pruned/missing block. */
function isMissingHistory(err: unknown): boolean {
  if (err instanceof BlockNotFoundError) return true;
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "BlockNotFoundError") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\bpruned\b|missing trie node|history (?:is )?(?:not available|unavailable|pruned)|ancient block|block .{0,40}(?:not found|could not be found)|header not found/i.test(
    message,
  );
}

/** The last block whose timestamp is at or before fromTimestamp, by binary search.
 * floor is the lowest block worth reading, when the caller gave an explicit scan
 * floor. A missing or pruned block with an explicit floor returns that floor, so
 * the scan starts lower and covers more. Without an explicit floor the search
 * throws instead of guessing where the pruned history ends. Every other read
 * error (a timeout, a rate limit) is rethrown, so the booking stays an error to
 * retry later. cache keeps the block times of one run, so two bounds and several
 * candidates do not re-read the same blocks. */
async function blockAtOrBefore(
  publicClient: PublicClient,
  fromTimestamp: number,
  floor?: bigint,
  cache?: Map<bigint, number>,
): Promise<bigint> {
  const tip = await publicClient.getBlockNumber();
  if (!Number.isFinite(fromTimestamp)) return floor ?? 0n;
  const readTime = async (blockNumber: bigint): Promise<number> => {
    const hit = cache?.get(blockNumber);
    if (hit !== undefined) return hit;
    const block = await publicClient.getBlock({ blockNumber });
    const time = Number(block.timestamp);
    cache?.set(blockNumber, time);
    return time;
  };
  const tipTime = await readTime(tip);
  if (tipTime <= fromTimestamp) return tip;
  let lo = floor === undefined ? 0n : floor > tip ? tip : floor;
  let hi = tip;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    let timestamp: number;
    try {
      timestamp = await readTime(mid);
    } catch (err) {
      if (!isMissingHistory(err)) throw err;
      if (floor !== undefined) return floor;
      throw new Error(`the node has pruned history below block ${mid}; pass fromBlock`);
    }
    if (timestamp <= fromTimestamp) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Read one log range in chunks, returning the last log of the last chunk. */
async function lastLogInRange(
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
  getChunk: (from: bigint, to: bigint) => Promise<Log[]>,
): Promise<Log | undefined> {
  let last: Log | undefined;
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n;
    const chunk = await getChunk(start, end < toBlock ? end : toBlock);
    if (chunk.length > 0) last = chunk[chunk.length - 1];
  }
  return last;
}

/**
 * The real AuthorizationChain over a viem client. authorizationState() is the
 * view call at the pinned block; the AuthorizationUsed log finds the
 * transaction; the receipt's USDC Transfer that matches the signed payee and
 * amount gives the exact from/to/value that moved.
 */
export function viemAuthorizationChain(
  publicClient: PublicClient,
  options: ViemAuthorizationChainOptions = {},
): AuthorizationChain {
  const fromBlockFloor = options.fromBlock === undefined ? undefined : BigInt(options.fromBlock);
  const toBlockCap = options.toBlock === undefined ? undefined : BigInt(options.toBlock);
  const logChunkSize = BigInt(options.logChunkSize ?? 1_000);
  if (logChunkSize <= 0n) throw new Error("logChunkSize must be a positive integer");
  if (options.rpcUrl) registerRedactionSecrets(options.rpcUrl);
  const blockTimes = new Map<bigint, number>();
  let chainId: number | null = null;

  /** Both bounds of the log scan: the derived floor and the smaller of the
   * valid_before block, the pinned block and any explicit cap. */
  const scanBounds = async (
    fromTimestamp: number,
    validBefore: number,
    pinnedBlockNumber: bigint,
  ): Promise<{ fromBlock: bigint; toBlock: bigint }> => {
    const derivedFrom = await blockAtOrBefore(publicClient, fromTimestamp, fromBlockFloor, blockTimes);
    const fromBlock = fromBlockFloor !== undefined && fromBlockFloor > derivedFrom ? fromBlockFloor : derivedFrom;
    const derivedTo = await blockAtOrBefore(publicClient, validBefore, undefined, blockTimes);
    let scanTo = derivedTo < pinnedBlockNumber ? derivedTo : pinnedBlockNumber;
    if (toBlockCap !== undefined && toBlockCap < scanTo) scanTo = toBlockCap;
    return { fromBlock, toBlock: scanTo };
  };

  const assertNodeAtPinned = async (pinnedBlockNumber: bigint): Promise<void> => {
    const tip = await publicClient.getBlockNumber();
    if (tip < pinnedBlockNumber) {
      throw new Error(`the RPC node is behind the pinned block ${pinnedBlockNumber} (tip ${tip}); retry later`);
    }
  };

  return {
    async latestBlock(): Promise<ChainBlock> {
      for (const tag of ["safe", "finalized"] as const) {
        try {
          const block = await publicClient.getBlock({ blockTag: tag });
          if (block.number === null) continue;
          return { number: block.number, timestamp: Number(block.timestamp), hash: block.hash, tag };
        } catch {
          // the RPC does not know this tag; try the next one
        }
      }
      const latest = await publicClient.getBlock({ blockTag: "latest" });
      if (latest.number === null) throw new Error("the latest block has no number");
      const target = latest.number > 12n ? latest.number - 12n : 0n;
      const block = target === latest.number ? latest : await publicClient.getBlock({ blockNumber: target });
      return { number: target, timestamp: Number(block.timestamp), hash: block.hash, tag: "latest-12" };
    },
    async blockHash(blockNumber): Promise<string> {
      const block = await publicClient.getBlock({ blockNumber });
      return block.hash;
    },
    async chainId(): Promise<number> {
      if (chainId === null) chainId = await publicClient.getChainId();
      return chainId;
    },
    async authorizationUsed(asset, authorizer, nonce, blockNumber): Promise<boolean> {
      const used = await publicClient.readContract({
        address: getAddress(asset),
        abi: eip3009ABI,
        functionName: "authorizationState",
        args: [getAddress(authorizer), nonce as `0x${string}`],
        blockNumber,
      });
      return used as boolean;
    },
    async findAuthorizationTx(
      asset,
      authorizer,
      nonce,
      fromTimestamp,
      validBefore,
      pinnedBlockNumber,
      expected,
    ): Promise<AuthorizationTx | null> {
      const bounds = await scanBounds(fromTimestamp, validBefore, pinnedBlockNumber);
      if (bounds.fromBlock > bounds.toBlock) {
        await assertNodeAtPinned(pinnedBlockNumber);
        return null;
      }
      const log = await lastLogInRange(bounds.fromBlock, bounds.toBlock, logChunkSize, async (from, to) => {
        const logs = await publicClient.getLogs({
          address: getAddress(asset),
          event: AUTHORIZATION_USED,
          args: { authorizer: getAddress(authorizer), nonce: nonce as `0x${string}` },
          fromBlock: from,
          toBlock: to,
        });
        return logs;
      });
      if (!log?.transactionHash) {
        // An empty result from a node that has not reached the pinned block is
        // not evidence that the authorization was unused.
        await assertNodeAtPinned(pinnedBlockNumber);
        return null;
      }
      const receipt = await publicClient.getTransactionReceipt({ hash: log.transactionHash });
      const status = receipt.status === "success" ? "success" : "reverted";
      const wantedFrom = getAddress(authorizer);
      const wantedTo = getAddress(expected.to);
      let fallback: AuthorizationTx | null = null;
      for (const entry of receipt.logs) {
        if (getAddress(entry.address) !== getAddress(asset)) continue;
        try {
          const decoded = decodeEventLog({
            abi: erc20Abi,
            eventName: "Transfer",
            data: entry.data,
            topics: entry.topics,
          });
          const found: AuthorizationTx = {
            txHash: log.transactionHash,
            from: getAddress(decoded.args.from),
            to: getAddress(decoded.args.to),
            value: decoded.args.value as bigint,
            status,
          };
          if (fallback === null) fallback = found;
          if (
            found.from.toLowerCase() === wantedFrom.toLowerCase() &&
            found.to.toLowerCase() === wantedTo.toLowerCase() &&
            found.value === expected.value
          ) {
            return found;
          }
        } catch {
          // not a Transfer event from this contract; keep looking
        }
      }
      return fallback ?? { txHash: log.transactionHash, from: "", to: "", value: 0n, status };
    },
    async findAuthorizationCanceled(asset, authorizer, nonce, fromTimestamp, validBefore, pinnedBlockNumber) {
      const bounds = await scanBounds(fromTimestamp, validBefore, pinnedBlockNumber);
      if (bounds.fromBlock > bounds.toBlock) return false;
      const log = await lastLogInRange(bounds.fromBlock, bounds.toBlock, logChunkSize, async (from, to) => {
        const logs = await publicClient.getLogs({
          address: getAddress(asset),
          event: AUTHORIZATION_CANCELED,
          args: { authorizer: getAddress(authorizer), nonce: nonce as `0x${string}` },
          fromBlock: from,
          toBlock: to,
        });
        return logs;
      });
      if (!log) await assertNodeAtPinned(pinnedBlockNumber);
      return log !== undefined;
    },
  };
}

interface Candidate {
  reservationId: string;
  reservedMicros: number;
  createdMs: number;
  details: Record<string, unknown> | null;
}

interface Facts {
  nonce: string;
  payer: string;
  asset: string;
  payTo: string;
  amountAtomic: bigint;
  validBefore: number;
  network: unknown;
}

interface Plan {
  result: ReconcileResult;
  chargedMicros: number;
  reason?: string;
  txHash?: string;
  details?: Record<string, unknown>;
}

interface PlanContext {
  block: ChainBlock | null;
  blockError: string | null;
  chainId: number | null;
  chainIdError: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** details.network as eip155:<id>, or null when it is not a valid chain id. */
function networkIdOf(network: unknown): number | null {
  if (typeof network !== "string") return null;
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The signed facts a charged_full booking must carry to be reconcilable. */
function factsFrom(details: Record<string, unknown> | null): Facts | null {
  if (!details || details.unconfirmed !== true) return null;
  const nonce = details.nonce;
  const payer = details.payer;
  const asset = details.asset;
  const payTo = details.pay_to;
  const amountAtomic = details.amount_atomic;
  const validBeforeRaw = details.valid_before;
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  if (typeof payer !== "string" || typeof asset !== "string" || typeof payTo !== "string") return null;
  let amount: bigint;
  if (typeof amountAtomic === "string" && /^\d+$/.test(amountAtomic)) amount = BigInt(amountAtomic);
  else if (typeof amountAtomic === "number" && Number.isSafeInteger(amountAtomic) && amountAtomic >= 0) amount = BigInt(amountAtomic);
  else return null;
  const validBefore = typeof validBeforeRaw === "string" ? Number(validBeforeRaw) : typeof validBeforeRaw === "number" ? validBeforeRaw : NaN;
  if (!Number.isFinite(validBefore)) return null;
  return { nonce, payer, asset, payTo, amountAtomic: amount, validBefore, network: details.network };
}

/** Plan one booking against the pinned block. Never throws: an RPC error is a plan. */
async function planOne(
  candidate: Candidate,
  chain: AuthorizationChain,
  graceSeconds: number,
  ctx: PlanContext,
): Promise<Plan> {
  const facts = factsFrom(candidate.details);
  if (!facts) return { result: "pending", chargedMicros: 0, reason: "no unconfirmed authorization to reconcile" };
  if (ctx.block === null) {
    return { result: "error", chargedMicros: 0, reason: ctx.blockError ?? "no pinned block" };
  }
  if (ctx.chainId === null) {
    return { result: "error", chargedMicros: 0, reason: ctx.chainIdError ?? "no chain id" };
  }
  const networkId = networkIdOf(facts.network);
  if (networkId === null) {
    return { result: "mismatch", chargedMicros: 0, reason: "details.network is not a valid eip155 chain id" };
  }
  if (networkId !== ctx.chainId) {
    return {
      result: "mismatch",
      chargedMicros: 0,
      reason: `booking is on eip155:${networkId} but the client is on eip155:${ctx.chainId}`,
    };
  }
  try {
    const used = await chain.authorizationUsed(facts.asset, facts.payer, facts.nonce, ctx.block.number);
    if (used) {
      if (facts.amountAtomic !== BigInt(candidate.reservedMicros)) {
        return { result: "mismatch", chargedMicros: 0, reason: "the reserved amount differs from the signed amount" };
      }
      const bookingSeconds = Math.floor(candidate.createdMs / 1000);
      const fromTimestamp = Math.min(bookingSeconds, facts.validBefore) - SCAN_MARGIN_SECONDS;
      const tx = await chain.findAuthorizationTx(
        facts.asset,
        facts.payer,
        facts.nonce,
        fromTimestamp,
        facts.validBefore,
        ctx.block.number,
        { to: facts.payTo, value: facts.amountAtomic },
      );
      if (!tx) {
        if (chain.findAuthorizationCanceled) {
          const canceled = await chain.findAuthorizationCanceled(
            facts.asset,
            facts.payer,
            facts.nonce,
            fromTimestamp,
            facts.validBefore,
            ctx.block.number,
          );
          if (canceled) {
            return { result: "mismatch", chargedMicros: 0, reason: "authorization was cancelled, manual review" };
          }
        }
        return { result: "mismatch", chargedMicros: 0, reason: "authorization is used but the transaction was not found" };
      }
      if (tx.status !== "success") return { result: "mismatch", chargedMicros: 0, reason: "the settlement transaction reverted" };
      if (tx.from.toLowerCase() !== facts.payer.toLowerCase()) return { result: "mismatch", chargedMicros: 0, reason: "the transfer did not come from the payer" };
      if (tx.to.toLowerCase() !== facts.payTo.toLowerCase()) return { result: "mismatch", chargedMicros: 0, reason: "the transfer did not go to the payee" };
      if (tx.value !== facts.amountAtomic) return { result: "mismatch", chargedMicros: 0, reason: "the transfer amount differs from the signed authorization" };
      return {
        result: "settled",
        chargedMicros: candidate.reservedMicros,
        txHash: tx.txHash,
        details: {
          reason: "settled_late",
          tx_hash: tx.txHash,
          tx_hash_source: "chain",
          settlement_verified: true,
          checked_block_number: String(ctx.block.number),
          checked_block_tag: ctx.block.tag,
          checked_block_time: ctx.block.timestamp,
        },
      };
    }
    if (ctx.block.tag === "latest-12") {
      return {
        result: "pending",
        chargedMicros: 0,
        reason: "release needs a safe or finalized block",
      };
    }
    if (ctx.block.timestamp > facts.validBefore + graceSeconds) {
      return {
        result: "released",
        chargedMicros: 0,
        details: {
          reason: "authorization_expired_unused",
          nonce: facts.nonce,
          valid_before: String(facts.validBefore),
          checked_block_number: String(ctx.block.number),
          checked_block_hash: ctx.block.hash,
          checked_block_tag: ctx.block.tag,
          checked_block_time: ctx.block.timestamp,
        },
      };
    }
    return { result: "pending", chargedMicros: 0, reason: "authorization is unused but not yet expired at the pinned block" };
  } catch (err) {
    return { result: "error", chargedMicros: 0, reason: redactError(err) };
  }
}

async function planAll(
  candidates: Candidate[],
  chain: AuthorizationChain,
  graceSeconds: number,
): Promise<{ report: ReconcileReport; plans: Array<{ candidate: Candidate; plan: Plan }> }> {
  const report: ReconcileReport = { results: [], releasedMicros: 0, confirmedMicros: 0 };
  const plans: Array<{ candidate: Candidate; plan: Plan }> = [];
  const ctx: PlanContext = { block: null, blockError: null, chainId: null, chainIdError: null };
  if (candidates.length > 0) {
    try {
      ctx.block = await chain.latestBlock();
      report.blockTag = ctx.block.tag;
    } catch (err) {
      ctx.blockError = redactError(err);
    }
    try {
      ctx.chainId = await chain.chainId();
    } catch (err) {
      ctx.chainIdError = redactError(err);
    }
  }
  for (const candidate of candidates) {
    const plan = await planOne(candidate, chain, graceSeconds, ctx);
    plans.push({ candidate, plan });
    const outcome: ReconcileOutcome = { reservationId: candidate.reservationId, result: plan.result };
    if (plan.reason !== undefined) outcome.reason = plan.reason;
    if (plan.txHash !== undefined) outcome.txHash = plan.txHash;
    report.results.push(outcome);
    if (plan.result === "released") report.releasedMicros += candidate.reservedMicros;
    if (plan.result === "settled") report.confirmedMicros += candidate.reservedMicros;
  }
  return { report, plans };
}

interface LastSettle {
  outcome: unknown;
  chargedMicros: unknown;
  details: Record<string, unknown>;
}

/** Last x402.settle per reservation id, from signed ledger entries. */
function lastSettleDetails(entries: Iterable<LedgerEntry>): Map<string, LastSettle> {
  const last = new Map<string, LastSettle>();
  for (const entry of entries) {
    if (entry.kind !== "x402.settle") continue;
    const payload = asRecord(entry.payload);
    const id = payload.reservation_id;
    if (typeof id !== "string") continue;
    last.set(id, {
      outcome: payload.outcome,
      chargedMicros: payload.charged_micros,
      details: asRecord(payload.details),
    });
  }
  return last;
}

/** A charged_full x402 row is a candidate only when the last signed settle entry
 * for that reservation says charged_full with the same amount and is unconfirmed.
 * That cross-check keeps a row flipped in SQL from being counted. */
function toCandidates(
  rows: Array<{ id: string; reserved_micros: number; created_ms: number }>,
  last: Map<string, LastSettle>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const entry = last.get(row.id);
    if (!entry || entry.outcome !== "charged_full" || entry.chargedMicros !== row.reserved_micros) continue;
    if (asRecord(entry.details).unconfirmed !== true) continue;
    candidates.push({
      reservationId: row.id,
      reservedMicros: row.reserved_micros,
      createdMs: row.created_ms,
      details: entry.details,
    });
  }
  return candidates;
}

function candidatesFromStore(rail: GovernedRail): Candidate[] {
  const rows = rail.store.database
    .prepare(
      "SELECT id, reserved_micros, created_ms FROM reservations WHERE mandate_id = ? AND rail = 'x402' AND status = 'charged_full'",
    )
    .all(rail.mandate.id) as Array<{ id: string; reserved_micros: number; created_ms: number }>;
  return toCandidates(rows, lastSettleDetails(rail.ledger.entries()));
}

function candidatesFromDb(db: DatabaseSync): Candidate[] {
  const rows = db
    .prepare("SELECT id, reserved_micros, created_ms FROM reservations WHERE rail = 'x402' AND status = 'charged_full'")
    .all() as Array<{ id: string; reserved_micros: number; created_ms: number }>;
  const entries = db
    .prepare("SELECT payload FROM ledger_entries WHERE kind = 'x402.settle' ORDER BY seq ASC")
    .all() as Array<{ payload: string }>;
  const last = new Map<string, LastSettle>();
  for (const entry of entries) {
    const payload = JSON.parse(entry.payload) as Record<string, unknown>;
    const id = payload.reservation_id;
    if (typeof id === "string") {
      last.set(id, {
        outcome: payload.outcome,
        chargedMicros: payload.charged_micros,
        details: asRecord(payload.details),
      });
    }
  }
  return toCandidates(rows, last);
}

/** A typed open for the runtime-only readOnly option (@types/node 22.10 lacks it). */
interface SqliteOpenOptions {
  open?: boolean;
  readOnly?: boolean;
}
function openSqlite(location: string, options: SqliteOpenOptions): DatabaseSync {
  return new DatabaseSync(location, options);
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}
function fileStamp(path: string): FileStamp | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  } catch {
    return null;
  }
}
function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Opens the ledger for a report without ever writing next to it. A database
 * with no sidecar at all is opened with a URI filename in immutable read-only
 * mode; any database with a -wal, -shm or -journal is copied (with its -wal)
 * into a temp folder and the copy is read. The temp folder is removed. The
 * caller checks assertUnchanged after its last read, so a ledger that gains a
 * writer mid-report is refused instead of being read torn.
 */
export function openReportDatabase(dbPath: string): {
  db: DatabaseSync;
  cleanup: () => void;
  assertUnchanged: () => void;
} {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const journalPath = `${dbPath}-journal`;
  const sidecars = [walPath, shmPath, journalPath];

  if (!sidecars.some((path) => existsSync(path))) {
    const before = fileStamp(dbPath);
    if (before === null) throw new Error(`cannot read the ledger ${dbPath}`);
    let db: DatabaseSync | null = null;
    try {
      db = openSqlite(`${pathToFileURL(dbPath).href}?mode=ro&immutable=1`, { open: true, readOnly: true });
      db.prepare("SELECT count(*) AS c FROM ledger_entries").get();
      return {
        db,
        cleanup: () => {},
        assertUnchanged: () => {
          const after = fileStamp(dbPath);
          if (!sameStamp(before, after) || sidecars.some((path) => existsSync(path))) {
            throw new Error("the ledger changed during the report");
          }
        },
      };
    } catch (err) {
      db?.close();
      // Fall through to the copy path; a clean database that cannot be opened
      // immutable may still be readable as a consistent copy.
      void err;
    }
  }

  if (existsSync(journalPath)) {
    throw new Error("the ledger has a hot journal; close the writer first");
  }

  const dir = mkdtempSync(join(tmpdir(), "tapvow-rec-"));
  const copy = join(dir, "rail.db");
  try {
    let copied = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3 && !copied; attempt++) {
      try {
        const mainBefore = fileStamp(dbPath);
        const walBefore = existsSync(walPath) ? fileStamp(walPath) : null;
        if (mainBefore === null) throw new Error(`cannot read the ledger ${dbPath}`);
        copyFileSync(dbPath, copy);
        if (walBefore !== null) copyFileSync(walPath, `${copy}-wal`);
        else rmSync(`${copy}-wal`, { force: true });
        const mainAfter = fileStamp(dbPath);
        const walAfter = existsSync(walPath) ? fileStamp(walPath) : null;
        copied =
          sameStamp(mainBefore, mainAfter) &&
          sameStamp(walBefore, walAfter) &&
          !existsSync(journalPath);
      } catch (err) {
        lastError = err;
      }
    }
    if (!copied) {
      throw new Error(
        `the ledger kept changing while it was copied; close the gateway first${
          lastError instanceof Error ? `: ${redactError(lastError)}` : ""
        }`,
      );
    }
    const db = openSqlite(copy, { open: true, readOnly: true });
    return {
      db,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
      assertUnchanged: () => {},
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Reconciles every charged_full x402 booking of the rail's mandate against the
 * chain. Releases an authorization that expired unused; books one that settled
 * late as settled (with the on-chain tx hash). A used authorization is never
 * released; an RPC error leaves its booking untouched. An edited ledger is
 * refused. Returns a report and appends a new signed x402.settle entry for each
 * booking it changes.
 */
export async function reconcileX402(
  rail: GovernedRail,
  chain: AuthorizationChain,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const graceSeconds = opts.graceSeconds ?? 60;
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) {
    throw new Error("graceSeconds must be a non-negative safe integer");
  }
  // The audit and the candidate rows must come from one WAL snapshot: a
  // gateway settle committed between two autocommit reads would look like a
  // mismatch and refuse a healthy run.
  const snapshot = rail.store.readTransaction(() => {
    const audit = auditRail(rail.store, rail.ledger, rail.mandate.id, rail.trustedLedgerKeys);
    return { audit, candidates: audit.ok ? candidatesFromStore(rail) : [] };
  });
  if (!snapshot.audit.ok) throw new Error(`reconcile refused: ledger audit failed: ${snapshot.audit.reason}`);
  const { report, plans } = await planAll(snapshot.candidates, chain, graceSeconds);
  for (let i = 0; i < plans.length; i++) {
    const { candidate, plan } = plans[i]!;
    if (plan.result !== "settled" && plan.result !== "released") continue;
    const outcome = report.results[i]!;
    if (plan.result === "released") {
      // The release frees budget on the strength of one pinned block. Re-read
      // its hash immediately before writing; if the chain moved under us, leave
      // the row alone and retry on a later run.
      const details = plan.details ?? {};
      const number = details.checked_block_number;
      const expected = details.checked_block_hash;
      let changed = false;
      try {
        if (typeof number !== "string" || typeof expected !== "string") {
          outcome.result = "error";
          outcome.reason = "the release plan has no pinned block hash";
          changed = true;
        } else {
          const current = await chain.blockHash(BigInt(number));
          if (current.toLowerCase() !== expected.toLowerCase()) {
            outcome.result = "error";
            outcome.reason = "the pinned block changed before the release was written";
            changed = true;
          }
        }
      } catch (err) {
        outcome.result = "error";
        outcome.reason = redactError(err);
        changed = true;
      }
      if (changed) {
        report.releasedMicros -= candidate.reservedMicros;
        continue;
      }
    }
    try {
      if (plan.result === "settled") {
        rail.store.reconcileCharged(
          candidate.reservationId,
          { outcome: "settled", chargedMicros: candidate.reservedMicros },
          plan.details ?? {},
        );
      } else {
        rail.store.reconcileCharged(candidate.reservationId, { outcome: "released" }, plan.details ?? {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A concurrent run already moved this row: report it, keep going.
      if (!/is already (released|settled|charged_full|reserved)/.test(message)) throw err;
      outcome.result = "skipped";
      outcome.reason = "already reconciled by a concurrent run";
      if (plan.result === "settled") report.confirmedMicros -= candidate.reservedMicros;
      else report.releasedMicros -= candidate.reservedMicros;
    }
  }
  return report;
}

/**
 * What reconcileX402 would do, without writing anything. Opens the ledger
 * READ ONLY (no signing key needed), for old ledgers whose signer no longer
 * exists. Every decision is still made against the chain. With trusted keys the
 * ledger is verified first; without them the report is advisory and says so.
 */
export async function reconcileReport(
  dbPath: string,
  chain: AuthorizationChain,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const graceSeconds = opts.graceSeconds ?? 60;
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) {
    throw new Error("graceSeconds must be a non-negative safe integer");
  }
  const { db, cleanup, assertUnchanged } = openReportDatabase(dbPath);
  try {
    if (opts.trusted) {
      const verify = new Ledger(db).verify(opts.trusted);
      if (!verify.ok) {
        throw new Error(`reconcile refused: ledger verify failed: ${verify.reason} at seq ${verify.firstBadSeq}`);
      }
    } else {
      console.warn("reconcileReport: the ledger was not verified (no trusted key was given)");
    }
    const candidates = candidatesFromDb(db);
    // All ledger reads are done; a writer that appeared since the open means
    // the pages may have been torn under the immutable connection.
    assertUnchanged();
    const { report } = await planAll(candidates, chain, graceSeconds);
    return report;
  } finally {
    db.close();
    cleanup();
  }
}
