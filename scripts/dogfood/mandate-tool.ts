// Dogfood mandate tool. Creates and edits a passkey-signed mandate for the
// local dogfood gateway, using the software authenticator from
// @mandate/passkey/testing, because no browser is used in these runs.
//
//   node --import tsx scripts/dogfood/mandate-tool.ts init --data <dir>
//   node --import tsx scripts/dogfood/mandate-tool.ts edit --data <dir> --per-call-cap 0.005 --approval-threshold 0.005
//
// The software authenticator's P-256 key is kept in <data>/authenticator.json
// with mode 600, so later edits can be signed by the same credential. A real
// passkey would keep that key in hardware. Every file is written with an
// exclusive create or a rename, and the tool never reads or writes anything
// outside <data>.
import { existsSync, readFileSync, renameSync, chmodSync, openSync, writeSync, closeSync } from "node:fs";
import { createPrivateKey, randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { generateSigner, validateMandate, type Mandate } from "@mandate/core";
import { openGovernedRailWithPasskey, readStoreId } from "@mandate/llm-rail";
import { PasskeyRegistry, mandateHash, type PasskeySignedMandate, type TrustedCredential } from "@mandate/passkey";
import { SoftAuthenticator } from "@mandate/passkey/testing";

export const RP_ID = "localhost";
export const ORIGIN = "http://localhost";
export const ISSUER_ID = "michael";
export const AGENT_ID = "opencode";

interface StoredAuthenticator {
  credential_id: string;
  private_key_pkcs8: string;
  x: string;
  y: string;
  spki: string;
  counter: number;
  step: number;
}

interface StoredKey {
  key_id: string;
  public_key: string;
  private_key_pkcs8: string;
}

export interface DogfoodConfig {
  version: 1;
  audience: string;
  rp_id: string;
  origin: string;
  db: string;
  ledger_key_file: string;
  credential_file: string;
  mandate_file: string;
  agent_key_file: string;
  upstream_base_url: string;
  upstream_label: string;
  host: string;
  port: number;
  approval: "auto-deny";
}

function writeExclusive(path: string, data: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

function writeReplace(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeExclusive(tmp, data, mode);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function saveAuthenticator(path: string, auth: SoftAuthenticator, exclusive: boolean): void {
  const a = auth as unknown as {
    credentialId: string;
    privateKey: import("node:crypto").KeyObject;
    x: Buffer;
    y: Buffer;
    spki: Buffer;
    counter: number;
    step: number;
  };
  const stored: StoredAuthenticator = {
    credential_id: a.credentialId,
    private_key_pkcs8: a.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    x: a.x.toString("base64"),
    y: a.y.toString("base64"),
    spki: a.spki.toString("base64"),
    counter: a.counter,
    step: a.step,
  };
  const text = JSON.stringify(stored, null, 2) + "\n";
  if (exclusive) writeExclusive(path, text, 0o600);
  else writeReplace(path, text, 0o600);
}

function loadAuthenticator(path: string): SoftAuthenticator {
  const s = readJson<StoredAuthenticator>(path);
  const auth = Object.create(SoftAuthenticator.prototype) as Record<string, unknown>;
  auth.credentialId = s.credential_id;
  auth.privateKey = createPrivateKey({ key: Buffer.from(s.private_key_pkcs8, "base64"), format: "der", type: "pkcs8" });
  auth.x = Buffer.from(s.x, "base64");
  auth.y = Buffer.from(s.y, "base64");
  auth.spki = Buffer.from(s.spki, "base64");
  auth.counter = s.counter;
  auth.step = s.step;
  return auth as unknown as SoftAuthenticator;
}

function usd(raw: string, name: string): string {
  if (!/^\d+\.\d{2,6}$/.test(raw)) throw new Error(`${name} must look like 0.10`);
  return raw;
}

async function signVersion(
  data: string,
  cfg: DogfoodConfig,
  mandate: Mandate,
  prevHash: string | null,
): Promise<PasskeySignedMandate> {
  const regDb = new DatabaseSync(join(data, "registry.sqlite"));
  try {
    const registry = new PasskeyRegistry(regDb, { rpID: cfg.rp_id, rpName: "TapVow dogfood", origin: cfg.origin, audience: cfg.audience });
    registry.init();
    const auth = loadAuthenticator(join(data, "authenticator.json"));
    const { challenge, nonce, audience, expires_at } = await registry.beginEdit({ issuerId: ISSUER_ID, mandate, prevHash });
    const assertion = auth.getAssertion(challenge, { origin: cfg.origin, rpID: cfg.rp_id });
    saveAuthenticator(join(data, "authenticator.json"), auth, false);
    const doc: PasskeySignedMandate = { format: "passkey-v1", mandate, prev_hash: prevHash, nonce, audience, expires_at, assertion };
    const result = await registry.finishEdit(doc);
    if (!result.ok) throw new Error(`registry refused the edit: ${result.reason}`);
    return doc;
  } finally {
    regDb.close();
  }
}

/** Opens the rail once with the document, which registers it in the signed ledger. */
async function registerOnGateway(data: string, cfg: DogfoodConfig, doc: PasskeySignedMandate, issueKey: boolean): Promise<string | null> {
  const ledgerKey = readJson<StoredKey>(cfg.ledger_key_file);
  const credential = readJson<TrustedCredential>(cfg.credential_file);
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
  try {
    return issueKey ? rail.issueAgentKey(AGENT_ID) : null;
  } finally {
    rail.close();
  }
}

async function init(data: string, port: number, upstream: string, label: string): Promise<void> {
  if (existsSync(join(data, "config.json"))) throw new Error(`${data} already holds a dogfood config; nothing changed`);
  const audience = `tapvow-dogfood-${randomBytes(6).toString("hex")}`;
  const cfg: DogfoodConfig = {
    version: 1,
    audience,
    rp_id: RP_ID,
    origin: ORIGIN,
    db: join(data, "gateway.db"),
    ledger_key_file: join(data, "ledger-key.json"),
    credential_file: join(data, "credential.json"),
    mandate_file: join(data, "mandate.current.json"),
    agent_key_file: join(data, "opencode.key"),
    upstream_base_url: upstream,
    upstream_label: label,
    host: "127.0.0.1",
    port,
    approval: "auto-deny",
  };

  // Ledger key (the gateway's own signing key) and the public keys a verifier pins.
  const ledger = generateSigner("dogfood-ledger-1");
  writeExclusive(
    cfg.ledger_key_file,
    JSON.stringify(
      {
        key_id: ledger.signer.keyId,
        public_key: ledger.publicKey,
        private_key_pkcs8: ledger.signer.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      },
      null,
      2,
    ) + "\n",
    0o600,
  );

  // Passkey registration through the registry and the software authenticator.
  const regDb = new DatabaseSync(join(data, "registry.sqlite"));
  let credential: TrustedCredential;
  try {
    const registry = new PasskeyRegistry(regDb, { rpID: RP_ID, rpName: "TapVow dogfood", origin: ORIGIN, audience });
    registry.init();
    const auth = new SoftAuthenticator();
    const options = await registry.beginRegistration(ISSUER_ID, "michael");
    const response = auth.createCredential(options, { origin: ORIGIN });
    credential = await registry.finishRegistration(ISSUER_ID, response);
    saveAuthenticator(join(data, "authenticator.json"), auth, true);
  } finally {
    regDb.close();
  }
  writeExclusive(cfg.credential_file, JSON.stringify(credential, null, 2) + "\n", 0o644);

  // The issuer field needs a public key; the owner's Ed25519 key is made here
  // and only its public half is kept. Edits are authorised by the passkey only.
  const owner = generateSigner("michael");
  writeExclusive(
    join(data, "public-keys.json"),
    JSON.stringify({ issuer: owner.publicKey, ledger: { [ledger.signer.keyId]: ledger.publicKey }, passkey_credential: credential.id }, null, 2) + "\n",
    0o644,
  );

  const storeId = readStoreId(cfg.db);
  const now = new Date();
  const iso = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");
  const mandate: Mandate = {
    mandate_version: "0.1",
    type: "IntentMandate",
    id: `mdt_dogfood_${randomBytes(6).toString("hex")}`,
    issuer: { id: ISSUER_ID, public_key: owner.publicKey },
    agents: [AGENT_ID],
    natural_language_description:
      "OpenCode workers on Michael's Mac may buy DeepSeek V4.1 Flash inference through the local model lock, within this budget.",
    currency: "USD",
    budget: { total: "3.00", period: "day" },
    per_call_cap: "0.10",
    allowed_payees: [{ rail: "llm", id: "openai" }],
    rate_limit: { max_calls: 120, window_seconds: 60 },
    approval_threshold: "0.05",
    rails: ["llm"],
    not_before: iso(new Date(now.getTime() - 60_000)),
    expires_at: iso(new Date(now.getTime() + 14 * 86_400_000)),
    created_at: iso(now),
    store_id: storeId,
  };
  const checked = validateMandate(mandate);
  if (!checked.ok) throw new Error(`invalid mandate: ${checked.errors.join("; ")}`);

  writeExclusive(join(data, "config.json"), JSON.stringify(cfg, null, 2) + "\n", 0o600);
  const doc = await signVersion(data, cfg, mandate, null);
  writeExclusive(join(data, "mandate.v1.json"), JSON.stringify(doc, null, 2) + "\n", 0o644);
  writeExclusive(cfg.mandate_file, JSON.stringify(doc, null, 2) + "\n", 0o644);
  const key = await registerOnGateway(data, cfg, doc, true);
  writeExclusive(cfg.agent_key_file, key!, 0o600);

  console.log(`mandate ${mandate.id} v1 signed with passkey credential ${credential.id.slice(0, 12)}`);
  console.log(`budget ${mandate.budget.total} USD per ${mandate.budget.period}, per-call cap ${mandate.per_call_cap}, approval threshold ${mandate.approval_threshold} (auto-deny)`);
  console.log(`store ${storeId}, audience ${audience}`);
}

async function edit(data: string, perCallCap: string, threshold: string): Promise<void> {
  const cfg = readJson<DogfoodConfig>(join(data, "config.json"));
  const current = readJson<PasskeySignedMandate>(cfg.mandate_file);
  const prevHash = mandateHash(current.mandate);
  const next: Mandate = {
    ...current.mandate,
    per_call_cap: usd(perCallCap, "per-call-cap"),
    approval_threshold: usd(threshold, "approval-threshold"),
    // The gateway refuses a changed mandate that is not newer, so each edit
    // carries a fresh created_at.
    created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  const checked = validateMandate(next);
  if (!checked.ok) throw new Error(`invalid mandate: ${checked.errors.join("; ")}`);
  const doc = await signVersion(data, cfg, next, prevHash);
  let n = 2;
  while (existsSync(join(data, `mandate.v${n}.json`)) || existsSync(join(data, `mandate.v${n}-rejected-same-created_at.json`))) n++;
  writeExclusive(join(data, `mandate.v${n}.json`), JSON.stringify(doc, null, 2) + "\n", 0o644);
  await registerOnGateway(data, cfg, doc, false);
  writeReplace(cfg.mandate_file, JSON.stringify(doc, null, 2) + "\n", 0o644);
  console.log(`mandate ${next.id} v${n} signed and registered, per-call cap ${next.per_call_cap}, approval threshold ${next.approval_threshold}`);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    data: { type: "string" },
    port: { type: "string", default: "47831" },
    upstream: { type: "string", default: "http://127.0.0.1:8788" },
    label: { type: "string", default: "tapvow-dogfood" },
    "per-call-cap": { type: "string" },
    "approval-threshold": { type: "string" },
  },
});
if (!values.data) throw new Error("--data <dir> is required");
const cmd = positionals[0];
if (cmd === "init") await init(values.data, Number(values.port), values.upstream!, values.label!);
else if (cmd === "edit") await edit(values.data, values["per-call-cap"] ?? "", values["approval-threshold"] ?? "");
else throw new Error("usage: mandate-tool.ts init|edit --data <dir>");
