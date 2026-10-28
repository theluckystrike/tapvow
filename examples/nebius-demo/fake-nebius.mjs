#!/usr/bin/env node
// A stand-in for the Nebius Token Factory chat completions API, for running the
// demo in CI with no key and no spend. It answers the demo agent's coding task
// with fixed, working code, streams like the real API, and reports usage in the
// last chunk when stream_options.include_usage is set. Token counts are
// estimated from text length (about 4 characters a token). Nothing here is a
// measurement of a real model.
//
// Usage: node fake-nebius.mjs <port-file> <expected-bearer-key>
import http from "node:http";
import { writeFileSync } from "node:fs";

const [portFile, expectedKey] = process.argv.slice(2);
if (!portFile || !expectedKey) {
  process.stderr.write("usage: fake-nebius.mjs <port-file> <expected-bearer-key>\n");
  process.exit(2);
}

const MODULE = `// file: duration.mjs
const UNITS = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
const LONG = { day: "d", days: "d", hour: "h", hours: "h", minute: "m", minutes: "m", second: "s", seconds: "s" };
const NAMES = { d: "day", h: "hour", m: "minute", s: "second", ms: "millisecond" };

/**
 * Parse a duration such as "1h30m" or "1.5 hours" into whole milliseconds.
 * @example parseDuration("1h30m") // 5400000
 * @param {string} text
 * @param {{ strict?: boolean }} [options] strict false ignores unknown units
 * @returns {number}
 */
export function parseDuration(text, { strict = true } = {}) {
  if (typeof text !== "string") throw new TypeError("duration must be a string");
  if (text.trim() === "") throw new RangeError("duration is empty");
  let total = 0;
  let seen = 0;
  let consumed = "";
  for (const m of text.matchAll(/(-?\\d+(?:\\.\\d+)?)\\s*([a-z]+)/gi)) {
    const value = Number(m[1]);
    if (value < 0) throw new RangeError("duration cannot be negative");
    const unit = LONG[m[2].toLowerCase()] ?? m[2].toLowerCase();
    if (unit in UNITS) {
      total += value * UNITS[unit];
      seen++;
    } else if (strict) {
      throw new TypeError(\`unknown unit \${m[2]}\`);
    }
    consumed += m[0];
  }
  if (consumed.replace(/\\s/g, "") !== text.replace(/\\s/g, "")) throw new TypeError(\`cannot parse \${text}\`);
  if (seen === 0 && strict) throw new TypeError(\`cannot parse \${text}\`);
  return Math.round(total);
}

/**
 * Format milliseconds as "1h30m", or "1 hour 30 minutes" with { long: true }.
 * @example formatDuration(5400000) // "1h30m"
 * @param {number} ms
 * @param {{ long?: boolean }} [options]
 * @returns {string}
 */
export function formatDuration(ms, { long = false } = {}) {
  if (!Number.isFinite(ms)) throw new TypeError("ms must be a finite number");
  if (ms < 0) throw new RangeError("ms cannot be negative");
  if (ms === 0) return long ? "0 seconds" : "0s";
  const parts = [];
  let rest = Math.round(ms);
  for (const [unit, size] of Object.entries(UNITS)) {
    const n = Math.floor(rest / size);
    if (n === 0) continue;
    parts.push(long ? \`\${n} \${NAMES[unit]}\${n === 1 ? "" : "s"}\` : \`\${n}\${unit}\`);
    rest -= n * size;
  }
  return parts.join(long ? " " : "");
}
`;

const TESTS = [
  `test("parses each unit", () => {
  assert.equal(parseDuration("45s"), 45000);
  assert.equal(parseDuration("2d"), 172800000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("1h 5m 10s"), 3910000);
});

test("rejects bad input with a TypeError", () => {
  assert.throws(() => parseDuration("abc"), TypeError);
  assert.throws(() => parseDuration("10x"), TypeError);
  assert.throws(() => parseDuration(42), TypeError);
});`,
  `test("accepts decimals", () => {
  assert.equal(parseDuration("1.5h"), 5400000);
  assert.equal(parseDuration("0.25d"), 21600000);
});`,
  `test("formatDuration is the inverse", () => {
  assert.equal(formatDuration(5400000), "1h30m");
  assert.equal(parseDuration(formatDuration(3910250)), 3910250);
});`,
  `test("rejects negatives and empty input with a RangeError", () => {
  assert.throws(() => parseDuration("-5s"), RangeError);
  assert.throws(() => parseDuration(""), RangeError);
});`,
  `test("exports are documented functions", () => {
  assert.equal(typeof parseDuration, "function");
  assert.equal(typeof formatDuration, "function");
});`,
  `test("accepts long unit names", () => {
  assert.equal(parseDuration("1 hour 30 minutes"), 5400000);
  assert.equal(parseDuration("2 days"), 172800000);
  assert.equal(parseDuration("1 second"), 1000);
});`,
  `test("strict false ignores unknown units", () => {
  assert.equal(parseDuration("10x 5s", { strict: false }), 5000);
  assert.throws(() => parseDuration("10x 5s"), TypeError);
});`,
  `test("JSDoc examples hold", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(formatDuration(5400000), "1h30m");
});`,
  `test("long format", () => {
  assert.equal(formatDuration(5400000, { long: true }), "1 hour 30 minutes");
  assert.equal(formatDuration(1000, { long: true }), "1 second");
});`,
];

function reply(step) {
  const tests = TESTS.slice(0, Math.min(step, TESTS.length - 1) + 1).join("\n\n");
  const testFile =
    `// file: duration.test.mjs\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
    `import { parseDuration, formatDuration } from "./duration.mjs";\n\n${tests}\n`;
  // The first answer has no Markdown fences, only "// file:" lines, the way
  // Nemotron on Nebius answered in the 27 Oct 2026 runs. Later answers are fenced.
  if (step === 0) return MODULE + "\n" + testFile;
  return "```js\n" + MODULE + "```\n\n```js\n" + testFile + "```\n";
}

const tokens = (s) => Math.ceil(Buffer.byteLength(s, "utf8") / 4);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${expectedKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Invalid API key" }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "invalid JSON" }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const users = messages.filter((m) => m.role === "user").length;
    let text = reply(Math.max(0, users - 1));
    const prompt = messages.reduce((n, m) => n + tokens(String(m.content ?? "")) + 4, 0);
    // The real API stops at max_tokens; so does the fake.
    const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 4096);
    if (tokens(text) > maxTokens) text = text.slice(0, maxTokens * 4);
    const completion = tokens(text);
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    const base = { id: `chatcmpl-fake-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: body.model };

    if (body.stream !== true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // Like the real API, every chunk carries usage null when include_usage is
    // set, and only the last chunk carries the numbers.
    const nullUsage = body.stream_options?.include_usage === true ? { usage: null } : {};
    const send = (obj) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...nullUsage, ...obj })}\n\n`);
    const parts = text.match(/[\s\S]{1,120}/g) ?? [];
    let i = 0;
    const tick = () => {
      if (i < parts.length) {
        send({ choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: parts[i] } : { content: parts[i] }, finish_reason: null }] });
        i++;
        setTimeout(tick, 4);
        return;
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      if (body.stream_options?.include_usage === true) send({ choices: [], usage });
      res.end("data: [DONE]\n\n");
    };
    tick();
  });
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String(server.address().port));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
