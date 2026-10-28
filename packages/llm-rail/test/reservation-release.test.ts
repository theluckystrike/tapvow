import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { closeServer, listen, post, shape, type HttpResult } from "./helpers.js";

const REAL = "sk-rr-upstream-NOT-REAL";
const issuer = generateSigner("rr-issuer");
const gatewayKey = generateSigner("rr-gateway");

const dirs: string[] = [];
const cleanup: Array<() => void | Promise<void>> = [];

after(async () => {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    ...EXAMPLE_MANDATE,
    id: "mdt_rr_0001_0001",
    issuer: { id: "rr-owner", public_key: issuer.publicKey },
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "0.50",
    approval_threshold: "0.50",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-10-18T00:00:00Z",
    ...over,
  };
}

interface Rig {
  dir: string;
  mandate: Mandate;
  rail: ReturnType<typeof openGovernedRail>;
  key: string;
}

interface Gateway {
  server: Server;
  port: number;
}

function makeRig(over: Partial<Mandate> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "mandate-rr-"));
  dirs.push(dir);
  const m = mandate(over);
  const rail = openGovernedRail({
    dbPath: join(dir, "rail.db"),
    signedMandate: signMandate(m, issuer.signer),
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
  });
  cleanup.push(() => rail.close());
  return { dir, mandate: m, rail, key: rail.issueAgentKey(m.agents[0]!) };
}

async function startGateway(
  rig: Rig,
  urls: { openai: string; anthropic: string },
  upstreamTimeoutMs?: number,
): Promise<Gateway> {
  const server = createGateway({
    store: rig.rail.store,
    upstreams: {
      openai: { baseUrl: urls.openai, apiKey: REAL },
      anthropic: { baseUrl: urls.anthropic, apiKey: REAL },
    },
    ...(upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs }),
  });
  const port = await listen(server);
  cleanup.push(() => closeServer(server));
  return { server, port };
}

async function startCustom(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  const port = await listen(server);
  cleanup.push(() => closeServer(server));
  return `http://127.0.0.1:${port}`;
}

function call(gw: Gateway, path: string, key: string, body: unknown): Promise<HttpResult> {
  const headers: Record<string, string> =
    path === "/v1/messages"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${key}` };
  return post(`http://127.0.0.1:${gw.port}`, path, headers, body);
}

function headerNum(r: HttpResult, name: string): number {
  const v = r.headers[name] ?? r.trailers[name];
  const raw = Array.isArray(v) ? v[0] : v;
  return Number(raw);
}

interface Row {
  id: string;
  status: string;
  reserved_micros: number;
  charged_micros: number | null;
}

function rows(rig: Rig): Row[] {
  return rig.rail.store.database
    .prepare("SELECT id, status, reserved_micros, charged_micros FROM reservations")
    .all() as Row[];
}

function held(rig: Rig): number {
  return rig.rail.store.spent(rig.mandate.id).reservedMicros;
}

test("settle: successful non-stream and stream calls on openai and anthropic close the hold with charged <= reserved", async () => {
  const rig = makeRig();
  const upstream = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 7 });
  cleanup.push(() => upstream.close());
  const gw = await startGateway(rig, { openai: upstream.url, anthropic: upstream.url });

  let charged = 0;
  let reserved = 0;
  for (const i of [0, 1, 2, 3]) {
    const s = shape(i);
    const r = await call(gw, s.path, rig.key, s.body);
    assert.equal(r.status, 200, `shape ${i}: ${r.text.slice(0, 200)}`);
    const res = headerNum(r, "x-mandate-reserved-micros");
    const ch = headerNum(r, "x-mandate-charged-micros");
    assert.ok(Number.isFinite(res) && res > 0, `shape ${i} reserved ${res}`);
    assert.ok(Number.isFinite(ch), `shape ${i} charged ${ch}`);
    assert.ok(ch <= res, `shape ${i} charged ${ch} > reserved ${res}`);
    assert.equal(held(rig), 0);
    charged += ch;
    reserved += res;
  }
  const rs = rows(rig);
  assert.equal(rs.length, 4);
  assert.ok(rs.every((r) => r.status === "settled"));
  console.log(`# rr settle: 4 calls ok, rows settled 4, held ${held(rig)}, charged ${charged} <= reserved ${reserved}`);
});

test("error: upstream 500 passes through, the row is released with charge 0 and held 0", async () => {
  const rig = makeRig();
  const upstream = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 2, failEvery: 1 });
  cleanup.push(() => upstream.close());
  const gw = await startGateway(rig, { openai: upstream.url, anthropic: upstream.url });

  const s = shape(0);
  const r = await call(gw, s.path, rig.key, s.body);
  assert.equal(r.status, 500);
  assert.match(r.text, /fake upstream failure/);
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "released");
  assert.equal(rs[0]!.charged_micros, 0);
  assert.equal(held(rig), 0);
  console.log(`# rr error500: status 500, row ${rs[0]!.status}, charged ${rs[0]!.charged_micros}, held ${held(rig)}`);
});

test("connection refused: upstream URL on a closed port answers 502, row released, held 0", async () => {
  const dead = createServer((_req, res) => res.end());
  const deadPort = await listen(dead);
  await closeServer(dead);
  const url = `http://127.0.0.1:${deadPort}`;

  const rig = makeRig();
  const gw = await startGateway(rig, { openai: url, anthropic: url });
  const s = shape(0);
  const r = await call(gw, s.path, rig.key, s.body);
  assert.equal(r.status, 502);
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "released");
  assert.equal(rs[0]!.charged_micros, 0);
  assert.equal(held(rig), 0);
  console.log(`# rr refused: status 502, row ${rs[0]!.status}, charged ${rs[0]!.charged_micros}, held ${held(rig)}`);
});

test("timeout before headers: answers 504 within upstreamTimeoutMs + 1 s, row charged_full, held 0", async () => {
  const url = await startCustom((req, _res) => {
    req.resume();
  });
  const rig = makeRig();
  const gw = await startGateway(rig, { openai: url, anthropic: url }, 300);
  const s = shape(0);

  const started = Date.now();
  const r = await call(gw, s.path, rig.key, s.body);
  const elapsed = Date.now() - started;
  assert.equal(r.status, 504);
  assert.ok(elapsed < 1300, `elapsed ${elapsed}`);
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "charged_full");
  assert.equal(rs[0]!.charged_micros, rs[0]!.reserved_micros);
  assert.equal(held(rig), 0);
  console.log(`# rr timeout-headers: 504 in ${elapsed} ms, row ${rs[0]!.status}, charged ${rs[0]!.charged_micros}, held ${held(rig)}`);
});

test("timeout mid-stream: response ends, row charged_full, held 0", async () => {
  const url = await startCustom((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" } }] })}\n\n`);
    });
  });
  const rig = makeRig();
  const gw = await startGateway(rig, { openai: url, anthropic: url }, 300);
  const s = shape(2);

  const started = Date.now();
  const r = await call(gw, s.path, rig.key, s.body);
  const elapsed = Date.now() - started;
  assert.equal(r.status, 200);
  assert.match(r.text, /"x"/);
  assert.ok(elapsed < 1300, `elapsed ${elapsed}`);
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "charged_full");
  assert.equal(held(rig), 0);
  console.log(`# rr timeout-stream: ended in ${elapsed} ms, row ${rs[0]!.status}, charged ${rs[0]!.charged_micros}, held ${held(rig)}`);
});

test("slow stream: a chunk every 100 ms for 1 s with upstreamTimeoutMs 300 is not timed out and settles", async () => {
  const url = await startCustom((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "y" } }] })}\n\n`);
        if (n === 10) {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 100);
      timer.unref?.();
    });
  });
  const rig = makeRig();
  const gw = await startGateway(rig, { openai: url, anthropic: url }, 300);
  const s = shape(2);

  const started = Date.now();
  const r = await call(gw, s.path, rig.key, s.body);
  const elapsed = Date.now() - started;
  assert.equal(r.status, 200);
  assert.ok(elapsed >= 900, `elapsed ${elapsed}`);
  const reserved = headerNum(r, "x-mandate-reserved-micros");
  const charged = headerNum(r, "x-mandate-charged-micros");
  assert.ok(charged <= reserved);
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "settled");
  assert.equal(held(rig), 0);
  console.log(`# rr slow-stream: settled in ${elapsed} ms, charged ${charged} <= reserved ${reserved}, held ${held(rig)}`);
});

test("concurrent: 40 mixed successes, 500s and hangs leave every row closed and committed equal to charged", async () => {
  const rig = makeRig();
  const ok = await startFakeUpstream({ latencyMs: [5, 20], completion: "random", seed: 11, failEvery: 4 });
  cleanup.push(() => ok.close());
  const hung = await startCustom((req, _res) => {
    req.resume();
  });
  const gwA = await startGateway(rig, { openai: ok.url, anthropic: ok.url });
  const gwB = await startGateway(rig, { openai: hung, anthropic: hung }, 300);

  const s = shape(0);
  const total = 40;
  const results = await Promise.all(
    Array.from({ length: total }, (_, i) => call(i % 5 === 0 ? gwB : gwA, s.path, rig.key, s.body)),
  );

  const counts = new Map<number, number>();
  for (const r of results) {
    assert.ok([200, 500, 504].includes(r.status), `unexpected status ${r.status}: ${r.text.slice(0, 200)}`);
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
  assert.ok((counts.get(200) ?? 0) > 0);
  assert.ok((counts.get(500) ?? 0) > 0);
  assert.ok((counts.get(504) ?? 0) > 0);

  const rs = rows(rig);
  assert.equal(rs.length, total);
  let sum = 0;
  for (const r of rs) {
    assert.ok(["settled", "released", "charged_full"].includes(r.status), `row ${r.id} is ${r.status}`);
    const charged = r.charged_micros ?? 0;
    if (r.status === "settled") assert.ok(charged <= r.reserved_micros, `settled ${charged} > ${r.reserved_micros}`);
    if (r.status === "released") assert.equal(charged, 0);
    sum += charged;
  }
  const spent = rig.rail.store.spent(rig.mandate.id);
  assert.equal(spent.reservedMicros, 0);
  assert.equal(spent.committedMicros, sum);
  console.log(
    `# rr concurrent40: statuses 200=${counts.get(200) ?? 0} 500=${counts.get(500) ?? 0} 504=${counts.get(504) ?? 0}, ` +
      `held ${spent.reservedMicros}, committed ${spent.committedMicros} == sum charged ${sum}`,
  );
});

test("concurrent tight budget: about 5 holds fit, the rest get 402, and afterwards calls succeed until the real charges leave less than one hold", async () => {
  const body = { model: "gpt-4o", max_tokens: 60, messages: [{ role: "user", content: "x".repeat(2000) }] };
  const probeRig = makeRig();
  const probeUp = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 5 });
  cleanup.push(() => probeUp.close());
  const probeGw = await startGateway(probeRig, { openai: probeUp.url, anthropic: probeUp.url });
  const probe = await call(probeGw, "/v1/chat/completions", probeRig.key, body);
  assert.equal(probe.status, 200);
  const hold = headerNum(probe, "x-mandate-reserved-micros");
  assert.ok(hold > 0);
  const budgetMicros = hold * 5;
  const budget = (budgetMicros / 1_000_000).toFixed(6);

  const rig = makeRig({ budget: { total: budget, period: "lifetime" }, per_call_cap: budget, approval_threshold: budget });
  const upstream = await startFakeUpstream({ latencyMs: [20, 60], completion: "random", seed: 9 });
  cleanup.push(() => upstream.close());
  const gw = await startGateway(rig, { openai: upstream.url, anthropic: upstream.url });

  const fired = await Promise.all(Array.from({ length: 30 }, () => call(gw, "/v1/chat/completions", rig.key, body)));
  const okCount = fired.filter((r) => r.status === 200).length;
  const denied = fired.filter((r) => r.status === 402);
  const deniedBudget = denied.filter((r) => String(r.text).includes("budget_exceeded")).length;
  assert.ok(okCount > 0, "at least one call should fit");
  assert.ok(deniedBudget > 0, "some calls should be denied with 402 budget_exceeded");
  assert.equal(okCount + denied.length, fired.length, "every call is either 200 or 402");

  const spent = rig.rail.store.spent(rig.mandate.id);
  assert.equal(spent.reservedMicros, 0);
  const rs = rows(rig);
  const sum = rs.reduce((a, r) => a + (r.charged_micros ?? 0), 0);
  assert.ok(sum <= budgetMicros, `sum ${sum} > budget ${budgetMicros}`);

  // Holds of finished calls must be free again: one by one, calls succeed until
  // the real charges leave less than one hold, and the first refusal is genuine.
  const followUps: number[] = [];
  for (let i = 0; i < 200; i++) {
    const r = await call(gw, "/v1/chat/completions", rig.key, body);
    followUps.push(r.status);
    assert.equal(held(rig), 0, `hold left open after follow-up ${i}`);
    if (r.status !== 200) {
      assert.equal(r.status, 402, r.text.slice(0, 200));
      assert.match(r.text, /budget_exceeded/);
      break;
    }
  }
  const after = rig.rail.store.spent(rig.mandate.id);
  const remaining = budgetMicros - after.committedMicros;
  assert.equal(followUps.at(-1), 402, "the follow-ups end in a 402");
  assert.ok(followUps.filter((st) => st === 200).length >= 1, "at least one follow-up fits again after the burst");
  assert.ok(remaining < hold, `refused with ${remaining} us left, which fits a ${hold} us hold`);
  assert.ok(after.committedMicros <= budgetMicros);
  console.log(
    `# rr tight-budget: hold ${hold} us, budget ${budgetMicros} us, 30 calls -> 200=${okCount} 402=${denied.length} ` +
      `(budget_exceeded ${deniedBudget}), sum charged ${sum} <= ${budgetMicros}, then ${followUps.length - 1} follow-ups ok, ` +
      `first refusal with ${remaining} us left < hold ${hold}, held ${held(rig)}`,
  );
});

test("a store.settle that throws still closes the hold through the finally block (charged in full, held 0)", async () => {
  const rig = makeRig();
  const upstream = await startFakeUpstream({ latencyMs: [1, 5], completion: "random", seed: 4 });
  cleanup.push(() => upstream.close());
  const gw = await startGateway(rig, { openai: upstream.url, anthropic: upstream.url });
  const store = rig.rail.store;
  const original = store.settle.bind(store);
  store.settle = () => {
    throw new Error("simulated disk error during settle");
  };
  try {
    const s = shape(0);
    const r = await call(gw, s.path, rig.key, s.body);
    assert.equal(r.status, 500);
  } finally {
    store.settle = original;
  }
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "charged_full");
  assert.equal(held(rig), 0);
  console.log(`# rr settle-throws: status 500, row ${rs[0]!.status}, held ${held(rig)}`);
});

test("an upstream error whose body stalls past the idle timeout is released, not charged, and answers 504", async () => {
  const url = await startCustom((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.write('{"error":');
    });
  });
  const rig = makeRig();
  const gw = await startGateway(rig, { openai: url, anthropic: url }, 300);
  const s = shape(0);
  const r = await call(gw, s.path, rig.key, s.body);
  assert.equal(r.status, 504);
  const rs = rows(rig);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.status, "released");
  assert.equal(rs[0]!.charged_micros, 0);
  assert.equal(held(rig), 0);
  console.log(`# rr error-body-stalls: 504, row ${rs[0]!.status}, charged ${rs[0]!.charged_micros}, held ${held(rig)}`);
});
