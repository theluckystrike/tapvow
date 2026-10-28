import { describe, expect, test } from "vitest";
import type { TransactionSigner } from "@solana/kit";
import { decodePaymentTransaction } from "../src/transaction.js";
import {
  buildPaymentTransaction,
  computeUnitLimit,
  computeUnitPrice,
  FEE_PAYER,
  memoInstruction,
  OTHER_PAYEE,
  PAYEE,
  testSigner,
  transferInstruction,
  USDC_MINT,
} from "./helpers.js";

const AMOUNT = "10000";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";
const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1_000_000n;

interface HostileArgs {
  payer: TransactionSigner;
  extraInstructions: readonly unknown[];
  feePayer?: string;
}

async function decodeHostile(args: HostileArgs, allowPayerAsFeePayer?: boolean) {
  const feePayer = args.feePayer ?? FEE_PAYER;
  const transaction = await buildPaymentTransaction({
    payer: args.payer,
    mint: USDC_MINT,
    payTo: PAYEE,
    amountAtomic: AMOUNT,
    feePayer,
    extraInstructions: args.extraInstructions,
  });
  return decodePaymentTransaction(transaction, {
    payer: args.payer.address,
    mint: USDC_MINT,
    payTo: PAYEE,
    amountAtomic: AMOUNT,
    feePayer,
    ...(allowPayerAsFeePayer === undefined ? {} : { allowPayerAsFeePayer }),
  });
}

describe("the signed transaction instruction allowlist", () => {
  test("accepts exactly the quoted transfer", async () => {
    const payer = await testSigner();
    const transaction = await buildPaymentTransaction({
      payer,
      mint: USDC_MINT,
      payTo: PAYEE,
      amountAtomic: AMOUNT,
      feePayer: FEE_PAYER,
    });

    const decoded = await decodePaymentTransaction(transaction, {
      payer: payer.address,
      mint: USDC_MINT,
      payTo: PAYEE,
      amountAtomic: AMOUNT,
      feePayer: FEE_PAYER,
    });

    expect(decoded.destination).toBeTruthy();
    expect(decoded.tokenProgram).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  test("accepts compute budget instructions and one memo", async () => {
    const payer = await testSigner();

    await expect(
      decodeHostile({
        payer,
        extraInstructions: [
          computeUnitLimit(200_000),
          computeUnitPrice(MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS),
          memoInstruction("invoice-42"),
        ],
      }),
    ).resolves.toMatchObject({ payer: payer.address });
  });

  test("refuses an extra transfer to another account", async () => {
    const payer = await testSigner();
    const secondTransfer = await transferInstruction({
      payer,
      mint: USDC_MINT,
      payTo: OTHER_PAYEE,
      amountAtomic: "1",
    });

    await expect(
      decodeHostile({ payer, extraInstructions: [secondTransfer] }),
    ).rejects.toThrow(/more than one SPL token instruction|not the quoted transfer/);
  });

  test("refuses a duplicated TransferChecked", async () => {
    const payer = await testSigner();
    const duplicate = await transferInstruction({
      payer,
      mint: USDC_MINT,
      payTo: PAYEE,
      amountAtomic: AMOUNT,
    });

    await expect(
      decodeHostile({ payer, extraInstructions: [duplicate] }),
    ).rejects.toThrow(/more than one SPL token instruction/);
  });

  test("refuses a System transfer from the payer", async () => {
    const payer = await testSigner();

    await expect(
      decodeHostile({
        payer,
        extraInstructions: [
          {
            programAddress: SYSTEM_PROGRAM,
            accounts: [
              { address: payer.address, role: 3 },
              { address: OTHER_PAYEE, role: 1 },
            ],
            data: new Uint8Array(12),
          },
        ],
        feePayer: payer.address,
      }, true),
    ).rejects.toThrow(/unsupported program/);
  });

  test("refuses an unknown program", async () => {
    const payer = await testSigner();

    await expect(
      decodeHostile({
        payer,
        extraInstructions: [{ programAddress: VOTE_PROGRAM, accounts: [], data: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/unsupported program/);
  });

  test("refuses a compute unit price above the cap", async () => {
    const payer = await testSigner();

    await expect(
      decodeHostile({
        payer,
        extraInstructions: [computeUnitPrice(MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS + 1n)],
      }),
    ).rejects.toThrow(/compute unit price above the cap/);
  });

  test("refuses a memo that names the payer as a writable signer", async () => {
    const payer = await testSigner();

    await expect(
      decodeHostile({
        payer,
        extraInstructions: [memoInstruction("invoice-42", [{ address: payer.address, role: 3 }])],
      }),
    ).rejects.toThrow(/writable signer/);
  });

  test("refuses the payer as fee payer unless the config allows it", async () => {
    const payer = await testSigner();

    await expect(
      decodeHostile({ payer, extraInstructions: [], feePayer: payer.address }),
    ).rejects.toThrow(/fee payer is the payer/);

    await expect(
      decodeHostile({ payer, extraInstructions: [], feePayer: payer.address }, true),
    ).resolves.toMatchObject({ feePayer: payer.address });
  });
});
