// End-to-end x402 payments on a real chain: an anvil fork of Base Sepolia.
//
// It starts a local facilitator built from the real x402 classes, which
// broadcasts real transferWithAuthorization transactions to the fork, pays a
// paid resource through the TapVow gateway 12 times, and checks every
// receipt, balance and signed ledger entry. A poisoned 50 USDC ask to a payee
// outside the mandate must be blocked before any transaction exists.
//
// Run: npm run fork-e2e
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAddress, decodeEventLog, erc20Abi, type Address, type Hex } from "viem";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { eip3009ABI } from "@x402/evm";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { generateSigner, signMandate, type Mandate, type SignedMandate } from "@mandate/core";
import { auditRail, createGateway, openGovernedRail, type GovernedRail } from "@mandate/llm-rail";
import { checkPayment, median, parseX402Allowlist } from "@mandate/payee-guard";
import { createX402Rail } from "../src/rail.js";
import { startChainFacilitator } from "../src/chain-facilitator.js";
import { startPaidResource, type PaidResource } from "../src/demo-server.js";
import { BASE_SEPOLIA_USDC } from "../src/local-facilitator.js";
import { reconcileX402, redactError, viemAuthorizationChain, type AuthorizationChain } from "../src/reconcile.js";
import type { PaymentGuard } from "../src/types.js";

const NETWORK = "eip155:84532";
const USDC = getAddress(BASE_SEPOLIA_USDC);
const FORK_URL = "https://sepolia.base.org";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EVIL_PAYEE = getAddress("0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a");
const PAYMENT_MICROS = 10_000n;
const PAYER_START = 1_000_000n;
const PAYER_END = PAYER_START - 12n * PAYMENT_MICROS; // 880000
const PAYEE_END = 12n * PAYMENT_MICROS; // 120000
const DAY_MS = 86_400_000;
const CALL_COUNT = 12;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

class Reporter {
  readonly checks: Check[] = [];
  record(name: string, ok: boolean, detail?: string): boolean {
    const check: Check = detail === undefined ? { name, ok } : { name, ok, detail };
    this.checks.push(check);
    if (!ok) console.error(`FAIL: ${name}${detail ? `: ${detail}` : ""}`);
    return ok;
  }
  allPassed(): boolean {
    return this.checks.every((c) => c.ok);
  }
  firstFailure(): Check | undefined {
    return this.checks.find((c) => !c.ok);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const height = await rpc(url, "eth_blockNumber", []);
      if (typeof height === "string") return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`anvil did not answer on ${url} within ${timeoutMs} ms`);
    await delay(500);
  }
}

function postJson(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
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

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

interface FailingFacilitator {
  url: string;
  close(): Promise<void>;
}

/**
 * A facilitator that verifies for real (proxying /supported and /verify to the
 * chain facilitator) but always fails /settle. A resource behind it signs a
 * real authorization and then cannot settle it, so the gateway books the full
 * amount as charged_full unconfirmed without moving any USDC.
 */
function startFailingFacilitator(realUrl: string, network: string): Promise<FailingFacilitator> {
  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        if (method === "GET" && url.startsWith("/supported")) {
          const r = await fetch(`${realUrl}/supported`);
          writeJson(res, r.status, await r.json());
          return;
        }
        if (method === "POST" && url.startsWith("/verify")) {
          const body = await readAll(req);
          const r = await fetch(`${realUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body });
          writeJson(res, r.status, await r.json());
          return;
        }
        if (method === "POST" && url.startsWith("/settle")) {
          await readAll(req);
          writeJson(res, 200, {
            success: false,
            errorReason: "simulated_settle_failure",
            errorMessage: "fork-e2e books this payment unconfirmed on purpose",
            network,
          });
          return;
        }
        writeJson(res, 404, { error: "not found" });
      } catch (err) {
        writeJson(res, 400, {
          isValid: false,
          invalidReason: "facilitator_error",
          invalidMessage: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => closeServer(server) });
    });
  });
}

interface CaptureProxy {
  origin: string;
  /** The most recent PAYMENT-SIGNATURE / X-PAYMENT header the resource received. */
  lastPaymentHeader(): string | null;
  close(): Promise<void>;
}

/** A transparent reverse proxy that records the payment header on its way to the resource. */
function startCaptureProxy(target: string): Promise<CaptureProxy> {
  const targetUrl = new URL(target);
  let last: string | null = null;
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const header = req.headers["payment-signature"] ?? req.headers["x-payment"];
      if (typeof header === "string") last = header;
      const forwarded: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (["host", "connection", "transfer-encoding", "content-length"].includes(lower)) continue;
        forwarded[lower] = value;
      }
      forwarded["host"] = targetUrl.host;
      const body = Buffer.concat(chunks);
      const upstream = request(
        { hostname: targetUrl.hostname, port: targetUrl.port, path: req.url ?? "/", method: req.method ?? "GET", headers: forwarded, agent: false },
        (ures) => {
          const out: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(ures.headers)) {
            if (value === undefined) continue;
            const lower = name.toLowerCase();
            if (lower === "transfer-encoding" || lower === "connection") continue;
            out[lower] = value;
          }
          res.writeHead(ures.statusCode ?? 502, out);
          ures.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
    req.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, lastPaymentHeader: () => last, close: () => closeServer(server) });
    });
  });
}

function buildMandate(payee: Address, issuerPublicKey: string): Mandate {
  return {
    mandate_version: "0.1",
    type: "IntentMandate",
    id: "mdt_fork_e2e_0001",
    issuer: { id: "fork-e2e-issuer", public_key: issuerPublicKey },
    agents: ["agent-01"],
    natural_language_description: "Pay an allowlisted x402 resource within budget on a Base Sepolia fork.",
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

async function main(): Promise<number> {
  const report = new Reporter();
  const dir = mkdtempSync(join(tmpdir(), "mandate-fork-e2e-"));
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  let anvil: ChildProcess | null = null;
  let gateway: HttpServer | null = null;
  let resource: PaidResource | null = null;
  let evil: PaidResource | null = null;
  let facilitator: Awaited<ReturnType<typeof startChainFacilitator>> | null = null;
  let failingFacilitator: FailingFacilitator | null = null;
  let failingResource: PaidResource | null = null;
  let captureProxy: CaptureProxy | null = null;
  let rail: GovernedRail | null = null;

  const stopAnvil = (): void => {
    if (anvil && anvil.exitCode === null && !anvil.killed) anvil.kill("SIGKILL");
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    stopAnvil();
    rmSync(dir, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    anvil = spawn("anvil", ["--fork-url", FORK_URL, "--port", String(port), "--silent"], { stdio: ["ignore", "ignore", "ignore"] });
    await waitForRpc(rpcUrl, 60_000);

    const publicClient = createPublicClient({ transport: http(rpcUrl) });

    const payerAccount = privateKeyToAccount(generatePrivateKey());
    const payeeAccount = privateKeyToAccount(generatePrivateKey());
    const payer = payerAccount.address;
    const payee = payeeAccount.address;

    await rpc(rpcUrl, "anvil_dealERC20", [payer, USDC, `0x${PAYER_START.toString(16)}`]);
    const funded = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [payer],
    })) as bigint;
    report.record("payer is funded with 1 USDC on the fork", funded === PAYER_START, `balance ${funded}`);

    facilitator = await startChainFacilitator({ rpcUrl, privateKey: ANVIL_KEY, network: NETWORK });
    resource = await startPaidResource({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: payee,
      routes: [{ path: "/report", price: "$0.01", body: { report: "paid" } }],
    });

    const issuer = generateSigner("fork-e2e-issuer");
    const mandate = buildMandate(payee, issuer.publicKey);
    const signed: SignedMandate = signMandate(mandate, issuer.signer);
    const ledgerSigner = generateSigner("fork-e2e-ledger");
    rail = openGovernedRail({
      dbPath: join(dir, "rail.db"),
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

    const x402 = createX402Rail({ rail, account: payerAccount, networks: [NETWORK], guard, allowPrivateNetwork: true });
    gateway = createGateway({ store: rail.store, upstreams: {}, routes: { "POST /v1/x402/fetch": x402.handler } });
    const gatewayPort = await listen(gateway);
    const key = rail.issueAgentKey("agent-01");
    const base = `http://127.0.0.1:${gatewayPort}`;

    const receiptHashes: string[] = [];
    let allReceiptsOk = true;

    for (let i = 1; i <= CALL_COUNT; i++) {
      const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${resource.origin}/report` });
      if (r.status !== 200) {
        allReceiptsOk = false;
        console.error(`payment ${i} failed: HTTP ${r.status} ${r.text}`);
        break;
      }
      const txHash = String(r.headers["x-mandate-tx-hash"] ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        allReceiptsOk = false;
        console.error(`payment ${i} has no tx hash header`);
        break;
      }
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      let transferOk = false;
      for (const log of receipt.logs) {
        if (getAddress(log.address) !== USDC) continue;
        try {
          const decoded = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
          if (
            getAddress(decoded.args.from) === payer &&
            getAddress(decoded.args.to) === payee &&
            decoded.args.value === PAYMENT_MICROS
          ) {
            transferOk = true;
          }
        } catch {
          // not a Transfer event from this contract
        }
      }
      if (receipt.status !== "success" || !transferOk) {
        allReceiptsOk = false;
        console.error(`payment ${i} receipt ${txHash} status ${receipt.status} transfer ${transferOk ? "ok" : "missing"}`);
        break;
      }
      receiptHashes.push(txHash);
      console.log(`x402 fork payment ${i}: tx ${txHash} block ${receipt.blockNumber} status success amount 0.010000 USDC`);
    }

    report.record("12 payments mined with a USDC Transfer to the payee", allReceiptsOk && receiptHashes.length === CALL_COUNT, `got ${receiptHashes.length}`);
    report.record("every payment has a distinct tx hash", new Set(receiptHashes).size === receiptHashes.length);

    // A poisoned ask: 50 USDC to a payee the mandate never named.
    evil = await startPaidResource({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: EVIL_PAYEE,
      routes: [{ path: "/unlock", price: "$50", body: { premium: true } }],
    });
    const poisoned = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: `${evil.origin}/unlock` });
    let blockedCode = "";
    let blockedReason = "";
    try {
      const err = (JSON.parse(poisoned.text) as { error?: { code?: string; message?: string } }).error;
      blockedCode = err?.code ?? "";
      blockedReason = err?.message ?? "";
    } catch {
      // leave empty
    }
    console.log(`x402 fork blocked call: HTTP ${poisoned.status} ${blockedCode}: ${blockedReason}`);
    report.record("poisoned 50 USDC ask is blocked with HTTP 403", poisoned.status === 403, `got ${poisoned.status}`);
    report.record("blocked ask names the guard reason", blockedCode === "payee_not_allowed" && blockedReason.includes(EVIL_PAYEE) && blockedReason.includes(evil.origin), blockedReason);
    report.record("blocked ask created no transaction", evil.paidRequests === 0, `paidRequests ${evil.paidRequests}`);

    const payerEnd = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [payer] })) as bigint;
    const payeeEnd = (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [payee] })) as bigint;
    report.record("payer balance is 880000", payerEnd === PAYER_END, `balance ${payerEnd}`);
    report.record("payee balance is 120000", payeeEnd === PAYEE_END, `balance ${payeeEnd}`);

    const verify = rail.ledger.verify(trusted);
    report.record("signed ledger verifies", verify.ok, verify.ok ? undefined : verify.reason);

    const settles = rail.ledger.entries().filter((e) => e.kind === "x402.settle");
    const ledgerTx = settles
      .map((e) => (e.payload as { details: { tx_hash: string } }).details.tx_hash)
      .sort();
    const expectedTx = [...receiptHashes].sort();
    report.record("ledger has 12 x402.settle entries", settles.length === CALL_COUNT, `got ${settles.length}`);
    report.record("ledger tx hashes equal the receipts", JSON.stringify(ledgerTx) === JSON.stringify(expectedTx));
    const blockedEntries = rail.ledger.entries().filter((e) => e.kind === "x402.blocked");
    report.record("ledger has 1 x402.blocked entry", blockedEntries.length === 1, `got ${blockedEntries.length}`);
    const spent = rail.store.spent(mandate.id);
    report.record("store spent is 120000 settled micros", spent.settledMicros === 120_000, `settled ${spent.settledMicros}, reserved ${spent.reservedMicros}`);
    report.record("no reservation is left open", spent.reservedMicros === 0, `reserved ${spent.reservedMicros}`);

    // ---- reconcile section ---------------------------------------------------
    // Two payments are signed through the gateway but their settlement fails, so
    // the rail books them charged_full unconfirmed. One authorization is then
    // spent on chain (settled late); the other is left to expire unused (released).
    // A resource whose facilitator verifies for real but never settles backs both,
    // behind a proxy that records the PAYMENT-SIGNATURE header the resource got.
    // On an anvil fork the "safe" block a reconcile pins trails the local tip by
    // a fixed window and does not advance unless blocks are mined, so a freshly
    // mined settlement or an evm_increaseTime warp is invisible at that block.
    // After each event, mine the whole trailing window plus a margin so the
    // pinned block is at or past the event, then print the pinned tag and number.
    const reconcileFromBlock = await publicClient.getBlockNumber();
    const FORK_MINE_MARGIN = 8;
    const trailingWindow = async (): Promise<number> => {
      const latest = await publicClient.getBlock({ blockTag: "latest" });
      for (const tag of ["safe", "finalized"] as const) {
        try {
          const pinned = await publicClient.getBlock({ blockTag: tag });
          return Number(latest.number - pinned.number);
        } catch {
          // this fork does not serve the tag; try the next one
        }
      }
      return 0;
    };
    const minePastPinned = async (): Promise<void> => {
      const count = (await trailingWindow()) + FORK_MINE_MARGIN;
      await rpc(rpcUrl, "anvil_mine", [`0x${count.toString(16)}`]);
    };
    const pinnedReconcileChain = async (): Promise<AuthorizationChain> => {
      const chain = viemAuthorizationChain(publicClient, { fromBlock: reconcileFromBlock });
      const block = await chain.latestBlock();
      console.log(`fork reconcile pinned block: tag ${block.tag} number ${block.number} time ${block.timestamp}`);
      return chain;
    };

    failingFacilitator = await startFailingFacilitator(facilitator.url, NETWORK);
    failingResource = await startPaidResource({
      facilitatorUrl: failingFacilitator.url,
      network: NETWORK,
      payTo: payee,
      routes: [{ path: "/unconfirmed", price: "$0.01", body: { ok: true } }],
    });
    captureProxy = await startCaptureProxy(failingResource.origin);
    const unconfirmedUrl = `${captureProxy.origin}/unconfirmed`;

    const balanceOf = async (who: Address): Promise<bigint> =>
      (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
    const latestChargedFull = (): { id: string; details: Record<string, unknown> } => {
      const row = rail!.store.database
        .prepare("SELECT id FROM reservations WHERE status = 'charged_full' AND rail = 'x402' ORDER BY created_ms DESC LIMIT 1")
        .get() as { id: string };
      const entry = [...rail!.ledger.entries()].reverse().find(
        (e) => e.kind === "x402.settle" && (e.payload as { reservation_id: string }).reservation_id === row.id,
      );
      return { id: row.id, details: (entry?.payload as { details?: Record<string, unknown> } | undefined)?.details ?? {} };
    };
    const failingPayment = async (): Promise<{ status: number; reservation: { id: string; details: Record<string, unknown> } }> => {
      const r = await postJson(base, "/v1/x402/fetch", { authorization: `Bearer ${key}` }, { url: unconfirmedUrl });
      return { status: r.status, reservation: latestChargedFull() };
    };

    // (b) Settled late: the gateway signed a real authorization; submit it ourselves.
    const late = await failingPayment();
    report.record("a settle-failing payment is booked charged_full unconfirmed", late.reservation.details.unconfirmed === true, `HTTP ${late.status}`);
    const captured = captureProxy.lastPaymentHeader();
    report.record("the signed payment header was captured at the resource", typeof captured === "string" && captured.length > 0);
    if (!captured) throw new Error("no signed payment header was captured at the resource");
    const decoded = decodePaymentSignatureHeader(captured) as unknown as {
      payload: {
        authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` };
        signature: `0x${string}`;
      };
    };
    const auth = decoded.payload.authorization;
    const forkChain = defineChain({
      id: 84532,
      name: "anvil-fork-84532",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY), chain: forkChain, transport: http(rpcUrl) });
    const ownHash = await wallet.writeContract({
      address: USDC,
      abi: eip3009ABI,
      functionName: "transferWithAuthorization",
      args: [
        getAddress(auth.from),
        getAddress(auth.to),
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
        decoded.payload.signature,
      ],
    });
    const ownReceipt = await publicClient.waitForTransactionReceipt({ hash: ownHash });
    report.record("the signed authorization we submitted ourselves mined", ownReceipt.status === "success", ownReceipt.status);

    // Mine the trailing pin window so the pinned block includes the settlement.
    await minePastPinned();
    const lateReport = await reconcileX402(rail, await pinnedReconcileChain());
    const lateResult = lateReport.results.find((r) => r.reservationId === late.reservation.id);
    report.record("reconcile books the late settlement as settled", lateResult?.result === "settled", lateResult?.result);
    report.record("reconcile uses the real on-chain tx hash", lateResult?.txHash === ownHash, `${lateResult?.txHash} vs ${ownHash}`);
    console.log(`fork reconcile settled-late: ${lateResult?.result ?? "none"}`);

    // (a) Expired unused: sign a real authorization, never settle it, advance chain time.
    const expired = await failingPayment();
    report.record("a second settle-failing payment is booked charged_full unconfirmed", expired.reservation.details.unconfirmed === true, `HTTP ${expired.status}`);
    const validBefore = Number(expired.reservation.details.valid_before);
    const tip = await publicClient.getBlock({ blockTag: "latest" });
    const increase = validBefore - Number(tip.timestamp) + 120;
    await rpc(rpcUrl, "evm_increaseTime", [increase]);
    // Mine past the pin window so the pinned block sees the warp and expires the authorization.
    await minePastPinned();
    const expiredReport = await reconcileX402(rail, await pinnedReconcileChain());
    const payerAfterRelease = await balanceOf(payer);
    const expiredResult = expiredReport.results.find((r) => r.reservationId === expired.reservation.id);
    report.record("reconcile releases the expired unused authorization", expiredResult?.result === "released", expiredResult?.result);
    const expectedPayer = PAYER_START - 13n * PAYMENT_MICROS; // 12 gateway calls plus the late settlement
    report.record(
      "releasing an unused authorization left the payer balance at its expected value",
      payerAfterRelease === expectedPayer,
      `${payerAfterRelease} vs ${expectedPayer}`,
    );
    console.log(`fork reconcile expired-unused: ${expiredResult?.result ?? "none"}`);

    const payerAfter = await balanceOf(payer);
    const payeeAfter = await balanceOf(payee);
    report.record("payer balance after reconcile is 870000", payerAfter === 870_000n, `balance ${payerAfter}`);
    report.record("payee balance after reconcile is 130000", payeeAfter === 130_000n, `balance ${payeeAfter}`);
    const spentAfter = rail.store.spent(mandate.id);
    report.record("store spent after reconcile is 130000 settled micros", spentAfter.settledMicros === 130_000, `settled ${spentAfter.settledMicros}`);
    const finalVerify = rail.ledger.verify(trusted);
    report.record("signed ledger verifies after reconcile", finalVerify.ok, finalVerify.ok ? undefined : finalVerify.reason);
    const finalAudit = auditRail(rail.store, rail.ledger, mandate.id, trusted);
    report.record("auditRail passes after reconcile", finalAudit.ok, finalAudit.ok ? undefined : finalAudit.reason);

    if (report.allPassed()) {
      console.log(
        `fork-e2e: ${receiptHashes.length}/${CALL_COUNT} settled on an anvil fork of Base Sepolia (real USDC contract ${USDC}), ledger verify PASS, blocked 1`,
      );
      return 0;
    }
    const failure = report.firstFailure();
    console.error(`fork-e2e: FAILED check "${failure?.name ?? "unknown"}"${failure?.detail ? `: ${failure.detail}` : ""}`);
    return 1;
  } catch (err) {
    console.error(`fork-e2e: error: ${redactError(err)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (gateway) await closeServer(gateway).catch(() => {});
    if (resource) await resource.close().catch(() => {});
    if (evil) await evil.close().catch(() => {});
    if (captureProxy) await captureProxy.close().catch(() => {});
    if (failingResource) await failingResource.close().catch(() => {});
    if (failingFacilitator) await failingFacilitator.close().catch(() => {});
    if (facilitator) await facilitator.close().catch(() => {});
    if (rail) rail.close();
    stopAnvil();
    if (anvil && anvil.exitCode === null) await delay(100);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
