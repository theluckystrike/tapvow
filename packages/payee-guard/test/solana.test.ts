// Solana payees use case-sensitive base58 addresses and the devnet USDC mint.
// The allowlist and the amount guard must accept them without lowercasing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addressKey,
  checkPayment,
  isBase58Address,
  parseX402Allowlist,
  type GuardOptions,
  type PaymentAsk,
} from "../src/index.js";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYEE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function ask(overrides?: Partial<PaymentAsk>): PaymentAsk {
  return {
    resourceUrl: "https://api.example.com/policy",
    network: DEVNET,
    asset: USDC_DEVNET,
    payTo: PAYEE,
    amount: "10000",
    ...overrides,
  };
}

function allowlistFor(ids: string[]): GuardOptions["allowlist"] {
  const parsed = parseX402Allowlist(ids.map((id) => ({ rail: "x402", id })));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.allowlist;
}

function opts(overrides: Partial<GuardOptions> = {}): GuardOptions {
  return {
    allowlist: allowlistFor([`${DEVNET}:${PAYEE}`]),
    networks: [DEVNET],
    median30d: () => null,
    ...overrides,
  };
}

test("accepts a canonical 32-byte base58 address", () => {
  assert.equal(isBase58Address(PAYEE), true);
  assert.equal(isBase58Address(USDC_DEVNET), true);
  assert.equal(isBase58Address("0OIl"), false);
  assert.equal(isBase58Address("not-an-address"), false);
});

test("parses a Solana allowlist entry without lowercasing the address", () => {
  const parsed = parseX402Allowlist([{ rail: "x402", id: `${DEVNET}:${PAYEE}` }]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.allowlist.addresses.has(`${DEVNET}:${PAYEE}`), true);
  assert.equal(parsed.allowlist.addresses.has(`${DEVNET}:${PAYEE.toLowerCase()}`), false);
  assert.equal(parsed.allowlist.addresses.has(addressKey(DEVNET, PAYEE)), true);
});

test("rejects a Solana id with a malformed address", () => {
  const parsed = parseX402Allowlist([{ rail: "x402", id: `${DEVNET}:0OIl` }]);
  assert.equal(parsed.ok, false);
});

test("an allowlisted devnet USDC payment passes on the first-payment basis", async () => {
  const result = await checkPayment(ask(), opts());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payeeBasis, "allowlist");
  assert.equal(result.amountMicros, 10000);
});

test("a Solana payee that differs only by case is not allowed", async () => {
  const lower = PAYEE.toLowerCase();
  assert.notEqual(lower, PAYEE);
  const result = await checkPayment(ask({ payTo: lower }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "bad_request");
});

test("an unknown Solana payee is blocked", async () => {
  const result = await checkPayment(ask({ payTo: OTHER }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "payee_not_allowed");
});

test("a non-USDC Solana mint is blocked", async () => {
  const result = await checkPayment(ask({ asset: PAYEE }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "asset_not_allowed");
});

test("a Solana network not enabled is blocked", async () => {
  const result = await checkPayment(ask({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "network_not_allowed");
});
