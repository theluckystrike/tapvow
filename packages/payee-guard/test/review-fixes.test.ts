// Regression tests for the independent review of 18 Oct 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateSigner } from "@mandate/core";
import { checkPayment, parseX402Allowlist, signBinding, USDC, type GuardOptions, type PayeeBinding } from "../src/index.js";

const NETWORK = "eip155:84532";
const ASSET = USDC[NETWORK]!;
const PAYEE = "0x" + "1".repeat(40);

function allowlist(ids: string[]): GuardOptions["allowlist"] {
  const p = parseX402Allowlist(ids.map((id) => ({ rail: "x402", id })));
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.allowlist;
}

test("an allowlisted payee on a plain http, non-loopback origin is refused", async () => {
  const r = await checkPayment(
    { resourceUrl: "http://api.example.com/report", network: NETWORK, asset: ASSET, payTo: PAYEE, amount: "10000" },
    { allowlist: allowlist([`${NETWORK}:${PAYEE}`]), networks: [NETWORK], median30d: () => null },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /https/);
});

test("NaN or negative bounds never switch the amount check off", async () => {
  const base = { allowlist: allowlist([`${NETWORK}:${PAYEE}`]), networks: [NETWORK], median30d: () => null };
  const ask = { resourceUrl: "https://api.example.com/report", network: NETWORK, asset: ASSET, payTo: PAYEE, amount: "50000000" };
  for (const bad of [{ multiplier: Number.NaN }, { multiplier: -1 }, { firstPaymentMaxMicros: Number.NaN }, { firstPaymentMaxMicros: -5 }]) {
    const r = await checkPayment(ask, { ...base, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("a rotated binding key works when both old and new keys are pinned for the origin", async () => {
  const oldKey = generateSigner("old");
  const newKey = generateSigner("new");
  let body = "";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const now = Date.now();
    const binding: PayeeBinding = {
      version: 1,
      origin,
      payees: [{ network: NETWORK, asset: ASSET, pay_to: PAYEE, quotes: [{ path: "/report", amount: "10000" }] }],
      issued_at: new Date(now - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      expires_at: new Date(now + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    body = JSON.stringify(signBinding(binding, newKey.signer));
    const r = await checkPayment(
      { resourceUrl: `${origin}/report`, network: NETWORK, asset: ASSET, payTo: PAYEE, amount: "10000" },
      { allowlist: allowlist([`binding:${oldKey.publicKey}@${origin}`, `binding:${newKey.publicKey}@${origin}`]), networks: [NETWORK], median30d: () => null },
    );
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    if (r.ok) assert.equal(r.priceBasis, "quote");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
