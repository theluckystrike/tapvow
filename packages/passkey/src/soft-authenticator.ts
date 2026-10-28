import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type CborInput = Parameters<typeof isoCBOR.encode>[0];

function cborEncode(value: unknown): Uint8Array {
  return isoCBOR.encode(value as CborInput);
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function uint32BE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

function uint16BE(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

export interface SoftAuthenticatorCreateContext {
  origin: string;
  rpID?: string;
  userVerified?: boolean;
  userPresent?: boolean;
  crossOrigin?: boolean;
  topOrigin?: string;
  /** COSE algorithm identifier placed in the credential public key map. */
  coseAlg?: number;
}

export interface SoftAuthenticatorAssertionContext {
  origin: string;
  rpID: string;
  userVerified?: boolean;
  userPresent?: boolean;
  type?: string;
  crossOrigin?: boolean;
  topOrigin?: string;
  counter?: number;
  signWith?: SoftAuthenticator;
}

/**
 * A software WebAuthn authenticator (ES256 / P-256) so tests need no browser.
 */
export class SoftAuthenticator {
  readonly credentialId: string;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private readonly spki: Buffer;
  private readonly step: number;
  private counter: number;

  constructor(opts: { counterStart?: number; counterStep?: number } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new Error("could not export P-256 public key coordinates");
    }
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
    this.spki = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
    this.credentialId = randomBytes(32).toString("base64url");
    this.counter = opts.counterStart ?? 0;
    this.step = opts.counterStep ?? 1;
  }

  private coseKeyBytes(alg = -7): Buffer {
    return Buffer.from(
      cborEncode(
        new Map<number, unknown>([
          [1, 2],
          [3, alg],
          [-1, 1],
          [-2, this.x],
          [-3, this.y],
        ]),
      ),
    );
  }

  /** base64url of the COSE_Key bytes for this credential. */
  credentialPublicKey(): string {
    return this.coseKeyBytes().toString("base64url");
  }

  createCredential(
    options: PublicKeyCredentialCreationOptionsJSON,
    ctx: SoftAuthenticatorCreateContext,
  ): RegistrationResponseJSON {
    const rpID = ctx.rpID ?? options.rp.id ?? "";
    const userPresent = ctx.userPresent ?? true;
    const userVerified = ctx.userVerified ?? true;
    const flags =
      (userPresent ? 0x01 : 0x00) | (userVerified ? 0x04 : 0x00) | 0x40;
    const credentialIdBytes = Buffer.from(this.credentialId, "base64url");
    const coseAlg = ctx.coseAlg ?? -7;
    const authData = Buffer.concat([
      sha256(Buffer.from(rpID, "utf8")),
      Buffer.from([flags]),
      uint32BE(this.counter),
      Buffer.alloc(16),
      uint16BE(credentialIdBytes.length),
      credentialIdBytes,
      this.coseKeyBytes(coseAlg),
    ]);
    const clientData: Record<string, unknown> = {
      type: "webauthn.create",
      challenge: options.challenge,
      origin: ctx.origin,
      crossOrigin: ctx.crossOrigin ?? false,
    };
    if (ctx.topOrigin) clientData.topOrigin = ctx.topOrigin;
    const clientDataJSON = JSON.stringify(clientData);
    const attestationObject = Buffer.from(
      cborEncode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map<string, unknown>()],
          ["authData", authData],
        ]),
      ),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON, "utf8")),
        attestationObject: attestationObject.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        transports: ["internal"],
        publicKeyAlgorithm: coseAlg,
        publicKey: this.spki.toString("base64url"),
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      type: "public-key",
    };
  }

  getAssertion(challenge: string, ctx: SoftAuthenticatorAssertionContext): AuthenticationResponseJSON {
    const userPresent = ctx.userPresent ?? true;
    const userVerified = ctx.userVerified ?? true;
    const flags = (userPresent ? 0x01 : 0x00) | (userVerified ? 0x04 : 0x00);
    let counter: number;
    if (typeof ctx.counter === "number") {
      counter = ctx.counter;
    } else {
      this.counter += this.step;
      counter = this.counter;
    }
    const authData = Buffer.concat([
      sha256(Buffer.from(ctx.rpID, "utf8")),
      Buffer.from([flags]),
      uint32BE(counter),
    ]);
    const clientData: Record<string, unknown> = {
      type: ctx.type ?? "webauthn.get",
      challenge,
      origin: ctx.origin,
      crossOrigin: ctx.crossOrigin ?? false,
    };
    if (ctx.topOrigin) clientData.topOrigin = ctx.topOrigin;
    const clientDataJSON = JSON.stringify(clientData);
    const clientDataHash = sha256(Buffer.from(clientDataJSON, "utf8"));
    const signatureBytes = sign(
      "sha256",
      Buffer.concat([authData, clientDataHash]),
      ctx.signWith ? ctx.signWith.privateKey : this.privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON, "utf8")),
        authenticatorData: authData.toString("base64url"),
        signature: signatureBytes.toString("base64url"),
      },
      clientExtensionResults: {},
      type: "public-key",
    };
  }
}
