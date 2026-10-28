// Operator command. Releases one charged_full Solana x402 booking and writes a
// signed ledger entry with reason operator_release. Use it when a facilitator
// accepted a payment and never submitted the transaction, or when a human must
// undo a booking. It never edits the database directly.
//
// Usage:
//   SVM_HOME=~/.tapvow SVM_OPERATOR=ops@example.com \
//     npm run operator-release --workspace @mandate/svm-rail -- <reservation-id> --reason "text"
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { openGovernedRail } from "@mandate/llm-rail";
import type { Signer } from "@mandate/core";
import { releaseSvmBooking } from "../src/reconcile.js";

interface GatewayConfig {
  db: string;
  mandate_file: string;
  owner_public_key: string;
  ledger_key_file: string;
}

interface StoredKey {
  key_id: string;
  public_key: string;
  private_key_pkcs8: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function resolveFromHome(home: string, path: string): string {
  return isAbsolute(path) ? path : join(home, path);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function main(): void {
  const homeArg = process.env.SVM_HOME;
  if (!homeArg) {
    throw new Error("Set SVM_HOME to the TapVow home that holds config.json");
  }
  const home = homeArg.replace(/^~/, homedir());
  const config = readJson<GatewayConfig>(join(home, "config.json"));
  const signed = readJson<unknown>(resolveFromHome(home, config.mandate_file));
  const ledgerKey = readJson<StoredKey>(resolveFromHome(home, config.ledger_key_file));
  const privateKey = createPrivateKey({
    key: Buffer.from(ledgerKey.private_key_pkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const ledgerSigner: Signer = { keyId: ledgerKey.key_id, privateKey };

  const reservationId = process.argv[2];
  if (!reservationId || reservationId.startsWith("--")) {
    throw new Error("Pass the reservation id as the first argument");
  }
  const operator = process.env.SVM_OPERATOR ?? option("--operator");
  if (!operator) {
    throw new Error("Set SVM_OPERATOR or pass --operator to record who ran the release");
  }
  const note = option("--reason");

  const rail = openGovernedRail({
    dbPath: resolveFromHome(home, config.db),
    signedMandate: signed,
    trustedIssuerKey: config.owner_public_key,
    ledgerSigner,
    requireStoreBinding: true,
  });
  const result = releaseSvmBooking(rail, reservationId, {
    operator,
    ...(note !== undefined ? { note } : {}),
  });
  console.log(
    `released ${result.reservationId}, ${result.releasedMicros} micros returned to the budget`,
  );
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
