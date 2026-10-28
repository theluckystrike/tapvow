import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { sha256Hex } from "@mandate/core";
import { ExitError, readJson, resolveHome, writeAtomic, writeExclusive } from "./home.js";
import { runInit } from "./init.js";
import { startGateway } from "./server.js";
import { buildPack, isCanonicalPackText, verifyLive, verifyPack, type ReceiptPack, type TrustedKeys } from "./pack.js";
import { buildPdf, pdfLinesForPack } from "./pdf.js";

const VERSION = "0.1.0";
const DEFAULT_PORT = 47821;

const USAGE = `tapvow - one signed spending limit for every AI agent

Usage:
  tapvow init [options]
  tapvow start [options]
  tapvow export --out <file.json> [--pdf <file.pdf>] [--home <dir>] [--force]
  tapvow verify <pack.json> [--keys <public-keys.json>] [--trust-pack-keys] [--home <dir>]
  tapvow verify --live [--home <dir>]

Common options:
  --home <dir>          home directory (default TAPVOW_HOME or ~/.tapvow)
  --help                show this help

init options:
  --budget <usd>        budget total (default 5.00)
  --period <p>          day, month or lifetime (default day)
  --per-call-cap <usd>  per-call cap (default 2.00, or the budget when it is lower;
                        a fresh Claude Code call reserves about 0.52)
  --days <n>            validity in days (default 30)
  --port <n>            gateway port written into the client files (default ${DEFAULT_PORT})
  --apply               also merge the env entries into the Claude Code settings file

start options:
  --host <host>         bind host (default from config)
  --port <n>            bind port (default from config); 0 picks a free port
  --fake-upstream       run against an in-process fake provider, no real key needed
  --adopt-head=<seq>    adopt a pre-existing ledger with no signed head file; <seq> must equal
                        the current ledger head seq (only for a home that never had head files)
  --openai-base-url <url>     override the OpenAI upstream
  --anthropic-base-url <url>  override the Anthropic upstream

export options:
  --force               overwrite an existing --out or --pdf file

verify options:
  --keys <file>         pin the trusted public keys from a file
  --trust-pack-keys     use the keys from the pack itself (consistency only, not identity)
  --live                verify the home's live database against its signed head files
`;

const OPTIONS = {
  home: { type: "string" },
  budget: { type: "string", default: "5.00" },
  period: { type: "string", default: "day" },
  "per-call-cap": { type: "string" },
  days: { type: "string", default: "30" },
  port: { type: "string" },
  apply: { type: "boolean", default: false },
  host: { type: "string" },
  "fake-upstream": { type: "boolean", default: false },
  "adopt-head": { type: "string" },
  "openai-base-url": { type: "string" },
  "anthropic-base-url": { type: "string" },
  out: { type: "string" },
  pdf: { type: "string" },
  force: { type: "boolean", default: false },
  keys: { type: "string" },
  "trust-pack-keys": { type: "boolean", default: false },
  live: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
  version: { type: "boolean", default: false },
} as const;

function intFlag(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ExitError(2, `${name} must be a non-negative integer`);
  return n;
}

function portFlag(raw: string, allowZero: boolean): number {
  const n = Number(raw);
  const min = allowZero ? 0 : 1;
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > 65535) {
    throw new ExitError(2, `port must be an integer from ${min} to 65535`);
  }
  return n;
}

/** 2.00 USD, or the budget when the budget is lower, so `init --budget 1` works. */
function defaultPerCallCap(budget: string): string {
  const n = Number(budget);
  return Number.isFinite(n) && n > 0 && n < 2 ? budget : "2.00";
}

function fingerprint(key: string): string {
  return sha256Hex(key).slice(0, 16);
}

function writeOut(path: string, data: string | Buffer, force: boolean): void {
  if (force) {
    writeAtomic(path, data, 0o644);
    return;
  }
  try {
    writeExclusive(path, data, 0o644);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ExitError(2, `${path} exists`);
    }
    throw err;
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return positionals.length === 0 && !values.help ? 2 : 0;
  }

  const command = positionals[0];
  const home = resolveHome(values.home);

  if (command === "init") {
    const period = values.period;
    if (period !== "day" && period !== "month" && period !== "lifetime") {
      throw new ExitError(2, "period must be day, month or lifetime");
    }
    runInit({
      home,
      budget: values.budget,
      period,
      perCallCap: values["per-call-cap"] ?? defaultPerCallCap(values.budget),
      days: intFlag(values.days, "days"),
      port: values.port === undefined ? DEFAULT_PORT : portFlag(values.port, false),
      apply: values.apply,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    return 0;
  }

  if (command === "start") {
    if (
      typeof values.host === "string" &&
      values.host.length > 0 &&
      values.host !== "127.0.0.1" &&
      values.host !== "::1" &&
      values.host !== "localhost"
    ) {
      process.stderr.write(
        `warning: --host ${values.host} binds to the network; the gateway and dashboard are then reachable from the network over plain HTTP\n`,
      );
    }
    const port = values.port === undefined ? undefined : portFlag(values.port, true);
    const running = await startGateway({
      home,
      host: values.host,
      port,
      fakeUpstream: values["fake-upstream"],
      openaiBaseUrl: values["openai-base-url"],
      anthropicBaseUrl: values["anthropic-base-url"],
      adoptHead: values["adopt-head"] === undefined ? undefined : intFlag(values["adopt-head"], "adopt-head"),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`TapVow gateway on ${running.url}\n`);
    process.stdout.write(`Dashboard ${running.dashboardUrl}\n`);
    const shutdown = (): void => {
      void running.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return new Promise<number>(() => {
      // stays alive until a signal closes the server
    });
  }

  if (command === "export") {
    if (!values.out) throw new ExitError(2, "export needs --out <file.json>");
    const pack = buildPack({ home });
    const json = JSON.stringify(pack, null, 2);
    writeOut(values.out, json, values.force);
    process.stdout.write(`wrote ${values.out}\n`);
    if (values.pdf) {
      const buf = buildPdf(pdfLinesForPack(pack, sha256Hex(json)));
      writeOut(values.pdf, buf, values.force);
      process.stdout.write(`wrote ${values.pdf}\n`);
    }
    return 0;
  }

  if (command === "verify") {
    if (values.live) {
      const result = verifyLive(home);
      if (!result.ok) {
        process.stdout.write(`FAIL ${result.reason}\n`);
        return 1;
      }
      const s = result.summary;
      process.stdout.write(
        `PASS live ledger anchored at seq ${s.anchoredSeq}, ${s.entries} entries, head seq ${s.headSeq}\n`,
      );
      return 0;
    }
    const packPath = positionals[1];
    if (!packPath) throw new ExitError(2, "verify needs a pack file (or --live)");
    const raw = readFileSync(packPath, "utf8");
    let pack: ReceiptPack;
    try {
      pack = JSON.parse(raw) as ReceiptPack;
    } catch {
      process.stdout.write(`FAIL ${packPath} is not valid JSON\n`);
      return 1;
    }
    if (!isCanonicalPackText(raw)) {
      process.stdout.write("FAIL the pack is not the canonical JSON form (duplicate keys or edited formatting)\n");
      return 1;
    }

    let trusted: TrustedKeys;
    let keySource: string;
    let pinned: boolean;
    const homeKeys = join(home, "public-keys.json");

    if (values["trust-pack-keys"]) {
      if (values.keys) throw new ExitError(2, "--trust-pack-keys cannot be combined with --keys");
      trusted = { issuer: pack.public_keys.issuer, ledger: pack.public_keys.ledger };
      keySource = "the pack keys (not pinned)";
      pinned = false;
    } else if (values.keys) {
      trusted = readJson<TrustedKeys>(values.keys);
      keySource = values.keys;
      pinned = true;
    } else if (existsSync(homeKeys)) {
      trusted = readJson<TrustedKeys>(homeKeys);
      keySource = homeKeys;
      pinned = true;
    } else {
      throw new ExitError(2, "no trusted keys; pass --keys, use a home with public-keys.json, or --trust-pack-keys");
    }

    const result = verifyPack(pack, trusted);
    if (!result.ok) {
      process.stdout.write(`FAIL ${result.reason}\n`);
      return 1;
    }

    const s = result.summary;
    const mandate = pack.mandate.mandate;
    process.stdout.write(
      pinned
        ? `PASS (keys pinned from ${keySource})\n`
        : "CONSISTENT, keys NOT pinned, this does not show who made the pack\n",
    );
    process.stdout.write(`mandate ${mandate.id}\n`);
    process.stdout.write(`budget ${mandate.budget.total} USD per ${mandate.budget.period}\n`);
    process.stdout.write(`store ${pack.store_id}\n`);
    process.stdout.write(`key source ${keySource}\n`);
    process.stdout.write(`entries ${s.entries}, head seq ${s.head_seq} ${s.head_hash.slice(0, 12)}\n`);
    process.stdout.write(
      `settled ${(s.settled_micros / 1_000_000).toFixed(6)} USD, calls settled ${s.calls_settled}, ` +
        `denials logged ${s.calls_denied}, approvals ${s.approvals}\n`,
    );

    if (!pinned) {
      process.stdout.write(`issuer fingerprint ${fingerprint(pack.public_keys.issuer)}\n`);
      for (const [id, key] of Object.entries(pack.public_keys.ledger)) {
        process.stdout.write(`ledger key ${id} fingerprint ${fingerprint(key)}\n`);
      }
      if (existsSync(homeKeys)) {
        process.stdout.write("note: --trust-pack-keys uses the pack keys even though a home public-keys.json exists\n");
      }
      return 3;
    }
    return 0;
  }

  throw new ExitError(2, `unknown command: ${command}`);
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ExitError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.code);
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
