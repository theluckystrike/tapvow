import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome } from "../src/home.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "tapvow-"));
  dirs.push(d);
  return d;
}

function withEnv(home: string, next: string | undefined, prev: string | undefined, fn: () => void): void {
  const saved = { HOME: process.env.HOME, TAPVOW_HOME: process.env.TAPVOW_HOME, SPENDMANDATE_HOME: process.env.SPENDMANDATE_HOME };
  process.env.HOME = home;
  if (next === undefined) delete process.env.TAPVOW_HOME;
  else process.env.TAPVOW_HOME = next;
  if (prev === undefined) delete process.env.SPENDMANDATE_HOME;
  else process.env.SPENDMANDATE_HOME = prev;
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("home 1: --home wins, then TAPVOW_HOME, then SPENDMANDATE_HOME", () => {
  const home = tempHome();
  const explicit = join(home, "explicit");
  withEnv(home, join(home, "tapvow-env"), join(home, "old-env"), () => {
    assert.equal(resolveHome(explicit), explicit, "the flag wins");
    assert.equal(resolveHome(), join(home, "tapvow-env"), "TAPVOW_HOME beats the old name");
  });
  withEnv(home, undefined, join(home, "old-env"), () => {
    assert.equal(resolveHome(), join(home, "old-env"), "the old name is the fallback");
  });
  console.log("# home 1: flag, TAPVOW_HOME and SPENDMANDATE_HOME in order");
});

test("home 2: with no environment variable a fresh install uses ~/.tapvow", () => {
  const home = tempHome();
  withEnv(home, undefined, undefined, () => {
    assert.equal(resolveHome(), join(home, ".tapvow"));
  });
  console.log("# home 2: fresh install resolves ~/.tapvow");
});

test("home 3: an existing ~/.spendmandate install keeps its home when ~/.tapvow is absent", () => {
  const home = tempHome();
  mkdirSync(join(home, ".spendmandate"), { recursive: true });
  withEnv(home, undefined, undefined, () => {
    assert.equal(resolveHome(), join(home, ".spendmandate"), "the existing ledger keeps its home");
  });
  console.log("# home 3: existing ~/.spendmandate is kept");
});

test("home 4: a new ~/.tapvow wins over an old ~/.spendmandate once it exists", () => {
  const home = tempHome();
  mkdirSync(join(home, ".spendmandate"), { recursive: true });
  mkdirSync(join(home, ".tapvow"), { recursive: true });
  withEnv(home, undefined, undefined, () => {
    assert.equal(resolveHome(), join(home, ".tapvow"), "the new home wins when both exist");
  });
  console.log("# home 4: ~/.tapvow wins when both exist");
});
