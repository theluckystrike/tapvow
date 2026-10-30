import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = process.env.SOURCE_INTEGRATION_AGENT || join(HERE, "agent.mjs");
const ROOT = resolve(HERE, "../..");
const FIXTURES = join(ROOT, "test-work");
const PROOF = join(ROOT, "proof", process.env.SOURCE_INTEGRATION_PROOF || "integration");
mkdirSync(FIXTURES, { recursive: true });
mkdirSync(PROOF, { recursive: true });

const BROKEN = `// file: duration.mjs
const units = {d:86400000,h:3600000,m:60000,s:1000,ms:1};
export function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('not a string');
  return text.split(' ').reduce((sum, part) => {
    const m = /^(\\d+)(ms|d|h|m|s)$/.exec(part);
    if (!m) throw new TypeError('invalid duration');
    return sum + Number(m[1]) * units[m[2]];
  }, 0);
}
`;
const GOOD = `// file: duration.mjs
const units = {d:86400000,h:3600000,m:60000,s:1000,ms:1};
export function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('not a string');
  let total=0, end=0, seen=false;
  const re=/(\\d+)(ms|d|h|m|s)/g;
  for (const m of text.matchAll(re)) {
    if (text.slice(end,m.index).trim()) throw new TypeError('invalid gap');
    total += Number(m[1]) * units[m[2]];
    end=m.index+m[0].length; seen=true;
  }
  if (!seen || text.slice(end).trim()) throw new TypeError('invalid duration');
  return total;
}
`;
const SELF_TEST = `// file: duration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from './duration.mjs';
test('model-generated test checks only a single unit',()=>assert.equal(parseDuration('45s'),45000));
`;
const reply = (module, complete = true) => module + (complete ? SELF_TEST : "");

function sizeOf(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const child = join(path, entry.name);
    return sum + (entry.isDirectory() ? sizeOf(child) : statSync(child).size);
  }, 0);
}

async function scenario(name, candidates, verify) {
  const work = join(FIXTURES, `${name}-${process.pid}-${Date.now()}`);
  mkdirSync(work);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body.messages);
    const content = candidates[requests.length - 1];
    if (content === undefined) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "mandate_denied", code: "test_budget_exhausted", message: "Local test refusal; no provider called" } }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-mandate-reserved-micros": "0", "x-mandate-charged-micros": "0", "x-mandate-remaining-micros": "0",
    });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
  });
  let stdout = "", stderr = "", result;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    result = await new Promise((done, reject) => {
      // This is a separate program under test. Do not let the outer Node test
      // runner mark its own nested test subprocesses as recursive invocations.
      const env = { ...process.env, OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_API_KEY: "mk_local_test_only", TAPVOW_MODEL: "local-test-stub", DEMO_WORKDIR: work, DEMO_MAX_CALLS: "8", DEMO_CALL_PAUSE_MS: "0" };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [AGENT], {
        env,
        timeout: 15000,
      });
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code, signal) => done({ code, signal }));
    });
    const summary = JSON.parse(readFileSync(join(work, "agent-summary.json"), "utf8"));
    writeFileSync(join(PROOF, `${name}.json`), JSON.stringify({ result, summary, last_user_messages: requests.map((messages) => messages.findLast((message) => message.role === "user")?.content), stdout, stderr }, null, 2));
    await verify({ summary, requests, result, work, stdout });
  } finally {
    await new Promise((done) => server.close(done));
    const bytes = sizeOf(work);
    const open = spawnSync(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-nP", "+D", work], { encoding: "utf8", timeout: 5000 });
    if (open.error?.code === "ENOENT") {
      // Keep the owned fixture if this host cannot verify that files are closed.
      appendFileSync(join(ROOT, "proof", "deletion-manifest.jsonl"), JSON.stringify({ at: new Date().toISOString(), path: work, bytes, reason: "lsof unavailable; fixture retained", deleted: false }) + "\n");
    } else {
      if (open.status !== 1) throw new Error(`Fixture cleanup held: lsof exit ${open.status}`);
      rmSync(work, { recursive: true });
      appendFileSync(join(ROOT, "proof", "deletion-manifest.jsonl"), JSON.stringify({ at: new Date().toISOString(), path: work, bytes, reason: "Owned integration test fixture; process ended and lsof found no open files", deleted: true }) + "\n");
    }
  }
}

test("generated green tests cannot hide the missed adjacent-unit case; repair is accepted", async () => {
  await scenario("repair", [reply(BROKEN), reply(GOOD)], ({ summary, requests, result, work }) => {
    assert.equal(result.code, 0);
    assert.equal(summary.log[0].tests.ok, true);
    assert.match(requests[1].at(-1).content, /Independent acceptance output/);
    assert.match(requests[1].at(-1).content, /1h30m/);
    assert.doesNotMatch(requests[1].at(-1).content, /Add support for decimal/);
    assert.equal(summary.log[0].acceptance.ok, false);
    assert.equal(summary.log[0].accepted, false);
    assert.equal(summary.log[1].accepted, true);
    assert.equal(summary.last_passing.call, 2);
    assert.equal(summary.last_passing.acceptance, 5);
    assert.match(requests[2].at(-1).content, /Add support for decimal/);
    assert.equal(readFileSync(join(work, "passing", "duration.mjs"), "utf8"), GOOD);
  });
});

test("a later failing candidate cannot replace the last accepted source", async () => {
  await scenario("retain", [reply(GOOD), reply(BROKEN)], ({ summary, requests, result, work }) => {
    assert.equal(result.code, 0);
    assert.equal(summary.last_passing.call, 1);
    assert.equal(summary.log[1].tests.ok, true);
    assert.equal(summary.log[1].accepted, false);
    assert.match(requests[2].at(-1).content, /Independent acceptance output/);
    assert.equal(readFileSync(join(work, "passing", "duration.mjs"), "utf8"), GOOD);
    assert.equal(readFileSync(join(work, "duration.mjs"), "utf8"), BROKEN);
  });
});

test("repair exhaustion stops instead of advancing to a feature", async () => {
  await scenario("exhausted", [reply(BROKEN), reply(BROKEN), reply(BROKEN)], ({ summary, requests, result }) => {
    assert.equal(result.code, 1);
    assert.equal(summary.calls, 3);
    assert.equal(requests.length, 3);
    assert.equal(summary.last_passing, null);
    assert.equal(summary.stopped_reason, "repair_limit");
    assert.ok(summary.log.every((entry) => entry.tests.ok && !entry.accepted));
    assert.ok(requests.slice(1).every((messages) => !messages.at(-1).content.includes("Add support for decimal")));
  });
});

test("a budget refusal without any accepted candidate is not a successful run", async () => {
  await scenario("no-accepted", [reply(BROKEN)], ({ summary, result }) => {
    assert.equal(result.code, 1);
    assert.equal(summary.last_passing, null);
    assert.equal(summary.refused.status, 402);
  });
});

test("a partial answer cannot reuse stale generated tests to become accepted", async () => {
  await scenario("partial", [reply(GOOD), reply(GOOD, false)], ({ summary, requests, result }) => {
    assert.equal(result.code, 0);
    assert.equal(summary.last_passing.call, 1);
    assert.equal(summary.log[1].accepted, false);
    assert.equal(summary.log[1].tests.pass, 0);
    assert.match(requests[2].at(-1).content, /both complete files/);
  });
});
