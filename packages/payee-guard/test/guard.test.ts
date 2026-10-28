import test from "node:test";
import assert from "node:assert/strict";
import { generateSigner } from "@mandate/core";
import {
  checkPayment,
  median,
  parseX402Allowlist,
  signBinding,
  type GuardOptions,
  type PayeeBinding,
  type PaymentAsk,
} from "../src/index.js";
import { ASSET, NETWORK, PAY_TO, makeBinding, startServer } from "./helpers.js";

const ALLOWED = "0x" + "1".repeat(40);
const ZERO = "0x" + "0".repeat(40);
const OTHER = "0x" + "2".repeat(40);

function ask(overrides?: Partial<PaymentAsk>): PaymentAsk {
  return {
    resourceUrl: "https://api.example.com/report",
    network: NETWORK,
    asset: ASSET,
    payTo: ALLOWED,
    amount: "10000",
    ...overrides,
  };
}

function allowlistFor(ids: string[]): GuardOptions["allowlist"] {
  const parsed = parseX402Allowlist(ids.map((id) => ({ rail: "x402", id })));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.allowlist;
}

function opts(partial?: Partial<GuardOptions>): GuardOptions {
  return {
    allowlist: allowlistFor([`eip155:${NETWORK.slice("eip155:".length)}:${ALLOWED}`]),
    networks: [NETWORK],
    median30d: () => null,
    ...partial,
  };
}

test("allowlisted 0.01 payment passes on the first-payment basis", async () => {
  const result = await checkPayment(ask(), opts());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payeeBasis, "allowlist");
  assert.equal(result.priceBasis, "first_payment");
  assert.equal(result.referenceMicros, null);
  assert.equal(result.amountMicros, 10000);
});

test("wrong network is blocked", async () => {
  const result = await checkPayment(ask({ network: "eip155:1" }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "network_not_allowed");
});

test("wrong asset is blocked", async () => {
  const result = await checkPayment(ask({ asset: "0x" + "9".repeat(40) }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "asset_not_allowed");
  assert.match(result.reason, /is not USDC on/);
});

test("zero address is blocked", async () => {
  const result = await checkPayment(ask({ payTo: ZERO }), opts());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "bad_request");
});

test("non-integer, leading-zero and negative amounts are blocked", async () => {
  for (const amount of ["1.5", "010", "-1", "", "0", "0.01"]) {
    const result = await checkPayment(ask({ amount }), opts());
    assert.equal(result.ok, false, `amount ${amount}`);
    if (result.ok) return;
    assert.equal(result.code, "bad_request");
  }
});

test("a malformed resourceUrl is blocked", async () => {
  for (const resourceUrl of ["not a url", "ftp://api.example.com/x", "file:///etc/passwd"]) {
    const result = await checkPayment(ask({ resourceUrl }), opts());
    assert.equal(result.ok, false, resourceUrl);
    if (result.ok) return;
    assert.equal(result.code, "bad_request");
  }
});

test("an unknown payee with no binding is blocked and names both", async () => {
  const result = await checkPayment(
    ask({ payTo: OTHER, resourceUrl: "https://evil.example/unlock" }),
    opts(),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "payee_not_allowed");
  assert.ok(result.reason.includes(OTHER));
  assert.ok(result.reason.includes("https://evil.example"));
});

test("median basis passes at 3x and fails above", async () => {
  const options = opts({ median30d: () => 10000 });
  const atThree = await checkPayment(ask({ amount: "30000" }), options);
  assert.equal(atThree.ok, true);
  if (!atThree.ok) return;
  assert.equal(atThree.priceBasis, "median_30d");
  assert.equal(atThree.referenceMicros, 10000);

  const above = await checkPayment(ask({ amount: "30001" }), options);
  assert.equal(above.ok, false);
  if (above.ok) return;
  assert.equal(above.code, "amount_out_of_bounds");
  assert.match(above.reason, /30-day median/);
  assert.match(above.reason, /0\.010000/);
});

test("first-payment cap applies when there is no history", async () => {
  const result = await checkPayment(
    ask({ amount: "50001" }),
    opts({ median30d: () => null }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "amount_out_of_bounds");
  assert.match(result.reason, /first-payment limit/);
});

test("binding payee with a quote passes at 3x and is blocked above, with reason", async () => {
  const { signer, publicKey } = generateSigner("binding");
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    const binding = makeBinding(server.origin);
    body = JSON.stringify(signBinding(binding, signer));

    const options: GuardOptions = {
      allowlist: allowlistFor([`binding:${publicKey}@${server.origin}`]),
      networks: [NETWORK],
      median30d: () => null,
    };

    const atQuote = await checkPayment(
      ask({ resourceUrl: `${server.origin}/report`, payTo: PAY_TO, amount: "10000" }),
      options,
    );
    assert.equal(atQuote.ok, true);
    if (!atQuote.ok) return;
    assert.equal(atQuote.payeeBasis, "binding");
    assert.equal(atQuote.priceBasis, "quote");
    assert.equal(atQuote.referenceMicros, 10000);
    assert.equal(typeof atQuote.bindingHash, "string");

    const atThree = await checkPayment(
      ask({ resourceUrl: `${server.origin}/report`, payTo: PAY_TO, amount: "30000" }),
      options,
    );
    assert.equal(atThree.ok, true);

    const above = await checkPayment(
      ask({ resourceUrl: `${server.origin}/report`, payTo: PAY_TO, amount: "30001" }),
      options,
    );
    assert.equal(above.ok, false);
    if (above.ok) return;
    assert.equal(above.code, "amount_out_of_bounds");
    assert.match(above.reason, /quoted price 0\.010000 USDC/);
  } finally {
    await server.close();
  }
});

test("binding payee not listed in the binding is blocked", async () => {
  const { signer, publicKey } = generateSigner("binding");
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    body = JSON.stringify(signBinding(makeBinding(server.origin), signer));
    const result = await checkPayment(
      ask({ resourceUrl: `${server.origin}/report`, payTo: OTHER }),
      {
        allowlist: allowlistFor([`binding:${publicKey}@${server.origin}`]),
        networks: [NETWORK],
        median30d: () => null,
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "payee_not_allowed");
  } finally {
    await server.close();
  }
});

test("a bad binding signature yields payee_binding_invalid", async () => {
  const { signer } = generateSigner("binding");
  const other = generateSigner("other");
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    body = JSON.stringify(signBinding(makeBinding(server.origin), signer));
    const result = await checkPayment(
      ask({ resourceUrl: `${server.origin}/report`, payTo: PAY_TO }),
      {
        allowlist: allowlistFor([`binding:${other.publicKey}@${server.origin}`]),
        networks: [NETWORK],
        median30d: () => null,
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "payee_binding_invalid");
  } finally {
    await server.close();
  }
});

test("a failed binding fetch yields payee_binding_invalid", async () => {
  const { publicKey } = generateSigner("binding");
  const result = await checkPayment(
    ask({ resourceUrl: "http://127.0.0.1:1/report", payTo: PAY_TO }),
    {
      allowlist: allowlistFor([`binding:${publicKey}@http://127.0.0.1:1`]),
      networks: [NETWORK],
      median30d: () => null,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "payee_binding_invalid");
});

test("median() computes odd, even and empty cases", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2]), 2);
  assert.equal(median([10000, 20000]), 15000);
});

test("a binding that quotes prices but not this path is blocked (no fallback to the median)", async () => {
  const { signer, publicKey } = generateSigner("binding");
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    body = JSON.stringify(signBinding(makeBinding(server.origin), signer));
    const result = await checkPayment(
      ask({ resourceUrl: `${server.origin}/other`, payTo: PAY_TO, amount: "10000" }),
      {
        allowlist: allowlistFor([`binding:${publicKey}@${server.origin}`]),
        networks: [NETWORK],
        median30d: () => null,
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "amount_out_of_bounds");
    assert.match(result.reason, /no quote for path \/other/);
  } finally {
    await server.close();
  }
});

test("PayeeBinding type is exported for consumers", () => {
  const b: PayeeBinding = makeBinding("https://x.example.com");
  assert.equal(b.version, 1);
});
