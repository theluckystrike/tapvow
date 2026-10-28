import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { envVar } from "./env.js";

/** An error that carries the process exit code the CLI should use. */
export class ExitError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ExitError";
    this.code = code;
  }
}

export function resolveHome(flag?: string): string {
  if (typeof flag === "string" && flag.length > 0) return flag;
  const env = envVar("HOME");
  if (typeof env === "string" && env.length > 0) return env;
  const next = join(homedir(), ".tapvow");
  const prev = join(homedir(), ".spendmandate");
  // An existing install keeps its ledger by staying on the old home when the
  // new home has never been created.
  if (!existsSync(next) && existsSync(prev)) return prev;
  return next;
}

export function ensureDir(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  try {
    chmodSync(dir, mode);
  } catch {
    // best effort; the create mode already applied where the platform allows it
  }
}

/**
 * Creates the file with an exclusive create, so an existing file is never
 * overwritten and the create is atomic. Every secret goes through here.
 */
export function writeExclusive(path: string, data: string | Buffer, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, mode);
  } catch {
    // best effort
  }
}

/** Writes through a temp file in the same directory and renames over the target. */
export function writeAtomic(path: string, data: string | Buffer, mode: number): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  writeExclusive(tmp, data, mode);
  try {
    chmodSync(tmp, mode);
  } catch {
    // best effort
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomMandateId(): string {
  return "mdt_" + randomBytes(12).toString("base64url");
}
