// Regression tests for the independent review of the tapvow CLI.
// Each test prints one "# rf-cli <n>: <result>" line.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DASHBOARD_HTML } from "../src/dashboard.html.js";
import { runInit, type InitOptions } from "../src/init.js";
import { buildPack, verifyPack, type TrustedKeys } from "../src/pack.js";
import { startGateway } from "../src/server.js";
import { cleanupTmp, tmp } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;

after(() => cleanupTmp());

const lowsDirs: string[] = [];
function lowsTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tapvow-lows-"));
  lowsDirs.push(d);
  return d;
}
after(() => {
  for (const d of lowsDirs) rmSync(d, { recursive: true, force: true });
  lowsDirs.length = 0;
});

const distCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function envRestore(): void {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.TAPVOW_HOME;
  delete process.env.SPENDMANDATE_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.TAPVOW_HOME;
  delete env.SPENDMANDATE_HOME;
  return env;
}

function runCli(args: string[], home: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [distCli, ...args], {
    encoding: "utf8",
    env: cleanEnv(home),
  });
}

function baseOpts(home: string, over: Partial<InitOptions> = {}): InitOptions {
  return {
    home,
    budget: "5.00",
    period: "day",
    perCallCap: "0.50",
    days: 30,
    port: 47821,
    apply: false,
    log: () => {},
    ...over,
  };
}

function initHome(root: string, over: Partial<InitOptions> = {}): string {
  const home = join(root, "home");
  runInit(baseOpts(home, over));
  return home;
}

test("rf-cli 1: the dashboard has no HTML sinks and the page/API responses carry the security headers", async () => {
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.equal(DASHBOARD_HTML.includes(sink), false, `dashboard source must not contain ${sink}`);
  }

  const root = tmp();
  const home = initHome(root);
  const running = await startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true });
  try {
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { dashboard_token: string };
    const token = encodeURIComponent(cfg.dashboard_token);
    const csp =
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    for (const path of ["/dashboard", "/api/state", "/api/events"]) {
      const res = await fetch(`${running.url}${path}?token=${token}`);
      assert.equal(res.status, 200, `${path} status`);
      assert.equal(res.headers.get("content-security-policy"), csp, `${path} CSP`);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${path} referrer policy`);
      assert.equal(res.headers.get("cache-control"), "no-store", `${path} cache control`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${path} nosniff`);
      if (res.body) {
        try {
          await res.body.cancel();
        } catch {
          // the event stream may already be buffered
        }
      }
    }
    console.log("# rf-cli 1: no HTML sinks; CSP, referrer, cache and nosniff on dashboard/state/events");
  } finally {
    await running.close();
    envRestore();
  }
});

test("rf-cli 2: --trust-pack-keys exits 3 without PASS and pinned keys exit 0", () => {
  const root = tmp();
  const forged = initHome(join(root, "forged"), { budget: "999999.00" });
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const packPath = join(root, "forged-pack.json");
  try {
    const exported = runCli(["export", "--out", packPath, "--home", forged], userHome);
    assert.equal(exported.status, 0, String(exported.stderr));

    const trust = runCli(["verify", packPath, "--trust-pack-keys", "--home", forged], userHome);
    assert.equal(trust.status, 3, `stdout=${String(trust.stdout)} stderr=${String(trust.stderr)}`);
    assert.equal(String(trust.stdout).includes("PASS"), false, "no PASS when keys are not pinned");
    assert.match(String(trust.stdout), /CONSISTENT, keys NOT pinned/);

    const pinned = runCli(["verify", packPath, "--home", forged], userHome);
    assert.equal(pinned.status, 0, `stdout=${String(pinned.stdout)} stderr=${String(pinned.stderr)}`);
    assert.match(String(pinned.stdout), /PASS \(keys pinned from /);
    console.log("# rf-cli 2: --trust-pack-keys -> CONSISTENT exit 3; pinned keys -> PASS exit 0");
  } finally {
    envRestore();
  }
});

test("rf-cli 3: a symlinked Claude settings file keeps the link and updates/backs up the real file", () => {
  const root = tmp();
  const home = join(root, "home");
  const smHome = join(root, "sm");
  const linkedDir = join(root, "linked");
  mkdirSync(linkedDir, { recursive: true });
  const realTarget = join(linkedDir, "settings.json");
  const original = JSON.stringify({ theme: "dark" });
  writeFileSync(realTarget, original);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const link = join(home, ".claude", "settings.json");
  symlinkSync(realTarget, link);

  process.env.HOME = home;
  try {
    runInit(baseOpts(smHome, { apply: true }));
    assert.equal(lstatSync(link).isSymbolicLink(), true, "settings.json is still a symlink");
    assert.equal(realpathSync(link), realpathSync(realTarget), "the link still points at the same file");

    const merged = JSON.parse(readFileSync(realTarget, "utf8")) as { env?: Record<string, string> };
    assert.equal(typeof merged.env?.ANTHROPIC_BASE_URL, "string", "the linked file was updated");

    const backups = readdirSync(linkedDir).filter((n) => n.startsWith("settings.json.tapvow-backup-"));
    assert.equal(backups.length, 1, "one backup next to the resolved file");
    assert.equal(readFileSync(join(linkedDir, backups[0]!), "utf8"), original);
    console.log("# rf-cli 3: symlink kept, linked file updated, backup next to the resolved file");
  } finally {
    envRestore();
  }
});

test("rf-cli 4: an existing ANTHROPIC_MODEL is a conflict and the file stays byte-identical", () => {
  const root = tmp();
  const home = join(root, "home");
  const smHome = join(root, "sm");
  const target = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const original = Buffer.from(JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-opus-x" } }));
  writeFileSync(target, original);

  process.env.HOME = home;
  try {
    const lines: string[] = [];
    runInit(baseOpts(smHome, { apply: true, log: (line) => lines.push(line) }));
    assert.deepEqual(readFileSync(target), original, "file is byte-identical");
    assert.equal(lines.join("\n").includes("ANTHROPIC_MODEL"), true, "the conflict is named");
    assert.equal(
      readdirSync(join(home, ".claude")).filter((n) => n.includes(".tapvow-backup-")).length,
      0,
      "no backup for a refused merge",
    );
    console.log("# rf-cli 4: ANTHROPIC_MODEL conflict, file byte-identical, no backup");
  } finally {
    envRestore();
  }
});

test("rf-cli 5: CLAUDE_CONFIG_DIR is honoured and no Codex config is written", () => {
  const root = tmp();
  const home = join(root, "home");
  const smHome = join(root, "sm");
  const claudeDir = join(root, "claude-config");
  const codexDir = join(root, "codex-home");
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  try {
    runInit(baseOpts(smHome, { apply: true }));

    const settings = join(claudeDir, "settings.json");
    assert.equal(existsSync(settings), true, "CLAUDE_CONFIG_DIR/settings.json written");
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as { env?: Record<string, string> };
    assert.equal(typeof parsed.env?.ANTHROPIC_BASE_URL, "string");

    // Current Codex refuses a wire_api = "chat" provider and then loads no config
    // at all, so --apply never writes a Codex config.
    assert.equal(existsSync(join(codexDir, "config.toml")), false, "CODEX_HOME/config.toml not written");

    assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "default .claude untouched");
    assert.equal(existsSync(join(home, ".codex", "config.toml")), false, "default .codex untouched");
    console.log("# rf-cli 5: CLAUDE_CONFIG_DIR used, no Codex config, default locations untouched");
  } finally {
    envRestore();
  }
});

test("rf-cli 7: init warns about a real provider key by name without printing its value", () => {
  const root = tmp();
  const smHome = join(root, "sm");
  const anthropicValue = "sk-ant-rf7-NOT-REAL-0001";
  const openaiValue = "sk-rf7-NOT-REAL-0002";
  process.env.HOME = join(root, "user");
  process.env.ANTHROPIC_API_KEY = anthropicValue;
  process.env.OPENAI_API_KEY = openaiValue;
  try {
    const lines: string[] = [];
    runInit(baseOpts(smHome, { log: (line) => lines.push(line) }));
    const output = lines.join("\n");
    assert.equal(output.includes("ANTHROPIC_API_KEY"), true, "names ANTHROPIC_API_KEY");
    assert.equal(output.includes("OPENAI_API_KEY"), true, "names OPENAI_API_KEY");
    assert.equal(output.includes(anthropicValue), false, "does not print the Anthropic value");
    assert.equal(output.includes(openaiValue), false, "does not print the OpenAI value");
    console.log("# rf-cli 7: both variable names warned, neither value printed");
  } finally {
    if (ORIGINAL_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_KEY;
    if (ORIGINAL_OPENAI_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
    envRestore();
  }
});

test("rf-cli 8: init --budget abc fails and leaves no home or temp dir, then a good init succeeds", () => {
  const root = tmp();
  const home = join(root, "home");
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  try {
    const bad = runCli(["init", "--home", home, "--budget", "abc"], userHome);
    assert.notEqual(bad.status, 0, `stdout=${String(bad.stdout)} stderr=${String(bad.stderr)}`);
    assert.equal(existsSync(home), false, "no home was left behind");
    assert.equal(
      readdirSync(root).filter((n) => n.startsWith("home.init-")).length,
      0,
      "no temporary directory was left behind",
    );

    const good = runCli(["init", "--home", home], userHome);
    assert.equal(good.status, 0, `stdout=${String(good.stdout)} stderr=${String(good.stderr)}`);
    assert.equal(existsSync(join(home, "config.json")), true, "the good init published the home");
    console.log("# rf-cli 8: bad budget left nothing; the next init succeeded");
  } finally {
    envRestore();
  }
});

test("rf-cli 9: a non-empty foreign home is refused and left untouched", () => {
  const root = tmp();
  const home = join(root, "home");
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "keep.txt"), "important");
  try {
    const res = runCli(["init", "--home", home], userHome);
    assert.equal(res.status, 2, `stdout=${String(res.stdout)} stderr=${String(res.stderr)}`);
    assert.match(String(res.stderr), /exists, is not empty and is not a TapVow home/);
    assert.deepEqual(readdirSync(home), ["keep.txt"], "the foreign home is untouched");
    assert.equal(existsSync(join(home, "config.json")), false);
    console.log("# rf-cli 9: foreign home refused with exit 2 and untouched");
  } finally {
    envRestore();
  }
});

test("rf-cli 10: --port 0 and 70000 are refused by init", () => {
  const root = tmp();
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  try {
    for (const port of ["0", "70000"]) {
      const home = join(root, `home-${port}`);
      const res = runCli(["init", "--home", home, "--port", port], userHome);
      assert.equal(res.status, 2, `port ${port}: stdout=${String(res.stdout)} stderr=${String(res.stderr)}`);
      assert.match(String(res.stderr), /port must be an integer from 1 to 65535/);
      assert.equal(existsSync(home), false, `port ${port} did not create a home`);
    }
    console.log("# rf-cli 10: ports 0 and 70000 refused with exit 2");
  } finally {
    envRestore();
  }
});

test("rf-cli 11: unknown pack fields and duplicate JSON keys all fail", () => {
  const root = tmp();
  const home = initHome(root);
  const pack = buildPack({ home });
  const trusted = JSON.parse(readFileSync(join(home, "public-keys.json"), "utf8")) as TrustedKeys;
  try {
    assert.equal(verifyPack(pack, trusted).ok, true, "the honest pack verifies");

    const extraEntry = structuredClone(pack);
    (extraEntry.entries[0] as unknown as Record<string, unknown>).extra = 1;
    assert.equal(verifyPack(extraEntry, trusted).ok, false, "extra entry field fails");

    const extraMandate = structuredClone(pack);
    (extraMandate.mandate as unknown as Record<string, unknown>).extra = 1;
    assert.equal(verifyPack(extraMandate, trusted).ok, false, "extra pack.mandate key fails");

    const extraTop = structuredClone(pack);
    (extraTop as unknown as Record<string, unknown>).extra = 1;
    assert.equal(verifyPack(extraTop, trusted).ok, false, "extra top-level field fails");

    const extraLedgerKey = structuredClone(pack);
    extraLedgerKey.public_keys.ledger["ledger-extra"] = "not-a-trusted-key";
    assert.equal(verifyPack(extraLedgerKey, trusted).ok, false, "unused extra ledger key fails");

    const canonical = JSON.stringify(pack, null, 2);
    const duplicateTotals = canonical.replace(
      '"totals":',
      '"totals": {"settled_micros":0,"calls_settled":0,"calls_denied":0,"approvals":0},\n  "totals":',
    );
    assert.notEqual(duplicateTotals, canonical, "the test file really has a duplicate totals key");
    const packPath = join(root, "duplicate-totals.json");
    writeFileSync(packPath, duplicateTotals);
    const userHome = join(root, "user");
    mkdirSync(userHome, { recursive: true });
    const res = runCli(["verify", packPath, "--home", home], userHome);
    assert.equal(res.status, 1, `stdout=${String(res.stdout)} stderr=${String(res.stderr)}`);
    assert.match(String(res.stdout), /FAIL/);
    console.log("# rf-cli 11: extra fields and a duplicate totals key all FAIL");
  } finally {
    envRestore();
  }
});
