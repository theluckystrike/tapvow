// Dogfood check. Verifies the gateway ledger with the pinned ledger public key,
// prints every entry with its cost, and matches each settled call against the
// model lock ledger by token counts and time.
//
//   node --import tsx scripts/dogfood/check.ts --data <dir> [--modellock <ledger.jsonl>] [--since <ISO time>]
//
// The model lock ledger is streamed line by line, never loaded whole.
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { verifyEntries, type LedgerRow } from "@mandate/core";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    data: { type: "string" },
    modellock: {
      type: "string",
      default: process.env.MODELLOCK_LEDGER ?? join(homedir(), ".hermes", "modellock", "ledger.jsonl"),
    },
    since: { type: "string" },
  },
});
if (!values.data) throw new Error("--data <dir> is required");
const data = values.data;
const keys = JSON.parse(readFileSync(join(data, "public-keys.json"), "utf8")) as { ledger: Record<string, string> };

const db = new DatabaseSync(join(data, "gateway.db"), { readOnly: true });
const rows = db.prepare("SELECT seq, ts, kind, payload, prev_hash, hash, key_id, sig FROM ledger_entries ORDER BY seq").all() as unknown as LedgerRow[];
db.close();

const result = verifyEntries(rows, keys.ledger);
console.log(`ledger verify with pinned key ${Object.keys(keys.ledger).join(",")} ${result.ok ? "PASS" : "FAIL"} checked ${result.checked}${result.reason ? " " + result.reason : ""}`);

interface Usage { input_tokens: number; output_tokens: number; cached_input_tokens: number }
const settles: { seq: number; ts: string; charged: number; usage: Usage }[] = [];
let charged = 0;
const kinds = new Map<string, number>();
for (const r of rows) {
  kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  const p = JSON.parse(r.payload) as Record<string, any>;
  if (values.since && r.ts < values.since) continue;
  if (r.kind === "llm.settle") {
    charged += p.charged_micros;
    settles.push({ seq: r.seq, ts: r.ts, charged: p.charged_micros, usage: p.usage });
    console.log(
      `seq ${r.seq} ${r.ts} llm.settle charged ${p.charged_micros} micros reserved ${p.reserved_micros} ` +
        `in ${p.usage.input_tokens} cached ${p.usage.cached_input_tokens} out ${p.usage.output_tokens}`,
    );
  } else if (r.kind !== "mandate.registered" && r.kind !== "mandate.updated") {
    console.log(`seq ${r.seq} ${r.ts} ${r.kind} code ${p.code ?? "-"} decision ${p.decision ?? "-"} amount ${p.amount_micros ?? "-"} reason ${p.reason ?? "-"}`);
  } else {
    console.log(`seq ${r.seq} ${r.ts} ${r.kind} auth ${p.auth ?? "-"} per_call_cap ${p.mandate?.per_call_cap ?? "-"} approval_threshold ${p.mandate?.approval_threshold ?? "-"}`);
  }
}
console.log(`entries by kind ${[...kinds].map(([k, n]) => `${k}=${n}`).join(" ")}`);
console.log(`settled calls ${settles.length}, charged ${charged} micros = ${(charged / 1e6).toFixed(6)} USD`);

// Stream the model lock ledger line by line and keep only calls inside the settle
// window (first settle - 120 s to last settle + 120 s). An earlier version read only
// the last 4 MB, which no longer reached the window once the ledger grew.
const ml: { ts: string; prompt: number; completion: number; cached: number; cost: number; bucket: string; model: string }[] = [];
const firstTs = settles.length > 0 ? new Date(Date.parse(settles[0]!.ts) - 120_000).toISOString().slice(0, 19) : "";
const lastTs = settles.length > 0 ? new Date(Date.parse(settles[settles.length - 1]!.ts) + 120_000).toISOString().slice(0, 19) : "";
const rl = createInterface({ input: createReadStream(values.modellock!, { encoding: "utf8" }), crlfDelay: Infinity });
let mlLines = 0;
for await (const line of rl) {
  mlLines++;
  if (!line.includes('"event":"call"') || !line.includes("deepseek-v4.1-flash-1017")) continue;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  if (o.event !== "call" || o.model !== "deepseek/deepseek-v4.1-flash-1017") continue;
  const ts = String(o.ts).slice(0, 19);
  if (ts < firstTs || ts > lastTs) continue;
  ml.push({ ts: o.ts, prompt: o.prompt_tokens, completion: o.completion_tokens, cached: o.cached_tokens, cost: o.cost_usd, bucket: o.bucket, model: o.model });
}
console.log(`modellock streamed ${mlLines} lines, window ${firstTs}Z to ${lastTs}Z`);
let matched = 0;
let mlCost = 0;
const used = new Set<number>();
for (const s of settles) {
  const i = ml.findIndex(
    (m, idx) => !used.has(idx) && m.prompt === s.usage.input_tokens && m.completion === s.usage.output_tokens && m.cached === s.usage.cached_input_tokens,
  );
  if (i >= 0) {
    used.add(i);
    matched++;
    mlCost += ml[i]!.cost;
    console.log(`  match seq ${s.seq} -> modellock ${ml[i]!.ts} bucket ${ml[i]!.bucket} cost_usd ${ml[i]!.cost}`);
  } else {
    console.log(`  NO MATCH seq ${s.seq}`);
  }
}
console.log(`modellock ds1017 calls in window ${ml.length}, matched ${matched} of ${settles.length} settles, modellock cost of matched ${mlCost.toFixed(6)} USD`);
