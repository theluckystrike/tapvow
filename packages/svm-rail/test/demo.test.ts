import { afterEach, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { createSvmPaymentGuard } from "../src/guard.js";
import { createSvmRail } from "../src/rail.js";
import { assertDistinctDemoActors, resolveDemoActors } from "../src/demo.js";
import {
  baseMandate,
  FakeChain,
  fakeScheme,
  fakeSeller,
  NETWORK,
  openTestRail,
  requirements,
  signTestMandate,
  signature,
  testSigner,
  tmpDir,
} from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("the devnet demo actor keys", () => {
  test("generates a payee and a fee payer that differ from the payer and from each other", async () => {
    const payer = await testSigner();
    const actors = await resolveDemoActors({
      payerSigner: payer,
      loadKey: () => {
        throw new Error("the test expects generated keys");
      },
      generateSigner: () => generateKeyPairSigner(),
    });

    expect(actors.payeeGenerated).toBe(true);
    expect(actors.feePayerGenerated).toBe(true);
    const addresses = new Set([String(payer.address), actors.payeeAddress, actors.feePayerAddress]);
    expect(addresses.size).toBe(3);
  });

  test("refuses a payer, a payee or a fee payer that share one address", () => {
    expect(() => assertDistinctDemoActors("payer", "payer", "fee")).toThrow(/payer and the payee/);
    expect(() => assertDistinctDemoActors("payer", "payee", "payer")).toThrow(/payer and the fee payer/);
    expect(() => assertDistinctDemoActors("payer", "payee", "payee")).toThrow(/payee and the fee payer/);
  });

  test("a three-key demo setup settles one payment", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const payer = await testSigner();
    const actors = await resolveDemoActors({
      payerSigner: payer,
      generateSigner: () => generateKeyPairSigner(),
    });
    const { issuer, signed } = signTestMandate(
      baseMandate({
        allowed_payees: [{ rail: "x402", id: `${NETWORK}:${actors.payeeAddress}` }],
      }),
    );
    const { rail } = openTestRail(join(dir, "rail.db"), signed, issuer.publicKey);
    const chain = new FakeChain();
    const settleSignature = signature(41);
    const requirement = requirements({
      payTo: actors.payeeAddress,
      extra: { feePayer: actors.feePayerAddress },
    });
    chain.record(settleSignature, {
      network: requirement.network,
      mint: requirement.asset,
      payTo: requirement.payTo,
      amountAtomic: requirement.amount,
      payer: payer.address,
    });
    const svm = createSvmRail({
      rail,
      signer: payer,
      networks: [NETWORK],
      guard: createSvmPaymentGuard({ rail, networks: [NETWORK], firstPaymentMaxMicros: 100_000_000 }),
      chain,
      scheme: () => fakeScheme(payer),
      fetch: fakeSeller({
        requirement,
        settle: { success: true, transaction: settleSignature, network: NETWORK },
      }),
      allowPrivateNetwork: true,
    });

    const result = await svm.pay(
      { agentId: "agent-01", mandateId: rail.mandate.id },
      { url: "http://127.0.0.1:9/policy-check" },
    );

    expect(result.status).toBe(200);
    expect(result.headers["X-Mandate-Tx-Signature"]).toBe(settleSignature);
    const settled = rail.ledger
      .entries()
      .filter((entry) => entry.kind === "x402.settle" && (entry.payload as any).outcome === "settled");
    expect(settled).toHaveLength(1);
    expect((settled[0]!.payload as any).details.fee_payer).toBe(actors.feePayerAddress);
    expect((settled[0]!.payload as any).details.pay_to).toBe(actors.payeeAddress);
  });
});
