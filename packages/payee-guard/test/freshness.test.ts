// DONE TEST for threat model issue 5: a replayed older signed payee binding is
// refused once a newer binding has been seen for the same origin.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  checkPayment,
  MemoryBindingFreshness,
  parseX402Allowlist,
  signBinding,
  SqliteBindingFreshness,
  type BindingFreshnessStore,
  type GuardOptions,
  type PaymentAsk,
} from "../src/index.js";
import { ASSET, NETWORK, PAY_TO, makeBinding, newKey, startServer } from "./helpers.js";

const NOW = Date.parse("2026-10-19T00:00:00Z");
const NEWER = "2026-10-10T00:00:00Z";
const OLDER = "2026-10-05T00:00:00Z";
const EVEN_NEWER = "2026-10-15T00:00:00Z";
const EXPIRES = "2026-11-17T00:00:00Z";

const tempDirs: string[] = [];
after(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mandate-bind-"));
  tempDirs.push(dir);
  return dir;
}

function allowlist(origin: string, publicKey: string): GuardOptions["allowlist"] {
  const parsed = parseX402Allowlist([{ rail: "x402", id: `binding:${publicKey}@${origin}` }]);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.allowlist;
}

function options(origin: string, publicKey: string, store: BindingFreshnessStore): GuardOptions {
  return {
    allowlist: allowlist(origin, publicKey),
    networks: [NETWORK],
    median30d: () => null,
    now: () => NOW,
    bindingFreshness: store,
  };
}

function ask(origin: string): PaymentAsk {
  return {
    resourceUrl: `${origin}/report`,
    network: NETWORK,
    asset: ASSET,
    payTo: PAY_TO,
    amount: "10000",
  };
}

test("an older binding for the same origin is blocked after a newer one was accepted", async () => {
  const { signer, publicKey } = newKey();
  const store = new MemoryBindingFreshness();
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    const opts = options(server.origin, publicKey, store);
    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: NEWER, expires_at: EXPIRES }), signer));
    const first = await checkPayment(ask(server.origin), opts);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);

    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: OLDER, expires_at: EXPIRES }), signer));
    const replayed = await checkPayment(ask(server.origin), opts);
    assert.equal(replayed.ok, false);
    if (replayed.ok) return;
    assert.equal(replayed.code, "binding_rolled_back");
    assert.ok(replayed.reason.includes(server.origin), replayed.reason);
    assert.ok(replayed.reason.includes(OLDER), replayed.reason);
    assert.ok(replayed.reason.includes(NEWER), replayed.reason);
    console.log(
      `# tm5 older-binding replay: accepted ${NEWER}, then blocked binding_rolled_back (reason names ${OLDER} and ${NEWER})`,
    );
  } finally {
    await server.close();
  }
});

test("a binding for another origin is not affected by the recorded value", async () => {
  const { signer, publicKey } = newKey();
  const store = new MemoryBindingFreshness();
  let bodyA = "";
  let bodyB = "";
  const serverA = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(bodyA);
  });
  const serverB = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(bodyB);
  });
  try {
    bodyA = JSON.stringify(signBinding(makeBinding(serverA.origin, { issued_at: NEWER, expires_at: EXPIRES }), signer));
    bodyB = JSON.stringify(signBinding(makeBinding(serverB.origin, { issued_at: OLDER, expires_at: EXPIRES }), signer));

    const first = await checkPayment(ask(serverA.origin), options(serverA.origin, publicKey, store));
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    const other = await checkPayment(ask(serverB.origin), options(serverB.origin, publicKey, store));
    assert.equal(other.ok, true, other.ok ? "" : other.reason);
    assert.equal(store.newestIssuedAt(serverB.origin), OLDER);
    console.log(`# tm5 other-origin: ${serverA.origin} recorded ${NEWER}, ${serverB.origin} accepted ${OLDER}`);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("repeating the newest binding passes", async () => {
  const { signer, publicKey } = newKey();
  const store = new MemoryBindingFreshness();
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    const opts = options(server.origin, publicKey, store);
    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: NEWER, expires_at: EXPIRES }), signer));
    const first = await checkPayment(ask(server.origin), opts);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    const again = await checkPayment(ask(server.origin), opts);
    assert.equal(again.ok, true, again.ok ? "" : again.reason);
    console.log(`# tm5 same-binding-again: accepted ${NEWER} twice (equal issued_at is not a rollback)`);
  } finally {
    await server.close();
  }
});

test("a binding that fails its signature does not move the stored value", async () => {
  const { signer, publicKey } = newKey();
  const wrong = newKey();
  const store = new MemoryBindingFreshness();
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  try {
    const opts = options(server.origin, publicKey, store);
    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: NEWER, expires_at: EXPIRES }), signer));
    const first = await checkPayment(ask(server.origin), opts);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);

    // A newer document signed by the wrong key must not advance the store.
    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: EVEN_NEWER, expires_at: EXPIRES }), wrong.signer));
    const bad = await checkPayment(ask(server.origin), opts);
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.code, "payee_binding_invalid");
    assert.equal(store.newestIssuedAt(server.origin), NEWER);

    // Still anchored at NEWER: OLDER is a rollback, EVEN_NEWER never landed.
    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: OLDER, expires_at: EXPIRES }), signer));
    const replayed = await checkPayment(ask(server.origin), opts);
    assert.equal(replayed.ok, false);
    if (replayed.ok) return;
    assert.equal(replayed.code, "binding_rolled_back");
    assert.equal(store.newestIssuedAt(server.origin), NEWER);
    console.log(`# tm5 invalid-signature: ${EVEN_NEWER} did not move the stored value, which stays ${NEWER}`);
  } finally {
    await server.close();
  }
});

test("the sqlite store survives a reopen of the database file", () => {
  const origin = "https://api.example.com";
  const dbPath = join(tempDir(), "freshness.db");

  const firstDb = new DatabaseSync(dbPath);
  try {
    const store = new SqliteBindingFreshness(firstDb);
    store.record(origin, OLDER);
    store.record(origin, NEWER);
    store.record(origin, OLDER);
    assert.equal(store.newestIssuedAt(origin), NEWER);
  } finally {
    firstDb.close();
  }

  const secondDb = new DatabaseSync(dbPath);
  try {
    const store = new SqliteBindingFreshness(secondDb);
    assert.equal(store.newestIssuedAt(origin), NEWER);
    assert.equal(store.newestIssuedAt("https://other.example.com"), null);
  } finally {
    secondDb.close();
  }
  console.log(`# tm5 sqlite-reopen: database reopened and still reports ${NEWER} for ${origin}`);
});

test("record compares instants, not strings: a fractional second is newer than the whole second", () => {
  const origin = "https://fraction.example.com";
  const HALF = "2026-10-10T00:00:00.5Z";
  const WHOLE = "2026-10-10T00:00:00Z";
  const db = new DatabaseSync(join(tempDir(), "fraction.db"));
  try {
    const store = new SqliteBindingFreshness(db);
    store.record(origin, HALF);
    store.record(origin, WHOLE);
    assert.equal(store.newestIssuedAt(origin), HALF);
    console.log(`# tm5 fractional-seconds: recorded ${HALF} then ${WHOLE}, stored value stays ${HALF}`);
  } finally {
    db.close();
  }
});

test("two sqlite stores on two connections to one database cannot move the value backwards", () => {
  const origin = "https://race.example.com";
  const dbPath = join(tempDir(), "race.db");
  const dbA = new DatabaseSync(dbPath);
  const dbB = new DatabaseSync(dbPath);
  try {
    const first = new SqliteBindingFreshness(dbA);
    const second = new SqliteBindingFreshness(dbB);
    first.record(origin, NEWER);
    second.record(origin, OLDER);
    assert.equal(first.newestIssuedAt(origin), NEWER);
    assert.equal(second.newestIssuedAt(origin), NEWER);
    console.log(`# tm5 two-connections: wrote ${NEWER} then ${OLDER} on another connection, stored value stays ${NEWER}`);
  } finally {
    dbA.close();
    dbB.close();
  }
});

test("a corrupt stored freshness value blocks the next payment and names the value", async () => {
  const { signer, publicKey } = newKey();
  const CORRUPT = "not-a-date";
  let body = "";
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  const db = new DatabaseSync(join(tempDir(), "corrupt.db"));
  try {
    const store = new SqliteBindingFreshness(db);
    db.prepare("INSERT INTO payee_binding_freshness (origin, newest_issued_at) VALUES (?, ?)").run(
      server.origin,
      CORRUPT,
    );
    body = JSON.stringify(signBinding(makeBinding(server.origin, { issued_at: NEWER, expires_at: EXPIRES }), signer));
    const blocked = await checkPayment(ask(server.origin), options(server.origin, publicKey, store));
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.code, "binding_rolled_back");
    assert.ok(blocked.reason.includes(CORRUPT), blocked.reason);
    assert.ok(blocked.reason.includes("invalid"), blocked.reason);
    assert.equal(store.newestIssuedAt(server.origin), CORRUPT);

    // record() repairs the corrupt row when it is next called with a verified value.
    store.record(server.origin, NEWER);
    assert.equal(store.newestIssuedAt(server.origin), NEWER);
    console.log(
      `# tm5 corrupt-stored-value: blocked binding_rolled_back naming ${JSON.stringify(CORRUPT)}, record repaired it to ${NEWER}`,
    );
  } finally {
    db.close();
    await server.close();
  }
});
