import { decodeB64urlStrict } from "@mandate/core";

export interface X402Allowlist {
  addresses: Set<string>;
  bindings: Array<{ origin: string; publicKey: string }>;
}

const NETWORK_RE = /^eip155:\d{1,12}$/;
const ADDRESS_ID_RE = /^(eip155:\d{1,12}):(0x[0-9a-fA-F]{40})$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const RAW_PUBLIC_KEY_LENGTH = 32;

export function addressKey(network: string, address: string): string {
  return `${network}:${address.toLowerCase()}`;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function checkOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "origin is not a valid URL";
  }
  if (url.origin !== origin) {
    return "origin must have no path, query, fragment, userinfo or trailing slash";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    if (url.hostname.startsWith("[")) {
      if (url.hostname === "[::1]") return null;
      return "http origin is only allowed for 127.0.0.1, localhost or [::1]";
    }
    if (isLoopbackHost(url.hostname)) return null;
    return "http origin is only allowed for 127.0.0.1, localhost or [::1]";
  }
  return "origin must use https (or http on loopback)";
}

function parseBindingId(id: string): { origin: string; publicKey: string } | string {
  const rest = id.slice("binding:".length);
  const at = rest.indexOf("@");
  if (at <= 0 || at === rest.length - 1) {
    return 'binding id must be "binding:<public key>@<origin>"';
  }
  const publicKey = rest.slice(0, at);
  const origin = rest.slice(at + 1);
  if (origin.includes("@")) {
    return "origin must not contain userinfo";
  }
  const keyBytes = decodeB64urlStrict(publicKey);
  if (!keyBytes || keyBytes.length !== RAW_PUBLIC_KEY_LENGTH) {
    return "public key must be a canonical 32-byte base64url string";
  }
  const originError = checkOrigin(origin);
  if (originError) return originError;
  return { origin, publicKey };
}

export function parseX402Allowlist(
  payees: ReadonlyArray<{ rail: string; id: string }>,
): { ok: true; allowlist: X402Allowlist } | { ok: false; errors: string[] } {
  const addresses = new Set<string>();
  const bindings: Array<{ origin: string; publicKey: string }> = [];
  const errors: string[] = [];

  payees.forEach((payee, i) => {
    if (payee.rail !== "x402") return;
    const id = payee.id;
    if (typeof id !== "string") {
      errors.push(`payees[${i}].id: must be a string`);
      return;
    }
    if (id.startsWith("binding:")) {
      const parsed = parseBindingId(id);
      if (typeof parsed === "string") {
        errors.push(`payees[${i}].id: ${parsed}`);
      } else {
        bindings.push(parsed);
      }
      return;
    }
    const match = ADDRESS_ID_RE.exec(id);
    if (match) {
      const network = match[1]!;
      const address = match[2]!;
      if (!NETWORK_RE.test(network)) {
        errors.push(`payees[${i}].id: invalid network`);
        return;
      }
      addresses.add(addressKey(network, address));
      return;
    }
    errors.push(
      `payees[${i}].id: must be "eip155:<chainId>:0x<40 hex>" or "binding:<key>@<origin>"`,
    );
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, allowlist: { addresses, bindings } };
}
