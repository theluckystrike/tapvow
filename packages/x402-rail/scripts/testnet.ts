// Real Base Sepolia payments through the TapVow gateway.
//
// It funds nothing itself: if the payer key file holds less than 0.01 USDC per payment the
// script stops before making any payment and tells the operator where to get
// Base Sepolia USDC. Otherwise it sends TESTNET_CALLS (default 3, at most 12) x 0.01 USDC payments to a paid
// resource through the CDP x402 facilitator (default; Ed25519 JWT per request) or the
// shared x402.org facilitator, waits for every receipt on Base Sepolia, and verifies the signed ledger.
//
// Run: npm run testnet
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, getAddress, decodeEventLog, erc20Abi, parseAbiItem, type Address, type Hex } from "viem";
import { generateSigner, signMandate, type Mandate, type SignedMandate } from "@mandate/core";
import { createGateway, openGovernedRail, type GovernedRail } from "@mandate/llm-rail";
import { checkPayment, median, parseX402Allowlist } from "@mandate/payee-guard";
import { createX402Rail } from "../src/rail.js";
import { startPaidResource, type PaidResource } from "../src/demo-server.js";
import { cdpFacilitatorAuth, loadCdpKey, CDP_FACILITATOR_URL } from "../src/cdp-auth.js";
import { loadAccountFromFile } from "../src/wallet.js";
import { BASE_SEPOLIA_USDC } from "../src/local-facilitator.js";
import type { PaymentGuard } from "../src/types.js";

const NETWORK = "eip155:84532";
const USDC = getAddress(BASE_SEPOLIA_USDC);
const RPC_URL = "https://sepolia.base.org";
// TESTNET_FACILITATOR=cdp (default) uses the Coinbase CDP facilitator with the
// CDP secret key in .secrets/cdp-api-key.json, signed as a per-request Ed25519
// JWT. x402org uses the public, shared x402.org facilitator.
const FACILITATOR = process.env.TESTNET_FACILITATOR ?? "cdp";
if (FACILITATOR !== "cdp" && FACILITATOR !== "x402org") throw new Error("TESTNET_FACILITATOR must be cdp or x402org");
const FACILITATOR_URL = FACILITATOR === "cdp" ? CDP_FACILITATOR_URL : "https://x402.org/facilitator";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRETS_DIR = process.env.TAPVOW_SECRETS_DIR ?? resolve(REPO_ROOT, "..", ".secrets");
const CDP_KEY_FILE = join(SECRETS_DIR, "cdp-api-key.json");
const PAYER_FILE = join(SECRETS_DIR, "base-sepolia-payer.json");
const PAYEE_FILE = join(SECRETS_DIR, "base-sepolia-payee.json");
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// One ledger file per run, so a run never reopens another run's mandate.
const LEDGER_DB = join(REPO_ROOT, ".data", `testnet-${RUN_ID}.db`);
// The run's ledger signing key is kept outside the repo (mode 600), so a later
// reconcile can append signed entries and anyone can re-verify the ledger.
const LEDGER_KEY_FILE = join(SECRETS_DIR, `testnet-ledger-${RUN_ID}.json`);
const PAYMENT_MICROS = 10_000n;
const CALL_COUNT = Number(process.env.TESTNET_CALLS ?? 3); // 1 to 12
if (!Number.isInteger(CALL_COUNT) || CALL_COUNT < 1 || CALL_COUNT > 12) throw new Error("TESTNET_CALLS must be 1 to 12");
const MIN_PAYMENT_MICROS = PAYMENT_MICROS * BigInt(CALL_COUNT);
// The public facilitator sends from one hot wallet and can collide on its own
// nonce when settles come back to back, so leave a gap between payments.
const GAP_MS = Number(process.env.TESTNET_GAP_MS ?? 0);
if (!Number.isInteger(GAP_MS) || GAP_MS < 0 || GAP_MS > 60000) throw new Error("TESTNET_GAP_MS must be 0 to 60000");
const DAY_MS = 86_400_000;

const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

function buildMandate(payee: Address, issuerPublicKey: string): Mandate {
  return {
    mandate_version: "0.1",
    type: "IntentMandate",
    id: "mdt_testnet_e2e_0001",
    issuer: { id: "testnet-issuer", public_key: issuerPublicKey },
    agents: ["agent-01"],
    natural_language_description: "Pay an allowlisted x402 resource within budget on Base Sepolia.",
    currency: "USD",
    budget: { total: "1.00", period: "lifetime" },
    per_call_cap: "0.05",
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "x402", id: `${NETWORK}:${payee}` },
    ],
    rate_limit: { max_calls: 1000, window_seconds: 60 },
    approval_threshold: "0.05",
    rails: ["llm", "x402"],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function postJson(baseUrl: string, path: string, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "content-length": String(payload.length) },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main(): Promise<number> {
  const payer = loadAccountFromFile(PAYER_FILE);
  const payee = loadAccountFromFile(PAYEE_FILE);
  const payeeAddress = getAddress(payee.address);

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const balance = (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payer.address],
  })) as bigint;

  if (balance < MIN_PAYMENT_MICROS) {
    console.log(
      `BLOCKED: payer ${payer.address} holds ${(Number(balance) / 1e6).toFixed(6)} USDC on Base Sepolia. Fund it at https://faucet.circle.com (Base Sepolia, USDC), then rerun.`,
    );
    return 3;
  }
  console.log(`testnet payer ${payer.address} holds ${(Number(balance) / 1e6).toFixed(6)} USDC on Base Sepolia`);

  let gateway: HttpServer | null = null;
  let resource: PaidResource | null = null;
  let rail: GovernedRail | null = null;
  const failures: string[] = [];

  try {
    const facilitatorAuth = FACILITATOR === "cdp" ? cdpFacilitatorAuth(loadCdpKey(CDP_KEY_FILE)) : null;
    resource = await startPaidResource({
      facilitatorUrl: FACILITATOR_URL,
      ...(facilitatorAuth ? { facilitatorAuth } : {}),
      network: NETWORK,
      payTo: payeeAddress,
      routes: [{ path: "/report", price: "$0.01", body: { report: "paid" } }],
    });

    const issuer = generateSigner("testnet-issuer");
    const mandate = buildMandate(payeeAddress, issuer.publicKey);
    const signed: SignedMandate = signMandate(mandate, issuer.signer);
    const ledgerSigner = generateSigner(`testnet-ledger-${RUN_ID}`);
    writeFileSync(
      LEDGER_KEY_FILE,
      JSON.stringify({
        key_id: ledgerSigner.signer.keyId,
        public_key: ledgerSigner.publicKey,
        private_key_pkcs8_b64: ledgerSigner.signer.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        ledger_db: LEDGER_DB,
      }),
      { mode: 0o600, flag: "wx" },
    );
    console.log(`testnet facilitator: ${FACILITATOR}`);
    console.log(`testnet ledger ${LEDGER_DB} key_id ${ledgerSigner.signer.keyId} public_key ${ledgerSigner.publicKey}`);

    mkdirSync(dirname(LEDGER_DB), { recursive: true });
    rail = openGovernedRail({
      dbPath: LEDGER_DB,
      signedMandate: signed,
      trustedIssuerKey: issuer.publicKey,
      ledgerSigner: ledgerSigner.signer,
    });
    const trusted = { [ledgerSigner.signer.keyId]: ledgerSigner.publicKey };

    const parsed = parseX402Allowlist(mandate.allowed_payees);
    if (!parsed.ok) throw new Error(`mandate x402 payees are invalid: ${parsed.errors.join("; ")}`);
    const guard: PaymentGuard = (ask) =>
      checkPayment(ask, {
        allowlist: parsed.allowlist,
        networks: [NETWORK],
        median30d: (payeeKey) => {
          const payTo = payeeKey.slice(payeeKey.lastIndexOf(":") + 1).toLowerCase();
          return median(rail!.store.settledAmounts(mandate.id, "x402", payTo, Date.now() - 30 * DAY_MS, { excludePriceBasis: "median_30d" }));
        },
      });

    const x402 = createX402Rail({ rail, account: payer, networks: [NETWORK], guard, allowPrivateNetwork: true });
    gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
    const gatewayPort = await listen(gateway);
    const key = rail.issueAgentKey("agent-01");
    const base = `http://127.0.0.1:${gatewayPort}`;

    for (let i = 1; i <= CALL_COUNT; i++) {
      if (i > 1 && GAP_MS > 0) await delay(GAP_MS);
      const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/report` });
      if (r.status !== 200) {
        failures.push(`payment ${i} failed: HTTP ${r.status} ${r.text}`);
        console.error(`testnet payment ${i}: HTTP ${r.status} ${r.text}`);
        break;
      }
      const txHash = String(r.headers["x-mandate-tx-hash"] ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        failures.push(`payment ${i} has no tx hash header`);
        break;
      }
      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 60_000 });
      } catch (err) {
        failures.push(`payment ${i} receipt ${txHash}: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`testnet payment ${i}: tx ${txHash} no receipt within 60 s`);
        break;
      }
      let transferOk = false;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== USDC) continue;
        try {
          const decoded = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
          if (
            getAddress(decoded.args.from) === getAddress(payer.address) &&
            getAddress(decoded.args.to) === payeeAddress &&
            decoded.args.value === PAYMENT_MICROS
          ) {
            transferOk = true;
          }
        } catch {
          // not a Transfer event from this contract
        }
      }
      if (receipt.status !== "success" || !transferOk) {
        failures.push(`payment ${i} tx ${txHash} status ${receipt.status}, transfer ${transferOk ? "ok" : "missing"}`);
        console.error(`testnet payment ${i}: tx ${txHash} status ${receipt.status} transfer ${transferOk ? "ok" : "missing"}`);
        break;
      }
      const paidSettles = rail.ledger.entries().filter((e) => e.kind === "x402.settle");
      const ledgerNonce = (paidSettles[paidSettles.length - 1]?.payload as { details?: { nonce?: string } } | undefined)?.details
        ?.nonce;
      if (typeof ledgerNonce !== "string" || ledgerNonce.length === 0) {
        failures.push(`payment ${i} has no x402.settle ledger nonce`);
        console.error(`testnet payment ${i}: no x402.settle ledger nonce`);
        break;
      }
      let authorizationOk = false;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== USDC) continue;
        try {
          const decoded = decodeEventLog({ abi: [AUTHORIZATION_USED], data: log.data, topics: log.topics });
          if (
            getAddress(decoded.args.authorizer) === getAddress(payer.address) &&
            decoded.args.nonce.toLowerCase() === ledgerNonce.toLowerCase()
          ) {
            authorizationOk = true;
          }
        } catch {
          // not an AuthorizationUsed event from this contract
        }
      }
      if (!authorizationOk) {
        failures.push(`payment ${i} tx ${txHash} has no AuthorizationUsed event for the payer and ledger nonce`);
        console.error(`testnet payment ${i}: tx ${txHash} AuthorizationUsed does not match payer/nonce`);
        break;
      }
      console.log(`testnet payment ${i}: https://sepolia.basescan.org/tx/${txHash} status success`);
    }

    const settles = rail.ledger.entries().filter(
      (e) => e.kind === "x402.settle" && (e.payload as { outcome?: string }).outcome === "settled",
    );
    if (settles.length !== CALL_COUNT) failures.push(`ledger has ${settles.length} settled x402.settle entries, expected ${CALL_COUNT}`);

    const verify = rail.ledger.verify(trusted);
    console.log(`testnet ledger verify: ${verify.ok ? "PASS" : `FAIL (${verify.reason})`} over ${rail.ledger.entries().length} entries`);
    if (!verify.ok) failures.push(`ledger verify failed: ${verify.reason}`);

    if (failures.length > 0) {
      console.error(`testnet: FAILED: ${failures.join("; ")}`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`testnet: error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (gateway) await closeServer(gateway).catch(() => {});
    if (resource) await resource.close().catch(() => {});
    if (rail) rail.close();
    await delay(1);
  }
}

main().then((code) => process.exit(code));
