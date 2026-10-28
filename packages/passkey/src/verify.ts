import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { validateMandate, type Mandate } from "@mandate/core";
import {
  PASSKEY_MANDATE_FORMAT,
  challengeFor,
  type PasskeySignedMandate,
} from "./envelope.js";

export interface TrustedCredential {
  id: string;
  publicKey: string;
  counter: number;
  issuerId: string;
}

export interface VerifyOptions {
  credentials: TrustedCredential[];
  rpID: string;
  origin: string | string[];
  expectedPrevHash: string | null;
  audience: string;
  now?: () => number;
  maxValidityMs?: number;
  checkExpiry?: boolean;
}

export type VerifyPasskeyResult =
  | {
      ok: true;
      mandate: Mandate;
      credentialId: string;
      newCounter: number;
      doc: PasskeySignedMandate;
    }
  | { ok: false; reason: string };

const HEX64_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const AUDIENCE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const EXPIRES_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DOC_KEYS = [
  "format",
  "mandate",
  "prev_hash",
  "nonce",
  "audience",
  "expires_at",
  "assertion",
] as const;
const DEFAULT_MAX_VALIDITY_MS = 900_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function malformed(detail: string): { ok: false; reason: string } {
  return { ok: false, reason: `unsigned or malformed passkey mandate: ${detail}` };
}

function decodeJson(raw: string): unknown {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}

export async function verifyPasskeyMandate(
  doc: unknown,
  opts: VerifyOptions,
): Promise<VerifyPasskeyResult> {
  try {
    // a. exact shape.
    if (!isPlainObject(doc)) return malformed("document must be a plain object");
    const keys = Object.keys(doc);
    if (keys.length !== DOC_KEYS.length || !DOC_KEYS.every((k) => keys.includes(k))) {
      return malformed(
        "document must have exactly the keys format, mandate, prev_hash, nonce, audience, expires_at, assertion",
      );
    }
    if (doc.format !== PASSKEY_MANDATE_FORMAT) {
      return malformed('format must be "passkey-v1"');
    }

    // b. the mandate itself must be valid.
    const validated = validateMandate(doc.mandate);
    if (!validated.ok) {
      return malformed(validated.errors.join("; "));
    }
    const mandate = validated.mandate;

    // c. prev_hash and nonce shapes.
    const prevHash = doc.prev_hash;
    if (prevHash !== null && (typeof prevHash !== "string" || !HEX64_RE.test(prevHash))) {
      return malformed("prev_hash must be null or 64 lowercase hex characters");
    }
    const nonce = doc.nonce;
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      return malformed("nonce must be a 43-character base64url string");
    }

    // d. freshness and deployment binding.
    const audience = doc.audience;
    if (typeof audience !== "string" || !AUDIENCE_RE.test(audience)) {
      return malformed("audience must be a deployment id of 1..128 characters");
    }
    const expiresAt = doc.expires_at;
    if (typeof expiresAt !== "string" || !EXPIRES_AT_RE.test(expiresAt)) {
      return malformed("expires_at must be an RFC3339 UTC timestamp ending in Z");
    }
    if (audience !== opts.audience) {
      return { ok: false, reason: "audience does not match this gateway" };
    }
    const expiresMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresMs)) {
      return malformed("expires_at is not a valid timestamp");
    }
    if (opts.checkExpiry !== false) {
      const nowMs = (opts.now ?? Date.now)();
      if (!(expiresMs > nowMs)) {
        return { ok: false, reason: "passkey mandate document expired" };
      }
      if (expiresMs - nowMs > (opts.maxValidityMs ?? DEFAULT_MAX_VALIDITY_MS)) {
        return { ok: false, reason: "passkey mandate document validity window too long" };
      }
    }

    // e. the version this edit replaces.
    if (prevHash !== opts.expectedPrevHash) {
      return { ok: false, reason: "prev_hash does not match the registered version" };
    }

    // f. assertion shape and trusted credential.
    const assertion = doc.assertion;
    if (!isPlainObject(assertion)) return malformed("assertion must be an object");
    if (typeof assertion.id !== "string" || assertion.id.length === 0) {
      return malformed("assertion.id must be a non-empty string");
    }
    if (typeof assertion.rawId !== "string") {
      return malformed("assertion.rawId must be a string");
    }
    if (assertion.id !== assertion.rawId) {
      return malformed("assertion.id must equal assertion.rawId");
    }
    if (assertion.type !== "public-key") {
      return malformed('assertion.type must be "public-key"');
    }
    const response = assertion.response;
    if (!isPlainObject(response)) return malformed("assertion.response must be an object");
    for (const field of ["clientDataJSON", "authenticatorData", "signature"] as const) {
      if (typeof response[field] !== "string" || (response[field] as string).length === 0) {
        return malformed(`assertion.response.${field} must be a non-empty string`);
      }
    }
    const credential = opts.credentials.find((c) => c.id === assertion.id);
    if (!credential) return { ok: false, reason: "credential not trusted" };
    if (credential.issuerId !== mandate.issuer.id) {
      return { ok: false, reason: "credential belongs to another issuer" };
    }

    // g. decode clientDataJSON ourselves and refuse cross-origin assertions.
    let clientData: unknown;
    try {
      clientData = decodeJson(response.clientDataJSON as string);
    } catch {
      return malformed("clientDataJSON is not valid base64url JSON");
    }
    if (!isPlainObject(clientData)) return malformed("clientDataJSON must be a JSON object");
    if (clientData.crossOrigin === true) {
      return { ok: false, reason: "cross-origin assertion refused" };
    }
    if ("topOrigin" in clientData) {
      return { ok: false, reason: "cross-origin assertion refused" };
    }

    // h. cryptographic verification, never trusting the document's own claims.
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = new Uint8Array(Buffer.from(credential.publicKey, "base64url"));
    } catch {
      return malformed("trusted credential public key is not valid base64url");
    }
    let authInfo;
    try {
      const result = await verifyAuthenticationResponse({
        response: assertion as unknown as AuthenticationResponseJSON,
        expectedChallenge: challengeFor({ mandate, prev_hash: prevHash, nonce, audience, expires_at: expiresAt }),
        expectedOrigin: opts.origin,
        expectedRPID: opts.rpID,
        expectedType: "webauthn.get",
        credential: {
          id: credential.id,
          publicKey: publicKeyBytes,
          counter: credential.counter,
        },
        requireUserVerification: true,
      });
      if (!result.verified) return { ok: false, reason: "passkey assertion rejected: not verified" };
      authInfo = result.authenticationInfo;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `passkey assertion rejected: ${message}` };
    }

    // i. belt and braces on the flags and the signature counter.
    if (authInfo.userVerified !== true) {
      return { ok: false, reason: "passkey assertion rejected: user was not verified" };
    }
    const newCounter = authInfo.newCounter;
    if (credential.counter > 0 || newCounter > 0) {
      if (!(newCounter > credential.counter)) {
        return {
          ok: false,
          reason: "signature counter did not increase (possible cloned authenticator or replay)",
        };
      }
    }

    return {
      ok: true,
      mandate,
      credentialId: assertion.id,
      newCounter,
      doc: doc as unknown as PasskeySignedMandate,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return malformed(message);
  }
}
