import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startFakeUpstream, NEBIUS_DEFAULT_MODEL } from "@mandate/llm-rail";
import { buildPack, verifyPack, type TrustedKeys } from "../src/pack.js";
import { parseProviders, runInit } from "../src/init.js";
import { startGateway } from "../src/server.js";
import { cleanupTmp, envValue, tmp } from "./helpers.js";
// Never let a test reach the owner's real Claude Code or Codex config.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.TAPVOW_HOME;
delete process.env.SPENDMANDATE_HOME;

after(() => cleanupTmp());

const distCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args: string[], home: string, env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  const clean = { ...process.env };
  delete clean.NEBIUS_API_KEY;
  delete clean.OPENAI_API_KEY;
  delete clean.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [distCli, ...args], { encoding: "utf8", env: { ...clean, HOME: home, ...env } });
}

test("nebius cli 1: init --provider nebius allows only Nebius, writes nebius.env and an OpenCode provider, and prints no key", () => {
  const root = tmp();
  const home = join(root, "home");
  const init = run(["init", "--home", home, "--provider", "nebius", "--budget", "0.05", "--port", "47990"], root);
  assert.equal(init.status, 0, String(init.stderr));
  const out = String(init.stdout);
  assert.match(out, /providers: nebius/);
  assert.match(out, /NEBIUS_API_KEY=<your key> npx tapvow start/);
  assert.match(out, /source .*nebius\.env/);
  assert.match(out, /OpenCode: {5}source .*opencode\.env/);
  assert.doesNotMatch(out, /Claude Code: /, "no Claude Code line when Anthropic is not allowed");
  assert.doesNotMatch(out, /mk_/, "virtual keys stay in the 0600 client files");

  const signed = JSON.parse(readFileSync(join(home, "mandate.signed.json"), "utf8"));
  assert.deepEqual(signed.mandate.allowed_payees, [{ rail: "llm", id: "nebius" }]);
  assert.equal(signed.mandate.budget.total, "0.05");

  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(cfg.upstreams, {
    nebius: { base_url: "https://api.tokenfactory.nebius.com", api_key_env: "NEBIUS_API_KEY" },
  });

  const envFile = join(home, "clients", "nebius.env");
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(envValue(envFile, "OPENAI_BASE_URL"), "http://127.0.0.1:47990/v1");
  assert.match(envValue(envFile, "OPENAI_API_KEY") ?? "", /^mk_/);
  assert.equal(envValue(envFile, "TAPVOW_MODEL"), NEBIUS_DEFAULT_MODEL);

  const oc = JSON.parse(readFileSync(join(home, "clients", "opencode.json"), "utf8"));
  assert.equal(oc.model, `tapvow-nebius/${NEBIUS_DEFAULT_MODEL}`);
  assert.equal(oc.provider["tapvow-nebius"].options.baseURL, "http://127.0.0.1:47990/v1");
  assert.ok(Object.keys(oc.provider["tapvow-nebius"].models).includes(NEBIUS_DEFAULT_MODEL));
  assert.equal(oc.provider.anthropic, undefined);
  console.log("# nebius cli 1: PASS");
});

test("nebius cli 2: the default init is unchanged, all adds nebius, and an unknown provider exits 2", () => {
  const root = tmp();
  const plain = join(root, "plain");
  assert.equal(run(["init", "--home", plain], root).status, 0);
  const signed = JSON.parse(readFileSync(join(plain, "mandate.signed.json"), "utf8"));
  assert.deepEqual(signed.mandate.allowed_payees, [
    { rail: "llm", id: "openai" },
    { rail: "llm", id: "anthropic" },
  ]);
  assert.equal(existsSync(join(plain, "clients", "nebius.env")), false);

  assert.deepEqual(parseProviders("all"), ["openai", "anthropic", "nebius"]);
  assert.deepEqual(parseProviders("nebius, anthropic,nebius"), ["nebius", "anthropic"]);
  const bad = run(["init", "--home", join(root, "bad"), "--provider", "nebius,acme"], root);
  assert.equal(bad.status, 2);
  assert.match(String(bad.stderr), /unknown provider acme/);
  assert.equal(existsSync(join(root, "bad")), false, "nothing is written on a bad flag");
});

test("nebius cli 3: start sends a Nemotron call to the Nebius upstream with NEBIUS_API_KEY, refuses at the cap, and the pack verifies", async () => {
  const root = tmp();
  const home = join(root, "home");
  runInit({
    home,
    budget: "0.01",
    period: "day",
    perCallCap: "0.01",
    days: 30,
    port: 8787,
    apply: false,
    providers: ["nebius"],
    log: () => {},
  });
  const fake = await startFakeUpstream({ latencyMs: [1, 3], completion: "max" });
  const saved = process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_API_KEY = "nebius-fake-key-NOT-REAL";
  const running = await startGateway({ home, host: "127.0.0.1", port: 0, nebiusBaseUrl: fake.url });
  try {
    const key = envValue(join(home, "clients", "nebius.env"), "OPENAI_API_KEY");
    const model = envValue(join(home, "clients", "nebius.env"), "TAPVOW_MODEL");
    assert.ok(key && model);
    let ok = 0;
    let last: Response | null = null;
    for (let i = 0; i < 1000; i++) {
      last = await fetch(`${running.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: "user", content: `task ${i}` }] }),
      });
      if (last.status !== 200) break;
      await last.text();
      ok++;
    }
    assert.ok(ok >= 1, "at least one call fits the budget");
    assert.equal(last!.status, 402);
    const err = (await last!.json()) as { error: { code: string; message: string } };
    assert.equal(err.error.code, "budget_exceeded");
    assert.match(err.error.message, /The budget is 0\.010000 USD per day/);
    assert.equal(fake.requests.length, ok, "the refused call never reached the provider");
    assert.equal(fake.requests[0]!.headers.authorization, "Bearer nebius-fake-key-NOT-REAL");
  } finally {
    await running.close();
    await fake.close();
    if (saved === undefined) delete process.env.NEBIUS_API_KEY;
    else process.env.NEBIUS_API_KEY = saved;
  }
  const pack = buildPack({ home });
  const trusted = JSON.parse(readFileSync(join(home, "public-keys.json"), "utf8")) as TrustedKeys;
  const result = verifyPack(pack, trusted);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.ok(result.ok && result.summary.calls_denied >= 1);
  assert.ok(result.ok && result.summary.settled_micros <= 10_000, "settled spend stays under the 0.01 USD budget");
  console.log(`# nebius cli 3: PASS, ${result.ok ? result.summary.calls_settled : 0} calls settled then 402`);
});
