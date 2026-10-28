// DONE TEST for the step 4 owner update: the passkey approval page replaces the
// Telegram bot. The gateway serves the page, the owner approves or denies with a
// WebAuthn assertion, and no answer within the timeout is a deny.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, generateSigner, signMandate, EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { SoftAuthenticator } from "@mandate/passkey/testing";
import type { TrustedCredential } from "@mandate/passkey";
import { createGateway, startFakeUpstream, openGovernedRail, type FakeUpstream } from "@mandate/llm-rail";
import { PasskeyApprover, CHALLENGE_PREFIX } from "../src/passkey-approver.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/types.js";

const issuer = generateSigner("owner-2026-10");
const gatewayKey = generateSigner("gateway-1");
const REAL = "sk-test-upstream-NOT-REAL";
const MANDATE_ID = "mdt_passkey_approval_test_0001";

const REQ: ApprovalRequest = {
  mandateId: MANDATE_ID,
  agentId: "agent-01",
  rail: "llm",
  payee: "openai",
  amountMicros: 25000,
  summary: "model gpt-4o, up to 0.025000 USD",
};

const BODY = { model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(2000) }], max_tokens: 100 };

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error("condition not met in time");
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function httpRequest(
  method: string,
  urlStr: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const url = new URL(urlStr);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function get(url: string): Promise<HttpResult> {
  return httpRequest("GET", url);
}

function listenAny(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => resolve((server.address() as AddressInfo).port)));
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function credentialFrom(auth: SoftAuthenticator): TrustedCredential {
  return { id: auth.credentialId, publicKey: auth.credentialPublicKey(), counter: 0, issuerId: "owner" };
}

function parts(link: string): { base: string; r: string; t: string } {
  const url = new URL(link);
  return {
    base: url.origin,
    r: url.searchParams.get("r") ?? "",
    t: url.searchParams.get("t") ?? "",
  };
}

// ---------------------------------------------------------------------------
// Full stack: gateway + routes + passkey approver + fake upstream.
// ---------------------------------------------------------------------------

interface Harness {
  rail: ReturnType<typeof openGovernedRail>;
  upstream: FakeUpstream;
  gateway: Server;
  approver: PasskeyApprover;
  auth: SoftAuthenticator;
  links: string[];
  requests: ApprovalRequest[];
  port: number;
  key: string;
  close(): Promise<void>;
}

async function build(
  opts: { timeoutMs?: number; notify?: (link: string, req: ApprovalRequest) => void | Promise<void> } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mandate-pkapr-"));
  dirs.push(dir);
  const mandate: Mandate = {
    ...EXAMPLE_MANDATE,
    id: MANDATE_ID,
    issuer: { id: "michael", public_key: issuer.publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "0.50",
    approval_threshold: "0.001000",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const signed = signMandate(mandate, issuer.signer);
  const rail = openGovernedRail({
    dbPath: join(dir, "rail.db"),
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  const upstream = await startFakeUpstream({ latencyMs: [5, 15], completion: "random", seed: 11 });
  const auth = new SoftAuthenticator();
  const links: string[] = [];
  const requests: ApprovalRequest[] = [];

  // The approver needs the gateway's port to build its origin and links, and the
  // gateway needs the approver's routes. Populate both once the port is known.
  const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>> = {};
  let approver: PasskeyApprover | null = null;
  const gatewayApprover = {
    request: (r: ApprovalRequest): Promise<ApprovalDecision> => {
      if (!approver) return Promise.reject(new Error("approver not ready"));
      return approver.request(r);
    },
  };
  const gateway = createGateway({
    store: rail.store,
    upstreams: { openai: { baseUrl: upstream.url, apiKey: REAL } },
    routes,
    approver: gatewayApprover,
  });
  const port = await listenAny(gateway);
  const baseUrl = `http://localhost:${port}`;
  const notify =
    opts.notify ??
    ((link: string, request: ApprovalRequest) => {
      links.push(link);
      requests.push(request);
    });
  approver = new PasskeyApprover({
    credentials: [credentialFrom(auth)],
    rpID: "localhost",
    origin: baseUrl,
    baseUrl,
    notify,
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
  });
  for (const [key, handler] of Object.entries(approver.routes())) routes[key] = handler;

  const key = rail.issueAgentKey(mandate.agents[0]!);
  return {
    rail,
    upstream,
    gateway,
    approver,
    auth,
    links,
    requests,
    port,
    key,
    async close() {
      await closeServer(gateway);
      await upstream.close();
      await approver!.close();
      rail.close();
    },
  };
}

function call(h: Harness): Promise<HttpResult> {
  return httpRequest("POST", `http://127.0.0.1:${h.port}/v1/chat/completions`, BODY, {
    authorization: `Bearer ${h.key}`,
  });
}

test("full stack: a passkey approve lets the agent call finish", async () => {
  const h = await build();
  try {
    const callPromise = call(h);
    await waitUntil(() => h.links.length > 0);
    const { base, r, t } = parts(h.links[0]!);

    const page = await get(h.links[0]!);
    assert.equal(page.status, 200);
    const amount = `${(h.requests[0]!.amountMicros / 1_000_000).toFixed(6)} USD`;
    assert.ok(page.text.includes("Amount: " + amount));
    assert.ok(page.text.includes("Approve"));
    assert.ok(page.text.includes("Deny"));
    console.log(`# step4pk amount: page shows exact amount ${amount}`);

    const optionsRes = await get(`${base}/approve/options?r=${encodeURIComponent(r)}&t=${encodeURIComponent(t)}`);
    assert.equal(optionsRes.status, 200);
    const options = JSON.parse(optionsRes.text) as { rpId: string; challenges: { approve: string; deny: string } };
    assert.equal(options.rpId, "localhost");

    const assertion = h.auth.getAssertion(options.challenges.approve, { origin: base, rpID: "localhost" });
    const decision = await httpRequest("POST", `${base}/approve/decision`, { r, t, decision: "approve", assertion });
    assert.equal(decision.status, 200);
    assert.equal(JSON.parse(decision.text).decision, "approved");

    const res = await callPromise;
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).object, "chat.completion");
    assert.equal(h.upstream.requests.length, 1);
    console.log(`# step4pk approve: agent status ${res.status}, upstream requests ${h.upstream.requests.length}`);
  } finally {
    await h.close();
  }
});

test("full stack: a passkey deny blocks the agent", async () => {
  const h = await build();
  try {
    const callPromise = call(h);
    await waitUntil(() => h.links.length > 0);
    const { base, r, t } = parts(h.links[0]!);
    const options = JSON.parse((await get(`${base}/approve/options?r=${r}&t=${t}`)).text) as {
      challenges: { deny: string };
    };
    const assertion = h.auth.getAssertion(options.challenges.deny, { origin: base, rpID: "localhost" });
    const decision = await httpRequest("POST", `${base}/approve/decision`, { r, t, decision: "deny", assertion });
    assert.equal(decision.status, 200);
    assert.equal(JSON.parse(decision.text).decision, "denied");

    const res = await callPromise;
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_denied");
    assert.equal(h.upstream.requests.length, 0);
    console.log(`# step4pk deny: agent status ${res.status}, code approval_denied`);
  } finally {
    await h.close();
  }
});

test("full stack: no answer within the timeout auto-denies and a later post is 409", async () => {
  const h = await build({ timeoutMs: 300 });
  try {
    const res = await call(h);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_timeout");
    assert.equal(h.links.length, 1);
    const { base, r, t } = parts(h.links[0]!);
    const assertion = h.auth.getAssertion("late", { origin: base, rpID: "localhost" });
    const late = await httpRequest("POST", `${base}/approve/decision`, { r, t, decision: "approve", assertion });
    assert.equal(late.status, 409);
    assert.equal(JSON.parse(late.text).error, "Expired");
    console.log(`# step4pk timeout: agent status ${res.status}, late decision ${late.status}`);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Unit cases against the approver's own routes.
// ---------------------------------------------------------------------------

interface UnitHarness {
  approver: PasskeyApprover;
  auth: SoftAuthenticator;
  credential: TrustedCredential;
  baseUrl: string;
  links: string[];
}

async function buildUnit(
  opts: {
    notify?: (link: string, req: ApprovalRequest) => void | Promise<void>;
    timeoutMs?: number;
    maxPendingPerAgent?: number;
    credentials?: TrustedCredential[];
    auth?: SoftAuthenticator;
  } = {},
): Promise<UnitHarness> {
  const auth = opts.auth ?? new SoftAuthenticator();
  const credential = credentialFrom(auth);
  const links: string[] = [];
  let current: PasskeyApprover | null = null;
  const server = createServer((req, res) => {
    void (async () => {
      if (!current) {
        res.writeHead(503);
        res.end();
        return;
      }
      const key = `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}`;
      const handler = current.routes()[key];
      if (!handler) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      await handler(req, res);
    })().catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end();
      } catch {
        // ignore
      }
    });
  });
  const port = await listenAny(server);
  const baseUrl = `http://localhost:${port}`;
  const approver = new PasskeyApprover({
    credentials: opts.credentials ?? [credential],
    rpID: "localhost",
    origin: baseUrl,
    baseUrl,
    notify: opts.notify ?? ((link: string) => { links.push(link); }),
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxPendingPerAgent != null ? { maxPendingPerAgent: opts.maxPendingPerAgent } : {}),
  });
  current = approver;
  cleanups.push(async () => {
    await approver.close();
    await closeServer(server);
  });
  return { approver, auth, credential, baseUrl, links };
}

async function optionsFor(h: UnitHarness, r: string, t: string): Promise<{ approve: string; deny: string }> {
  const res = await get(`${h.baseUrl}/approve/options?r=${encodeURIComponent(r)}&t=${encodeURIComponent(t)}`);
  assert.equal(res.status, 200);
  return (JSON.parse(res.text) as { challenges: { approve: string; deny: string } }).challenges;
}

async function openRequest(
  h: UnitHarness,
  req: ApprovalRequest = REQ,
): Promise<{ promise: Promise<ApprovalDecision>; r: string; t: string; settled: () => boolean }> {
  const before = h.links.length;
  let done = false;
  const promise = h.approver.request(req).then((d) => {
    done = true;
    return d;
  });
  await waitUntil(() => h.links.length > before);
  const { r, t } = parts(h.links[before]!);
  return { promise, r, t, settled: () => done };
}

test("wrong token is a plain 404 and the request stays open", async () => {
  const h = await buildUnit();
  const { promise, r, t, settled } = await openRequest(h);
  const wrong = `${h.baseUrl}/approve?r=${encodeURIComponent(r)}&t=not-the-token`;

  assert.equal((await get(wrong)).status, 404);
  assert.equal((await get(`${h.baseUrl}/approve/options?r=${encodeURIComponent(r)}&t=wrong`)).status, 404);
  const post = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t: "wrong", decision: "approve", assertion: {} });
  assert.equal(post.status, 404);
  assert.equal((await get(`${h.baseUrl}/approve?r=nope&t=${encodeURIComponent(t)}`)).status, 404);
  await sleep(30);
  assert.equal(settled(), false);
  console.log(`# step4pk wrong-token: page 404, options 404, decision 404, request still open`);
  await h.approver.close();
  await promise;
});

test("an approve assertion posted as decision deny is refused", async () => {
  const h = await buildUnit();
  const { promise, r, t, settled } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const assertion = h.auth.getAssertion(challenges.approve, { origin: h.baseUrl, rpID: "localhost" });
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "deny", assertion });
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(settled(), false);
  console.log(`# step4pk cross-decision: ${res.status}, request still open`);
  await h.approver.close();
  await promise;
});

test("an assertion made for another request is refused", async () => {
  const h = await buildUnit();
  const a = await openRequest(h);
  const b = await openRequest(h, { ...REQ, amountMicros: 99000 });
  const challengesB = await optionsFor(h, b.r, b.t);
  const assertion = h.auth.getAssertion(challengesB.approve, { origin: h.baseUrl, rpID: "localhost" });
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r: a.r, t: a.t, decision: "approve", assertion });
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(a.settled(), false);
  console.log(`# step4pk other-request: ${res.status}, request still open`);
  await h.approver.close();
  await Promise.all([a.promise, b.promise]);
});

test("a different authenticator's key is refused with 403", async () => {
  const h = await buildUnit();
  const { promise, r, t, settled } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const other = new SoftAuthenticator();
  const assertion = other.getAssertion(challenges.approve, { origin: h.baseUrl, rpID: "localhost" });
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(settled(), false);
  console.log(`# step4pk unknown-credential: ${res.status}, request still open`);
  await h.approver.close();
  await promise;
});

test("an assertion from the wrong origin is refused", async () => {
  const h = await buildUnit();
  const { promise, r, t, settled } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const assertion = h.auth.getAssertion(challenges.approve, { origin: "https://evil.example", rpID: "localhost" });
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(settled(), false);
  console.log(`# step4pk wrong-origin: ${res.status}, request still open`);
  await h.approver.close();
  await promise;
});

test("an assertion without user verification is refused", async () => {
  const h = await buildUnit();
  const { promise, r, t, settled } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const assertion = h.auth.getAssertion(challenges.approve, {
    origin: h.baseUrl,
    rpID: "localhost",
    userVerified: false,
  });
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(settled(), false);
  console.log(`# step4pk no-user-verification: ${res.status}, request still open`);
  await h.approver.close();
  await promise;
});

test("a replayed winning assertion after the decision is 409", async () => {
  const h = await buildUnit();
  const { promise, r, t } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const assertion = h.auth.getAssertion(challenges.approve, { origin: h.baseUrl, rpID: "localhost" });
  const first = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(first.status, 200);
  const replay = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(replay.status, 409);
  assert.equal(JSON.parse(replay.text).error, "already decided");
  assert.equal((await promise).decision, "approved");
  console.log(`# step4pk replay: first ${first.status}, replay ${replay.status}`);
});

test("concurrent approve, deny and replayed approve settle exactly one", async () => {
  const h = await buildUnit();
  const { promise, r, t } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const approveAssertion = h.auth.getAssertion(challenges.approve, { origin: h.baseUrl, rpID: "localhost" });
  const denyAssertion = h.auth.getAssertion(challenges.deny, { origin: h.baseUrl, rpID: "localhost" });
  const post = (decision: "approve" | "deny", assertion: unknown): Promise<HttpResult> =>
    httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision, assertion });

  const results = await Promise.all([
    post("approve", approveAssertion),
    post("deny", denyAssertion),
    post("approve", approveAssertion),
  ]);
  const winners = results.filter((x) => x.status === 200);
  const conflicts = results.filter((x) => x.status === 409);
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 2);
  const winnerDecision = (JSON.parse(winners[0]!.text) as { decision: string }).decision;
  const settled = await promise;
  assert.equal(settled.decision, winnerDecision);
  console.log(
    `# step4pk concurrent: one 200 (${winnerDecision}), ${conflicts.length} 409, agent decision ${settled.decision}`,
  );
});

test("an assertion bound to a different amount is refused", async () => {
  const h = await buildUnit();
  const a = await openRequest(h);
  const optsRes = await get(`${h.baseUrl}/approve/options?r=${encodeURIComponent(a.r)}&t=${encodeURIComponent(a.t)}`);
  assert.equal(optsRes.status, 200);
  const opts = JSON.parse(optsRes.text) as { challenges: { approve: string }; nonce: string };

  const buildChallenge = (amountMicros: number): string =>
    createHash("sha256")
      .update(
        CHALLENGE_PREFIX +
          canonicalize({
            request_id: a.r,
            nonce: opts.nonce,
            decision: "approve",
            mandate_id: REQ.mandateId,
            agent_id: REQ.agentId,
            rail: REQ.rail,
            payee: REQ.payee,
            amount_micros: amountMicros,
          }),
        "utf8",
      )
      .digest("base64url");

  // The amount is part of the challenge: A's own amount reproduces the challenge
  // the page was given, a different amount does not.
  assert.equal(buildChallenge(REQ.amountMicros), opts.challenges.approve);
  const forced = buildChallenge(REQ.amountMicros + 1);
  assert.notEqual(forced, opts.challenges.approve);

  const assertion = h.auth.getAssertion(forced, { origin: h.baseUrl, rpID: "localhost" });
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, {
    r: a.r,
    t: a.t,
    decision: "approve",
    assertion,
  });
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(a.settled(), false);
  console.log(`# step4pk amount-binding: forged-amount assertion ${res.status}, request still open`);
  await h.approver.close();
  await a.promise;
});

test("a decision body over 16 KB gets 413", async () => {
  const h = await buildUnit();
  const { promise, r, t } = await openRequest(h);
  const res = await httpRequest("POST", `${h.baseUrl}/approve/decision`, {
    r,
    t,
    decision: "approve",
    assertion: { padding: "x".repeat(20 * 1024) },
  });
  assert.equal(res.status, 413);
  console.log(`# step4pk body-limit: ${res.status} for a body over 16 KB`);
  await h.approver.close();
  await promise;
});

test("the page after expiry is 409 with no buttons", async () => {
  const h = await buildUnit({ timeoutMs: 120 });
  const { promise, r, t } = await openRequest(h);
  await promise;
  const page = await get(`${h.baseUrl}/approve?r=${encodeURIComponent(r)}&t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 409);
  assert.ok(/no longer open/i.test(page.text));
  assert.ok(!page.text.includes("<button"));
  console.log(`# step4pk expired-page: ${page.status} and no button markup`);
});

test("a decision post after close is 409, not 404", async () => {
  const h = await buildUnit();
  const { promise, r, t } = await openRequest(h);
  const challenges = await optionsFor(h, r, t);
  const assertion = h.auth.getAssertion(challenges.approve, { origin: h.baseUrl, rpID: "localhost" });
  const first = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(first.status, 200);
  await h.approver.close();
  const after = await httpRequest("POST", `${h.baseUrl}/approve/decision`, { r, t, decision: "approve", assertion });
  assert.equal(after.status, 409);
  console.log(`# step4pk close-retains: post after close ${after.status}`);
  await promise;
});

test("a script tag and a bidi override in the summary are escaped and stripped", async () => {
  const h = await buildUnit();
  const { promise, r, t } = await openRequest(h, {
    ...REQ,
    summary: "<script>alert(1)</script>\u202Eevil",
  });
  const page = await get(`${h.baseUrl}/approve?r=${encodeURIComponent(r)}&t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!page.text.includes("<script>alert(1)"));
  assert.ok(!page.text.includes("\u202E"));
  console.log(`# step4pk summary-escape: escaped and bidi stripped`);
  await h.approver.close();
  await promise;
});

test("the approval page carries the content-security-policy header", async () => {
  const h = await buildUnit();
  const { promise, r, t } = await openRequest(h);
  const page = await get(`${h.baseUrl}/approve?r=${encodeURIComponent(r)}&t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  const csp = page.headers["content-security-policy"] ?? "";
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "DENY");
  console.log(`# step4pk csp: ${csp}`);
  await h.approver.close();
  await promise;
});

test("a third open request for one agent resolves timeout at once", async () => {
  const h = await buildUnit({ maxPendingPerAgent: 2 });
  const a = h.approver.request(REQ);
  const b = h.approver.request(REQ);
  await waitUntil(() => h.links.length === 2);
  const c = await h.approver.request(REQ);
  assert.equal(c.decision, "timeout");
  assert.equal(h.links.length, 2);
  console.log(`# step4pk max-pending: third request ${c.decision}, links ${h.links.length}`);
  await h.approver.close();
  await Promise.all([a, b]);
});

test("a counter-zero credential approves two consecutive requests", async () => {
  const auth = new SoftAuthenticator();
  const h = await buildUnit({ auth });

  // A failed verification must not leak the verifier's error text.
  const first = await openRequest(h);
  const firstChallenges = await optionsFor(h, first.r, first.t);
  const forged = auth.getAssertion("not-the-challenge", {
    origin: h.baseUrl,
    rpID: "localhost",
    counter: 0,
  });
  const failed = await httpRequest("POST", `${h.baseUrl}/approve/decision`, {
    r: first.r,
    t: first.t,
    decision: "approve",
    assertion: forged,
  });
  assert.equal(failed.status, 403);
  assert.equal(JSON.parse(failed.text).error, "assertion not verified");
  assert.equal(first.settled(), false);

  // The authenticator always reports counter 0; a stored counter of 0 must not
  // lock the credential out after the first approval.
  const firstAssertion = auth.getAssertion(firstChallenges.approve, {
    origin: h.baseUrl,
    rpID: "localhost",
    counter: 0,
  });
  const firstRes = await httpRequest("POST", `${h.baseUrl}/approve/decision`, {
    r: first.r,
    t: first.t,
    decision: "approve",
    assertion: firstAssertion,
  });
  assert.equal(firstRes.status, 200);
  assert.equal((await first.promise).decision, "approved");

  const second = await openRequest(h);
  const secondChallenges = await optionsFor(h, second.r, second.t);
  const secondAssertion = auth.getAssertion(secondChallenges.approve, {
    origin: h.baseUrl,
    rpID: "localhost",
    counter: 0,
  });
  const secondRes = await httpRequest("POST", `${h.baseUrl}/approve/decision`, {
    r: second.r,
    t: second.t,
    decision: "approve",
    assertion: secondAssertion,
  });
  assert.equal(secondRes.status, 200);
  assert.equal((await second.promise).decision, "approved");

  console.log(
    `# step4pk counter-zero: failed verify ${failed.status} "${JSON.parse(failed.text).error}", approvals ${firstRes.status} and ${secondRes.status}`,
  );
});

test("notify throwing resolves timeout and never approves", async () => {
  const h = await buildUnit({
    notify: () => {
      throw new Error("no delivery channel");
    },
  });
  const decision = await h.approver.request(REQ);
  assert.equal(decision.decision, "timeout");
  assert.notEqual(decision.decision, "approved");
  console.log(`# step4pk notify-throw: ${decision.decision}, not approved`);
});
