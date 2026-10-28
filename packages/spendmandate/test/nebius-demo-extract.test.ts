// The Nebius demo agent's reply parser (examples/nebius-demo/extract.mjs),
// tested on real Nemotron replies recorded through the gateway. The old parser
// read only Markdown fences and found no files in the two real replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFiles, stripReasoning } from "../../../examples/nebius-demo/extract.mjs";

const FIXTURES = fileURLToPath(new URL("../../../examples/nebius-demo/fixtures/", import.meta.url));
const FILES = ["duration.mjs", "duration.test.mjs"];
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

test("real reply with reasoning off and no fences gives both files", () => {
  const { files, truncated } = extractFiles(fixture("nemotron-reasoning-off-20261027.txt"), FILES);
  assert.deepEqual(Object.keys(files).sort(), FILES);
  assert.equal(truncated, false);
  assert.match(files["duration.mjs"]!, /^\/\/ file: duration\.mjs\nexport function parseDuration/);
  assert.doesNotMatch(files["duration.mjs"]!, /duration\.test\.mjs/);
  assert.match(files["duration.test.mjs"]!, /from '\.\/duration\.mjs'/);
});

test("real reply with reasoning on and no fences gives both files", () => {
  const { files } = extractFiles(fixture("nemotron-reasoning-on-20261027.txt"), FILES);
  assert.deepEqual(Object.keys(files).sort(), FILES);
  assert.match(files["duration.test.mjs"]!, /node:test/);
});

test("fenced reply (26 Oct call 1, rebuilt) still gives both files without fence lines", () => {
  const { files } = extractFiles(fixture("nemotron-fenced-20261026-rebuilt.txt"), FILES);
  assert.deepEqual(Object.keys(files).sort(), FILES);
  for (const body of Object.values(files)) assert.doesNotMatch(body, /```/);
});

test("extracted real files run under node --test", () => {
  const dir = mkdtempSync(join(tmpdir(), "nebius-extract-"));
  try {
    const { files } = extractFiles(fixture("nemotron-reasoning-off-20261027.txt"), FILES);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    // Without NODE_TEST_CONTEXT the child prints its own "# pass" summary.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", "duration.test.mjs"], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
    assert.match(`${r.stdout}${r.stderr}`, /# pass [1-9]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every reply of the capped 27 Oct demo run gives both files", () => {
  for (const call of ["01", "02", "03", "04"]) {
    const { files, truncated } = extractFiles(fixture(`nemotron-run-20261027-call-${call}.txt`), FILES);
    assert.deepEqual(Object.keys(files).sort(), FILES, `call ${call}`);
    assert.equal(truncated, false);
  }
});

test("fence styles. tilde, info string with a file name, label line above, CRLF", () => {
  const reply = [
    "**duration.mjs**",
    "~~~javascript",
    "export const a = 1;",
    "~~~",
    "",
    "```js title=\"duration.test.mjs\"",
    "import { a } from './duration.mjs';",
    "```",
  ].join("\r\n");
  const { files } = extractFiles(reply, FILES);
  assert.equal(files["duration.mjs"], "export const a = 1;\n");
  assert.equal(files["duration.test.mjs"], "import { a } from './duration.mjs';\n");
});

test("a // File: header with another case and a path keeps the base name", () => {
  const { files } = extractFiles("```\n// File: src/duration.mjs\nexport {};\n```\n", FILES);
  assert.deepEqual(Object.keys(files), ["duration.mjs"]);
});

test("a shell block is not taken as a file by answer order", () => {
  const { files } = extractFiles("```bash\nnode --test\n```\n```js\nexport {};\n```\n", FILES);
  assert.deepEqual(Object.keys(files), ["duration.test.mjs"]);
});

test("a reply cut inside a fence is marked truncated and the half file is dropped", () => {
  const reply = "```js\n// file: duration.mjs\nexport {};\n```\n```js\n// file: duration.test.mjs\nimport x";
  const { files, truncated } = extractFiles(reply, FILES);
  assert.equal(truncated, true);
  assert.deepEqual(Object.keys(files), ["duration.mjs"]);
});

test("reasoning only (26 Oct call 7, 4096 of 4096 tokens reasoning) gives no files", () => {
  assert.deepEqual(extractFiles("", FILES), { files: {}, truncated: false });
});

test("reasoning in the content is removed, also with only a closing tag", () => {
  const code = "// file: duration.mjs\nexport {};\n";
  assert.equal(stripReasoning(`<think>plan with \`\`\` fences</think>${code}`), code);
  assert.equal(stripReasoning(`plan // file: duration.test.mjs\n</think>${code}`), code);
  const { files } = extractFiles(`<think>\n// file: duration.test.mjs\nnot code\n</think>\n${code}`, FILES);
  assert.deepEqual(Object.keys(files), ["duration.mjs"]);
});

test("unknown file names are ignored", () => {
  assert.deepEqual(extractFiles("// file: evil.sh\nrm -rf /\n", FILES).files, {});
  assert.deepEqual(extractFiles("// file: ../../duration.mjs\nexport {};\n", FILES).files, { "duration.mjs": "// file: ../../duration.mjs\nexport {};\n" });
});
