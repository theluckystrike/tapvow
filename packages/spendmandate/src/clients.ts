import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NEBIUS_DEFAULT_MODEL, NEBIUS_MODELS } from "@mandate/llm-rail";
import { ensureDir, writeAtomic, writeExclusive } from "./home.js";

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function openaiEnv(port: number, key: string): string {
  return `export OPENAI_BASE_URL=${base(port)}/v1\nexport OPENAI_API_KEY=${key}\n`;
}

/**
 * The OpenAI SDK, LangChain or any chat completions client pointed at the
 * gateway, with a Nemotron model on Nebius Token Factory as the default. The
 * real Nebius key stays with the gateway; this file holds the virtual key.
 */
export function nebiusEnv(port: number, key: string): string {
  return [
    `export OPENAI_BASE_URL=${base(port)}/v1`,
    `export OPENAI_API_KEY=${key}`,
    `export TAPVOW_MODEL=${NEBIUS_DEFAULT_MODEL}`,
    "",
  ].join("\n");
}

/**
 * Claude Code sends max_tokens up to the model limit (128000 on the 5-series),
 * and the gateway reserves the worst case before each call. CLAUDE_CODE_MAX_OUTPUT_TOKENS
 * keeps that reservation near 0.50 USD on Sonnet 5.5 for a fresh session.
 */
export function claudeSettingsEnv(port: number, key: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: base(port),
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: "claude-sonnet-5-5",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
  };
}

export function claudeCodeEnv(port: number, key: string): string {
  const env = claudeSettingsEnv(port, key);
  return ["unset ANTHROPIC_API_KEY", ...Object.entries(env).map(([k, v]) => `export ${k}=${v}`), ""].join("\n");
}

export function claudeSettingsJson(port: number, key: string): string {
  return JSON.stringify({ env: claudeSettingsEnv(port, key) }, null, 2) + "\n";
}

/**
 * An OpenCode config file for OPENCODE_CONFIG. Anthropic models go through the
 * messages route. OpenAI models use an openai-compatible provider, because the
 * built-in openai provider calls the Responses API, which the gateway does not speak.
 */
export function opencodeJson(port: number, key: string, providers: readonly string[] = ["openai", "anthropic"]): string {
  const provider: Record<string, unknown> = {};
  if (providers.includes("anthropic")) {
    provider.anthropic = { options: { baseURL: `${base(port)}/v1`, apiKey: key } };
  }
  if (providers.includes("openai")) {
    provider["tapvow-openai"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "TapVow (OpenAI)",
      options: { baseURL: `${base(port)}/v1`, apiKey: key },
      models: { "gpt-4.1": {}, "gpt-4.1-mini": {}, "gpt-4o-mini": {} },
    };
  }
  if (providers.includes("nebius")) {
    // Nebius Token Factory speaks chat completions, so OpenCode reaches it
    // through the openai-compatible provider, like the OpenAI models above.
    provider["tapvow-nebius"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "TapVow (Nebius Token Factory)",
      options: { baseURL: `${base(port)}/v1`, apiKey: key },
      models: Object.fromEntries(NEBIUS_MODELS.map((m) => [m, {}])),
    };
  }
  const nebiusFirst = providers.includes("nebius") && !providers.includes("anthropic");
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: nebiusFirst ? `tapvow-nebius/${NEBIUS_DEFAULT_MODEL}` : "anthropic/claude-sonnet-5-5",
    small_model: nebiusFirst ? `tapvow-nebius/${NEBIUS_DEFAULT_MODEL}` : "anthropic/claude-haiku-4-5",
    provider,
  };
  return JSON.stringify(config, null, 2) + "\n";
}

export function opencodeEnv(path: string): string {
  return `export OPENCODE_CONFIG=${path}\n`;
}

export interface ApplyOutcome {
  status: "created" | "applied" | "unchanged" | "conflict" | "invalid";
  path: string;
  messages: string[];
  backup?: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupPath(target: string): string {
  const base0 = `${target}.tapvow-backup-${stamp()}`;
  if (!existsSync(base0)) return base0;
  for (let i = 0; i < 100; i++) {
    const candidate = `${base0}-${i + 1}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find a free backup name for ${target}`);
}

const CLAUDE_CONFLICT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
];

/** ~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json when that is set. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (typeof dir === "string" && dir.length > 0) return join(dir, "settings.json");
  return join(homedir(), ".claude", "settings.json");
}

/**
 * A settings file may be a symlink. Writing next to the link path would replace
 * the link, so resolve it first and write the real file (the link stays).
 */
function resolveTarget(target: string): string {
  if (!existsSync(target)) return target;
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** Merges the TapVow env entries into the Claude Code settings file. */
export function applyClaude(port: number, key: string): ApplyOutcome {
  const target = resolveTarget(claudeSettingsPath());
  const env = claudeSettingsEnv(port, key);

  if (!existsSync(target)) {
    ensureDir(dirname(target), 0o700);
    writeAtomic(target, claudeSettingsJson(port, key), 0o600);
    return { status: "created", path: target, messages: [`created ${target}`] };
  }

  const original = readFileSync(target, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return {
      status: "invalid",
      path: target,
      messages: [`${target} is not valid JSON; skipped, merge clients/claude-code.settings.json by hand`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      status: "invalid",
      path: target,
      messages: [`${target} is not a JSON object; skipped, merge clients/claude-code.settings.json by hand`],
    };
  }

  const record = parsed as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(record, "env") &&
    (typeof record.env !== "object" || record.env === null || Array.isArray(record.env))
  ) {
    return {
      status: "invalid",
      path: target,
      messages: [`${target} has a non-object "env"; skipped, merge clients/claude-code.settings.json by hand`],
    };
  }
  const existingEnv = (record.env ?? {}) as Record<string, unknown>;
  const conflicts = CLAUDE_CONFLICT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(existingEnv, k));
  // apiKeyHelper output is sent as the API key and would replace the virtual key.
  if (Object.prototype.hasOwnProperty.call(record, "apiKeyHelper")) conflicts.push("apiKeyHelper");
  if (conflicts.length > 0) {
    return {
      status: "conflict",
      path: target,
      messages: [
        `${target} already sets ${conflicts.join(", ")}; not changed, merge clients/claude-code.settings.json by hand`,
      ],
    };
  }

  const backup = backupPath(target);
  writeExclusive(backup, original, 0o600);
  const merged = { ...record, env: { ...existingEnv, ...env } };
  writeAtomic(target, JSON.stringify(merged, null, 2) + "\n", 0o600);
  return { status: "applied", path: target, backup, messages: [`updated ${target} (backup ${backup})`] };
}
