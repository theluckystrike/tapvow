// Dogfood gateway. Runs the TapVow LLM rail on 127.0.0.1 in front of the
// local model lock proxy, with the passkey-signed mandate made by
// mandate-tool.ts. Approval above the threshold goes to an auto-deny approver,
// because no Telegram approval bot exists yet, so every such decision is a
// signed llm.approval entry with decision "denied".
//
//   node --import tsx scripts/dogfood/gateway.ts --data <dir>
//
// The upstream bearer is a label the model lock uses to pick a budget bucket,
// not a secret. The real provider key stays inside the model lock.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createPrivateKey, randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openGovernedRailWithPasskey, createGateway } from "@mandate/llm-rail";
import type { TrustedCredential } from "@mandate/passkey";

interface Cfg {
  audience: string;
  rp_id: string;
  origin: string;
  db: string;
  ledger_key_file: string;
  credential_file: string;
  mandate_file: string;
  upstream_base_url: string;
  upstream_label: string;
  host: string;
  port: number;
}

const { values } = parseArgs({ args: process.argv.slice(2), options: { data: { type: "string" } } });
if (!values.data) throw new Error("--data <dir> is required");
const data = values.data;
const cfg = JSON.parse(readFileSync(join(data, "config.json"), "utf8")) as Cfg;
if (cfg.host !== "127.0.0.1") throw new Error("the dogfood gateway binds to 127.0.0.1 only");

// The rate for deepseek/deepseek-v4.1-flash-1017 lives in
// packages/llm-rail/src/pricing.ts (the reconciled 0.15 in / 0.60 out entry).
// The gateway settles at the upstream usage.cost whenever that is higher than
// the table, so the model lock's own billing raises the charge automatically.

const ledgerKey = JSON.parse(readFileSync(cfg.ledger_key_file, "utf8")) as { key_id: string; private_key_pkcs8: string };
const credential = JSON.parse(readFileSync(cfg.credential_file, "utf8")) as TrustedCredential;
const doc = JSON.parse(readFileSync(cfg.mandate_file, "utf8"));

const rail = await openGovernedRailWithPasskey({
  dbPath: cfg.db,
  signedMandate: doc,
  passkey: { credentials: [credential], rpID: cfg.rp_id, origin: cfg.origin, audience: cfg.audience },
  ledgerSigner: {
    keyId: ledgerKey.key_id,
    privateKey: createPrivateKey({ key: Buffer.from(ledgerKey.private_key_pkcs8, "base64"), format: "der", type: "pkcs8" }),
  },
  requireStoreBinding: true,
});

const gateway = createGateway({
  store: rail.store,
  upstreams: { openai: { baseUrl: cfg.upstream_base_url, apiKey: cfg.upstream_label } },
  defaultMaxTokens: 4096,
  approver: {
    async request() {
      return { decision: "denied", requestId: `auto-deny-${randomUUID()}`, decidedBy: "auto-deny (no approval bot yet)" };
    },
  },
});

const pidFile = join(data, "..", "gateway.pid");
await new Promise<void>((resolve, reject) => {
  gateway.once("error", reject);
  gateway.listen(cfg.port, cfg.host, () => resolve());
});
writeFileSync(pidFile, `${process.pid}\n`);
const m = rail.mandate;
console.log(
  `${new Date().toISOString()} TapVow dogfood gateway pid ${process.pid} on http://${cfg.host}:${cfg.port}/v1 ` +
    `mandate ${m.id} budget ${m.budget.total}/${m.budget.period} cap ${m.per_call_cap} approval ${m.approval_threshold} (auto-deny) ` +
    `upstream ${cfg.upstream_base_url}`,
);

let lastSeq = rail.ledger.head().seq;
const tick = setInterval(() => {
  try {
    for (const e of rail.ledger.entries(lastSeq + 1)) {
      lastSeq = e.seq;
      const p = e.payload as Record<string, unknown>;
      console.log(
        `${e.ts} seq ${e.seq} ${e.kind} agent ${String(p.agent_id ?? "-")} model ${String(p.model ?? "-")} ` +
          `charged ${String(p.charged_micros ?? "-")} amount ${String(p.amount_micros ?? "-")} code ${String(p.code ?? "-")} decision ${String(p.decision ?? "-")}`,
      );
    }
  } catch (err) {
    console.log(`ledger tail error ${String(err)}`);
  }
}, 1000);

const shutdown = (): void => {
  clearInterval(tick);
  gateway.close(() => {
    try {
      rail.close();
    } catch {
      // already closed
    }
    try {
      rmSync(pidFile, { force: true });
    } catch {
      // ignore
    }
    console.log(`${new Date().toISOString()} gateway stopped`);
    process.exit(0);
  });
  gateway.closeAllConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
