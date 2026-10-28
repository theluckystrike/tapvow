import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate, type SignedMandate } from "@mandate/core";
import { openGovernedRail, type GovernedRail } from "@mandate/llm-rail";
import type { ChainVerification, SolanaChain, TransferFacts, TransferSearch } from "../src/types.js";
import type { PaymentScheme } from "../src/rail.js";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const PAYEE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const OTHER_PAYEE = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const FEE_PAYER = "11111111111111111111111111111111";
export const EXPLORER = "https://explorer.solana.com/tx/";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tapvow-svm-"));
}

export function signature(byte = 7): string {
  return getBase58Decoder().decode(new Uint8Array(64).fill(byte) as never);
}

export async function testSigner(): Promise<TransactionSigner> {
  return generateKeyPairSigner();
}

export interface RawInstruction {
  programAddress: string;
  accounts?: readonly { address: string; role?: number }[];
  data?: Uint8Array;
}

export async function transferInstruction(args: {
  payer: TransactionSigner;
  mint: string;
  payTo: string;
  amountAtomic: string;
  decimals?: number;
}) {
  const [source] = await findAssociatedTokenPda({
    mint: args.mint as never,
    owner: args.payer.address as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destination] = await findAssociatedTokenPda({
    mint: args.mint as never,
    owner: args.payTo as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return getTransferCheckedInstruction(
    {
      source,
      mint: args.mint as never,
      destination,
      authority: args.payer,
      amount: BigInt(args.amountAtomic),
      decimals: args.decimals ?? 6,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS },
  );
}

/** Build a real partially signed SPL transfer transaction for the fake scheme. */
export async function buildPaymentTransaction(args: {
  payer: TransactionSigner;
  mint: string;
  payTo: string;
  amountAtomic: string;
  feePayer: string;
  decimals?: number;
  extraInstructions?: readonly unknown[];
}): Promise<string> {
  const transfer = await transferInstruction(args);
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(args.feePayer as never, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: "11111111111111111111111111111111" as never, lastValidBlockHeight: 1000n },
        tx,
      ),
    (tx) => appendTransactionMessageInstruction(transfer, tx),
  ) as never;
  for (const extra of args.extraInstructions ?? []) {
    message = appendTransactionMessageInstruction(extra as never, message) as never;
  }
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

export function computeUnitLimit(units: number): RawInstruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: "ComputeBudget111111111111111111111111111111", data };
}

export function computeUnitPrice(microLamports: bigint): RawInstruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: "ComputeBudget111111111111111111111111111111", data };
}

export function memoInstruction(text: string, accounts: RawInstruction["accounts"] = []): RawInstruction {
  return {
    programAddress: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    accounts,
    data: new TextEncoder().encode(text),
  };
}

export function fakeScheme(payer: TransactionSigner): PaymentScheme {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version, requirements) {
      const transaction = await buildPaymentTransaction({
        payer,
        mint: requirements.asset,
        payTo: requirements.payTo,
        amountAtomic: requirements.amount,
        feePayer: String(requirements.extra.feePayer),
      });
      return { x402Version, payload: { transaction } };
    },
  };
}

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_MINT,
    amount: "10000",
    payTo: PAYEE,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
    ...overrides,
  };
}

export interface FakeSellerOptions {
  requirement: PaymentRequirements;
  settle?: SettleResponse;
  facilitatorError?: boolean;
  status?: number;
  body?: string;
  /** Answer the paid request with a 302. Honours the fetch redirect mode. */
  redirectTo?: string;
}

/** A fetch that answers 402 with PAYMENT-REQUIRED, then settles with PAYMENT-RESPONSE. */
export function fakeSeller(opts: FakeSellerOptions): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      const required = {
        x402Version: 2,
        resource: { url: request.url },
        accepts: [opts.requirement],
      };
      return new Response("", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
      });
    }
    if (opts.redirectTo) {
      // A real fetch with redirect: "error" rejects on a 3xx. The old rail used
      // that mode, so this branch reproduces its failure.
      if (request.redirect === "error") throw new TypeError("unexpected redirect");
      return new Response(null, { status: 302, headers: { location: opts.redirectTo } });
    }
    if (opts.facilitatorError) {
      return new Response(JSON.stringify({ error: "facilitator failed" }), {
        status: opts.status ?? 502,
        headers: { "content-type": "application/json" },
      });
    }
    const settle: SettleResponse =
      opts.settle ??
      ({ success: true, transaction: signature(), network: NETWORK } satisfies SettleResponse);
    const body = opts.body ?? JSON.stringify({ paid: true });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle),
      },
    });
  };
}

export interface TransferRecord extends TransferFacts {
  status: "success" | "failed";
  atMs: number;
}

/** A chain fake with a balance that only moves on a confirmed success. */
export class FakeChain implements SolanaChain {
  preflightError: Error | null = null;
  verifyError: Error | null = null;
  verifyThrow: Error | null = null;
  findError: Error | null = null;
  /** Force the history scan to stop before it has read the whole window. */
  findIncomplete: { capped: boolean; timedOut: boolean } | null = null;
  genesisHash: string = DEVNET_GENESIS_HASH;
  readonly transfers = new Map<string, TransferRecord>();
  balance: bigint;
  /** When set, verifyTransfer waits for this gate after it counts an arrival. */
  verifyGate: Promise<void> | null = null;
  verifyStarted = 0;

  constructor(balance = 100_000_000n) {
    this.balance = balance;
  }

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  record(
    sig: string,
    facts: TransferFacts,
    status: "success" | "failed" = "success",
    move = true,
    atMs = Date.now(),
  ): void {
    this.transfers.set(sig, { ...facts, status, atMs });
    if (status === "success" && move) this.balance -= BigInt(facts.amountAtomic);
  }

  async preflight(): Promise<void> {
    if (this.preflightError) throw this.preflightError;
  }

  async verifyTransfer(sig: string, facts: TransferFacts): Promise<ChainVerification> {
    this.verifyStarted += 1;
    if (this.verifyGate) await this.verifyGate;
    if (this.verifyThrow) throw this.verifyThrow;
    if (this.verifyError) return { status: "error", reason: this.verifyError.message };
    const record = this.transfers.get(sig);
    if (!record) return { status: "pending", reason: "not confirmed" };
    if (record.status === "failed") return { status: "failed", reason: "transaction failed on chain" };
    if (
      record.network !== facts.network ||
      record.mint !== facts.mint ||
      record.payTo !== facts.payTo ||
      record.amountAtomic !== facts.amountAtomic ||
      record.payer !== facts.payer
    ) {
      return { status: "mismatch", reason: "facts do not match" };
    }
    return { status: "success" };
  }

  async findTransfer(facts: TransferFacts & { sinceMs: number }): Promise<TransferSearch> {
    if (this.findError) throw this.findError;
    if (this.findIncomplete) return { kind: "incomplete", ...this.findIncomplete };
    let best: { sig: string; atMs: number } | null = null;
    for (const [sig, record] of this.transfers) {
      if (record.status !== "success") continue;
      if (record.atMs < facts.sinceMs) continue;
      if (
        record.network === facts.network &&
        record.mint === facts.mint &&
        record.payTo === facts.payTo &&
        record.amountAtomic === facts.amountAtomic &&
        record.payer === facts.payer
      ) {
        if (best === null || record.atMs > best.atMs) best = { sig, atMs: record.atMs };
      }
    }
    return best === null ? { kind: "none" } : { kind: "found", signature: best.sig };
  }
}

export function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_svm_test_0001",
    agents: ["agent-01"],
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "1.00",
    approval_threshold: "1.00",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    allowed_payees: [{ rail: "x402", id: `${NETWORK}:${PAYEE}` }],
    rails: ["x402"],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function signTestMandate(
  mandate: Mandate,
  issuerId = "owner-test",
): { issuer: ReturnType<typeof generateSigner>; signed: SignedMandate } {
  const issuer = generateSigner(issuerId);
  const withKey: Mandate = { ...mandate, issuer: { id: "michael", public_key: issuer.publicKey } };
  return { issuer, signed: signMandate(withKey, issuer.signer) };
}

export function openTestRail(
  dbPath: string,
  signed: SignedMandate,
  issuerPublicKey: string,
): { rail: GovernedRail; trusted: Record<string, string> } {
  const ledgerSigner = generateSigner("gateway-test");
  const rail = openGovernedRail({
    dbPath,
    signedMandate: signed,
    trustedIssuerKey: issuerPublicKey,
    ledgerSigner: ledgerSigner.signer,
  });
  return { rail, trusted: { [ledgerSigner.signer.keyId]: ledgerSigner.publicKey } };
}

export function reservationStatus(rail: GovernedRail, amountMicros: number): string | null {
  const row = rail.store.database
    .prepare(
      "SELECT status FROM reservations WHERE mandate_id = ? AND rail = 'x402' AND reserved_micros = ? ORDER BY created_ms DESC LIMIT 1",
    )
    .get(rail.mandate.id, amountMicros) as { status: string } | undefined;
  return row?.status ?? null;
}
