// DONE TEST for the threat model issue 1, rail half: open a governed rail with
// head files outside the database, then delete the tail of the ledger and watch
// the next open refuse. A fake upstream keeps it all in process, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXAMPLE_MANDATE, generateSigner, Ledger, signMandate, type Mandate, type SignedHead } from "@mandate/core";
import { openGovernedRail, type GovernedRail } from "../src/mandate.js";
import { createGateway } from "../src/gateway.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { closeServer, listen, post, shape } from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-head-"));
  dirs.push(d);
  return d;
}

const issuer = generateSigner("owner-2026-10");
const gatewayKey = generateSigner("gateway-1");
const mandate: Mandate = {
  ...EXAMPLE_MANDATE,
  id: "mdt_head_anchor_0001",
  issuer: { id: "michael", public_key: issuer.publicKey },
  budget: { total: "5.00", period: "lifetime" },
  per_call_cap: "0.50",
  approval_threshold: "0.50",
  rate_limit: { max_calls: 100000, window_seconds: 60 },
  not_before: "2026-01-01T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
};
const signed = signMandate(mandate, issuer.signer);

interface Fixture {
  dir: string;
  db: string;
  headFiles: [string, string];
}

function fixture(): Fixture {
  const dir = tmp();
  const headFiles: [string, string] = [join(dir, "ledger.head.json"), join(dir, "heads", "ledger.head.json")];
  mkdirSync(join(dir, "heads"), { recursive: true });
  return { dir, db: join(dir, "rail.db"), headFiles };
}

function open(f: Fixture, opts: { headFiles?: string[]; allowMissingHead?: boolean } = {}): GovernedRail {
  return openGovernedRail({
    dbPath: f.db,
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
    headFiles: opts.headFiles,
    allowMissingHead: opts.allowMissingHead,
  });
}

async function runCalls(rail: GovernedRail, n: number): Promise<void> {
  const up = await startFakeUpstream({ completion: "random", seed: 7 });
  const gw = createGateway({
    store: rail.store,
    upstreams: {
      openai: { baseUrl: up.url, apiKey: "sk-test-upstream-NOT-REAL" },
      anthropic: { baseUrl: up.url, apiKey: "sk-test-upstream-NOT-REAL" },
    },
  });
  const port = await listen(gw);
  try {
    const key = rail.issueAgentKey(mandate.agents[0]!);
    for (let i = 0; i < n; i++) {
      const s = shape(i);
      const r = await post(`http://127.0.0.1:${port}`, s.path, s.headers(key), s.body);
      assert.equal(r.status, 200, `call ${i}: ${r.text.slice(0, 200)}`);
    }
  } finally {
    await closeServer(gw);
    await up.close();
  }
}

/** The threat model attack: delete the given ledger seqs and their matching budget rows. */
function deleteSeqs(dbPath: string, seqs: number[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const seq of seqs) {
      const row = db.prepare("SELECT payload FROM ledger_entries WHERE seq = ?").get(seq) as
        | { payload: string }
        | undefined;
      if (row) {
        const p = JSON.parse(row.payload) as { reservation_id?: string };
        if (typeof p.reservation_id === "string") {
          db.prepare("DELETE FROM reservations WHERE id = ?").run(p.reservation_id);
        }
      }
      db.prepare("DELETE FROM ledger_entries WHERE seq = ?").run(seq);
    }
  } finally {
    db.close();
  }
}

function headOf(f: Fixture): SignedHead {
  return JSON.parse(readFileSync(f.headFiles[0], "utf8")) as SignedHead;
}

test("tm1 rail-delete-tail: deleting the last two entries is refused on reopen with head files", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  await runCalls(rail, 5);
  const head = rail.ledger.head();
  assert.equal(head.seq, 6, "one mandate entry and five settles");
  rail.close();

  deleteSeqs(f.db, [head.seq, head.seq - 1]);

  assert.throws(
    () => open(f, { headFiles: f.headFiles }),
    /ledger rejected: ledger is shorter than the published head/,
    "the head outside the database catches the deleted tail",
  );

  const reopened = open(f);
  assert.equal(reopened.ledger.head().seq, 4, "without head files the gap is real");
  reopened.close();

  console.log("# tm1 rail-delete-tail: reopen with heads refused, without heads opened (gap real)");
});

test("tm1 rail-reopen: a normal close and reopen keeps the head equal to the ledger head", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  await runCalls(rail, 1);
  const headSeq = rail.ledger.head().seq;
  rail.close();
  assert.equal(headOf(f).seq, headSeq, "close published the head");

  const reopened = open(f, { headFiles: f.headFiles });
  assert.equal(headOf(f).seq, reopened.ledger.head().seq);
  assert.equal(reopened.publishHead()?.seq, headSeq);
  reopened.close();

  console.log("# tm1 rail-reopen: works, head seq equals the ledger head");
});

test("tm1 rail-crash-window: a ledger one entry longer than the head opens and republishes", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  await runCalls(rail, 1);
  rail.close();
  const seen = headOf(f).seq;

  const extra = Ledger.open(f.db, gatewayKey.signer);
  extra.append("test.extra", { crash: true });
  extra.close();

  const reopened = open(f, { headFiles: f.headFiles });
  assert.equal(reopened.ledger.head().seq, seen + 1);
  reopened.close();
  assert.equal(headOf(f).seq, seen + 1, "the head was republished past the crash");

  console.log("# tm1 rail-crash-window: opened and republished the longer head");
});

test("tm1 rail-forge-missing: a forged head is refused, a missing head is refused unless adopted", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  await runCalls(rail, 1);
  rail.close();

  const good = readFileSync(f.headFiles[0], "utf8");
  const forged = JSON.parse(good) as SignedHead;
  forged.sig = (forged.sig[0] === "A" ? "B" : "A") + forged.sig.slice(1);
  writeFileSync(f.headFiles[0], JSON.stringify(forged));
  assert.throws(() => open(f, { headFiles: f.headFiles }), /head file .* is invalid/, "forged signature");
  writeFileSync(f.headFiles[0], good);

  rmSync(f.headFiles[0], { force: true });
  rmSync(f.headFiles[1], { force: true });
  assert.throws(
    () => open(f, { headFiles: f.headFiles }),
    /head file missing for a non-empty ledger/,
    "missing head refused",
  );

  const adopted = open(f, { headFiles: f.headFiles, allowMissingHead: true });
  adopted.close();
  assert.equal(existsSync(f.headFiles[0]), true, "adopted start republished the head");

  console.log("# tm1 rail-forge-missing: forged refused, missing refused, adopted accepted");
});

test("tm1 rail-rollback: an old head on one path cannot beat the newer mirror", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  await runCalls(rail, 1);
  const oldHead = readFileSync(f.headFiles[0], "utf8");
  await runCalls(rail, 1);
  rail.close();
  const older = JSON.parse(oldHead) as SignedHead;
  assert.equal(older.seq + 1, headOf(f).seq, "one new entry");

  writeFileSync(f.headFiles[0], oldHead);
  deleteSeqs(f.db, [older.seq + 1]);

  assert.throws(
    () => open(f, { headFiles: f.headFiles }),
    /ledger rejected: ledger is shorter than the published head/,
    "the newer mirror wins and refuses the rollback",
  );

  console.log("# tm1 rail-rollback: newer mirror caught the rolled-back first path");
});

test("tm1 rail-forged-mirror: a forged high head in the mirror cannot lock the owner out", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  await runCalls(rail, 1);

  // Forge a shape-valid, high-seq head in the mirror only, while the rail is live.
  const good = JSON.parse(readFileSync(f.headFiles[0], "utf8")) as SignedHead;
  const forged: SignedHead = { ...good, seq: 999999, hash: "c".repeat(64), sig: "garbage" };
  writeFileSync(f.headFiles[1], JSON.stringify(forged));

  await runCalls(rail, 1);
  const real = rail.ledger.head();
  assert.ok(real.seq < 999999, "the real head is below the forged one");
  rail.close();

  for (const path of f.headFiles) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SignedHead;
    assert.equal(parsed.seq, real.seq, `${path} holds the real verified head`);
  }

  const reopened = open(f, { headFiles: f.headFiles });
  assert.equal(reopened.ledger.head().seq, real.seq);
  reopened.close();

  console.log("# tm1 rail-forged-mirror: forged high head ignored, both files real, reopen works");
});

test("tm1 rail-decisions-head: the head moves after denied, approval and mandate.updated entries", async () => {
  const f = fixture();
  const rail = open(f, { headFiles: f.headFiles });
  const start = headOf(f).seq;

  rail.store.recordDenial({
    mandateId: mandate.id,
    agentId: mandate.agents[0]!,
    provider: "openai",
    model: "gpt-4.1",
    amountMicros: 1,
    code: "per_call_cap",
    reason: "over the cap",
  });
  const afterDenied = headOf(f).seq;
  assert.equal(afterDenied, start + 1, "an llm.denied entry moved the head");

  rail.store.recordApproval({
    mandateId: mandate.id,
    agentId: mandate.agents[0]!,
    rail: "llm",
    provider: "openai",
    model: "gpt-4.1",
    amountMicros: 1,
    decision: "approved",
    requestId: "req_head_anchor_0001",
    decidedBy: "owner",
  });
  const afterApproval = headOf(f).seq;
  assert.equal(afterApproval, afterDenied + 1, "an llm.approval entry moved the head");
  rail.close();

  const updated: Mandate = {
    ...mandate,
    budget: { total: "9.00", period: "lifetime" },
    created_at: "2026-10-19T00:00:00Z",
  };
  const signedUpdate = signMandate(updated, issuer.signer);
  const reopened = openGovernedRail({
    dbPath: f.db,
    signedMandate: signedUpdate,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
    headFiles: f.headFiles,
  });
  const afterUpdate = headOf(f).seq;
  assert.equal(afterUpdate, afterApproval + 1, "a mandate.updated entry moved the head");
  reopened.close();

  console.log("# tm1 rail-decisions-head: head moved after denied, approval and mandate.updated");
});

test("tm1 rail-publish-error: a failing mirror warns once and the next commit repairs it", async () => {
  const f = fixture();
  const warnings: Array<{ path: string; code: string | undefined }> = [];
  const rail = openGovernedRail({
    dbPath: f.db,
    signedMandate: signed,
    trustedIssuerKey: issuer.publicKey,
    ledgerSigner: gatewayKey.signer,
    headFiles: f.headFiles,
    onHeadPublishError: (path, err) => {
      warnings.push({ path, code: (err as NodeJS.ErrnoException).code });
    },
  });
  await runCalls(rail, 1);
  assert.equal(warnings.length, 0, "no warning while the mirror is writable");

  chmodSync(join(f.dir, "heads"), 0o500);
  try {
    await runCalls(rail, 1);
    await runCalls(rail, 1);
    assert.equal(warnings.length, 1, "the warning fires exactly once per path");
    assert.equal(warnings[0]!.path, f.headFiles[1]);
    assert.match(warnings[0]!.code ?? "", /EACCES|EPERM/);
    const head = rail.ledger.head();
    assert.equal(headOf(f).seq, head.seq, "the local head still advanced");
    assert.notEqual(
      (JSON.parse(readFileSync(f.headFiles[1], "utf8")) as SignedHead).seq,
      head.seq,
      "the mirror is stale while unwritable",
    );
  } finally {
    chmodSync(join(f.dir, "heads"), 0o700);
  }

  await runCalls(rail, 1);
  assert.equal(
    (JSON.parse(readFileSync(f.headFiles[1], "utf8")) as SignedHead).seq,
    rail.ledger.head().seq,
    "the repaired mirror caught up on the next commit",
  );
  assert.equal(warnings.length, 1, "no further warning after the mirror is repaired");
  rail.close();

  console.log("# tm1 rail-publish-error: calls succeeded, warned once, mirror repaired next commit");
});
