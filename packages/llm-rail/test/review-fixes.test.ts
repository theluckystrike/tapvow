// Regression tests for the findings of the independent review on 18 Oct 2026.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateSigner, signMandate, EXAMPLE_MANDATE, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { worstCase, TOOL_OVERHEAD_TOKENS } from "../src/estimate.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { closeServer, listen, post } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const db = () => {
  const d = mkdtempSync(join(tmpdir(), "mandate-rev-"));
  dirs.push(d);
  return join(d, "r.db");
};
const issuer = generateSigner("owner");
const gw = generateSigner("gw");
const base: Mandate = {
  ...EXAMPLE_MANDATE,
  id: "mdt_review_fix_0001",
  issuer: { id: "michael", public_key: issuer.publicKey },
  approval_threshold: "0.50",
  not_before: "2026-01-01T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
};
const open = (path: string, m: Mandate) =>
  openGovernedRail({ dbPath: path, signedMandate: signMandate(m, issuer.signer), trustedIssuerKey: issuer.publicKey, ledgerSigner: gw.signer });
const body = { model: "gpt-4o", max_tokens: 50, messages: [{ role: "user", content: "hi" }] };

test("a connection reset after the request was sent is charged in full, a refused connection is released", async () => {
  const path = db();
  const rail = open(path, base);
  const key = rail.issueAgentKey("agent-01");
  const resetter = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.socket?.destroy());
  });
  const rp = await listen(resetter);
  let g = createGateway({ store: rail.store, upstreams: { openai: { baseUrl: `http://127.0.0.1:${rp}`, apiKey: "sk-test-NOT-REAL" } } });
  let port = await listen(g);
  const r = await post(`http://127.0.0.1:${port}`, "/v1/chat/completions", { authorization: `Bearer ${key}` }, body);
  assert.equal(r.status, 502);
  const after1 = rail.store.spent(base.id).settledMicros;
  assert.ok(after1 > 0, "reset after send must be charged");
  await closeServer(g);
  await closeServer(resetter);
  // nothing listens on rp now: connection refused, provably never sent
  g = createGateway({ store: rail.store, upstreams: { openai: { baseUrl: `http://127.0.0.1:${rp}`, apiKey: "sk-test-NOT-REAL" } } });
  port = await listen(g);
  const r2 = await post(`http://127.0.0.1:${port}`, "/v1/chat/completions", { authorization: `Bearer ${key}` }, body);
  assert.equal(r2.status, 502);
  assert.equal(rail.store.spent(base.id).settledMicros, after1, "refused connection must be released");
  await closeServer(g);
  rail.close();
});

test("a changed mandate is written to the ledger, an older one is refused, a dropped agent loses access", () => {
  const path = db();
  let rail = open(path, base);
  const k3 = rail.issueAgentKey("agent-03");
  rail.close();
  const v2: Mandate = { ...base, budget: { total: "50.00", period: "lifetime" }, agents: base.agents.filter((a) => a !== "agent-03"), created_at: "2026-10-19T00:00:00Z" };
  rail = open(path, v2);
  const kinds = rail.ledger.entries().map((e) => e.kind);
  assert.deepEqual(kinds, ["mandate.registered", "mandate.updated"]);
  assert.equal(rail.store.authenticate(k3), null, "agent-03 was removed from the mandate");
  rail.close();
  assert.throws(() => open(path, base), /not newer/);
});

test("tools add a fixed input allowance for the provider's hidden tool prompt", () => {
  const plain = worstCase("anthropic", { max_tokens: 5, messages: [{ role: "user", content: "x" }] }, 100, 1024);
  const tools = worstCase("anthropic", { max_tokens: 5, messages: [{ role: "user", content: "x" }], tools: [{ name: "f", input_schema: {} }] }, 100, 1024);
  assert.ok(plain.ok && tools.ok && tools.maxInputTokens - plain.maxInputTokens === TOOL_OVERHEAD_TOKENS);
  assert.equal(worstCase("openai", { messages: [], service_tier: "auto" }, 10, 10).ok, false);
});

test("editing charged_micros in the budget table makes the rail refuse to start", async () => {
  const path = db();
  const rail = open(path, base);
  const key = rail.issueAgentKey("agent-01");
  const up = await startFakeUpstream({ latencyMs: [1, 2] });
  const g = createGateway({ store: rail.store, upstreams: { openai: { baseUrl: up.url, apiKey: "sk-test-NOT-REAL" } } });
  const port = await listen(g);
  assert.equal((await post(`http://127.0.0.1:${port}`, "/v1/chat/completions", { authorization: `Bearer ${key}` }, body)).status, 200);
  await closeServer(g);
  await up.close();
  rail.close();
  const raw = new DatabaseSync(path);
  raw.exec("UPDATE reservations SET charged_micros = 0");
  raw.close();
  assert.throws(() => open(path, base), /rail audit failed/);
});

test("an unauthenticated request is refused before its body is read", async () => {
  const rail = open(db(), base);
  const g = createGateway({ store: rail.store, upstreams: {} });
  const port = await listen(g);
  const r = await post(`http://127.0.0.1:${port}`, "/v1/chat/completions", { authorization: "Bearer mk_wrong" }, body);
  assert.equal(r.status, 401);
  await closeServer(g);
  rail.close();
});
