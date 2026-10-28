// DONE TEST for the threat model issue 1, tapvow half: init publishes a
// head, start refuses a shortened ledger, --adopt-head is the one-time escape
// for a home made before the head files existed, and verify --live sees it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifySignedHead, type SignedHead } from "@mandate/core";
import { runInit } from "../src/init.js";
import { buildPack } from "../src/pack.js";
import { startGateway } from "../src/server.js";
import { envValue } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-head-"));
  dirs.push(d);
  return d;
}

const distCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(args: string[], home: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [distCli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function initHome(): string {
  const home = join(tmp(), "home");
  runInit({
    home,
    budget: "5.00",
    period: "day",
    perCallCap: "0.50",
    days: 30,
    port: 47821,
    apply: false,
    log: () => {},
  });
  return home;
}

async function startAndCall(home: string): Promise<void> {
  const running = await startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true });
  try {
    const key = envValue(join(home, "clients", "openai.env"), "OPENAI_API_KEY");
    assert.ok(key, "openai client key");
    const response = await fetch(`${running.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", max_tokens: 16, messages: [{ role: "user", content: "tm1" }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await running.close();
  }
}

function deleteLastEntry(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT seq, payload FROM ledger_entries ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; payload: string }
      | undefined;
    assert.ok(row, "the ledger has an entry to delete");
    const p = JSON.parse(row.payload) as { reservation_id?: string };
    if (typeof p.reservation_id === "string") {
      db.prepare("DELETE FROM reservations WHERE id = ?").run(p.reservation_id);
    }
    db.prepare("DELETE FROM ledger_entries WHERE seq = ?").run(row.seq);
  } finally {
    db.close();
  }
}

test("tm1 tapvow-tail: start refuses a shortened ledger and verify --live fails", async () => {
  const home = initHome();
  assert.equal(existsSync(join(home, "ledger.head.json")), true, "init published the first head");
  assert.equal(existsSync(join(home, "heads", "ledger.head.json")), true, "init published the mirror");

  await startAndCall(home);

  const before = runCli(["verify", "--live", "--home", home], home);
  assert.equal(before.status, 0, `stdout=${String(before.stdout)} stderr=${String(before.stderr)}`);
  assert.match(String(before.stdout), /^PASS /);

  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { db: string };
  deleteLastEntry(cfg.db);

  await assert.rejects(
    startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true }),
    /ledger rejected: ledger is shorter than the published head/,
    "start refuses the shortened ledger",
  );

  const refused = runCli(["start", "--home", home, "--fake-upstream", "--port", "0"], home);
  assert.equal(refused.status, 1, `stdout=${String(refused.stdout)} stderr=${String(refused.stderr)}`);
  assert.match(String(refused.stderr), /ledger rejected: ledger is shorter than the published head/);

  const after = runCli(["verify", "--live", "--home", home], home);
  assert.equal(after.status, 1, `stdout=${String(after.stdout)}`);
  assert.match(String(after.stdout), /^FAIL .*shorter than the published head/);

  console.log("# tm1 tapvow-tail: start refused, verify --live PASS then FAIL");
});

function ledgerHeadSeq(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT MAX(seq) AS s FROM ledger_entries").get() as { s: number | null };
    return row.s ?? 0;
  } finally {
    db.close();
  }
}

function dbOf(home: string): string {
  return (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { db: string }).db;
}

/** Drops the head files but keeps the .anchored marker (a home that used heads). */
function dropHeadFiles(home: string): void {
  rmSync(join(home, "ledger.head.json"), { force: true });
  rmSync(join(home, "heads", "ledger.head.json"), { force: true });
}

test("tm1 tapvow-adopt: refused without the flag, wrong seq refused, adopted with the right seq", async () => {
  const home = initHome();
  await startAndCall(home);

  // A home made before the head files existed: drop the marker and the heads.
  rmSync(join(home, "ledger.head.json"), { force: true });
  rmSync(join(home, "heads"), { recursive: true, force: true });

  await assert.rejects(
    startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true }),
    /head file missing for a non-empty ledger/,
    "without the flag the missing head is refused",
  );

  const headSeq = ledgerHeadSeq(dbOf(home));
  await assert.rejects(
    startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true, adoptHead: headSeq + 7, log: () => {} }),
    /refusing --adopt-head: the current ledger head is seq \d+, not \d+/,
    "the wrong seq is refused",
  );

  const lines: string[] = [];
  const running = await startGateway({
    home,
    host: "127.0.0.1",
    port: 0,
    fakeUpstream: true,
    adoptHead: headSeq,
    log: (line) => lines.push(line),
  });
  await running.close();
  assert.match(lines.join("\n"), /last ledger entry: seq \d+, hash [0-9a-f]{12}, time /, "prints the last entry");
  assert.match(lines.join("\n"), /missing head files can mean entries were deleted/);
  assert.match(lines.join("\n"), /adopted unverified/);
  assert.equal(existsSync(join(home, "ledger.head.json")), true, "the adopted start republished the head");

  // The CLI passes --adopt-head=<seq> through and prints the same notice.
  rmSync(join(home, "ledger.head.json"), { force: true });
  rmSync(join(home, "heads"), { recursive: true, force: true });
  const cli = spawnSync(
    process.execPath,
    [distCli, "start", "--home", home, "--fake-upstream", "--port", "0", `--adopt-head=${headSeq}`],
    { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 4000 },
  );
  assert.match(String(cli.stdout), /adopted unverified/, `stdout=${String(cli.stdout)} stderr=${String(cli.stderr)}`);

  console.log("# tm1 tapvow-adopt: refused without flag/wrong seq, adopted with the right seq");
});

test("tm1 tapvow-adopt-marker: the .anchored marker refuses adoption even with the right seq", async () => {
  const home = initHome();
  await startAndCall(home);
  const marker = join(home, "heads", ".anchored");
  assert.equal(existsSync(marker), true, "init wrote the marker");
  assert.equal(statSync(marker).mode & 0o777, 0o600, "the marker is mode 600");

  dropHeadFiles(home);
  const headSeq = ledgerHeadSeq(dbOf(home));
  await assert.rejects(
    startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true, adoptHead: headSeq, log: () => {} }),
    /refusing --adopt-head: .*restore the head files from a backup or investigate/,
    "the marker refuses adoption of a missing head",
  );

  console.log("# tm1 tapvow-adopt-marker: marker present refuses adopt even with the right seq");
});

test("tm1 tapvow-pack-head: export republishes and verifies the head it puts in the pack", async () => {
  const home = initHome();
  await startAndCall(home);

  // Put a forged high head in the first path: the pack must publish the real
  // head over it, and must only carry a head that verifies.
  const good = JSON.parse(readFileSync(join(home, "ledger.head.json"), "utf8")) as SignedHead;
  const forged: SignedHead = { ...good, seq: good.seq + 1000, hash: "c".repeat(64), sig: "garbage" };
  writeFileSync(join(home, "ledger.head.json"), JSON.stringify(forged));

  const pack = buildPack({ home });
  const trusted = JSON.parse(readFileSync(join(home, "public-keys.json"), "utf8")) as {
    ledger: Record<string, string>;
  };
  assert.ok(pack.signed_head, "the pack carries a published head");
  assert.equal(verifySignedHead(pack.signed_head, trusted.ledger).ok, true, "the head verifies");
  assert.equal(pack.signed_head!.seq, pack.head.seq, "the carried head matches the pack head");
  assert.equal(pack.signed_head!.seq, good.seq, "the forged high head was not adopted");

  console.log("# tm1 tapvow-pack-head: export published and verified the real head");
});
