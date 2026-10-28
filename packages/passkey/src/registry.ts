import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { canonicalize, validateMandate, type Mandate } from "@mandate/core";
import { challengeFor, mandateHash, type PasskeySignedMandate } from "./envelope.js";
import { verifyPasskeyMandate, type TrustedCredential } from "./verify.js";

export interface PasskeyRegistryOptions {
  rpID: string;
  rpName: string;
  origin: string | string[];
  audience: string;
  now?: () => number;
  challengeTtlMs?: number;
}

export interface PasskeySignedApproval {
  challenge: string;
  assertion: AuthenticationResponseJSON;
}

interface CredentialRow {
  credential_id: string;
  issuer_id: string;
  public_key: string;
  counter: number;
}

interface ChallengeRow {
  challenge: string;
  issuer_id: string;
  prev_hash: string | null;
  mandate_id: string | null;
}

const DEFAULT_TTL_MS = 300_000;
const APPROVAL_CHALLENGE_PREFIX = "spendmandate/passkey-add-credential/v1\n";

function approvalChallenge(issuerId: string, nonce: string): string {
  return createHash("sha256")
    .update(APPROVAL_CHALLENGE_PREFIX + canonicalize({ issuer_id: issuerId, nonce }), "utf8")
    .digest("base64url");
}

function wholeSecondsIso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clientDataChallenge(response: RegistrationResponseJSON): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
  } catch {
    throw new Error("registration response clientDataJSON is not valid base64url JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("registration response clientDataJSON is not a JSON object");
  }
  const data = decoded as { challenge?: unknown; crossOrigin?: unknown; topOrigin?: unknown };
  if (data.crossOrigin === true || "topOrigin" in data) {
    throw new Error("cross-origin registration refused");
  }
  if (typeof data.challenge !== "string") {
    throw new Error("registration response clientDataJSON has no challenge");
  }
  return data.challenge;
}

export class PasskeyRegistry {
  private readonly db: DatabaseSync;
  private readonly rpID: string;
  private readonly rpName: string;
  private readonly origin: string | string[];
  private readonly audience: string;
  private readonly now: () => number;
  private readonly challengeTtlMs: number;

  constructor(db: DatabaseSync, opts: PasskeyRegistryOptions) {
    this.db = db;
    this.rpID = opts.rpID;
    this.rpName = opts.rpName;
    this.origin = opts.origin;
    this.audience = opts.audience;
    this.now = opts.now ?? (() => Date.now());
    this.challengeTtlMs = opts.challengeTtlMs ?? DEFAULT_TTL_MS;
  }

  init(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS passkey_credentials (
        credential_id TEXT PRIMARY KEY,
        issuer_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS passkey_challenges (
        challenge TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK(purpose IN ('register','edit','approve')),
        issuer_id TEXT NOT NULL,
        mandate_id TEXT,
        prev_hash TEXT,
        mandate_hash TEXT,
        nonce TEXT,
        audience TEXT,
        doc_expires_at TEXT,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      )`,
    );
  }

  async beginRegistration(
    issuerId: string,
    userName: string,
    approval?: PasskeySignedApproval,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const credentials = this.credentialsFor(issuerId);
    if (credentials.length > 0) {
      await this.consumeCredentialApproval(issuerId, approval, credentials);
    }
    const excludeCredentials = credentials.map((c) => ({ id: c.id }));
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName,
      userID: new TextEncoder().encode(issuerId),
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    this.db
      .prepare(
        `INSERT INTO passkey_challenges (challenge, purpose, issuer_id, expires_at)
         VALUES (?, 'register', ?, ?)`,
      )
      .run(options.challenge, issuerId, this.now() + this.challengeTtlMs);
    return options;
  }

  /**
   * Issues a challenge an existing credential of the issuer must sign before a
   * second passkey may be added.
   */
  async beginCredentialApproval(
    issuerId: string,
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challenge: string }> {
    const credentials = this.credentialsFor(issuerId);
    const nonce = randomBytes(32).toString("base64url");
    const challenge = approvalChallenge(issuerId, nonce);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
      allowCredentials: credentials.map((c) => ({ id: c.id })),
      userVerification: "required",
    });
    if (options.challenge !== challenge) {
      throw new Error("approval options challenge does not match the computed challenge");
    }
    this.db
      .prepare(
        `INSERT INTO passkey_challenges (challenge, purpose, issuer_id, nonce, expires_at)
         VALUES (?, 'approve', ?, ?, ?)`,
      )
      .run(challenge, issuerId, nonce, this.now() + this.challengeTtlMs);
    return { options, challenge };
  }

  private async consumeCredentialApproval(
    issuerId: string,
    approval: PasskeySignedApproval | undefined,
    credentials: TrustedCredential[],
  ): Promise<void> {
    const rejected = (): never => {
      throw new Error(
        `adding a passkey to issuer ${issuerId} needs an assertion from an existing passkey`,
      );
    };
    if (!approval || typeof approval.challenge !== "string") return rejected();
    const assertion = approval.assertion;
    if (typeof assertion !== "object" || assertion === null) return rejected();
    if (typeof assertion.id !== "string") return rejected();
    const credential = credentials.find((c) => c.id === assertion.id);
    if (!credential) return rejected();

    // Consume before verifying so an approval can never be replayed.
    const consumed = this.db
      .prepare(
        `UPDATE passkey_challenges SET used = 1
         WHERE challenge = ? AND purpose = 'approve' AND issuer_id = ?
           AND used = 0 AND expires_at > ?
         RETURNING challenge`,
      )
      .get(approval.challenge, issuerId, this.now());
    if (!consumed) return rejected();

    let newCounter: number;
    try {
      const result = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: approval.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
          counter: credential.counter,
        },
      });
      if (!result.verified) return rejected();
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      return rejected();
    }
    if (credential.counter > 0 || newCounter > 0) {
      if (!(newCounter > credential.counter)) return rejected();
    }
    const updated = this.db
      .prepare("UPDATE passkey_credentials SET counter = ? WHERE credential_id = ? AND counter = ?")
      .run(newCounter, credential.id, credential.counter);
    if (updated.changes !== 1) return rejected();
  }

  async finishRegistration(
    issuerId: string,
    response: RegistrationResponseJSON,
  ): Promise<TrustedCredential> {
    const challenge = clientDataChallenge(response);
    // Consume before verifying so a challenge can never be replayed.
    const consumed = this.db
      .prepare(
        `UPDATE passkey_challenges SET used = 1
         WHERE challenge = ? AND purpose = 'register' AND issuer_id = ?
           AND used = 0 AND expires_at > ?
         RETURNING challenge`,
      )
      .get(challenge, issuerId, this.now()) as { challenge: string } | undefined;
    if (!consumed) {
      throw new Error("registration challenge unknown, expired or already used");
    }

    let registrationInfo;
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
      if (!result.verified) throw new Error("registration response was not verified");
      registrationInfo = result.registrationInfo;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`registration response rejected: ${message}`);
    }

    const credentialId = registrationInfo.credential.id;
    const existing = this.db
      .prepare("SELECT credential_id FROM passkey_credentials WHERE credential_id = ?")
      .get(credentialId);
    if (existing) throw new Error("credential already registered");

    const publicKey = Buffer.from(registrationInfo.credential.publicKey).toString("base64url");
    const counter = registrationInfo.credential.counter;
    this.db
      .prepare(
        `INSERT INTO passkey_credentials (credential_id, issuer_id, public_key, counter, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(credentialId, issuerId, publicKey, counter, new Date(this.now()).toISOString());
    return { id: credentialId, publicKey, counter, issuerId };
  }

  credentialsFor(issuerId: string): TrustedCredential[] {
    const rows = this.db
      .prepare(
        "SELECT credential_id, issuer_id, public_key, counter FROM passkey_credentials WHERE issuer_id = ? ORDER BY created_at ASC",
      )
      .all(issuerId) as unknown as CredentialRow[];
    return rows.map((row) => ({
      id: row.credential_id,
      issuerId: row.issuer_id,
      publicKey: row.public_key,
      counter: row.counter,
    }));
  }

  async beginEdit(args: {
    issuerId: string;
    mandate: Mandate;
    prevHash: string | null;
  }): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    nonce: string;
    challenge: string;
    audience: string;
    expires_at: string;
  }> {
    const validated = validateMandate(args.mandate);
    if (!validated.ok) throw new Error(`invalid mandate: ${validated.errors.join("; ")}`);
    if (args.mandate.issuer.id !== args.issuerId) {
      throw new Error("mandate issuer does not match issuerId");
    }
    const credentials = this.credentialsFor(args.issuerId);
    if (credentials.length === 0) {
      throw new Error("issuer has no registered passkey credential");
    }
    const nonce = randomBytes(32).toString("base64url");
    const audience = this.audience;
    const expires_at = wholeSecondsIso(this.now() + this.challengeTtlMs);
    const challenge = challengeFor({
      mandate: args.mandate,
      prev_hash: args.prevHash,
      nonce,
      audience,
      expires_at,
    });
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: new Uint8Array(Buffer.from(challenge, "base64url")),
      allowCredentials: credentials.map((c) => ({ id: c.id })),
      userVerification: "required",
    });
    if (options.challenge !== challenge) {
      throw new Error("authentication options challenge does not match the computed challenge");
    }
    this.db
      .prepare(
        `INSERT INTO passkey_challenges
           (challenge, purpose, issuer_id, mandate_id, prev_hash, mandate_hash, nonce, audience, doc_expires_at, expires_at)
         VALUES (?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        challenge,
        args.issuerId,
        args.mandate.id,
        args.prevHash,
        mandateHash(args.mandate),
        nonce,
        audience,
        expires_at,
        this.now() + this.challengeTtlMs,
      );
    return { options, nonce, challenge, audience, expires_at };
  }

  async finishEdit(
    doc: PasskeySignedMandate,
  ): Promise<
    { ok: true; doc: PasskeySignedMandate; newCounter: number } | { ok: false; reason: string }
  > {
    try {
      let challenge: string;
      let mandate_hash: string;
      try {
        challenge = challengeFor(doc);
        mandate_hash = mandateHash(doc.mandate);
      } catch {
        return { ok: false, reason: "unsigned or malformed passkey mandate: cannot hash document" };
      }
      const nonce = doc.nonce;
      const raw = doc as unknown as Record<string, unknown>;
      const audienceParam = typeof raw.audience === "string" ? raw.audience : "";
      const expiresAtParam = typeof raw.expires_at === "string" ? raw.expires_at : "";
      const mandateIdParam =
        typeof raw.mandate === "object" && raw.mandate !== null &&
        typeof (raw.mandate as { id?: unknown }).id === "string"
          ? ((raw.mandate as { id: string }).id)
          : "";
      // Consume the edit challenge before verifying: single use whatever happens next.
      const row = this.db
        .prepare(
          `UPDATE passkey_challenges SET used = 1
           WHERE challenge = ? AND purpose = 'edit' AND used = 0 AND expires_at > ?
             AND prev_hash IS ? AND nonce = ? AND mandate_hash = ?
             AND audience = ? AND doc_expires_at = ? AND mandate_id = ?
           RETURNING issuer_id, prev_hash, mandate_id`,
        )
        .get(
          challenge,
          this.now(),
          doc.prev_hash,
          nonce,
          mandate_hash,
          audienceParam,
          expiresAtParam,
          mandateIdParam,
        ) as ChallengeRow | undefined;
      if (!row) {
        return { ok: false, reason: "edit challenge unknown, expired or already used" };
      }

      const issuerId = row.issuer_id;
      const credentials = this.credentialsFor(issuerId);
      const result = await verifyPasskeyMandate(doc, {
        credentials,
        rpID: this.rpID,
        origin: this.origin,
        expectedPrevHash: row.prev_hash,
        audience: this.audience,
        now: this.now,
      });
      if (!result.ok) return result;

      const prior = credentials.find((c) => c.id === result.credentialId);
      if (!prior) return { ok: false, reason: "credential not trusted" };
      const updated = this.db
        .prepare(
          "UPDATE passkey_credentials SET counter = ? WHERE credential_id = ? AND counter = ?",
        )
        .run(result.newCounter, result.credentialId, prior.counter);
      if (updated.changes !== 1) {
        return { ok: false, reason: "credential counter changed concurrently; edit refused" };
      }
      return { ok: true, doc: result.doc, newCounter: result.newCounter };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: message };
    }
  }
}
