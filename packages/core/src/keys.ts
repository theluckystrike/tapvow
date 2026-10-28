import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface Signer {
  keyId: string;
  privateKey: KeyObject;
}

const RAW_PUBLIC_KEY_LENGTH = 32;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url decode. Buffer.from(s, "base64url") silently skips invalid
 * characters and ignores the unused low bits of the last character, so two
 * different strings can decode to the same bytes. A ledger verifier must not
 * accept a stored signature that differs from the one that was written, so
 * only the canonical encoding of the decoded bytes is accepted.
 */
export function decodeB64urlStrict(s: unknown): Buffer | null {
  if (typeof s !== "string" || !B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

export function generateSigner(keyId: string): { signer: Signer; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = der.subarray(der.length - RAW_PUBLIC_KEY_LENGTH);
  return {
    signer: { keyId, privateKey },
    publicKey: raw.toString("base64url"),
  };
}

export function publicKeyFromRaw(b64url: string): KeyObject {
  const raw = decodeB64urlStrict(b64url);
  if (!raw) throw new TypeError("invalid base64url public key");
  if (raw.length !== RAW_PUBLIC_KEY_LENGTH) {
    throw new TypeError(`public key must be ${RAW_PUBLIC_KEY_LENGTH} bytes`);
  }
  const der = Buffer.concat([SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function signBytes(privateKey: KeyObject, data: Uint8Array): string {
  const sig = sign(null, data, privateKey);
  return sig.toString("base64url");
}

export function verifyBytes(
  publicKeyB64url: string,
  data: Uint8Array,
  sigB64url: string,
): boolean {
  try {
    const raw = decodeB64urlStrict(publicKeyB64url);
    if (!raw || raw.length !== RAW_PUBLIC_KEY_LENGTH) return false;
    const sig = decodeB64urlStrict(sigB64url);
    if (!sig || sig.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
