import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "../src/init.js";
import { startGateway, type RunningGateway } from "../src/server.js";
import { cleanupTmp, envValue, tmp } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;


after(() => cleanupTmp());

interface Fixture {
  home: string;
  running: RunningGateway;
  token: string;
  key: string;
}

async function setup(): Promise<Fixture> {
  const root = tmp();
  const home = join(root, "home");
  runInit({
    home,
    budget: "5.00",
    period: "day",
    perCallCap: "0.50",
    days: 30,
    port: 8787,
    apply: false,
    log: () => {},
  });
  const running = await startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true });
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { dashboard_token: string };
  const key = envValue(join(home, "clients", "openai.env"), "OPENAI_API_KEY");
  assert.ok(key, "openai client key");
  return { home, running, token: cfg.dashboard_token, key };
}

function chatRequest(fixture: Fixture, key: string): Promise<Response> {
  return fetch(`${fixture.running.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

test("cli 5: fake upstream serves a governed call and rejects a bad key", async () => {
  const fixture = await setup();
  try {
    const ok = await chatRequest(fixture, fixture.key);
    assert.equal(ok.status, 200);
    const charged = ok.headers.get("x-mandate-charged-micros");
    assert.ok(charged !== null, "X-Mandate-Charged-Micros header");
    await ok.text();

    const bad = await chatRequest(fixture, "mk_not-a-real-virtual-key");
    assert.equal(bad.status, 401);
    await bad.text();
    console.log("# cli 5: PASS");
  } finally {
    await fixture.running.close();
  }
});

test("cli 6: the live view streams a settlement event", async () => {
  const fixture = await setup();
  const controller = new AbortController();
  try {
    const sse = await fetch(
      `${fixture.running.url}/api/events?token=${encodeURIComponent(fixture.token)}`,
      { signal: controller.signal },
    );
    assert.equal(sse.status, 200);
    assert.ok(sse.body, "event stream body");
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let helloDone = false;
    let resolveMatch: (at: number) => void = () => {};
    const matched = new Promise<number>((resolve) => {
      resolveMatch = resolve;
    });

    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (block.includes("event: hello")) helloDone = true;
            for (const line of block.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const obj = JSON.parse(line.slice(5).trim()) as { kind?: string };
                if (obj.kind === "llm.settle") resolveMatch(Date.now());
              } catch {
                // the hello payload is valid JSON too; ignore anything else
              }
            }
          }
        }
      } catch {
        // aborted at the end of the test
      }
    })();

    const started = Date.now();
    while (!helloDone && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(helloDone, "hello event arrived");

    const response = await chatRequest(fixture, fixture.key);
    assert.equal(response.status, 200);
    await response.text();
    const responseAt = Date.now();

    const eventAt = await Promise.race([
      matched,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("no entry event")), 2000)),
    ]);
    const ms = eventAt - responseAt;
    assert.ok(ms <= 2000, `entry event took ${ms} ms`);
    console.log(`# cli 6: PASS (entry event ${ms} ms after the response)`);
  } finally {
    controller.abort();
    await fixture.running.close();
  }
});

test("cli 7: dashboard and API routes require the token", async () => {
  const fixture = await setup();
  try {
    for (const path of ["/dashboard", "/api/state", "/api/export", "/api/export.pdf"]) {
      const denied = await fetch(`${fixture.running.url}${path}`);
      assert.equal(denied.status, 401, `${path} without a token`);
      await denied.text();

      const allowed = await fetch(
        `${fixture.running.url}${path}?token=${encodeURIComponent(fixture.token)}`,
      );
      assert.equal(allowed.status, 200, `${path} with a token`);
      await allowed.arrayBuffer();
    }
    const bearer = await fetch(`${fixture.running.url}/api/state`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    assert.equal(bearer.status, 200);
    await bearer.text();
    console.log("# cli 7: PASS");
  } finally {
    await fixture.running.close();
  }
});

function claudeCodeRequest(fixture: Fixture, key: string, betas: string, model = "claude-sonnet-5-5"): Promise<Response> {
  return fetch(`${fixture.running.url}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": betas,
    },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
  });
}

test("cli cc-1: the Claude Code request shape (?beta=true, its betas, a 5-series model) is governed", async () => {
  const fixture = await setup();
  try {
    const key = envValue(join(fixture.home, "clients", "claude-code.env"), "ANTHROPIC_AUTH_TOKEN");
    assert.ok(key, "claude code client key");
    const ok = await claudeCodeRequest(fixture, key!, "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24");
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get("x-mandate-charged-micros") !== null, "charged header");
    await ok.text();

    // A beta that changes the price is still refused.
    const priced = await claudeCodeRequest(fixture, key!, "claude-code-20250219,context-1m-2025-08-07");
    assert.equal(priced.status, 400);
    assert.match(await priced.text(), /context-1m-2025-08-07 is not allowed/);

    // An unknown model is still refused, not priced at zero.
    const unknown = await claudeCodeRequest(fixture, key!, "claude-code-20250219", "claude-unknown-9");
    assert.notEqual(unknown.status, 200);
    await unknown.text();
    console.log("# cli cc-1: PASS");
  } finally {
    await fixture.running.close();
  }
});
