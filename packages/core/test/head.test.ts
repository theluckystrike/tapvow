// DONE TEST for the threat model issue 1, core half: a signed head that lives
// outside the database, and an anchor that keeps the highest head it has seen.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigner } from "../src/keys.js";
import { signHead, verifySignedHead, HeadAnchor, type SignedHead } from "../src/head.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-head-"));
  dirs.push(d);
  return d;
}

const HASH_A = "a".repeat(64);

test("tm1 core-sign-verify: a signed head verifies and every changed field fails", () => {
  const { signer, publicKey } = generateSigner("head-key-1");
  const trusted = { "head-key-1": publicKey };
  const head = signHead(signer, { seq: 7, hash: HASH_A }, "2026-10-19T00:00:00.000Z");
  assert.equal(head.format, "spendmandate-head-v1");
  assert.equal(head.seq, 7);
  assert.equal(head.key_id, "head-key-1");

  const ok = verifySignedHead(head, trusted);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.head, head);

  const tamper = (edit: (h: SignedHead) => void): boolean => {
    const clone = structuredClone(head);
    edit(clone);
    return verifySignedHead(clone, trusted).ok;
  };
  assert.equal(tamper((h) => (h.seq = 8)), false, "changed seq must fail");
  assert.equal(tamper((h) => (h.hash = "b".repeat(64))), false, "changed hash must fail");
  assert.equal(tamper((h) => (h.ts = "2026-10-20T00:00:00.000Z")), false, "changed ts must fail");
  // The changed key_id must fail because the signature no longer matches, not
  // because the id is unknown, so the same public key is trusted under both ids.
  const bothTrusted = { "head-key-1": publicKey, "head-key-9": publicKey };
  const changedId = structuredClone(head);
  changedId.key_id = "head-key-9";
  assert.equal(
    verifySignedHead(changedId, bothTrusted).ok,
    false,
    "changed key_id must fail on the signature",
  );

  const other = generateSigner("head-key-1");
  const otherSigned = signHead(other.signer, { seq: 7, hash: HASH_A }, "2026-10-19T00:00:00.000Z");
  assert.equal(verifySignedHead(otherSigned, trusted).ok, false, "another key must fail");

  const extra = { ...head, extra: 1 } as unknown;
  const missing = { ...head } as Record<string, unknown>;
  delete missing.sig;
  assert.equal(verifySignedHead(extra, trusted).ok, false, "an extra key must fail");
  assert.equal(verifySignedHead(missing, trusted).ok, false, "a missing key must fail");
  assert.equal(verifySignedHead({ ...head, hash: "A".repeat(64) }, trusted).ok, false, "uppercase hex must fail");

  console.log("# tm1 core-sign-verify: signature and shape hold, every tamper fails");
});

test("tm1 core-publish: publish keeps the higher head, writes 600, and leaves no temp file", () => {
  const { signer, publicKey } = generateSigner("head-key-2");
  const dir = tmp();
  mkdirSync(join(dir, "heads"), { recursive: true });
  const paths = [join(dir, "ledger.head.json"), join(dir, "heads", "ledger.head.json")];

  const anchor = new HeadAnchor(paths, signer);
  const high = anchor.publish({ seq: 5, hash: "b".repeat(64) });
  assert.equal(high.seq, 5);
  const lower = anchor.publish({ seq: 3, hash: "c".repeat(64) });
  assert.equal(lower.seq, 5, "publish must never lower a head");
  assert.equal(lower.hash, "b".repeat(64));

  const trusted = { "head-key-2": publicKey };
  for (const path of paths) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SignedHead;
    assert.equal(parsed.seq, 5);
    assert.equal(parsed.hash, "b".repeat(64));
    assert.equal(verifySignedHead(parsed, trusted).ok, true, `${path} verifies`);
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is mode 600`);
  }
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), [], "no temp file left");
  assert.deepEqual(
    readdirSync(join(dir, "heads")).filter((n) => n.includes(".tmp-")),
    [],
    "no temp file left next to the mirror",
  );

  console.log("# tm1 core-publish: higher head kept, mode 600, no temp file left");
});

test("tm1 core-forged-head: a forged higher head is ignored when trusted keys are given", () => {
  const { signer, publicKey } = generateSigner("head-key-3");
  const dir = tmp();
  mkdirSync(join(dir, "heads"), { recursive: true });
  const paths = [join(dir, "ledger.head.json"), join(dir, "heads", "ledger.head.json")];
  const trusted = { "head-key-3": publicKey };

  // A shape-valid but unverifiable high head only in the mirror.
  const forged: SignedHead = {
    format: "spendmandate-head-v1",
    seq: 999999,
    hash: "c".repeat(64),
    ts: "2026-10-19T00:00:00.000Z",
    key_id: "head-key-3",
    sig: "garbage",
  };
  writeFileSync(paths[1]!, JSON.stringify(forged));

  const anchor = new HeadAnchor(paths, signer, { trusted });
  const written = anchor.publish({ seq: 5, hash: "b".repeat(64) });
  assert.equal(written.seq, 5, "the forged high head must not win");
  for (const path of paths) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SignedHead;
    assert.equal(parsed.seq, 5, `${path} holds the real head`);
    assert.equal(verifySignedHead(parsed, trusted).ok, true, `${path} verifies`);
  }

  console.log("# tm1 core-forged-head: forged high head ignored, both paths hold the real head");
});
