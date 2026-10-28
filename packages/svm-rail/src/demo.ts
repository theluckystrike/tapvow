// Actor key resolution for the devnet demo. The payer, the payee and the
// facilitator fee payer must be three different keys. One wallet must never pay
// itself, and the payer must never pay the network fee in the demo.
import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";

export interface DemoActorInput {
  payerSigner: TransactionSigner;
  /** Key file for the payee. A fresh key is generated when this is absent. */
  payeeKeyFile?: string;
  /** Key file for the facilitator fee payer. A fresh key is generated when this is absent. */
  feePayerKeyFile?: string;
  loadKey?: (path: string) => Uint8Array | Promise<Uint8Array>;
  /** Override for tests. Defaults to generateKeyPairSigner. */
  generateSigner?: () => Promise<TransactionSigner>;
}

export interface DemoActors {
  payerSigner: TransactionSigner;
  payeeAddress: string;
  feePayerSigner: TransactionSigner;
  feePayerAddress: string;
  payeeGenerated: boolean;
  feePayerGenerated: boolean;
}

/** Throws when two demo roles share one address. */
export function assertDistinctDemoActors(payer: string, payee: string, feePayer: string): void {
  if (payer === payee) throw new Error("the payer and the payee must be different keys");
  if (payer === feePayer) throw new Error("the payer and the fee payer must be different keys");
  if (payee === feePayer) throw new Error("the payee and the fee payer must be different keys");
}

/**
 * Resolve the three demo keys. A missing payee or fee payer key file gives a
 * fresh key. Only addresses leave this function. Key bytes never do.
 */
export async function resolveDemoActors(input: DemoActorInput): Promise<DemoActors> {
  const generate = input.generateSigner ?? (() => generateKeyPairSigner());

  let payeeSigner: TransactionSigner;
  let payeeGenerated = false;
  if (input.payeeKeyFile) {
    if (!input.loadKey) throw new Error("a payee key file needs a key loader");
    payeeSigner = await createKeyPairSignerFromBytes(await input.loadKey(input.payeeKeyFile));
  } else {
    payeeSigner = await generate();
    payeeGenerated = true;
  }

  let feePayerSigner: TransactionSigner;
  let feePayerGenerated = false;
  if (input.feePayerKeyFile) {
    if (!input.loadKey) throw new Error("a fee payer key file needs a key loader");
    feePayerSigner = await createKeyPairSignerFromBytes(await input.loadKey(input.feePayerKeyFile));
  } else {
    feePayerSigner = await generate();
    feePayerGenerated = true;
  }

  const payerAddress = String(input.payerSigner.address);
  const payeeAddress = String(payeeSigner.address);
  const feePayerAddress = String(feePayerSigner.address);
  assertDistinctDemoActors(payerAddress, payeeAddress, feePayerAddress);

  return {
    payerSigner: input.payerSigner,
    payeeAddress,
    feePayerSigner,
    feePayerAddress,
    payeeGenerated,
    feePayerGenerated,
  };
}
