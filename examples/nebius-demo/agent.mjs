#!/usr/bin/env node
// A small scripted coding agent for the Nebius demo. It talks to any
// OpenAI-compatible base URL (here the local TapVow gateway, which forwards to
// Nebius Token Factory), writes the files the model returns, runs the tests,
// sends failures back, and keeps taking feature requests until the gateway
// refuses a call. No dependencies, Node 22 or later.
//
// Environment
//   OPENAI_BASE_URL   the gateway, for example http://127.0.0.1:47990/v1
//   OPENAI_API_KEY    the TapVow virtual key (never the real Nebius key)
//   TAPVOW_MODEL      the model id, for example a Nemotron model on Nebius
//   DEMO_WORKDIR      where the agent writes code and runs tests
//   DEMO_MAX_TOKENS   max_tokens per call (default 2048)
//   DEMO_MAX_CALLS    a safety stop on calls (default 40)
//   DEMO_REASONING    "off" (default) asks Nemotron to skip its reasoning
//                     (chat_template_kwargs.enable_thinking false), "on" keeps it
//   DEMO_CALL_PAUSE_MS  pause after each call, for screen recording (default 0)
import http from "node:http";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFiles } from "./extract.mjs";

const BASE = process.env.OPENAI_BASE_URL ?? "";
const KEY = process.env.OPENAI_API_KEY ?? "";
const MODEL = process.env.TAPVOW_MODEL ?? "";
const WORK = process.env.DEMO_WORKDIR ?? "";
const MAX_TOKENS = Number(process.env.DEMO_MAX_TOKENS ?? 2048);
const MAX_CALLS = Number(process.env.DEMO_MAX_CALLS ?? 40);
const PAUSE_MS = Number(process.env.DEMO_CALL_PAUSE_MS ?? 0);
const REASONING = (process.env.DEMO_REASONING ?? "off") === "on";
const FILES = ["duration.mjs", "duration.test.mjs"];
const ACCEPTANCE = fileURLToPath(new URL("./acceptance.mjs", import.meta.url));

const color = process.stdout.isTTY || process.env.FORCE_COLOR ? (c, s) => `\x1b[${c}m${s}\x1b[0m` : (_c, s) => s;
const dim = (s) => color("2", s);
const green = (s) => color("32", s);
const red = (s) => color("31", s);
const bold = (s) => color("1", s);

function fail(msg) {
  process.stderr.write(`agent: ${msg}\n`);
  process.exit(2);
}
if (!BASE.startsWith("http://127.0.0.1:") && !BASE.startsWith("http://localhost:")) fail("OPENAI_BASE_URL must point at the local gateway");
if (!KEY.startsWith("mk_")) fail("OPENAI_API_KEY must be a TapVow virtual key (mk_...), not a provider key");
if (!MODEL) fail("TAPVOW_MODEL is not set");
if (!WORK) fail("DEMO_WORKDIR is not set");
mkdirSync(join(WORK, "replies"), { recursive: true });

// Nemotron tends to answer with bare "// file:" sections and no Markdown
// fences, so the prompt asks for exactly that layout (extract.mjs also reads
// fenced answers).
const SYSTEM = [
  "You are a careful JavaScript engineer working in a Node 22 project with ES modules.",
  "Answer with the two complete files and nothing else, in this layout:",
  "a line // file: duration.mjs, then the whole module,",
  "then a line // file: duration.test.mjs, then the whole test file.",
  "Tests use node:test and node:assert/strict and import from ./duration.mjs. No other dependencies.",
  "Every test must pass against your module, so check each expected value.",
  "Keep the code short. Do not explain.",
].join(" ");

const TASK =
  "Write parseDuration(text) that turns strings like '45s', '1h30m', '2d' and '1h 5m 10s' into milliseconds. " +
  "Units are d, h, m, s and ms, and units can be combined. Throw a TypeError for anything else. " +
  "Add tests for each unit, for combined units and for bad input.";

const BACKLOG = [
  "Add support for decimal values such as '1.5h' and '0.25d'. Return whole milliseconds. Update both files.",
  "Add formatDuration(ms) that is the inverse of parseDuration, for example 5400000 gives '1h30m'. Update both files.",
  "Reject negative numbers and an empty string with a RangeError. Update both files.",
  "Add a JSDoc comment to every export. Update both files.",
  "Allow the long unit names day, hour, minute and second, singular and plural. Update both files.",
  "Add a parseDuration option { strict: false } that ignores unknown units instead of throwing. Update both files.",
  "Add tests for every example in the JSDoc. Update both files.",
  "Make formatDuration accept a second argument { long: true } that writes '1 hour 30 minutes'. Update both files.",
];

/** One streamed chat completion through the gateway. Resolves with the text, usage and TapVow headers/trailers. */
function complete(messages) {
  const url = new URL(BASE.replace(/\/+$/, "") + "/chat/completions");
  const payload = Buffer.from(
    JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
      stream: true,
      ...(REASONING ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    }),
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
      },
      (res) => {
        let raw = "";
        let buf = "";
        let text = "";
        let reasoning = 0;
        let finish = null;
        let usage = null;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data);
              const delta = obj.choices?.[0]?.delta?.content;
              if (typeof delta === "string") text += delta;
              const r = obj.choices?.[0]?.delta?.reasoning_content ?? obj.choices?.[0]?.delta?.reasoning;
              if (typeof r === "string") reasoning += r.length;
              if (obj.choices?.[0]?.finish_reason) finish = obj.choices[0].finish_reason;
              if (obj.usage) usage = obj.usage;
            } catch {
              // a partial or non-JSON line is ignored
            }
          }
        });
        res.on("end", () => {
          const h = { ...res.headers, ...res.trailers };
          resolve({
            status: res.statusCode ?? 0,
            raw,
            text,
            reasoningChars: reasoning,
            finish,
            usage,
            reserved: Number(h["x-mandate-reserved-micros"] ?? NaN),
            charged: Number(h["x-mandate-charged-micros"] ?? NaN),
            remaining: Number(h["x-mandate-remaining-micros"] ?? NaN),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function runTests(file) {
  const r = spawnSync(process.execPath, ["--test", file], { cwd: WORK, encoding: "utf8", timeout: 30_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const pass = Number(out.match(/# pass (\d+)/)?.[1] ?? 0);
  const failed = Number(out.match(/# fail (\d+)/)?.[1] ?? 0);
  return { ok: r.status === 0 && pass > 0, pass, failed, out };
}

/** The short result shown on each call line. */
function label(extracted, tests, acceptance, finish) {
  if (Object.keys(extracted.files).length === 0) {
    return red(finish === "length" || extracted.truncated ? "no code returned (cut at max_tokens)" : "no code returned");
  }
  if (tests.ok && acceptance.ok) return green(`tests ${tests.pass} pass, acceptance ${acceptance.pass} pass`);
  if (tests.ok) return red(`generated tests ${tests.pass} pass; acceptance fails`);
  if (tests.pass + tests.failed === 0) return red("tests did not run");
  return red(`tests ${tests.failed} of ${tests.pass + tests.failed} fail`);
}

const usd = (micros) => (Number.isFinite(micros) ? (micros / 1e6).toFixed(6) : "?");

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content: TASK },
];
let calls = 0;
let charged = 0;
let fixRounds = 0;
let backlog = 0;
let refused = null;
let lastPassing = null;
let stoppedReason = "call_limit";
const log = [];
console.log(bold(`agent: model ${MODEL} through ${BASE}`));
console.log(dim(`task: ${TASK}`));

while (calls < MAX_CALLS) {
  const r = await complete(messages);
  if (r.status !== 200) {
    let reason = r.raw;
    let byTapVow = false;
    try {
      const body = JSON.parse(r.raw);
      const e = body.error ?? { message: body.detail ?? r.raw };
      byTapVow = e.type === "mandate_denied";
      reason = `${e.code ?? e.type ?? "error"}: ${e.message}`;
    } catch {
      // keep the raw body
    }
    refused = { status: r.status, reason, by_tapvow: byTapVow };
    stoppedReason = "gateway_or_provider_refusal";
    console.log(
      red(byTapVow ? `\nHTTP ${r.status} from TapVow, the call never reached Nebius` : `\nHTTP ${r.status} from the provider, passed through by TapVow`),
    );
    console.log(red(reason));
    break;
  }
  calls++;
  charged += Number.isFinite(r.charged) ? r.charged : 0;
  const extracted = extractFiles(r.text, FILES);
  const names = Object.keys(extracted.files);
  for (const name of names) writeFileSync(join(WORK, name), extracted.files[name]);
  const completeCandidate = FILES.every((name) => names.includes(name)) && !extracted.truncated;
  const notRun = { ok: false, pass: 0, failed: 0, out: "Both complete files are required before tests can run." };
  const tests = completeCandidate ? runTests("duration.test.mjs") : notRun;
  // The model's own tests can omit a requirement. Run the fixed task contract
  // from the source tree, outside the generated answer files, on every candidate.
  const acceptance = completeCandidate ? runTests(ACCEPTANCE) : notRun;
  const accepted = tests.ok && acceptance.ok;
  if (accepted) {
    mkdirSync(join(WORK, "passing"), { recursive: true });
    for (const name of FILES) copyFileSync(join(WORK, name), join(WORK, "passing", name));
    lastPassing = { call: calls, tests: tests.pass, acceptance: acceptance.pass };
  }
  const u = r.usage ?? {};
  const entry = {
    call: calls,
    finish_reason: r.finish,
    usage: r.usage,
    reasoning_chars: r.reasoningChars,
    files: names,
    truncated: extracted.truncated,
    tests: { ok: tests.ok, pass: tests.pass, failed: tests.failed },
    acceptance: { ok: acceptance.ok, pass: acceptance.pass, failed: acceptance.failed },
    accepted,
    charged_micros: Number.isFinite(r.charged) ? r.charged : null,
  };
  log.push(entry);
  // The raw reply is kept so a bad parse can be replayed offline (extract.test.ts).
  writeFileSync(join(WORK, "replies", `call-${String(calls).padStart(2, "0")}.json`), JSON.stringify({ ...entry, content: r.text }, null, 2) + "\n");
  console.log(
    `call ${String(calls).padStart(2)}  ${String(u.prompt_tokens ?? "?").padStart(5)} in ${String(u.completion_tokens ?? "?").padStart(5)} out` +
      `  held ${usd(r.reserved)}  charged ${usd(r.charged)} USD  left ${usd(r.remaining)} USD  ` +
      label(extracted, tests, acceptance, r.finish),
  );
  messages.push({ role: "assistant", content: r.text });
  if (PAUSE_MS > 0) await new Promise((done) => setTimeout(done, PAUSE_MS));
  if (!accepted) {
    if (fixRounds >= 2) {
      stoppedReason = "repair_limit";
      console.log(red("agent: task contract still fails after two repair attempts; stopping without a new feature"));
      break;
    }
    fixRounds++;
    messages.push({
      role: "user",
      content:
        !completeCandidate
          ? "I did not receive both complete files. Answer again with both complete files in the layout from the system message."
          : `The candidate failed the task checks. Fix both files. Generated test output:\n${tests.out.slice(-2000)}\nIndependent acceptance output:\n${acceptance.out.slice(-2500)}`,
    });
    continue;
  }
  fixRounds = 0;
  const next = BACKLOG[backlog % BACKLOG.length];
  backlog++;
  console.log(dim(`next: ${next}`));
  messages.push({ role: "user", content: next });
}

console.log(
  bold(`\nagent: ${calls} calls settled, ${usd(charged)} USD charged by TapVow` + (refused ? `, then stopped with HTTP ${refused.status}` : "")),
);
console.log(
  lastPassing
    ? green(`agent: last passing code from call ${lastPassing.call} (${lastPassing.tests} generated tests, ${lastPassing.acceptance} acceptance tests) kept in ${join(WORK, "passing")}`)
    : red("agent: no call produced code that passes both generated and acceptance tests"),
);
writeFileSync(
  join(WORK, "agent-summary.json"),
  JSON.stringify(
    { model: MODEL, reasoning: REASONING ? "on" : "off", calls, charged_micros: charged, last_passing: lastPassing, refused, stopped_reason: stoppedReason, log },
    null,
    2,
  ) + "\n",
);
process.exit(refused && refused.status === 402 && lastPassing ? 0 : 1);
