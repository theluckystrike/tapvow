// Decodes the partially signed Solana transaction that @x402/svm hands back
// and proves it moves exactly the quoted amount of the allowed mint to the
// allowed payee. The client signature is checked but the on-chain transaction
// id comes from the facilitator's settlement response.
import {
  decompileTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

export interface DecodedPayment {
  /** The payer's own signature. The on-chain id is the fee payer's signature. */
  payerSignature: string;
  payer: string;
  feePayer: string;
  mint: string;
  payTo: string;
  amountAtomic: string;
  destination: string;
  tokenProgram: string;
}

interface BytesLike {
  readonly [index: number]: number;
  readonly length: number;
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface ExpectedPayment {
  payer: string;
  mint: string;
  payTo: string;
  amountAtomic: string;
  feePayer: string;
  /** Allow the payer to also pay the network fee. Off by default. */
  allowPayerAsFeePayer?: boolean;
}

const TRANSFER_CHECKED = 12;
const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);
const COMPUTE_BUDGET_PROGRAM_ADDRESS = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAMS: ReadonlySet<string> = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const WRITABLE_SIGNER = 3;
/** Cap on the priority fee, in micro-lamports per compute unit. */
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1_000_000n;

function readU64LE(data: BytesLike, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

/**
 * Decode one base64 wire transaction and verify its single payment transfer.
 * Throws with a stable message when the transaction is not the payment the
 * guard approved.
 */
export async function decodePaymentTransaction(
  transaction: string,
  expected: ExpectedPayment,
): Promise<DecodedPayment> {
  let bytes: Uint8Array;
  try {
    bytes = getBase64Encoder().encode(transaction) as unknown as Uint8Array;
  } catch {
    throw new Error("payment transaction is not valid base64");
  }
  let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    tx = getTransactionDecoder().decode(bytes);
  } catch {
    throw new Error("payment transaction is not a valid Solana wire transaction");
  }

  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes as unknown as Uint8Array);
  } catch {
    throw new Error("payment transaction message cannot be decoded");
  }

  let decompiled: ReturnType<typeof decompileTransactionMessage>;
  try {
    decompiled = decompileTransactionMessage(message, { lastValidBlockHeight: 0n });
  } catch {
    throw new Error("payment transaction message cannot be decompiled");
  }

  const feePayerValue = decompiled.feePayer as unknown as string | { address?: string };
  const feePayer =
    typeof feePayerValue === "string" ? feePayerValue : String(feePayerValue.address ?? "");
  if (feePayer !== expected.feePayer) {
    throw new Error("payment fee payer is not the facilitator in the requirements");
  }
  if (feePayer === expected.payer && expected.allowPayerAsFeePayer !== true) {
    throw new Error("payment fee payer is the payer");
  }
  const signature = tx.signatures[expected.payer as keyof typeof tx.signatures];
  if (!signature || signature.length !== 64) {
    throw new Error("payment transaction has no payer signature");
  }
  let zero = true;
  for (let i = 0; i < signature.length; i += 1) {
    if (signature[i] !== 0) {
      zero = false;
      break;
    }
  }
  if (zero) {
    throw new Error("payment transaction has an all-zero payer signature");
  }
  const payerSignature = getBase58Decoder().decode(signature);

  const instructions = (decompiled.instructions ?? []) as unknown as DecodedInstruction[];
  let found: { destination: string; tokenProgram: string } | null = null;
  let transferInstruction: DecodedInstruction | null = null;
  let memoCount = 0;
  for (const instruction of instructions) {
    const program = String(instruction.programAddress);
    if (TOKEN_PROGRAMS.has(program)) {
      if (transferInstruction !== null) {
        throw new Error("payment transaction has more than one SPL token instruction");
      }
      const candidate = await matchesTransfer(instruction, expected, program);
      if (!candidate) {
        throw new Error("payment transaction has an SPL token instruction that is not the quoted transfer");
      }
      found = candidate;
      transferInstruction = instruction;
      continue;
    }
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const problem = computeBudgetProblem(instruction);
      if (problem) throw new Error(problem);
      continue;
    }
    if (MEMO_PROGRAMS.has(program)) {
      memoCount += 1;
      if (memoCount > 1) {
        throw new Error("payment transaction has more than one memo instruction");
      }
      continue;
    }
    throw new Error(`payment transaction contains an unsupported program instruction: ${program}`);
  }
  if (!found) {
    throw new Error("payment transaction has no matching SPL transfer checked instruction");
  }
  for (const instruction of instructions) {
    if (instruction === transferInstruction) continue;
    if (namesPayerAsWritableSigner(instruction, expected.payer)) {
      throw new Error("payment transaction has an instruction that makes the payer a writable signer");
    }
  }
  return {
    payerSignature,
    payer: expected.payer,
    feePayer,
    mint: expected.mint,
    payTo: expected.payTo,
    amountAtomic: expected.amountAtomic,
    destination: found.destination,
    tokenProgram: found.tokenProgram,
  };
}

interface DecodedInstruction {
  programAddress?: { toString(): string };
  accounts?: readonly { address: { toString(): string }; role?: number }[];
  data?: BytesLike;
}

function computeBudgetProblem(instruction: DecodedInstruction): string | null {
  const data = instruction.data;
  if (!data || data.length === 0) {
    return "payment transaction has an empty compute budget instruction";
  }
  if (data[0] === SET_COMPUTE_UNIT_LIMIT) {
    if (data.length !== 5) return "payment transaction has a malformed compute unit limit instruction";
    return null;
  }
  if (data[0] === SET_COMPUTE_UNIT_PRICE) {
    if (data.length !== 9) return "payment transaction has a malformed compute unit price instruction";
    if (readU64LE(data, 1) > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) {
      return "payment transaction has a compute unit price above the cap";
    }
    return null;
  }
  return "payment transaction has an unsupported compute budget instruction";
}

function namesPayerAsWritableSigner(instruction: DecodedInstruction, payer: string): boolean {
  for (const account of instruction.accounts ?? []) {
    if (String(account.address) === payer && Number(account.role) === WRITABLE_SIGNER) return true;
  }
  return false;
}

async function matchesTransfer(
  instruction: DecodedInstruction,
  expected: ExpectedPayment,
  tokenProgram: string,
): Promise<{ destination: string; tokenProgram: string } | null> {
  if (!TOKEN_PROGRAMS.has(tokenProgram)) return null;
  const data = instruction.data;
  if (!data || data.length !== 10 || data[0] !== TRANSFER_CHECKED) return null;
  const accounts = instruction.accounts ?? [];
  if (accounts.length !== 4) return null;
  const mint = accounts[1]?.address.toString();
  const destination = accounts[2]?.address.toString();
  const authority = accounts[3]?.address.toString();
  if (mint !== expected.mint) return null;
  if (authority !== expected.payer) return null;
  if (readU64LE(data, 1).toString() !== expected.amountAtomic) return null;
  const [ataToken] = await findAssociatedTokenPda({
    mint: expected.mint as never,
    owner: expected.payTo as never,
    tokenProgram: tokenProgram as never,
  });
  if (String(ataToken) !== destination) return null;
  return { destination: destination!, tokenProgram };
}
