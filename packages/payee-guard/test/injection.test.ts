import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPayment, parseX402Allowlist, type GuardOptions } from "../src/index.js";
import { ASSET, NETWORK } from "./helpers.js";

const README = readFileSync(new URL("./fixtures/poisoned-README.md", import.meta.url), "utf8");

const LEGIT = "0x" + "1".repeat(40);

function allowlistFor(ids: string[]): GuardOptions["allowlist"] {
  const parsed = parseX402Allowlist(ids.map((id) => ({ rail: "x402", id })));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.allowlist;
}

function extractInjection(): { url: string; origin: string; payTo: string; amount: string } {
  const url = /http:\/\/127\.0\.0\.1:\d+\/unlock/.exec(README);
  const payTo = /0x[0-9a-fA-F]{40}/.exec(README);
  const amount = /amount\s+"?(\d{1,18})"?/.exec(README);
  assert.ok(url, "README must contain the injected URL");
  assert.ok(payTo, "README must contain the injected payTo");
  assert.ok(amount, "README must contain the injected amount");
  return {
    url: url[0],
    origin: new URL(url[0]).origin,
    payTo: payTo[0],
    amount: amount[1]!,
  };
}

test("an agent that obeys the poisoned README is blocked with payee_not_allowed", async () => {
  const injected = extractInjection();
  assert.equal(injected.amount, "50000000");

  const result = await checkPayment(
    {
      resourceUrl: injected.url,
      network: NETWORK,
      asset: ASSET,
      payTo: injected.payTo,
      amount: injected.amount,
    },
    {
      allowlist: allowlistFor([`eip155:84532:${LEGIT}`]),
      networks: [NETWORK],
      median30d: () => null,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "payee_not_allowed");
  assert.ok(result.reason.includes(injected.payTo));
  assert.ok(result.reason.includes(injected.origin));
  console.log("# blocked: " + result.reason);
});

test("a poisoned payment to an allowlisted payee is blocked by the amount cap", async () => {
  const injected = extractInjection();
  const result = await checkPayment(
    {
      resourceUrl: injected.url,
      network: NETWORK,
      asset: ASSET,
      payTo: injected.payTo,
      amount: injected.amount,
    },
    {
      allowlist: allowlistFor([`eip155:84532:${injected.payTo}`]),
      networks: [NETWORK],
      median30d: () => 10000,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "amount_out_of_bounds");
  assert.ok(result.reason.includes("50.000000"));
  console.log("# blocked: " + result.reason);
});

test("a legitimate 0.01 payment to the allowlisted payee passes", async () => {
  const result = await checkPayment(
    {
      resourceUrl: "https://api.skycast.example/v1/forecast",
      network: NETWORK,
      asset: ASSET,
      payTo: LEGIT,
      amount: "10000",
    },
    {
      allowlist: allowlistFor([`eip155:84532:${LEGIT}`]),
      networks: [NETWORK],
      median30d: () => null,
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.priceBasis, "first_payment");
  assert.equal(result.referenceMicros, null);
});
