import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalize,
  generateSigner,
  sha256Hex,
  signBytes,
  signMandate,
  type Mandate,
} from "@mandate/core";
import { buildPack, verifyPack, type ReceiptPack, type TrustedKeys } from "../src/pack.js";
import { buildPdf, pdfLinesForPack } from "../src/pdf.js";
import { runInit } from "../src/init.js";
import { startGateway } from "../src/server.js";
import { cleanupTmp, envValue, tmp } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;


after(() => cleanupTmp());

const PACK_PREFIX = "spendmandate-pack/v1\n";

function reasonOf(result: ReturnType<typeof verifyPack>): string {
  return result.ok ? "PASS" : result.reason;
}

async function makePack(): Promise<{ pack: ReceiptPack; trusted: TrustedKeys }> {
  const root = tmp();
  const home = join(root, "home");
  runInit({
    home,
    budget: "5.00",
    period: "day",
    perCallCap: "0.50",
    days: 30,
    port: 8787,
    apply: false,
    log: () => {},
  });
  const running = await startGateway({ home, host: "127.0.0.1", port: 0, fakeUpstream: true });
  try {
    const key = envValue(join(home, "clients", "openai.env"), "OPENAI_API_KEY");
    assert.ok(key);
    for (let i = 0; i < 2; i++) {
      const response: Response = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1",
          max_tokens: 16,
          messages: [{ role: "user", content: `export test ${i}` }],
        }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
  } finally {
    await running.close();
  }
  const pack = buildPack({ home });
  const trusted = JSON.parse(readFileSync(join(home, "public-keys.json"), "utf8")) as TrustedKeys;
  return { pack, trusted };
}

function resignHead(pack: ReceiptPack, privateKey: import("node:crypto").KeyObject): void {
  const message =
    PACK_PREFIX +
    canonicalize({
      format: pack.format,
      created_at: pack.created_at,
      store_id: pack.store_id,
      mandate_id: pack.mandate.mandate.id,
      head: pack.head,
      totals: pack.totals,
    });
  pack.head_signature = signBytes(privateKey, new TextEncoder().encode(message));
}

function checkPdf(pdf: Buffer): void {
  const s = pdf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4"), "starts with %PDF-1.4");
  assert.ok(s.trimEnd().endsWith("%%EOF"), "ends with %%EOF");

  const startxref = s.lastIndexOf("startxref");
  assert.ok(startxref >= 0, "has startxref");
  const xrefOffset = Number(s.slice(startxref + "startxref".length).trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(xrefOffset), "startxref is a number");
  assert.equal(s.slice(xrefOffset, xrefOffset + 4), "xref");

  const table = s.slice(xrefOffset).split("\n");
  assert.equal(table[0], "xref");
  const count = Number(table[1]!.split(" ")[1]);
  const entries = table.slice(2, 2 + count);
  assert.equal(entries.length, count);
  for (let id = 1; id < count; id++) {
    const offset = Number(entries[id]!.slice(0, 10));
    assert.ok(Number.isInteger(offset) && offset > 0, `offset ${id}`);
    assert.match(s.slice(offset), /^\d+ 0 obj/, `offset ${id} points at an object`);
  }
}

test("cli 8: export verifies and every tampered copy fails", async () => {
  const { pack, trusted } = await makePack();

  const good = verifyPack(pack, trusted);
  if (!good.ok) throw new Error(`export failed: ${good.reason}`);
  assert.ok(good.summary.entries >= 3);
  assert.ok(pack.entries.some((e) => e.kind === "llm.settle"));
  console.log("# cli 8: export verify PASS");

  const other = generateSigner("attacker");

  const changedPayload = structuredClone(pack);
  const settle = changedPayload.entries.find((e) => e.kind === "llm.settle");
  assert.ok(settle);
  const payload = JSON.parse(settle.payload) as Record<string, unknown>;
  payload.charged_micros = Number(payload.charged_micros) + 1;
  settle.payload = canonicalize(payload);
  const r1 = verifyPack(changedPayload, trusted);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.reason, /hash/);
  console.log(`# cli 8: changed payload -> ${reasonOf(r1)}`);

  const changedTotals = structuredClone(pack);
  changedTotals.totals.settled_micros += 1;
  const r2 = verifyPack(changedTotals, trusted);
  assert.equal(r2.ok, false);
  console.log(`# cli 8: changed totals -> ${reasonOf(r2)}`);

  const droppedTail = structuredClone(pack);
  droppedTail.entries.pop();
  const r3 = verifyPack(droppedTail, trusted);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.match(r3.reason, /head/);
  console.log(`# cli 8: dropped tail -> ${reasonOf(r3)}`);

  const droppedMiddle = structuredClone(pack);
  droppedMiddle.entries.splice(1, 1);
  const r4 = verifyPack(droppedMiddle, trusted);
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.match(r4.reason, /seq/);
  console.log(`# cli 8: dropped middle -> ${reasonOf(r4)}`);

  const swappedIssuer = structuredClone(pack);
  swappedIssuer.public_keys.issuer = other.publicKey;
  const r5 = verifyPack(swappedIssuer, trusted);
  assert.equal(r5.ok, false);
  if (!r5.ok) assert.match(r5.reason, /issuer key/);
  console.log(`# cli 8: swapped issuer -> ${reasonOf(r5)}`);

  const reSignedHead = structuredClone(pack);
  resignHead(reSignedHead, other.signer.privateKey);
  const r6 = verifyPack(reSignedHead, trusted);
  assert.equal(r6.ok, false);
  if (!r6.ok) assert.match(r6.reason, /head_signature/);
  console.log(`# cli 8: re-signed head -> ${reasonOf(r6)}`);

  const swappedMandate = structuredClone(pack);
  const otherMandate: Mandate = {
    ...pack.mandate.mandate,
    id: "mdt_other_mandate_0001",
    issuer: { id: "other", public_key: other.publicKey },
  };
  swappedMandate.mandate = signMandate(otherMandate, other.signer);
  const r7 = verifyPack(swappedMandate, trusted);
  assert.equal(r7.ok, false);
  if (!r7.ok) assert.match(r7.reason, /mandate/);
  console.log(`# cli 8: swapped mandate -> ${reasonOf(r7)}`);

  console.log("# cli 8: PASS");
});

test("cli 9: the PDF is valid and its xref points at objects", async () => {
  const { pack } = await makePack();
  const sha = sha256Hex(JSON.stringify(pack, null, 2));
  const pdf = buildPdf(pdfLinesForPack(pack, sha));
  checkPdf(pdf);

  const longLines = Array.from({ length: 200 }, (_, i) => `line ${i} (with) \\ special`);
  const longPdf = buildPdf(longLines);
  checkPdf(longPdf);
  const pages = (longPdf.toString("latin1").match(/\/Type \/Page /g) ?? []).length;
  assert.ok(pages >= 2, "long documents break over several pages");
  console.log(`# cli 9: PASS (${pages} pages)`);
});
