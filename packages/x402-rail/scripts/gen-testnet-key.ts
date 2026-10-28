// Creates the two Base Sepolia testnet key files for the payer and payee.
// The lead runs this by hand; it never prints the private keys.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyFile } from "../src/wallet.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRETS_DIR = process.env.TAPVOW_SECRETS_DIR ?? resolve(REPO_ROOT, "..", ".secrets");

const files = [
  join(SECRETS_DIR, "base-sepolia-payer.json"),
  join(SECRETS_DIR, "base-sepolia-payee.json"),
];

for (const path of files) {
  if (existsSync(path)) {
    console.log(`${path}: already exists, skipped`);
    continue;
  }
  const result = generateKeyFile(path);
  console.log(`${path}: ${result.address}`);
}
