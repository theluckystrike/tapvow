import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStoreId } from "@mandate/llm-rail";
import { ExitError } from "../src/home.js";
import { runInit, type InitOptions } from "../src/init.js";
import { cleanupTmp, tmp, treeHash, walkFiles } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;
const ORIGINAL_HOME = process.env.HOME;


after(() => cleanupTmp());

function opts(home: string, extra: Partial<InitOptions> = {}): InitOptions {
  return {
    home,
    budget: "5.00",
    period: "day",
    perCallCap: "0.50",
    days: 30,
    port: 8787,
    apply: false,
    log: () => {},
    ...extra,
  };
}

test("cli 1: init creates bound files with safe modes and a second init exits 2 without changes", () => {
  const root = tmp();
  const home = join(root, "home");
  process.env.HOME = home;
  try {
    const result = runInit(opts(home));
    assert.equal(result.port, 8787);
    assert.equal(statSync(home).mode & 0o777, 0o700);

    for (const name of ["owner-key.json", "ledger-key.json", "config.json"]) {
      assert.equal(statSync(join(home, name)).mode & 0o777, 0o600, `${name} mode`);
    }
    assert.equal(statSync(join(home, "public-keys.json")).mode & 0o777, 0o644);
    assert.equal(statSync(join(home, "clients")).mode & 0o777, 0o700);
    for (const name of readdirSync(join(home, "clients"))) {
      assert.equal(statSync(join(home, "clients", name)).mode & 0o777, 0o600, `${name} mode`);
    }

    const signed = JSON.parse(readFileSync(join(home, "mandate.signed.json"), "utf8")) as {
      mandate: { id: string; store_id: string };
    };
    assert.equal(signed.mandate.store_id, readStoreId(join(home, "ledger.db")));
    assert.equal(signed.mandate.id, result.mandateId);

    const before = treeHash(home);
    assert.throws(
      () => runInit(opts(home)),
      (err: unknown) => err instanceof ExitError && err.code === 2,
    );
    assert.deepEqual(treeHash(home), before);
    console.log("# cli 1: PASS");
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  }
});

test("cli 2: init --apply never reads or writes real provider keys", () => {
  const root = tmp();
  const home = join(root, "home");
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = "sk-real-test-0001";
  process.env.ANTHROPIC_API_KEY = "sk-ant-real-test-0002";
  try {
    const lines: string[] = [];
    runInit(opts(home, { apply: true, log: (line) => lines.push(line) }));
    const output = lines.join("\n");
    assert.ok(!output.includes("sk-real-test-0001"));
    assert.ok(!output.includes("sk-ant-real-test-0002"));
    for (const file of walkFiles(home)) {
      const content = readFileSync(file, "utf8");
      assert.ok(!content.includes("sk-real-test-0001"), `${file} leaks the OpenAI key`);
      assert.ok(!content.includes("sk-ant-real-test-0002"), `${file} leaks the Anthropic key`);
    }
    console.log("# cli 2: PASS");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  }
});

test("cli 3: --apply merges Claude Code settings, keeps other keys and backs up", () => {
  const root = tmp();
  const home = join(root, "home");
  const smHome = join(home, ".tapvow");
  const target = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const original = JSON.stringify({ theme: "dark", env: { FOO: "1" } });
  writeFileSync(target, original);

  process.env.HOME = home;
  try {
    runInit(opts(smHome, { apply: true }));
    const merged = JSON.parse(readFileSync(target, "utf8")) as {
      theme?: string;
      env?: Record<string, string>;
    };
    assert.equal(merged.theme, "dark");
    assert.equal(merged.env?.FOO, "1");
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
    ]) {
      assert.equal(typeof merged.env?.[name], "string", `${name} present`);
    }
    const backups = readdirSync(join(home, ".claude")).filter((n) =>
      n.startsWith("settings.json.tapvow-backup-"),
    );
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(home, ".claude", backups[0]!), "utf8"), original);
    console.log("# cli 3a: PASS");
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  }
});

test("cli 3: --apply leaves a conflicting Claude Code settings file byte-for-byte unchanged", () => {
  const root = tmp();
  const home = join(root, "home");
  const smHome = join(home, ".tapvow");
  const target = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const original = Buffer.from(JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-inside-file-123" } }));
  writeFileSync(target, original);

  process.env.HOME = home;
  try {
    const lines: string[] = [];
    runInit(opts(smHome, { apply: true, log: (line) => lines.push(line) }));
    assert.deepEqual(readFileSync(target), original);
    const output = lines.join("\n");
    assert.ok(output.includes("ANTHROPIC_API_KEY"));
    assert.ok(!output.includes("sk-inside-file-123"));
    assert.equal(
      readdirSync(join(home, ".claude")).filter((n) => n.includes(".tapvow-backup-")).length,
      0,
    );
    console.log("# cli 3b: PASS");
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  }
});

test("cli 4: --apply leaves an existing Codex config byte-for-byte unchanged", () => {
  const root = tmp();
  const home = join(root, "home");
  const smHome = join(home, ".tapvow");
  const target = join(home, ".codex", "config.toml");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const original = 'model = "o3"\n';
  writeFileSync(target, original);

  process.env.HOME = home;
  try {
    const lines: string[] = [];
    runInit(opts(smHome, { apply: true, log: (line) => lines.push(line) }));
    assert.equal(readFileSync(target, "utf8"), original);
    assert.ok(lines.some((l) => l.includes("Codex:") && l.includes("not supported yet")));
    assert.ok(existsSync(join(smHome, "clients", "opencode.json")));
    console.log("# cli 4: PASS");
  } finally {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  }
});
