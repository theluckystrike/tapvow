// Tests for the CDP x402 facilitator auth: key loading, JWT shape and
// signature, redaction, and an end-to-end payment whose facilitator must see a
// valid Bearer JWT on /verify and /settle.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "@mandate/llm-rail";
import { CDP_FACILITATOR_URL, cdpFacilitatorAuth, cdpJwt, loadCdpKey } from "../src/cdp-auth.js";
import { startPaidResource, type PaidResource } from "../src/demo-server.js";
import { createX402Rail } from "../src/rail.js";
import {
  NETWORK,
  allowlistGuard,
  baseMandate,
  closeServer,
  listen,
  openTestRail,
  postJson,
  signTestMandate,
  tokenWallet,
} from "./helpers.js";

const HOST = new URL(CDP_FACILITATOR_URL).host;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-cdp-"));
  dirs.push(d);
  return d;
}

interface GeneratedKey {
  id: string;
  secret: string;
  publicKey: KeyObject;
}

function generatedKey(): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d as string, "base64url");
  const pub = Buffer.from(jwk.x as string, "base64url");
  return { id: randomUUID(), secret: Buffer.concat([seed, pub]).toString("base64"), publicKey };
}

function writeFile(dir: string, name: string, body: unknown, mode: number): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode });
  return path;
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) throw new Error("token must have three parts");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${body}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

function bearer(value: string | undefined): string {
  if (!value || !value.startsWith("Bearer ")) throw new Error("expected a Bearer header");
  return value.slice("Bearer ".length);
}

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.resume();
    req.on("end", resolve);
  });
}

interface FakeFacilitator {
  url: string;
  seen: { verify?: string; settle?: string; supported?: string };
  close(): Promise<void>;
}

/** A minimal facilitator that echoes success and records the Authorization header it saw. */
async function startFakeFacilitator(network: string): Promise<FakeFacilitator> {
  const seen: FakeFacilitator["seen"] = {};
  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const authorization = req.headers.authorization;
      const send = (status: number, body: unknown): void => {
        const payload = Buffer.from(JSON.stringify(body), "utf8");
        res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
        res.end(payload);
      };
      if (req.method === "GET" && path === "/supported") {
        seen.supported = authorization;
        send(200, { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} });
        return;
      }
      if (req.method === "POST" && path === "/verify") {
        await drain(req);
        seen.verify = authorization;
        send(200, { isValid: true, payer: "0x0000000000000000000000000000000000000001" });
        return;
      }
      if (req.method === "POST" && path === "/settle") {
        await drain(req);
        seen.settle = authorization;
        send(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network });
        return;
      }
      send(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close(): Promise<void> {
      return new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    },
  };
}

test("a generated mode-600 key file loads", () => {
  const { id, secret } = generatedKey();
  const path = writeFile(tmp(), "cdp.json", { id, secret }, 0o600);
  const key = loadCdpKey(path);
  assert.equal(key.id, id);
  assert.ok(key.key.type === "private");
  console.log("# cdp load: ok");
});

test("the JWT header and payload have exactly the specified fields", () => {
  const { id, secret } = generatedKey();
  const key = loadCdpKey(writeFile(tmp(), "cdp.json", { id, secret }, 0o600));
  const now = 1_700_000_000;
  const cases: Array<["GET" | "POST", string, string]> = [
    ["GET", "/supported", `GET ${HOST}/platform/v2/x402/supported`],
    ["POST", "/verify", `POST ${HOST}/platform/v2/x402/verify`],
    ["POST", "/settle", `POST ${HOST}/platform/v2/x402/settle`],
  ];
  for (const [method, suffix, expectedUri] of cases) {
    const token = cdpJwt(key, method, `${CDP_FACILITATOR_URL}${suffix}`, now);
    const { header, payload } = decodeJwt(token);
    assert.deepEqual(Object.keys(header).sort(), ["alg", "kid", "nonce", "typ"]);
    assert.equal(header.alg, "EdDSA");
    assert.equal(header.kid, id);
    assert.equal(header.typ, "JWT");
    assert.match(String(header.nonce), /^[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(payload).sort(), ["exp", "iss", "nbf", "sub", "uris"]);
    assert.equal(payload.sub, id);
    assert.equal(payload.iss, "cdp");
    assert.equal(payload.nbf, now);
    assert.equal((payload.exp as number) - (payload.nbf as number), 120);
    assert.deepEqual(payload.uris, [expectedUri]);
  }
  console.log("# cdp jwt fields: ok");
});

test("the JWT signature verifies with the public key", () => {
  const { id, secret, publicKey } = generatedKey();
  const key = loadCdpKey(writeFile(tmp(), "cdp.json", { id, secret }, 0o600));
  const { signingInput, signature } = decodeJwt(cdpJwt(key, "POST", `${CDP_FACILITATOR_URL}/settle`, 1_700_000_000));
  assert.ok(verify(null, Buffer.from(signingInput, "ascii"), publicKey, signature));
  console.log("# cdp signature: verified");
});

test("a mode-644 key file is refused", () => {
  const { id, secret } = generatedKey();
  const path = writeFile(tmp(), "cdp.json", { id, secret }, 0o644);
  assert.throws(() => loadCdpKey(path), /chmod 600/);
  console.log("# cdp mode 644: refused");
});

test("a secret whose public half does not match is refused", () => {
  const a = generatedKey();
  const b = generatedKey();
  const seed = Buffer.from(a.secret, "base64").subarray(0, 32);
  const wrongPublic = Buffer.from(b.secret, "base64").subarray(32, 64);
  const secret = Buffer.concat([seed, wrongPublic]).toString("base64");
  const path = writeFile(tmp(), "cdp.json", { id: a.id, secret }, 0o600);
  assert.throws(() => loadCdpKey(path), /public half does not match/);
  console.log("# cdp public half mismatch: refused");
});

test("a malformed file is refused without leaking the secret", () => {
  const { id, secret } = generatedKey();
  const raw = Buffer.from(secret, "base64");
  const leaks = [secret, raw.toString("hex"), raw.toString("base64url")];
  const files: Array<[unknown, number]> = [
    [{ id, secret, extra: "x" }, 0o600],
    [`{"id":${JSON.stringify(id)},"secret":${JSON.stringify(secret)}`, 0o600],
  ];
  for (const [body, mode] of files) {
    const path = writeFile(tmp(), "cdp.json", body, mode);
    let message = "";
    try {
      loadCdpKey(path);
      assert.fail("malformed key file should be refused");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const leak of leaks) assert.ok(!message.includes(leak), "error message leaked the secret");
  }
  console.log("# cdp malformed: refused without leaking the secret");
});

test("JSON.stringify and util.inspect redact the secret", () => {
  const { id, secret } = generatedKey();
  const key = loadCdpKey(writeFile(tmp(), "cdp.json", { id, secret }, 0o600));
  assert.equal(JSON.stringify(key), JSON.stringify({ id, secret: "<redacted>" }));
  assert.ok(inspect(key).includes("<redacted>"));
  assert.ok(!JSON.stringify(key).includes(secret));
  assert.ok(!inspect(key).includes(secret));
  console.log("# cdp redaction: ok");
});

test("createAuthHeaders returns three distinct JWTs with the right uris", async () => {
  const { id, secret, publicKey } = generatedKey();
  const key = loadCdpKey(writeFile(tmp(), "cdp.json", { id, secret }, 0o600));
  const auth = cdpFacilitatorAuth(key);
  const headers = await auth();
  assert.deepEqual(Object.keys(headers).sort(), ["settle", "supported", "verify"]);
  const tokens = {
    verify: bearer(headers.verify?.Authorization),
    settle: bearer(headers.settle?.Authorization),
    supported: bearer(headers.supported?.Authorization),
  };
  assert.equal(new Set(Object.values(tokens)).size, 3);
  const expected: Record<keyof typeof tokens, string> = {
    verify: `POST ${HOST}/platform/v2/x402/verify`,
    settle: `POST ${HOST}/platform/v2/x402/settle`,
    supported: `GET ${HOST}/platform/v2/x402/supported`,
  };
  for (const name of Object.keys(tokens) as Array<keyof typeof tokens>) {
    const decoded = decodeJwt(tokens[name]);
    assert.ok(verify(null, Buffer.from(decoded.signingInput, "ascii"), publicKey, decoded.signature));
    assert.deepEqual(decoded.payload.uris, [expected[name]]);
  }
  console.log("# cdp auth headers: three signed JWTs");
});

test("startPaidResource sends a valid Bearer JWT to a facilitator on /verify and /settle", async () => {
  const { id, secret, publicKey } = generatedKey();
  const key = loadCdpKey(writeFile(tmp(), "cdp.json", { id, secret }, 0o600));

  const payer = tokenWallet();
  const payee = tokenWallet();
  const mandate = baseMandate({
    id: "mdt_x402_cdp_0001",
    budget: { total: "5.00", period: "lifetime" },
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "x402", id: `${NETWORK}:${payee.account.address}` },
    ],
  });
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);

  const facilitator = await startFakeFacilitator(NETWORK);
  const resource: PaidResource = await startPaidResource({
    facilitatorUrl: facilitator.url,
    facilitatorAuth: cdpFacilitatorAuth(key, facilitator.url),
    network: NETWORK,
    payTo: payee.account.address,
    routes: [{ path: "/data", price: "$0.01", body: { data: "paid" } }],
  });

  const x402 = createX402Rail({
    allowPrivateNetwork: true,
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: allowlistGuard([payee.account.address]),
  });
  const gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
  const port = await listen(gateway);
  const base = `http://127.0.0.1:${port}`;
  const agentKey = rail.issueAgentKey("agent-01");

  try {
    const response = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${agentKey}` }, { url: `${resource.origin}/data` });
    assert.equal(response.status, 200, response.text);
    assert.equal(resource.paidRequests, 1);

    assert.ok(facilitator.seen.supported?.startsWith("Bearer "), "/supported got no Bearer token");
    assert.ok(facilitator.seen.verify?.startsWith("Bearer "), "/verify got no Bearer token");
    assert.ok(facilitator.seen.settle?.startsWith("Bearer "), "/settle got no Bearer token");

    const host = new URL(facilitator.url).host;
    const expected: Array<["verify" | "settle", string]> = [
      ["verify", `POST ${host}/verify`],
      ["settle", `POST ${host}/settle`],
    ];
    for (const [name, uri] of expected) {
      const token = bearer(facilitator.seen[name]);
      const decoded = decodeJwt(token);
      assert.equal(decoded.header.alg, "EdDSA");
      assert.equal(decoded.header.kid, id);
      assert.deepEqual(decoded.payload.uris, [uri]);
      assert.ok(verify(null, Buffer.from(decoded.signingInput, "ascii"), publicKey, decoded.signature), `${name} signature`);
    }
  } finally {
    await closeServer(gateway);
    await resource.close();
    await facilitator.close();
    rail.close();
  }
  console.log("# cdp e2e facilitator auth: verified on verify and settle");
});
