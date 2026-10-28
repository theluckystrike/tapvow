import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cleanupTmp, tmp } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;


after(() => cleanupTmp());

const distCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args: string[], home: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [distCli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

test("cli 10: the built CLI runs help, init, export and verify", () => {
  const root = tmp();
  const home = join(root, "home");

  const help = run(["--help"], home);
  assert.equal(help.status, 0, String(help.stderr));
  assert.match(String(help.stdout), /tapvow/);

  const init = run(["init", "--home", home], home);
  assert.equal(init.status, 0, String(init.stderr));
  assert.match(String(init.stdout), /TapVow initialized/);

  const packPath = join(root, "pack.json");
  const pdfPath = join(root, "pack.pdf");
  const exported = run(["export", "--out", packPath, "--pdf", pdfPath, "--home", home], home);
  assert.equal(exported.status, 0, String(exported.stderr));

  const verified = run(["verify", packPath, "--home", home], home);
  assert.equal(verified.status, 0, String(verified.stderr));
  assert.match(String(verified.stdout), /PASS/);
  console.log("# cli 10: PASS");
});

test("cli 14: init with a budget below 2.00 USD gets a per-call cap equal to the budget, and prints the client lines", () => {
  const root = tmp();
  const home = join(root, "home");
  const init = run(["init", "--home", home, "--budget", "1.00"], home);
  assert.equal(init.status, 0, String(init.stderr));
  const out = String(init.stdout);
  assert.match(out, /Claude Code: {2}source .*claude-code\.env/);
  assert.match(out, /OpenCode: {5}source .*opencode\.env/);
  assert.match(out, /Codex: {8}not supported yet/);
  assert.doesNotMatch(out, /mk_/, "virtual keys stay in the 0600 client files");

  const explicit = run(["init", "--home", join(root, "home2"), "--budget", "1.00", "--per-call-cap", "1.50"], home);
  assert.equal(explicit.status, 2, "an explicit cap above the budget is still refused");
  console.log("# cli 14: PASS");
});
