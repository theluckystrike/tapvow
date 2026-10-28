// Wallet handling for the gateway's payer account. Agents never touch this:
// the private key lives only in a file the gateway reads at boot. Errors never
// include the key material.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";

/**
 * Reads {"privateKey":"0x..."} from path and returns the viem account.
 * Refuses a file that group or other can access (mode & 0o077), so a key can
 * never be world-readable. Error messages never contain the key.
 */
export function loadAccountFromFile(path: string): LocalAccount {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`key file not found: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`key file ${path} is accessible to group or other (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`key file ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`key file ${path} must be a JSON object`);
  }
  const privateKey = (parsed as { privateKey?: unknown }).privateKey;
  if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`key file ${path} has no 0x-prefixed 32-byte privateKey`);
  }
  return privateKeyToAccount(privateKey as `0x${string}`);
}

/**
 * Writes {"privateKey","address"} with mode 0o600, creating the parent
 * directory with mode 0o700. Refuses to overwrite an existing file. Returns
 * only the address, never the key.
 */
export function generateKeyFile(path: string): { address: string } {
  if (existsSync(path)) {
    throw new Error(`refusing to overwrite existing key file: ${path}`);
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ privateKey, address: account.address }), { mode: 0o600, flag: "wx" });
  return { address: account.address };
}
