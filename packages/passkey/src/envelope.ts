import { createHash } from "node:crypto";
import { canonicalize, sha256Hex, type Mandate } from "@mandate/core";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export const PASSKEY_MANDATE_FORMAT = "passkey-v1";
export const PASSKEY_CHALLENGE_PREFIX = "spendmandate/passkey-mandate/v1\n";

export interface PasskeySignedMandate {
  format: "passkey-v1";
  mandate: Mandate;
  prev_hash: string | null;
  nonce: string;
  audience: string;
  expires_at: string;
  assertion: AuthenticationResponseJSON;
}

/**
 * Hash of the exact mandate content, versioned so a future schema change cannot
 * be replayed as the same version.
 */
export function mandateHash(m: Mandate): string {
  return sha256Hex("mandate/v0.1\n" + canonicalize(m));
}

/**
 * The WebAuthn challenge binds the exact mandate content, the previous version,
 * the registry-issued nonce, the audience and the validity window. Returned as
 * unpadded base64url of the raw 32-byte SHA-256 digest.
 */
export function challengeFor(args: {
  mandate: Mandate;
  prev_hash: string | null;
  nonce: string;
  audience: string;
  expires_at: string;
}): string {
  const canonical = canonicalize({
    audience: args.audience,
    expires_at: args.expires_at,
    mandate: args.mandate,
    nonce: args.nonce,
    prev_hash: args.prev_hash,
  });
  return createHash("sha256")
    .update(PASSKEY_CHALLENGE_PREFIX + canonical, "utf8")
    .digest("base64url");
}
