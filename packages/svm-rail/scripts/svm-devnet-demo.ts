// Runs the Solana x402 rail against devnet with three separate wallets.
//
// The demo starts a paid seller and an in-process facilitator, then uses the
// rail to buy calls under a signed mandate. It shows a successful payment, a
// blocked payee, an approval timeout and a budget refusal. The payer, the payee
// and the fee payer are different keys, so the demo never pays itself. If a key
// has no devnet SOL, or the payee has no USDC token account, the script prints
// OWNER-NEEDED and stops. It never asks a faucet for funds and never prints key
// bytes, only addresses.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  devnet,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { EXAMPLE_MANDATE, generateSigner, signMandate } from "@mandate/core";
import { openGovernedRail } from "@mandate/llm-rail";
import { createSvmPaymentGuard } from "../src/guard.js";
import { createSvmRail } from "../src/rail.js";
import { rpcSolanaChain } from "../src/chain.js";
import { resolveDemoActors, type DemoActors } from "../src/demo.js";
import { prepareDevnetDemoActors } from "../src/demo-preflight.js";
import type { Approver } from "../src/types.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OFF_RAIL_PAYEE = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const RPC_URL = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const PRICE_ATOMIC = "10000";
const OVER_LINE_ATOMIC = "30000";
const BUDGET_ATOMIC = "50000";
const SETUP_SOL_FLOOR_LAMPORTS = 10_000_000n;
const FEE_PAYER_SOL_FLOOR_LAMPORTS = 1_000_000n;
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

function ownerNeeded(lines: string[]): void {
  console.log("OWNER-NEEDED");
  for (const line of lines) console.log(line);
  process.exitCode = 2;
}

function loadKey(path: string): Uint8Array {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("the key file is readable by other users. Run chmod 600 on it");
  }
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) {
    const bytes = JSON.parse(text) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("the JSON key file must hold 64 bytes");
    return Uint8Array.from(bytes);
  }
  const bytes = getBase58Encoder().encode(text) as unknown as Uint8Array;
  if (bytes.length !== 64) throw new Error("the base58 key must hold 64 bytes");
  return bytes;
}

function systemTransferInstruction(from: string, to: string, lamports: bigint): Record<string, unknown> {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

async function waitForConfirmation(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await rpc.getSignatureStatuses([signature as never]).send();
    const status = (result as unknown as { value?: Array<{ err?: unknown; confirmationStatus?: string | null }> }).value?.[0];
    if (status?.err !== null && status?.err !== undefined) {
      throw new Error("a devnet setup transaction failed on chain");
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("a devnet setup transaction did not confirm within 30 s");
}

async function sendPayerTransaction(
  rpc: ReturnType<typeof createSolanaRpc>,
  payerSigner: TransactionSigner,
  instructions: readonly unknown[],
): Promise<string> {
  const latest = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payerSigner as never, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash((latest as { value: unknown }).value as never, tx),
    (tx) => appendTransactionMessageInstructions(instructions as never, tx),
  );
  const signed = await signTransactionMessageWithSigners(message as never);
  const wire = getBase64EncodedWireTransaction(signed as never);
  const signature = String(await rpc.sendTransaction(wire as never, { encoding: "base64" }).send());
  await waitForConfirmation(rpc, signature);
  return signature;
}

async function main(): Promise<void> {
  const keyPath = process.env.SVM_KEY_FILE;
  if (!keyPath) {
    console.log("Set SVM_KEY_FILE to a Solana key file. The file must have mode 600.");
    process.exitCode = 1;
    return;
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = loadKey(keyPath);
  } catch (err) {
    ownerNeeded([err instanceof Error ? err.message : String(err)]);
    return;
  }
  const signer: TransactionSigner = await createKeyPairSignerFromBytes(keyBytes);
  const payer = String(signer.address);
  const rpc = createSolanaRpc(devnet(RPC_URL));

  let actors: DemoActors;
  try {
    actors = await prepareDevnetDemoActors(rpc, () =>
      resolveDemoActors({
        payerSigner: signer,
        payeeKeyFile: process.env.SVM_PAYEE_KEY_FILE,
        feePayerKeyFile: process.env.SVM_FEE_PAYER_KEY_FILE,
        loadKey,
      }),
    );
  } catch (err) {
    ownerNeeded([err instanceof Error ? err.message : String(err)]);
    return;
  }
  const payTo = actors.payeeAddress;
  const feePayer = actors.feePayerAddress;

  let sol = 0n;
  let usdc = 0n;
  try {
    sol = BigInt((await rpc.getBalance(signer.address).send()).value);
  } catch (err) {
    ownerNeeded([
      "The devnet RPC could not be read. Check the network and SVM_RPC_URL.",
      err instanceof Error ? err.message : String(err),
    ]);
    return;
  }
  const [payerAta] = await findAssociatedTokenPda({
    mint: USDC_MINT as never,
    owner: payer as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  try {
    usdc = BigInt((await rpc.getTokenAccountBalance(payerAta).send()).value.amount);
  } catch {
    usdc = 0n;
  }

  const neededUsdc = BigInt(BUDGET_ATOMIC) + BigInt(OVER_LINE_ATOMIC);
  if (sol < SETUP_SOL_FLOOR_LAMPORTS) {
    ownerNeeded([
      `The payer ${payer} has ${sol} lamports of devnet SOL and needs at least ${SETUP_SOL_FLOOR_LAMPORTS}.`,
      "The payer uses this SOL to create the payee token account and to fund the fee payer.",
      "Step 1. Open https://faucet.solana.com in the owner browser.",
      `Step 2. Request devnet SOL for ${payer}.`,
      "Step 3. Run this script again.",
    ]);
    return;
  }
  if (usdc < neededUsdc) {
    ownerNeeded([
      `The wallet ${payer} has ${usdc} atomic USDC and needs at least ${neededUsdc}.`,
      "Step 1. Open https://faucet.circle.com in the owner browser. That faucet uses a CAPTCHA, so the owner must do it.",
      `Step 2. Request devnet USDC and send it to ${payer}.`,
      "Step 3. Run this script again.",
    ]);
    return;
  }

  const [payeeAta] = await findAssociatedTokenPda({
    mint: USDC_MINT as never,
    owner: payTo as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  try {
    const payeeAccount = await rpc.getAccountInfo(payeeAta).send();
    if (payeeAccount.value === null) {
      const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: payTo as never,
        mint: USDC_MINT as never,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await sendPayerTransaction(rpc, signer, [createAta]);
      console.log(`created the payee token account ${payeeAta}`);
    }
  } catch (err) {
    ownerNeeded([
      `The payee token account ${payeeAta} does not exist and the demo could not create it.`,
      err instanceof Error ? err.message : String(err),
      "Step 1. Check the payer SOL balance and the devnet RPC.",
      "Step 2. Run this script again.",
    ]);
    return;
  }

  try {
    const feePayerSol = BigInt((await rpc.getBalance(actors.feePayerSigner.address).send()).value);
    if (feePayerSol < FEE_PAYER_SOL_FLOOR_LAMPORTS) {
      const topUp = FEE_PAYER_SOL_FLOOR_LAMPORTS - feePayerSol;
      await sendPayerTransaction(rpc, signer, [systemTransferInstruction(payer, feePayer, topUp)]);
      console.log(`funded the fee payer ${feePayer} with ${topUp} lamports`);
    }
  } catch (err) {
    ownerNeeded([
      `The fee payer ${feePayer} needs devnet SOL and the demo could not fund it.`,
      err instanceof Error ? err.message : String(err),
      "Step 1. Open https://faucet.solana.com in the owner browser.",
      `Step 2. Request devnet SOL for ${feePayer}.`,
      "Step 3. Run this script again.",
    ]);
    return;
  }

  const facilitator = new x402Facilitator();
  registerExactSvmScheme(facilitator, {
    signer: toFacilitatorSvmSigner(actors.feePayerSigner as never, { defaultRpcUrl: RPC_URL }),
    networks: NETWORK,
  });

  const routes: Record<string, { amount: string; payTo: string }> = {
    "/policy-check": { amount: PRICE_ATOMIC, payTo },
    "/over-line": { amount: OVER_LINE_ATOMIC, payTo },
    "/unknown-payee": { amount: PRICE_ATOMIC, payTo: OFF_RAIL_PAYEE },
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "seller failed" }));
    });
  });

  async function handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const requirement: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      asset: USDC_MINT,
      amount: route.amount,
      payTo: route.payTo,
      maxTimeoutSeconds: 300,
      extra: { feePayer },
    };
    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      const required = { x402Version: 2, resource: { url: `http://${req.headers.host ?? "127.0.0.1"}${path}` }, accepts: [requirement] };
      res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
      res.end(JSON.stringify({ error: "payment required" }));
      return;
    }
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad payment header" }));
      return;
    }
    const verified = await facilitator.verify(payload, requirement);
    if (!verified.isValid) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verified.invalidReason ?? "invalid payment" }));
      return;
    }
    const settlement: SettleResponse = await facilitator.settle(payload, requirement);
    if (!settlement.success) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: settlement.errorReason ?? "settlement failed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    });
    res.end(JSON.stringify({ decision: "allow", policy: "policy-check-v1" }));
  }

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const workDir = process.env.SVM_DEMO_DIR ?? join(homedir(), ".tapvow", "svm-demo", String(process.pid));
  mkdirSync(workDir, { recursive: true });
  const dbPath = join(workDir, "rail.db");
  const issuer = generateSigner("svm-demo-owner");
  const mandate = {
    ...EXAMPLE_MANDATE,
    id: `mdt_svm_demo_${process.pid}`,
    issuer: { id: "owner", public_key: issuer.publicKey },
    agents: ["agent-01"],
    budget: { total: "0.05", period: "lifetime" as const },
    per_call_cap: "0.05",
    approval_threshold: "0.02",
    rate_limit: { max_calls: 1000, window_seconds: 60 },
    allowed_payees: [{ rail: "x402" as const, id: `${NETWORK}:${payTo}` }],
    rails: ["x402" as const],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
  const signedMandate = signMandate(mandate, issuer.signer);
  const ledgerSigner = generateSigner("svm-demo-ledger");
  const rail = openGovernedRail({
    dbPath,
    signedMandate,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: ledgerSigner.signer,
  });

  const approver: Approver = {
    async request() {
      console.log("approval requested for 0.030000 USDC. The demo approver does not answer.");
      return { decision: "timeout", requestId: "demo_timeout_0001" };
    },
  };
  const svm = createSvmRail({
    rail,
    signer,
    payerAddress: payer,
    networks: [NETWORK],
    guard: createSvmPaymentGuard({ rail, networks: [NETWORK], firstPaymentMaxMicros: 1_000_000 }),
    chain: rpcSolanaChain(rpc as never, { timeoutMs: 20_000 }),
    rpcUrl: RPC_URL,
    approver,
  });
  const auth = { agentId: "agent-01", mandateId: rail.mandate.id };

  console.log(`payer ${payer}`);
  console.log(`payee ${payTo}`);
  console.log(`fee payer ${feePayer}`);
  console.log(`seller ${baseUrl}`);
  console.log(`ledger ${dbPath}`);

  const overLine = await svm.pay(auth, { url: `${baseUrl}/over-line` });
  console.log(`approval timeout ${overLine.status} ${overLine.body}`);

  const blocked = await svm.pay(auth, { url: `${baseUrl}/unknown-payee` });
  console.log(`blocked payee ${blocked.status} ${blocked.body}`);

  for (let i = 1; i <= 5; i++) {
    const result = await svm.pay(auth, { url: `${baseUrl}/policy-check` });
    const sig = result.headers["X-Mandate-Tx-Signature"];
    const paid = sig ? `https://explorer.solana.com/tx/${sig}?cluster=devnet delivered ${(result.body.split("\n")[0] ?? "").slice(0, 120)}` : result.body;
    console.log(`payment ${i} ${result.status} ${paid}`);
  }
  const overBudget = await svm.pay(auth, { url: `${baseUrl}/policy-check` });
  console.log(`budget refusal ${overBudget.status} ${overBudget.body}`);

  const verify = rail.ledger.verify(rail.trustedLedgerKeys);
  console.log(`ledger verify ${verify.ok ? "ok" : "FAILED"}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  rail.close();
}

main().catch((err) => {
  console.error("the devnet demo failed", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
