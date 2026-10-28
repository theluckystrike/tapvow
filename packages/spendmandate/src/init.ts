import { existsSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { generateSigner, signMandate, validateMandate, type Mandate, type SignedMandate } from "@mandate/core";
import { openGovernedRail, readStoreId } from "@mandate/llm-rail";
import {
  applyClaude,
  claudeCodeEnv,
  claudeSettingsJson,
  nebiusEnv,
  openaiEnv,
  opencodeEnv,
  opencodeJson,
  type ApplyOutcome,
} from "./clients.js";
import { ensureDir, ExitError, nowIso, randomMandateId, randomToken, writeExclusive } from "./home.js";

export const AGENTS = ["claude-code", "opencode", "openai-client"] as const;

/** LLM providers a mandate can allow. The default keeps the two original ones. */
export const PROVIDERS = ["openai", "anthropic", "nebius"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const DEFAULT_PROVIDERS: readonly ProviderName[] = ["openai", "anthropic"];

/** Parses --provider: a comma list of openai, anthropic and nebius, or "all". */
export function parseProviders(raw: string | undefined): ProviderName[] {
  if (raw === undefined) return [...DEFAULT_PROVIDERS];
  const names = raw === "all" ? [...PROVIDERS] : raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (names.length === 0) throw new ExitError(2, "--provider needs at least one of openai, anthropic, nebius");
  const out: ProviderName[] = [];
  for (const name of names) {
    if (!(PROVIDERS as readonly string[]).includes(name)) {
      throw new ExitError(2, `unknown provider ${name}; use openai, anthropic, nebius or all`);
    }
    if (!out.includes(name as ProviderName)) out.push(name as ProviderName);
  }
  return out;
}

const UPSTREAM_DEFAULTS: Record<ProviderName, { base_url: string; api_key_env: string }> = {
  openai: { base_url: "https://api.openai.com", api_key_env: "OPENAI_API_KEY" },
  anthropic: { base_url: "https://api.anthropic.com", api_key_env: "ANTHROPIC_API_KEY" },
  nebius: { base_url: "https://api.tokenfactory.nebius.com", api_key_env: "NEBIUS_API_KEY" },
};

export interface InitOptions {
  home: string;
  budget: string;
  period: "day" | "month" | "lifetime";
  perCallCap: string;
  days: number;
  port: number;
  apply: boolean;
  /** Providers the mandate allows. Default openai and anthropic. */
  providers?: readonly ProviderName[];
  log: (line: string) => void;
}

export interface InitResult {
  home: string;
  mandateId: string;
  storeId: string;
  budget: string;
  period: string;
  port: number;
  providers: ProviderName[];
  clientFiles: string[];
  applied: ApplyOutcome[];
}

interface StoredKey {
  key_id: string;
  public_key: string;
  private_key_pkcs8: string;
}

function keyFile(signer: { keyId: string; privateKey: import("node:crypto").KeyObject }, publicKey: string): string {
  const stored: StoredKey = {
    key_id: signer.keyId,
    public_key: publicKey,
    private_key_pkcs8: signer.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
  return JSON.stringify(stored, null, 2) + "\n";
}

/** Provider key names that, if left in the shell, a client may send to the gateway base URL. */
function warnAboutRealKeys(log: (line: string) => void): void {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NEBIUS_API_KEY"]) {
    if (typeof process.env[name] === "string" && process.env[name]!.length > 0) {
      log(
        `warning: ${name} is set in this shell; a real provider key may be sent to the gateway base URL. ` +
          `Unset it in shells that use the gateway.`,
      );
    }
  }
}

/**
 * The lines a user pastes next. Each env file holds a virtual key for this
 * gateway only, so the lines name the files instead of printing the keys.
 */
export function nextSteps(home: string, providers: readonly ProviderName[] = DEFAULT_PROVIDERS): string[] {
  const c = (name: string) => join(home, "clients", name);
  const keyVars = (["anthropic", "openai", "nebius"] as const)
    .filter((p) => providers.includes(p))
    .map((p) => `${UPSTREAM_DEFAULTS[p].api_key_env}=<your key>`)
    .join(" ");
  const nebiusLines = providers.includes("nebius")
    ? [
        `   Nebius Token Factory (OpenAI SDK, LangChain, your own agents):  source ${c("nebius.env")}`,
        "                 (sets OPENAI_BASE_URL, OPENAI_API_KEY and TAPVOW_MODEL to a Nemotron model)",
        "   OpenCode on Nemotron:  source " + c("opencode.env") + " and pick a tapvow-nebius/* model",
      ]
    : [];
  if (!providers.includes("anthropic")) {
    return [
      "",
      "Next steps",
      "1. Start the gateway in its own terminal. It reads your real keys from its own environment.",
      `   ${keyVars} npx tapvow start`,
      "   (npx tapvow start --fake-upstream tries it with no key and no spend)",
      "2. In the shell where your agent runs, paste the line for your agent.",
      ...nebiusLines,
      `   OpenCode:     source ${c("opencode.env")}`,
      `   OpenAI SDK:   source ${c("openai.env")}`,
      "3. Watch spend at the dashboard link that start prints. A call over the cap gets HTTP 402.",
    ];
  }
  return [
    "",
    "Next steps",
    "1. Start the gateway in its own terminal. It reads your real keys from its own environment.",
    `   ${keyVars} npx tapvow start`,
    "   (npx tapvow start --fake-upstream tries it with no key and no spend)",
    "2. In the shell where your agent runs, paste the line for your agent.",
    ...nebiusLines,
    `   Claude Code:  source ${c("claude-code.env")}`,
    "                 (sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL,",
    "                 ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_MAX_OUTPUT_TOKENS; init --apply writes them",
    "                 into the Claude Code settings file instead)",
    `   OpenCode:     source ${c("opencode.env")}`,
    "                 (sets OPENCODE_CONFIG; use anthropic/* models or tapvow-openai/*)",
    `   OpenAI SDK, LangChain, your own agents:  source ${c("openai.env")}`,
    "                 (sets OPENAI_BASE_URL and OPENAI_API_KEY)",
    "   Codex:        not supported yet. Codex now calls only the OpenAI Responses API,",
    "                 and this gateway speaks chat completions and Anthropic messages.",
    "3. Watch spend at the dashboard link that start prints. A call over the cap gets HTTP 402.",
  ];
}

export function runInit(opts: InitOptions): InitResult {
  const home = opts.home;

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new ExitError(2, "port must be an integer from 1 to 65535");
  }

  const providers: ProviderName[] = [...(opts.providers ?? DEFAULT_PROVIDERS)];
  if (providers.length === 0) throw new ExitError(2, "at least one provider is needed");

  const configPath = join(home, "config.json");
  if (existsSync(home)) {
    const isDir = statSync(home).isDirectory();
    if (isDir && existsSync(configPath)) {
      throw new ExitError(2, `already initialized at ${home}; nothing was changed`);
    }
    if (!isDir || readdirSync(home).length > 0) {
      throw new ExitError(2, `${home} exists, is not empty and is not a TapVow home`);
    }
  }

  // Build everything in a sibling directory, then move it into place with one
  // rename, so a failure never leaves a half-built home behind.
  const temp = `${home}.init-${randomBytes(6).toString("hex")}`;
  const clientFiles = [
    join(home, "clients", "openai.env"),
    join(home, "clients", "claude-code.env"),
    join(home, "clients", "claude-code.settings.json"),
    join(home, "clients", "opencode.json"),
    join(home, "clients", "opencode.env"),
  ];
  if (providers.includes("nebius")) clientFiles.push(join(home, "clients", "nebius.env"));
  let mandate: Mandate;
  let storeId: string;
  let claudeKey = "";
  let opencodeKey = "";
  let openaiKey = "";

  try {
    ensureDir(temp, 0o700);

    const owner = generateSigner("owner");
    const ledger = generateSigner("ledger-1");

    // The store id lives in the database and does not depend on the path, so it
    // is read from the temporary database and survives the rename.
    storeId = readStoreId(join(temp, "ledger.db"));

    const created = nowIso();
    const expires = nowIso(new Date(Date.now() + opts.days * 86_400_000));
    mandate = {
      mandate_version: "0.1",
      type: "IntentMandate",
      id: randomMandateId(),
      issuer: { id: "owner", public_key: owner.publicKey },
      agents: [...AGENTS],
      natural_language_description: "Local agents may buy model inference within this budget.",
      currency: "USD",
      budget: { total: opts.budget, period: opts.period },
      per_call_cap: opts.perCallCap,
      allowed_payees: providers.map((id) => ({ rail: "llm" as const, id })),
      rate_limit: { max_calls: 120, window_seconds: 60 },
      approval_threshold: opts.perCallCap,
      rails: ["llm"],
      not_before: created,
      expires_at: expires,
      created_at: created,
      store_id: storeId,
    };
    const checked = validateMandate(mandate);
    if (!checked.ok) throw new ExitError(2, `invalid mandate: ${checked.errors.join("; ")}`);

    writeExclusive(join(temp, "owner-key.json"), keyFile(owner.signer, owner.publicKey), 0o600);
    writeExclusive(join(temp, "ledger-key.json"), keyFile(ledger.signer, ledger.publicKey), 0o600);
    writeExclusive(
      join(temp, "public-keys.json"),
      JSON.stringify({ issuer: owner.publicKey, ledger: { [ledger.signer.keyId]: ledger.publicKey } }, null, 2) + "\n",
      0o644,
    );

    const signed: SignedMandate = signMandate(mandate, owner.signer);
    writeExclusive(join(temp, "mandate.signed.json"), JSON.stringify(signed, null, 2) + "\n", 0o644);

    ensureDir(join(temp, "heads"), 0o700);
    // A marker that this home has published signed head files at least once, so
    // --adopt-head can never be used to wave away a missing head on a home that
    // had one, and to point the owner at a backup instead.
    writeExclusive(join(temp, "heads", ".anchored"), "spendmandate-heads/v1\n", 0o600);
    const rail = openGovernedRail({
      dbPath: join(temp, "ledger.db"),
      signedMandate: signed,
      trustedIssuerKey: owner.publicKey,
      ledgerSigner: ledger.signer,
      requireStoreBinding: true,
      // Publish the signed head outside the database from the very first start,
      // so a fresh home needs no --adopt-head.
      headFiles: [join(temp, "ledger.head.json"), join(temp, "heads", "ledger.head.json")],
    });
    const keys = new Map<string, string>();
    try {
      for (const agent of AGENTS) keys.set(agent, rail.issueAgentKey(agent));
    } finally {
      rail.close();
    }

    // Every path written into config.json is the final home path, not the temp one.
    const config = {
      version: 1,
      host: "127.0.0.1",
      port: opts.port,
      db: join(home, "ledger.db"),
      mandate_file: join(home, "mandate.signed.json"),
      owner_public_key: owner.publicKey,
      ledger_key_file: join(home, "ledger-key.json"),
      dashboard_token: randomToken(),
      upstreams: Object.fromEntries(providers.map((p) => [p, UPSTREAM_DEFAULTS[p]])),
    };
    writeExclusive(join(temp, "config.json"), JSON.stringify(config, null, 2) + "\n", 0o600);

    ensureDir(join(temp, "clients"), 0o700);
    claudeKey = keys.get("claude-code") ?? "";
    opencodeKey = keys.get("opencode") ?? "";
    openaiKey = keys.get("openai-client") ?? "";
    writeExclusive(join(temp, "clients", "openai.env"), openaiEnv(opts.port, openaiKey), 0o600);
    writeExclusive(join(temp, "clients", "claude-code.env"), claudeCodeEnv(opts.port, claudeKey), 0o600);
    writeExclusive(join(temp, "clients", "claude-code.settings.json"), claudeSettingsJson(opts.port, claudeKey), 0o600);
    writeExclusive(join(temp, "clients", "opencode.json"), opencodeJson(opts.port, opencodeKey, providers), 0o600);
    if (providers.includes("nebius")) {
      writeExclusive(join(temp, "clients", "nebius.env"), nebiusEnv(opts.port, openaiKey), 0o600);
    }
    writeExclusive(join(temp, "clients", "opencode.env"), opencodeEnv(join(home, "clients", "opencode.json")), 0o600);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }

  // Remove an empty leftover directory, then publish the built home.
  if (existsSync(home)) rmdirSync(home);
  renameSync(temp, home);

  // The --apply steps touch files outside the home, so they run only after the
  // home is fully in place.
  const applied: ApplyOutcome[] = [];
  if (opts.apply) applied.push(applyClaude(opts.port, claudeKey));

  warnAboutRealKeys(opts.log);

  opts.log("TapVow initialized");
  opts.log(`home: ${home}`);
  opts.log(`mandate: ${mandate.id}`);
  opts.log(`budget: ${opts.budget} USD per ${opts.period}`);
  opts.log(`providers: ${providers.join(", ")}`);
  opts.log(`store id: ${storeId}`);
  opts.log(`client files: ${clientFiles.join(", ")}`);
  for (const a of applied) for (const m of a.messages) opts.log(m);
  for (const line of nextSteps(home, providers)) opts.log(line);

  return {
    home,
    mandateId: mandate.id,
    storeId,
    budget: opts.budget,
    period: opts.period,
    port: opts.port,
    providers,
    clientFiles,
    applied,
  };
}
