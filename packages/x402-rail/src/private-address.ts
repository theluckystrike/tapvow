// Shared private-address policy for the x402 rail and its pinned fetch.
import { isIP } from "node:net";

/** Parse four dotted decimal octets, or null. */
function parseIpv4(a: string): number[] | null {
  const parts = a.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parse one colon-separated IPv6 side (no "::") into 16-bit groups, or null. */
function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const parts = side.split(":");
  const out: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.includes(".")) {
      // An embedded dotted IPv4 is only valid as the final group and stands in
      // for the last two 16-bit groups.
      if (i !== parts.length - 1) return null;
      const v4 = parseIpv4(part);
      if (!v4) return null;
      out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
  }
  return out;
}

/** Parse an IPv6 literal into 16 bytes, or null if it is malformed. */
function parseIpv6(a: string): Uint8Array | null {
  let s = a;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  const dbl = s.indexOf("::");
  let groups: number[];
  if (dbl >= 0) {
    if (s.indexOf("::", dbl + 1) !== -1) return null;
    const head = parseIpv6Side(s.slice(0, dbl));
    const tail = parseIpv6Side(s.slice(dbl + 2));
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const all = parseIpv6Side(s);
    if (!all || all.length !== 8) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[i * 2] = (groups[i]! >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

function allZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/** IPv4 private, loopback, link-local, shared, benchmarking, reserved and multicast ranges. */
function isPrivateIpv4(octets: number[]): boolean {
  const [x, y, z] = octets as [number, number, number];
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 198 && y >= 18 && y <= 19) ||
    (x === 192 && y === 0 && z === 0) ||
    x >= 224
  );
}

/** True for loopback, private, link-local, unspecified and other non-public addresses. */
export function isPrivateAddress(a: string): boolean {
  const bare = a.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) {
    const v4 = parseIpv4(bare);
    return v4 === null ? true : isPrivateIpv4(v4);
  }
  if (isIP(bare) === 6) {
    const b = parseIpv6(bare);
    if (!b) return true;
    // ::ffff:0:0/96 (IPv4-mapped).
    if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
      return isPrivateIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
    }
    // ::ffff:0:0:0/96 (IPv4-translated): the IPv4 is in the last four bytes.
    if (allZero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
      return isPrivateIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
    }
    // ::/96 (IPv4-compatible, also covers :: and ::1).
    if (allZero(b, 0, 12)) {
      return isPrivateIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
    }
    // 64:ff9b::/96 (NAT64).
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
      return isPrivateIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
    }
    // 2002::/16 (6to4): the embedded IPv4 is bytes 2..5.
    if (b[0] === 0x20 && b[1] === 0x02) {
      return isPrivateIpv4([b[2]!, b[3]!, b[4]!, b[5]!]);
    }
    if (b[0] === 0xff) return true; // ff00::/8 multicast
    if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local
    return false;
  }
  // Not an IP literal: fail closed.
  return true;
}
