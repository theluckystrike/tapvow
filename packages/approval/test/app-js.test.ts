// Runs the real browser script (APPROVAL_APP_JS) without a browser: a minimal
// DOM and a fake navigator.credentials.get backed by SoftAuthenticator exercise
// the whole approval page against a real gateway.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner, signMandate, EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { SoftAuthenticator } from "@mandate/passkey/testing";
import type { TrustedCredential } from "@mandate/passkey";
import { createGateway, startFakeUpstream, openGovernedRail, type FakeUpstream } from "@mandate/llm-rail";
import { PasskeyApprover, APPROVAL_APP_JS } from "../src/passkey-approver.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/types.js";

const issuer = generateSigner("owner-2026-10");
const gatewayKey = generateSigner("gateway-1");
const REAL = "sk-test-upstream-NOT-REAL";
const MANDATE_ID = "mdt_appjs_approval_test_0001";

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

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

// ---------------------------------------------------------------------------
// The real browser script, run in node:vm.
// ---------------------------------------------------------------------------

interface FakeElement {
  textContent: string;
  addEventListener(type: string, listener: () => void): void;
  click(): void;
}

interface AppRun {
  status(): string;
  clickApprove(): void;
  clickDeny(): void;
}

function runApp(link: string, auth: SoftAuthenticator, gatewayOrigin: string): AppRun {
  const url = new URL(link);
  const elements = new Map<string, { textContent: string; handlers: Map<string, () => void> }>();
  const elementFor = (id: string): FakeElement => {
    let el = elements.get(id);
    if (!el) {
      el = { textContent: "", handlers: new Map() };
      elements.set(id, el);
    }
    const target = el;
    return {
      get textContent() {
        return target.textContent;
      },
      set textContent(value: string) {
        target.textContent = value;
      },
      addEventListener(type: string, listener: () => void) {
        target.handlers.set(type, listener);
      },
      click() {
        target.handlers.get("click")?.();
      },
    };
  };

  const bytesOf = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64url"));

  const navigator = {
    credentials: {
      get: async (options: { publicKey: { challenge: Uint8Array } }): Promise<unknown> => {
        const challenge = Buffer.from(options.publicKey.challenge).toString("base64url");
        const assertion = auth.getAssertion(challenge, { origin: gatewayOrigin, rpID: "localhost" });
        return {
          id: assertion.id,
          rawId: bytesOf(assertion.rawId),
          type: "public-key",
          response: {
            clientDataJSON: bytesOf(assertion.response.clientDataJSON),
            authenticatorData: bytesOf(assertion.response.authenticatorData),
            signature: bytesOf(assertion.response.signature),
            userHandle: null,
          },
          getClientExtensionResults: () => ({}),
        };
      },
    },
  };

  const fetchRelative = (input: string, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(new URL(input, gatewayOrigin), init);

  const context = vm.createContext({
    location: { search: url.search },
    document: {
      getElementById: (id: string) => elementFor(id),
      querySelector: (selector: string) => elementFor(selector),
    },
    navigator,
    fetch: fetchRelative,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    URLSearchParams,
  });

  vm.runInContext(APPROVAL_APP_JS, context, { filename: "approval-app.js" });

  return {
    status: () => elementFor("status").textContent,
    clickApprove: () => elementFor("approve").click(),
    clickDeny: () => elementFor("deny").click(),
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
  port: number;
  key: string;
  close(): Promise<void>;
}

async function build(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "mandate-appjs-"));
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
  approver = new PasskeyApprover({
    credentials: [credentialFrom(auth)],
    rpID: "localhost",
    origin: baseUrl,
    baseUrl,
    notify: (link: string) => {
      links.push(link);
    },
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

test("app.js: clicking approve lets the agent call finish", async () => {
  const h = await build();
  try {
    const callPromise = call(h);
    await waitUntil(() => h.links.length > 0);
    const app = runApp(h.links[0]!, h.auth, `http://localhost:${h.port}`);

    app.clickApprove();
    await waitUntil(() => app.status().includes("approved"));
    const res = await callPromise;
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).object, "chat.completion");
    assert.ok(app.status().includes("Decision approved"));
    assert.equal(h.upstream.requests.length, 1);
    console.log(`# step4pk app-js approve: page "${app.status()}", agent status ${res.status}`);
  } finally {
    await h.close();
  }
});

test("app.js: clicking deny blocks the agent call", async () => {
  const h = await build();
  try {
    const callPromise = call(h);
    await waitUntil(() => h.links.length > 0);
    const app = runApp(h.links[0]!, h.auth, `http://localhost:${h.port}`);

    app.clickDeny();
    await waitUntil(() => app.status().includes("denied"));
    const res = await callPromise;
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.text).error.code, "approval_denied");
    assert.ok(app.status().includes("Decision denied"));
    assert.equal(h.upstream.requests.length, 0);
    console.log(`# step4pk app-js deny: page "${app.status()}", agent status ${res.status}`);
  } finally {
    await h.close();
  }
});
