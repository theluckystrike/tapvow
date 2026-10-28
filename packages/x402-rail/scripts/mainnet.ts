// Real Base mainnet payments through the TapVow gateway.
//
// It funds nothing itself. The owner must put a dedicated payer key in
// .secrets/base-mainnet-payer.json (mode 600) and fund that wallet with USDC on
// Base mainnet. The script refuses to start unless MAINNET_CONFIRM is "yes".
// It prints the payer address and USDC balance, refuses a balance below 0.12
// USDC, then sends at most 12 payments of 0.01 USDC under a 0.50 USD mandate
// budget through the CDP x402 facilitator. It stops at the first failure and
// logs every settled payment to logs/mainnet-<date>.jsonl.
//
// Run: MAINNET_CONFIRM=yes npm run mainnet
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import type { PaymentGuard } from "../src/types.js";

// The x402 library names Base mainnet "eip155:8453".
const NETWORK = "eip155:8453";
const CHAIN_ID = 8453;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const BASESCAN = "https://basescan.org/tx/";
const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://mainnet.base.org";
const FACILITATOR_URL = CDP_FACILITATOR_URL;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRETS_DIR = process.env.TAPVOW_SECRETS_DIR ?? resolve(REPO_ROOT, "..", ".secrets");
const CDP_KEY_FILE = join(SECRETS_DIR, "cdp-api-key.json");
const PAYER_FILE = join(SECRETS_DIR, "base-mainnet-payer.json");
// A payee key is only an address on mainnet. Use the mainnet file when the
// owner saves one, otherwise the existing testnet payee address.
const MAINNET_PAYEE_FILE = join(SECRETS_DIR, "base-mainnet-payee.json");
const PAYEE_FILE = existsSync(MAINNET_PAYEE_FILE) ? MAINNET_PAYEE_FILE : join(SECRETS_DIR, "base-sepolia-payee.json");
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// One ledger file per run, so a run never reopens another run's mandate.
const LEDGER_DB = join(REPO_ROOT, ".data", `mainnet-${RUN_ID}.db`);
// The run's ledger signing key is kept outside the repo (mode 600).
const LEDGER_KEY_FILE = join(SECRETS_DIR, `mainnet-ledger-${RUN_ID}.json`);
const LOG_DIR = join(REPO_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, `mainnet-${new Date().toISOString().slice(0, 10)}.jsonl`);
const PAYMENT_MICROS = 10_000n; // 0.01 USDC
const MANDATE_BUDGET_MICROS = 500_000n; // 0.50 USD in total
const BALANCE_FLOOR_MICROS = 120_000n; // 0.12 USDC, 12 payments plus margin
const HARD_MAX_CALLS = 12;
const RAW_CALLS = Number(process.env.TESTNET_CALLS ?? 12);
if (!Number.isInteger(RAW_CALLS) || RAW_CALLS < 1) throw new Error("TESTNET_CALLS must be an integer of 1 or more");
const CALL_COUNT = Math.min(RAW_CALLS, HARD_MAX_CALLS);
const MIN_PAYMENT_MICROS = PAYMENT_MICROS * BigInt(CALL_COUNT);
if (MIN_PAYMENT_MICROS > MANDATE_BUDGET_MICROS) throw new Error("payment plan exceeds the 0.50 USD mandate budget");
const GAP_MS = Number(process.env.TESTNET_GAP_MS ?? 0);
if (!Number.isInteger(GAP_MS) || GAP_MS < 0 || GAP_MS > 60000) throw new Error("TESTNET_GAP_MS must be 0 to 60000");
const DAY_MS = 86_400_000;

const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

function buildMandate(payee: Address, issuerPublicKey: string): Mandate {
  return {
    mandate_version: "0.1",
    type: "IntentMandate",
    id: "mdt_mainnet_e2e_0001",
    issuer: { id: "mainnet-issuer", public_key: issuerPublicKey },
    agents: ["agent-01"],
    natural_language_description: "Pay an allowlisted x402 resource within budget on Base mainnet.",
    currency: "USD",
    budget: { total: "0.50", period: "lifetime" },
    per_call_cap: "0.01",
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

function logPayment(index: number, txHash: string): void {
  mkdirSync(LOG_DIR, { recursive: true });
  const entry = {
    time: new Date().toISOString(),
    tx_hash: txHash,
    basescan_url: `${BASESCAN}${txHash}`,
    amount_usdc: "0.01",
    payment: index,
  };
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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

  const requiredMicros = MIN_PAYMENT_MICROS > BALANCE_FLOOR_MICROS ? MIN_PAYMENT_MICROS : BALANCE_FLOOR_MICROS;
  console.log(
    `mainnet payer ${payer.address} holds ${(Number(balance) / 1e6).toFixed(6)} USDC on Base mainnet (chain ${CHAIN_ID}, ${NETWORK})`,
  );
  if (balance < requiredMicros) {
    console.log(
      `BLOCKED: balance is below ${(Number(requiredMicros) / 1e6).toFixed(2)} USDC. Fund ${payer.address} on Base mainnet, then rerun.`,
    );
    return 3;
  }
  console.log(`mainnet plan: ${CALL_COUNT} payments of 0.01 USDC, mandate budget 0.50 USD, log ${LOG_FILE}`);

  let gateway: HttpServer | null = null;
  let resource: PaidResource | null = null;
  let rail: GovernedRail | null = null;
  const failures: string[] = [];

  try {
    const facilitatorAuth = cdpFacilitatorAuth(loadCdpKey(CDP_KEY_FILE));
    resource = await startPaidResource({
      facilitatorUrl: FACILITATOR_URL,
      facilitatorAuth,
      network: NETWORK,
      payTo: payeeAddress,
      routes: [{ path: "/report", price: "$0.01", body: { report: "paid" } }],
    });

    const issuer = generateSigner("mainnet-issuer");
    const mandate = buildMandate(payeeAddress, issuer.publicKey);
    const signed: SignedMandate = signMandate(mandate, issuer.signer);
    const ledgerSigner = generateSigner(`mainnet-ledger-${RUN_ID}`);
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
    console.log(`mainnet facilitator: cdp (${FACILITATOR_URL})`);
    console.log(`mainnet ledger ${LEDGER_DB} key_id ${ledgerSigner.signer.keyId} public_key ${ledgerSigner.publicKey}`);

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
    let settled = 0;

    for (let i = 1; i <= CALL_COUNT; i++) {
      if (i > 1 && GAP_MS > 0) await delay(GAP_MS);
      const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/report` });
      if (r.status !== 200) {
        failures.push(`payment ${i} failed: HTTP ${r.status} ${r.text}`);
        console.error(`mainnet payment ${i}: HTTP ${r.status} ${r.text}`);
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
        console.error(`mainnet payment ${i}: tx ${txHash} no receipt within 60 s`);
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
        console.error(`mainnet payment ${i}: tx ${txHash} status ${receipt.status} transfer ${transferOk ? "ok" : "missing"}`);
        break;
      }
      const paidSettles = rail.ledger.entries().filter((e) => e.kind === "x402.settle");
      const ledgerNonce = (paidSettles[paidSettles.length - 1]?.payload as { details?: { nonce?: string } } | undefined)?.details
        ?.nonce;
      if (typeof ledgerNonce !== "string" || ledgerNonce.length === 0) {
        failures.push(`payment ${i} has no x402.settle ledger nonce`);
        console.error(`mainnet payment ${i}: no x402.settle ledger nonce`);
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
        console.error(`mainnet payment ${i}: tx ${txHash} AuthorizationUsed does not match payer/nonce`);
        break;
      }
      settled += 1;
      logPayment(i, txHash);
      console.log(`mainnet payment ${i}: ${BASESCAN}${txHash} status success amount 0.01 USDC`);
    }

    const settles = rail.ledger.entries().filter(
      (e) => e.kind === "x402.settle" && (e.payload as { outcome?: string }).outcome === "settled",
    );
    if (settles.length !== settled) failures.push(`ledger has ${settles.length} settled x402.settle entries, expected ${settled}`);

    const verify = rail.ledger.verify(trusted);
    console.log(`mainnet ledger verify: ${verify.ok ? "PASS" : `FAIL (${verify.reason})`} over ${rail.ledger.entries().length} entries`);
    if (!verify.ok) failures.push(`ledger verify failed: ${verify.reason}`);

    if (failures.length > 0) {
      console.error(`mainnet: FAILED after ${settled} of ${CALL_COUNT} payments: ${failures.join("; ")}`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`mainnet: error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (gateway) await closeServer(gateway).catch(() => {});
    if (resource) await resource.close().catch(() => {});
    if (rail) rail.close();
    await delay(1);
  }
}

if (process.env.MAINNET_CONFIRM !== "yes") {
  console.error("BLOCKED: set MAINNET_CONFIRM=yes to allow real Base mainnet payments. No payment was made.");
  process.exit(3);
}
main().then((code) => process.exit(code));
