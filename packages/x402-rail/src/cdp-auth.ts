// Coinbase Developer Platform (CDP) x402 facilitator authentication.
//
// The CDP facilitator (https://api.cdp.coinbase.com/platform/v2/x402) needs an
// Authorization: Bearer <JWT> header on every request. The JWT is Ed25519,
// signed with the CDP secret API key, and names the exact method and path it is
// good for. A fresh token is minted per request.
//
// The key file holds {"id":"<uuid>","secret":"<base64 of 64 bytes: Ed25519 seed
// (32) then public key (32)>"}. It is read at runtime only, never logged, never
// put in an error message and never serialized: CdpKey.redacted forms are all
// that JSON.stringify or util.inspect can see.
import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import type { FacilitatorConfig } from "@x402/core/server";

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const DEFAULT_CDP_KEY_FILE =
  process.env.TAPVOW_CDP_KEY_FILE ?? join(homedir(), ".tapvow", "secrets", "cdp-api-key.json");

const REDACTED = "<redacted>";
const SECRET_BYTES = 64;
const SEED_BYTES = 32;
const JWT_TTL_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A CDP secret API key: an Ed25519 signing key bound to the key id. */
export class CdpKey {
  readonly id: string;
  readonly key: KeyObject;

  constructor(id: string, key: KeyObject) {
    this.id = id;
    this.key = key;
  }

  toJSON(): { id: string; secret: string } {
    return { id: this.id, secret: REDACTED };
  }

  [inspect.custom](): { id: string; secret: string } {
    return { id: this.id, secret: REDACTED };
  }
}

function decodeSecret(secret: string, path: string): Buffer {
  if (!B64_RE.test(secret) || secret.length % 4 !== 0) {
    throw new Error(`CDP key file ${path}: field secret must be base64`);
  }
  const raw = Buffer.from(secret, "base64");
  if (raw.length !== SECRET_BYTES || raw.toString("base64") !== secret) {
    throw new Error(`CDP key file ${path}: field secret must be base64 of exactly ${SECRET_BYTES} bytes`);
  }
  return raw;
}

/**
 * Reads and checks the CDP key file at path.
 *
 * Refuses a file that group or others can read, that is not JSON with exactly
 * the string fields id and secret, whose id is not a UUID, whose secret is not
 * base64 of exactly 64 bytes, or whose last 32 bytes are not the public key of
 * the first 32. Errors name the path and the failed check, never the content.
 */
export function loadCdpKey(path: string): CdpKey {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`CDP key file not found at ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`CDP key file ${path} must not be readable by group or others (chmod 600)`);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`CDP key file ${path} could not be read`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`CDP key file ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`CDP key file ${path} must hold a JSON object`);
  }
  const fields = Object.keys(parsed);
  if (fields.length !== 2 || !fields.includes("id") || !fields.includes("secret")) {
    throw new Error(`CDP key file ${path} must have exactly the fields id and secret`);
  }
  const { id, secret } = parsed as { id: unknown; secret: unknown };
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error(`CDP key file ${path}: field id must be a UUID`);
  }
  if (typeof secret !== "string") {
    throw new Error(`CDP key file ${path}: field secret must be a string`);
  }

  const raw = decodeSecret(secret, path);
  const seed = raw.subarray(0, SEED_BYTES);
  const publicHalf = raw.subarray(SEED_BYTES, SECRET_BYTES);
  const expectedX = publicHalf.toString("base64url");

  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: expectedX },
      format: "jwk",
    });
  } catch {
    throw new Error(`CDP key file ${path}: field secret is not a valid Ed25519 key`);
  }
  const derivedX = createPublicKey(key).export({ format: "jwk" }).x;
  if (derivedX !== expectedX) {
    throw new Error(`CDP key file ${path}: secret public half does not match its private half`);
  }
  return new CdpKey(id, key);
}

/**
 * Builds a short-lived Ed25519 JWT for one facilitator request. url is the full
 * https URL; the uris claim is "<METHOD> <host><path>" without the query.
 */
export function cdpJwt(
  key: CdpKey,
  method: "GET" | "POST",
  url: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const parsed = new URL(url);
  const header = {
    alg: "EdDSA",
    kid: key.id,
    typ: "JWT",
    nonce: randomBytes(16).toString("hex"),
  };
  const payload = {
    sub: key.id,
    iss: "cdp",
    nbf: nowSec,
    exp: nowSec + JWT_TTL_SECONDS,
    uris: [`${method} ${parsed.host}${parsed.pathname}`],
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), key.key).toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * FacilitatorConfig createAuthHeaders for the CDP facilitator. Each call mints
 * three fresh JWTs, one per facilitator path, with the right method and uri.
 */
export function cdpFacilitatorAuth(
  key: CdpKey,
  baseUrl: string = CDP_FACILITATOR_URL,
): NonNullable<FacilitatorConfig["createAuthHeaders"]> {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return async () => ({
    verify: { Authorization: `Bearer ${cdpJwt(key, "POST", `${base}/verify`)}` },
    settle: { Authorization: `Bearer ${cdpJwt(key, "POST", `${base}/settle`)}` },
    supported: { Authorization: `Bearer ${cdpJwt(key, "GET", `${base}/supported`)}` },
  });
}
