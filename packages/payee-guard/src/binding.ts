import {
  canonicalize,
  sha256Hex,
  signBytes,
  verifyBytes,
  type Signer,
} from "@mandate/core";
import { BINDING_PATH, BINDING_SIGNING_PREFIX } from "./constants.js";

export interface PayeeBinding {
  version: 1;
  origin: string;
  payees: Array<{
    network: string;
    asset: string;
    pay_to: string;
    quotes?: Array<{ path: string; amount: string }>;
  }>;
  issued_at: string;
  expires_at: string;
}

export interface SignedPayeeBinding {
  binding: PayeeBinding;
  signature: string;
}

const HEX40_RE = /^0x[0-9a-fA-F]{40}$/;
const NETWORK_RE = /^eip155:\d{1,12}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const INT_RE = /^[1-9]\d*$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BINDING_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_PAYEES = 100;
const MAX_QUOTES = 100;
const MAX_PATH_LENGTH = 512;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 65536;

const DOC_KEYS = new Set(["binding", "signature"]);
const BINDING_KEYS = new Set(["version", "origin", "payees", "issued_at", "expires_at"]);
const PAYEE_KEYS = new Set(["network", "asset", "pay_to", "quotes"]);
const QUOTE_KEYS = new Set(["path", "amount"]);

type Fail = { ok: false; reason: string };
type Verified = { ok: true; binding: PayeeBinding; hash: string };

function fail(reason: string): Fail {
  return { ok: false, reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

function isRealDate(v: string): boolean {
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 19) === v.slice(0, 19);
}

function isCanonicalAmount(v: unknown): v is string {
  if (typeof v !== "string" || !INT_RE.test(v)) return false;
  return BigInt(v) <= MAX_SAFE;
}

function encode(message: string): Uint8Array {
  return new TextEncoder().encode(message);
}

export function signBinding(b: PayeeBinding, signer: Signer): SignedPayeeBinding {
  const message = BINDING_SIGNING_PREFIX + canonicalize(b);
  return { binding: b, signature: signBytes(signer.privateKey, encode(message)) };
}

export function verifyBinding(
  doc: unknown,
  publicKey: string,
  expectedOrigin: string,
  nowMs: number,
): Verified | Fail {
  if (!isRecord(doc)) return fail("document: must be an object");
  const unknownDocument = unknownKeys(doc, DOC_KEYS);
  if (unknownDocument.length > 0) return fail(`document: unknown field ${unknownDocument[0]}`);
  if (typeof doc.signature !== "string") return fail("signature: must be a string");
  if (!isRecord(doc.binding)) return fail("binding: must be an object");
  const b = doc.binding;

  const unknownBinding = unknownKeys(b, BINDING_KEYS);
  if (unknownBinding.length > 0) return fail(`binding.${unknownBinding[0]}: unknown field`);

  if (b.version !== 1) return fail("binding.version: must be 1");
  if (typeof b.origin !== "string") return fail("binding.origin: must be a string");
  if (b.origin !== expectedOrigin) {
    return fail(`binding.origin: expected ${expectedOrigin} but found ${b.origin}`);
  }

  if (!Array.isArray(b.payees)) return fail("binding.payees: must be an array");
  if (b.payees.length > MAX_PAYEES) {
    return fail(`binding.payees: must contain at most ${MAX_PAYEES} entries`);
  }
  for (let i = 0; i < b.payees.length; i++) {
    const p = b.payees[i];
    if (!isRecord(p)) return fail(`binding.payees[${i}]: must be an object`);
    const unknownPayee = unknownKeys(p, PAYEE_KEYS);
    if (unknownPayee.length > 0) {
      return fail(`binding.payees[${i}].${unknownPayee[0]}: unknown field`);
    }
    if (typeof p.network !== "string" || !NETWORK_RE.test(p.network)) {
      return fail(`binding.payees[${i}].network: must match ^eip155:\\d{1,12}$`);
    }
    if (typeof p.asset !== "string" || !HEX40_RE.test(p.asset)) {
      return fail(`binding.payees[${i}].asset: must be 0x + 40 hex`);
    }
    if (typeof p.pay_to !== "string" || !HEX40_RE.test(p.pay_to)) {
      return fail(`binding.payees[${i}].pay_to: must be 0x + 40 hex`);
    }
    if (p.quotes !== undefined) {
      if (!Array.isArray(p.quotes)) {
        return fail(`binding.payees[${i}].quotes: must be an array`);
      }
      if (p.quotes.length > MAX_QUOTES) {
        return fail(`binding.payees[${i}].quotes: must contain at most ${MAX_QUOTES} entries`);
      }
      for (let j = 0; j < p.quotes.length; j++) {
        const q = p.quotes[j];
        if (!isRecord(q)) return fail(`binding.payees[${i}].quotes[${j}]: must be an object`);
        const unknownQuote = unknownKeys(q, QUOTE_KEYS);
        if (unknownQuote.length > 0) {
          return fail(`binding.payees[${i}].quotes[${j}].${unknownQuote[0]}: unknown field`);
        }
        if (typeof q.path !== "string" || !q.path.startsWith("/") || q.path.length > MAX_PATH_LENGTH) {
          return fail(
            `binding.payees[${i}].quotes[${j}].path: must start with "/" and be at most ${MAX_PATH_LENGTH} characters`,
          );
        }
        if (!isCanonicalAmount(q.amount)) {
          return fail(
            `binding.payees[${i}].quotes[${j}].amount: must be a canonical positive integer string`,
          );
        }
      }
    }
  }

  for (const field of ["issued_at", "expires_at"] as const) {
    const v = b[field];
    if (typeof v !== "string" || !TS_RE.test(v) || !isRealDate(v)) {
      return fail(`binding.${field}: must be an RFC3339 UTC timestamp ending in Z`);
    }
  }
  const issuedAt = Date.parse(b.issued_at as string);
  const expiresAt = Date.parse(b.expires_at as string);
  if (expiresAt - issuedAt > MAX_BINDING_MS) {
    return fail("binding: validity window must not exceed 400 days");
  }
  if (issuedAt > nowMs) return fail("binding.issued_at: is not yet valid");
  if (nowMs >= expiresAt) return fail("binding.expires_at: has expired");

  const binding = b as unknown as PayeeBinding;
  const message = BINDING_SIGNING_PREFIX + canonicalize(binding);
  if (!verifyBytes(publicKey, encode(message), doc.signature)) {
    return fail("signature: verification failed");
  }
  return { ok: true, binding, hash: sha256Hex(canonicalize(binding)) };
}

export async function fetchBinding(
  origin: string,
  opts?: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number },
): Promise<{ ok: true; doc: unknown } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetch ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchImpl(origin + BINDING_PATH, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      return { ok: false, reason: `binding fetch: HTTP ${res.status}` };
    }
    const body = await readLimited(res, maxBytes);
    if (!body.ok) return { ok: false, reason: body.reason };
    let doc: unknown;
    try {
      doc = JSON.parse(body.text);
    } catch {
      return { ok: false, reason: "binding fetch: response is not valid JSON" };
    }
    return { ok: true, doc };
  } catch (err) {
    if (timedOut) {
      return { ok: false, reason: `binding fetch: timed out after ${timeoutMs} ms` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `binding fetch: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(
  res: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const tooLarge = `binding fetch: response exceeds ${maxBytes} bytes`;
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, reason: tooLarge };
    return { ok: true, text };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // the stream may already be closed; ignore.
      }
      return { ok: false, reason: tooLarge };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}
