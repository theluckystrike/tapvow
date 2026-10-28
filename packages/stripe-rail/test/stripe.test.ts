import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import {
  StripeClient,
  encodeForm,
  redactSecrets,
  unsafeWebhookEndpoints,
  verifyStripeSignature,
} from "../src/index.js";
import { FAKE_KEY, account, balance, cleanupDirs, fakeStripe, json, token } from "./helpers.js";

after(cleanupDirs);

test("redactSecrets removes test, live and webhook secrets", () => {
  const text = `a sk_test_abc123 b rk_live_def456 c whsec_ghi789 d`;
  assert.equal(redactSecrets(text), "a [REDACTED] b [REDACTED] c [REDACTED] d");
});

test("encodeForm uses bracket notation and encodes values", () => {
  assert.equal(
    encodeForm({
      amount: 60,
      currency: "usd",
      "usage_limits[currency]": "usd",
      confirm: true,
      skip: null,
    }),
    "amount=60&currency=usd&usage_limits%5Bcurrency%5D=usd&confirm=true",
  );
});

test("assertTestMode must pass before any other call, and sends no key in errors", async () => {
  const fake = fakeStripe((call) => {
    if (call.path === "/v1/balance") return balance(false);
    if (call.path === "/v1/account") return account();
    if (call.path.startsWith("/v1/shared_payment/granted_tokens/")) return json(token());
    return json({}, 500);
  });
  const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
  await assert.rejects(client.getToken("spt_test_0001"), /assertTestMode\(\) must pass first/);
  assert.equal(fake.calls.length, 0);
  await client.assertTestMode();
  assert.equal(client.isTestModeVerified, true);
  assert.equal(client.accountId, "acct_test_0001");
  assert.equal(fake.calls[0]!.path, "/v1/balance");
  assert.equal(fake.calls[0]!.headers["stripe-version"], undefined);
  assert.equal(fake.calls[1]!.path, "/v1/account");
  const res = await client.getToken("spt_test_0001");
  assert.ok(res.ok);
  assert.equal(fake.calls[2]!.headers["stripe-version"], "2026-09-30.preview");
  assert.match(fake.calls[2]!.headers.authorization ?? "", /^Basic /);
});

test("the key is not printable through inspect or JSON", () => {
  const client = new StripeClient(FAKE_KEY);
  assert.ok(!inspect(client).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(client).includes(FAKE_KEY));
  assert.match(inspect(client), /\[REDACTED\]/);
});

test("a network error is thrown with the key redacted", async () => {
  const fake = fakeStripe((call) => {
    if (call.path === "/v1/balance") return balance(false);
    if (call.path === "/v1/account") return account();
    throw new Error(`socket closed for ${FAKE_KEY}`);
  });
  const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
  await client.assertTestMode();
  await assert.rejects(client.getToken("spt_test_0001"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(FAKE_KEY));
    assert.equal(err.message, "Stripe request failed: socket closed for [REDACTED]");
    return true;
  });
});

test("response bodies are redacted, including a webhook secret", async () => {
  const fake = fakeStripe((call) => {
    if (call.path === "/v1/balance") return balance(false);
    if (call.path === "/v1/account") return account();
    return json({ object: "list", data: [{ id: "we_1", secret: "whsec_abc123", key: FAKE_KEY }], has_more: false });
  });
  const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
  await client.assertTestMode();
  const res = await client.listWebhookEndpoints();
  const body = res.body as { data: Array<{ secret: string; key: string }> };
  assert.equal(body.data[0]!.secret, "[REDACTED]");
  assert.equal(body.data[0]!.key, "[REDACTED]");
});

test("unsafeWebhookEndpoints fails closed on status, event families and shape", () => {
  assert.deepEqual(
    unsafeWebhookEndpoints([
      { id: "we_disabled", status: "disabled", enabled_events: ["*"] },
      { id: "we_probe", status: "enabled", enabled_events: [] },
    ]),
    [],
  );
  assert.deepEqual(
    unsafeWebhookEndpoints([{ id: "we_charge", status: "enabled", enabled_events: ["charge.captured"] }]),
    ["we_charge"],
  );
  assert.deepEqual(
    unsafeWebhookEndpoints([{ id: "we_wild", status: "enabled", enabled_events: ["*"] }]),
    ["we_wild"],
  );
  assert.deepEqual(
    unsafeWebhookEndpoints([{ id: "we_no_status", enabled_events: ["payment_intent.created"] }]),
    ["we_no_status"],
  );
  assert.deepEqual(
    unsafeWebhookEndpoints([{ id: "we_no_events", status: "enabled" }]),
    ["we_no_events"],
  );
  assert.deepEqual(
    unsafeWebhookEndpoints([{ id: "we_shared", status: "enabled", enabled_events: ["shared_payment.granted_token.deactivated"] }]),
    ["we_shared"],
  );
  assert.deepEqual(
    unsafeWebhookEndpoints([{ id: "we_safe", status: "disabled", enabled_events: [] }, null, "nope"]),
    ["<endpoint 1>", "<endpoint 2>"],
    "a non-object list entry is counted as unsafe, not skipped",
  );
});

test("listWebhookEndpoints fails closed on a malformed 2xx body", async () => {
  const cases: Array<(call: { path: string }) => Response> = [
    () => json({}),
    () => json({ object: "list", data: "nope", has_more: false }),
    () => new Response("<html>not a list</html>", { status: 200 }),
  ];
  for (const response of cases) {
    const fake = fakeStripe((call) => {
      if (call.path === "/v1/balance") return balance(false);
      if (call.path === "/v1/account") return account();
      return response(call);
    });
    const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
    await client.assertTestMode();
    await assert.rejects(client.listWebhookEndpoints(), /was not a webhook endpoint list/);
  }
});

test("listWebhookEndpoints follows has_more and finds an unsafe endpoint on page 2", async () => {
  const fake = fakeStripe((call) => {
    if (call.path === "/v1/balance") return balance(false);
    if (call.path === "/v1/account") return account();
    const after = new URL(call.url).searchParams.get("starting_after");
    if (after === null) {
      return json({
        object: "list",
        data: [{ id: "we_safe", status: "enabled", enabled_events: [] }],
        has_more: true,
      });
    }
    return json({
      object: "list",
      data: [{ id: "we_page2", status: "enabled", enabled_events: ["charge.succeeded"] }],
      has_more: false,
    });
  });
  const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
  await client.assertTestMode();
  const res = await client.listWebhookEndpoints();
  const body = res.body as { data: Array<{ id: string }> };
  assert.deepEqual(body.data.map((e) => e.id), ["we_safe", "we_page2"]);
  assert.deepEqual(unsafeWebhookEndpoints(body.data), ["we_page2"]);
  assert.equal(new URL(fake.calls.at(-1)!.url).searchParams.get("starting_after"), "we_safe");
});

test("a non-JSON error response is redacted", async () => {
  const fake = fakeStripe((call) => {
    if (call.path === "/v1/balance") return balance(false);
    if (call.path === "/v1/account") return account();
    return new Response(`gateway rejected ${FAKE_KEY}`, { status: 502 });
  });
  const client = new StripeClient(FAKE_KEY, { fetch: fake.fetch });
  await client.assertTestMode();
  const res = await client.getToken("spt_test_0001");
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes(FAKE_KEY));
});

function sign(payload: string, secret: string, t: number): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

test("the Stripe-Signature verifier accepts a good signature", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "shared_payment.granted_token.deactivated" });
  const secret = "whsec_testsecret123";
  const t = 1_792_385_400;
  assert.equal(verifyStripeSignature({ payload, signatureHeader: sign(payload, secret, t), secret, nowSeconds: t }), true);
  assert.equal(
    verifyStripeSignature({ payload, signatureHeader: sign(payload, secret, t), secret, nowSeconds: t - 300 }),
    true,
  );
});

test("the verifier rejects a bad signature and a stale timestamp", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  const secret = "whsec_testsecret123";
  const t = 1_792_385_400;
  const good = sign(payload, secret, t);
  const bad = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
  assert.equal(verifyStripeSignature({ payload, signatureHeader: bad, secret, nowSeconds: t }), false);
  assert.equal(verifyStripeSignature({ payload, signatureHeader: sign(payload, "whsec_other", t), secret, nowSeconds: t }), false);
  assert.equal(verifyStripeSignature({ payload, signatureHeader: good, secret, nowSeconds: t - 301 }), false, "301 s in the future");
  assert.equal(verifyStripeSignature({ payload, signatureHeader: good, secret, nowSeconds: t + 301 }), false, "301 s in the past");
  assert.equal(verifyStripeSignature({ payload, signatureHeader: good, secret, nowSeconds: t + 300 }), true, "exactly at the tolerance");
  assert.equal(verifyStripeSignature({ payload, signatureHeader: "garbage", secret, nowSeconds: t }), false);
});

test("the verifier refuses trailing junk, empty secrets, two t values and bad lengths", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  const secret = "whsec_testsecret123";
  const t = 1_792_385_400;
  const good = sign(payload, secret, t);
  const goodV1 = good.split("v1=")[1]!;
  assert.equal(verifyStripeSignature({ payload, signatureHeader: `${good}zz`, secret, nowSeconds: t }), false);
  assert.equal(verifyStripeSignature({ payload, signatureHeader: `t=${t},v1=${goodV1}a`, secret, nowSeconds: t }), false);
  assert.equal(verifyStripeSignature({ payload, signatureHeader: good, secret: "", nowSeconds: t }), false);
  assert.equal(verifyStripeSignature({ payload, signatureHeader: `${good},t=${t}`, secret, nowSeconds: t }), false);
  assert.equal(
    verifyStripeSignature({
      payload,
      signatureHeader: `t=${t},v1=${"0".repeat(64)},v1=${goodV1}`,
      secret,
      nowSeconds: t,
    }),
    true,
    "the second v1 value is the good one",
  );
  assert.equal(
    verifyStripeSignature({ payload, signatureHeader: `t=${t},v1=${goodV1.slice(0, 63)}`, secret, nowSeconds: t }),
    false,
    "a 63 character v1 is rejected without throwing",
  );
});
