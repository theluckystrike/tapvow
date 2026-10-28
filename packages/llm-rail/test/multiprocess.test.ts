// Two gateway PROCESSES share one SQLite file. Reservations use BEGIN
// IMMEDIATE, so the budget holds and the ledger stays one chain even when
// the race is between processes, not just between requests in one process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigner, signMandate, EXAMPLE_MANDATE, Ledger, type Mandate } from "@mandate/core";
import { openGovernedRail } from "../src/mandate.js";
import { startFakeUpstream } from "../src/fake-upstream.js";
import { costMicros } from "../src/pricing.js";
import { agentUntilDenied } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mandate-mp-"));
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

function startChild(cfgPath: string): Promise<number> {
  const c = spawn(process.execPath, ["--no-warnings", "--import", "tsx", join(here, "fixtures", "gateway-child.ts"), cfgPath], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(c);
  return new Promise((resolve, reject) => {
    let buf = "";
    c.stdout!.on("data", (d) => {
      buf += d;
      const m = buf.match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    c.on("exit", (code) => reject(new Error(`child exited ${code}`)));
  });
}

test("10 agents across 2 gateway processes on one db stay under 5.00 USD and keep one ledger chain", { timeout: 90_000 }, async () => {
  const issuer = generateSigner("owner");
  const gwKey = generateSigner("gateway-shared");
  const mandate: Mandate = {
    ...EXAMPLE_MANDATE,
    id: "mdt_multiproc_0001",
    issuer: { id: "michael", public_key: issuer.publicKey },
    approval_threshold: "0.50",
    rate_limit: { max_calls: 100000, window_seconds: 60 },
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const signed = signMandate(mandate, issuer.signer);
  const dbPath = join(dir, "shared.db");
  const rail = openGovernedRail({ dbPath, signedMandate: signed, trustedIssuerKey: issuer.publicKey, ledgerSigner: gwKey.signer });
  const keys = mandate.agents.map((a) => rail.issueAgentKey(a));
  rail.close();

  const up = await startFakeUpstream({ latencyMs: [20, 120], completion: "random", seed: 7 });
  const cfgPath = join(dir, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({
    dbPath, signedMandate: signed, trustedIssuerKey: issuer.publicKey, upstream: up.url, upstreamKey: "sk-test-upstream-NOT-REAL",
    ledgerKeyId: gwKey.signer.keyId, ledgerPrivatePem: gwKey.signer.privateKey.export({ type: "pkcs8", format: "pem" }),
  }));
  const ports = await Promise.all([startChild(cfgPath), startChild(cfgPath)]);
  const results = await Promise.all(keys.map((k, n) => agentUntilDenied(`http://127.0.0.1:${ports[n % 2]}`, k, n)));
  for (const c of children) c.kill("SIGTERM");
  await up.close();

  const billed = up.billed.reduce((s, b) => s + costMicros(b.model, { inputTokens: b.inputTokens, outputTokens: b.outputTokens, cachedInputTokens: 0 }), 0);
  const ledger = Ledger.open(dbPath);
  const registered = ledger.entries().filter((e) => e.kind === "mandate.registered").length;
  assert.equal(registered, 1, "mandate registered exactly once across both processes");
  const v = ledger.verify({ [gwKey.signer.keyId]: gwKey.publicKey });
  const settles = ledger.entries().filter((e) => e.kind === "llm.settle");
  const ledgerCharged = settles.reduce((s, e) => s + (e.payload as { charged_micros: number }).charged_micros, 0);
  ledger.close();
  const calls = results.reduce((s, r) => s + r.calls, 0);
  console.log(`multiprocess: 2 gateways, provider billed ${(billed / 1e6).toFixed(6)} USD, ledger ${(ledgerCharged / 1e6).toFixed(6)} USD, calls ${calls}, ledger verify ${v.ok ? "PASS" : "FAIL"}`);
  assert.ok(billed <= 5_000_000);
  assert.ok(billed <= ledgerCharged);
  assert.equal(settles.length, calls);
  assert.equal(v.ok, true);
});
