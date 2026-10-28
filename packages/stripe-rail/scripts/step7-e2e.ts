// Step 7 done-test: a test-mode SPT payment on the shared signed ledger, then a
// revoke whose shared_payment.granted_token.deactivated event must arrive
// (verified webhook or GET /v1/events). Nothing here may print a Stripe key.
//
// The orchestrator runs this script. It reads one file under .secrets, makes
// real test-mode calls and exits 3 when the TapVow sandbox key is missing.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_MANDATE, generateSigner, signMandate, type Mandate } from "@mandate/core";
import { auditRail, openGovernedRail, type GovernedRail } from "@mandate/llm-rail";
import {
  StripeClient,
  createStripeSptRail,
  redactSecrets,
  unsafeWebhookEndpoints,
  verifyStripeSignature,
  type GrantedToken,
  type StripeSptRail,
} from "../src/index.js";

const EVENT = "shared_payment.granted_token.deactivated";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRETS_DIR = process.env.TAPVOW_SECRETS_DIR ?? resolve(REPO_ROOT, "..", ".secrets");
const DEFAULT_KEY_FILE = join(SECRETS_DIR, "stripe-tapvow-test.key");
const KEY_FILE = process.env.STRIPE_KEY_FILE ?? DEFAULT_KEY_FILE;
const STRIPE_BIN = process.env.STRIPE_BIN ?? "stripe";
const AMOUNT_CENTS = Number(process.env.STEP7_AMOUNT_CENTS ?? "60");
const CURRENCY = "usd";

class ExitError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const children: ChildProcess[] = [];
let server: ReturnType<typeof createServer> | null = null;
// Memoise the cleanup promise: a second caller waits for the first instead of
// returning while children are still being stopped.
let cleanupPromise: Promise<void> | null = null;
let shuttingDown = false;
// Set as soon as a signal or a fatal error starts shutdown, so main() stops
// before its next Stripe write call instead of racing cleanup.
let aborting = false;
// The running main(), so shutdown can wait for its finally { rail?.close() }.
let mainPromise: Promise<number> | null = null;

function log(line: string): void {
  console.log(redactSecrets(line));
}

function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function killChildrenSync(): void {
  for (const child of children) {
    if (childAlive(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // the child is already gone
      }
    }
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) {
    // A second signal must not fall through to Node's default handler, which
    // would kill this process without the "exit" hook and leave a child alive.
    killChildrenSync();
    process.exit(code);
    return;
  }
  shuttingDown = true;
  aborting = true;
  try {
    if (mainPromise) {
      // Longer than the client's 30 s timeout, so main()'s finally runs and the
      // ledger closes before we exit. The timer stays ref'd: if main never
      // settles it must keep the loop alive until cleanup runs, not let Node
      // exit 0 with the ledger still open.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 35000);
      });
      try {
        await Promise.race([mainPromise.then(() => undefined).catch(() => undefined), capped]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    await cleanup();
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => {
  void shutdown(130);
});
process.on("SIGTERM", () => {
  void shutdown(130);
});
process.on("SIGHUP", () => {
  void shutdown(130);
});
process.on("uncaughtException", (err: unknown) => {
  log(`step7-e2e uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
  void shutdown(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  log(`step7-e2e unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  void shutdown(1);
});
// Synchronous last resort for a child that outlived every async cleanup path.
process.on("exit", () => {
  killChildrenSync();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readKey(): string {
  let key: string;
  try {
    key = readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    throw new ExitError(
      3,
      `Stripe key file ${KEY_FILE} is missing; the owner must create the TapVow sandbox key (see BLOCKERS.md step 7).`,
    );
  }
  if (key.length === 0) {
    throw new ExitError(3, `Stripe key file ${KEY_FILE} is empty; create the TapVow sandbox key (see BLOCKERS.md step 7).`);
  }
  return key;
}

function startChild(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(STRIPE_BIN, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  children.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

async function getWebhookSecret(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(STRIPE_BIN, ["listen", "--print-secret"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for `stripe listen --print-secret`"));
    }, 30000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = /whsec_[A-Za-z0-9]+/.exec(output);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(match[0]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not run ${STRIPE_BIN} listen: ${err.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`\`stripe listen --print-secret\` exited with ${String(code)} before printing a secret`));
    });
  });
}

function startWebhookReceiver(secret: string): Promise<{ port: number; received: Promise<Record<string, unknown>> }> {
  let resolveEvent: (event: Record<string, unknown>) => void = () => {};
  const received = new Promise<Record<string, unknown>>((resolve) => {
    resolveEvent = resolve;
  });
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/stripe/webhook") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "payload too large" }));
        return;
      }
      const payload = Buffer.concat(chunks);
      const header = req.headers["stripe-signature"];
      const signature = Array.isArray(header) ? header[0] : header;
      if (typeof signature !== "string" || !verifyStripeSignature({ payload, signatureHeader: signature, secret })) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: true }));
      try {
        const event = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        if (event.type === EVENT) resolveEvent(event);
      } catch {
        // signature was valid but the body was not JSON; the event poll can still pass
      }
    });
  });
  server = httpServer;
  return new Promise((resolve, reject) => {
    httpServer.on("error", (err) => {
      server = null;
      reject(err);
    });
    httpServer.listen(0, "127.0.0.1", () => {
      resolve({ port: (httpServer.address() as AddressInfo).port, received });
    });
  });
}

function eventMatches(event: Record<string, unknown>, sptId: string): { id: string; reason: string; at: number } | null {
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const object = (data as { object?: unknown }).object;
  if (typeof object !== "object" || object === null) return null;
  const obj = object as Record<string, unknown>;
  if (obj.id !== sptId) return null;
  if (obj.deactivated_reason !== "revoked") return null;
  const id = typeof event.id === "string" ? event.id : null;
  if (!id) return null;
  return {
    id,
    reason: "revoked",
    at: typeof obj.deactivated_at === "number" ? obj.deactivated_at : Math.floor(Date.now() / 1000),
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function cleanup(): Promise<void> {
  return (cleanupPromise ??= (async () => {
    for (const child of children) await stopChild(child);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  })());
}

async function main(): Promise<number> {
  const key = readKey();

  log(
    `Plan text says 0.50 USD; using ${(AMOUNT_CENTS / 100).toFixed(2)} USD (${AMOUNT_CENTS} cents) because Stripe's USD minimum converts below the EUR minimum on this account.`,
  );
  if (!Number.isSafeInteger(AMOUNT_CENTS) || AMOUNT_CENTS <= 0) {
    throw new ExitError(1, "STEP7_AMOUNT_CENTS must be a positive integer");
  }

  const client = new StripeClient(key);
  try {
    await client.assertTestMode();
  } catch (err) {
    throw new ExitError(1, err instanceof Error ? err.message : "Stripe test-mode check failed");
  }
  log("Stripe key is test mode (livemode:false).");
  const accountId = client.accountId;
  if (accountId === null) throw new ExitError(1, "Stripe did not report an acct_ account id");
  log(`Stripe account id: ${accountId}.`);

  // Refuse to make any write call when another product on this account listens
  // for a payment event this test charge could emit. The guard reads status
  // and the full enabled_events list, following has_more across pages.
  const endpoints = await client.listWebhookEndpoints();
  if (!endpoints.ok) throw new ExitError(1, `GET /v1/webhook_endpoints returned HTTP ${endpoints.status}`);
  const endpointData = (endpoints.body as { data?: unknown }).data;
  if (!Array.isArray(endpointData)) {
    throw new ExitError(1, "GET /v1/webhook_endpoints returned a body without a data array");
  }
  const unsafe = unsafeWebhookEndpoints(endpointData);
  if (unsafe.length > 0) {
    throw new ExitError(
      4,
      `Refusing to charge: webhook endpoint(s) ${unsafe.join(", ")} are enabled for a payment event. Use a dedicated TapVow sandbox.`,
    );
  }
  log("No enabled webhook endpoint listens for payment_intent.*, charge.*, shared_payment.* or *.");

  // The ledger and mandate come first, so the SPT can be bound to the mandate id.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ledgerDir = join(REPO_ROOT, ".data", `step7-${stamp}`);
  mkdirSync(ledgerDir, { recursive: true });

  const issuer = generateSigner("step7-owner");
  const ledgerSigner = generateSigner("step7-gateway");
  const mandate: Mandate = {
    ...EXAMPLE_MANDATE,
    id: `mdt_step7_${Date.now()}`,
    issuer: { id: "step7-owner", public_key: issuer.publicKey },
    agents: ["step7-agent"],
    natural_language_description: "Step 7 test: pay one Stripe SPT on the shared signed ledger.",
    budget: { total: "5.00", period: "lifetime" },
    per_call_cap: "2.00",
    approval_threshold: "5.00",
    allowed_payees: [
      { rail: "llm", id: "openai" },
      { rail: "stripe_spt", id: accountId },
    ],
    rate_limit: { max_calls: 1000, window_seconds: 60 },
    rails: ["llm", "stripe_spt"],
    not_before: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: new Date().toISOString(),
  };
  const signed = signMandate(mandate, issuer.signer);
  let rail: GovernedRail | null = null;
  try {
    rail = openGovernedRail({
      dbPath: join(ledgerDir, "budget.db"),
      signedMandate: signed,
      trustedIssuerKey: issuer.publicKey,
      ledgerSigner: ledgerSigner.signer,
    });
    const agentKey = rail.issueAgentKey("step7-agent");
    const auth = rail.store.authenticate(agentKey);
    if (!auth) throw new ExitError(1, "the step 7 agent key did not authenticate");
    const sellerLabel = process.env.STEP7_SELLER_LABEL ?? "tapvow_test_seller";
    const stripe: StripeSptRail = createStripeSptRail({ rail, client, sellerLabel });
    const countStripeSptRows = (): number =>
      (
        rail!.store.database
          .prepare("SELECT COUNT(*) AS c FROM reservations WHERE rail = 'stripe_spt'")
          .get() as { c: number }
      ).c;

    // L8: one small llm settle in the same chain, before the SPT payment.
    const llmReserved = rail.store.reserve({
      mandateId: mandate.id,
      agentId: "step7-agent",
      model: "gpt-4o",
      provider: "openai",
      amountMicros: 1000,
      rail: "llm",
    });
    if (!llmReserved.ok) throw new ExitError(1, `llm reservation failed: ${llmReserved.code}`);
    rail.store.settle(llmReserved.reservationId, null, 800);
    const llmEntry = rail.ledger
      .entries()
      .find(
        (entry) =>
          entry.kind === "llm.settle" &&
          (entry.payload as { reservation_id?: string }).reservation_id === llmReserved.reservationId,
      );
    if (!llmEntry) throw new ExitError(1, "no llm.settle entry for the setup reservation");

    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    if (aborting) throw new ExitError(130, "interrupted");
    const created = await client.createGrantedToken({
      paymentMethod: "pm_card_visa",
      currency: CURRENCY,
      maxAmount: AMOUNT_CENTS,
      expiresAt,
      metadata: { tapvow_step7: "1", tapvow_mandate_id: mandate.id },
    });
    if (!created.ok) throw new ExitError(1, `creating the granted SPT returned HTTP ${created.status}`);
    const granted = created.body as GrantedToken;
    if (typeof granted.id !== "string" || !granted.id.startsWith("spt_")) {
      throw new ExitError(1, "the granted token response had no spt_ id");
    }
    const sptId = granted.id;
    const profile = granted.agent_details?.network_business_profile;
    log(
      `Created granted SPT ${sptId} bound to mandate ${mandate.id} for account ${accountId}` +
        (typeof profile === "string" && profile.length > 0 ? ` (agent profile ${profile}).` : "."),
    );

    const env = { ...process.env, STRIPE_API_KEY: key };
    const secret = await getWebhookSecret(env);
    const receiver = await startWebhookReceiver(secret);
    const forwarder = startChild(
      ["listen", "--events", EVENT, "--forward-to", `http://127.0.0.1:${receiver.port}/stripe/webhook`],
      env,
    );
    forwarder.on("error", () => {});
    await sleep(1000);

    if (aborting) throw new ExitError(130, "interrupted");
    const paid = await stripe.payWithSpt(auth, { sptId, amountCents: AMOUNT_CENTS, currency: CURRENCY });
    if (!paid.ok) throw new ExitError(1, `SPT payment refused: ${paid.code}: ${paid.reason}`);

    const settles = rail.ledger.entries().filter((e) => e.kind === "stripe_spt.settle");
    const settle = settles.find(
      (e) => (e.payload as { reservation_id?: string }).reservation_id === paid.reservationId,
    );
    if (!settle) throw new ExitError(1, "no stripe_spt.settle entry for the payment");
    const payload = settle.payload as { outcome?: string; charged_micros?: number };
    if (payload.outcome !== "settled" || payload.charged_micros !== AMOUNT_CENTS * 10_000) {
      throw new ExitError(1, `unexpected settle booking: ${JSON.stringify({ outcome: payload.outcome, charged: payload.charged_micros })}`);
    }
    const audit = auditRail(rail.store, rail.ledger, mandate.id, rail.trustedLedgerKeys);
    if (!audit.ok) throw new ExitError(1, `auditRail failed: ${audit.reason}`);
    log(`Paid ${AMOUNT_CENTS} cents: PaymentIntent ${paid.paymentIntentId}, ledger seq ${settle.seq}.`);
    if (settle.seq <= llmEntry.seq) {
      throw new ExitError(1, `stripe_spt.settle seq ${settle.seq} is not after llm.settle seq ${llmEntry.seq}`);
    }
    log(`Same hash chain: llm.settle seq ${llmEntry.seq}, stripe_spt.settle seq ${settle.seq}.`);

    // Over-cap attempt: the token's usage limit is now used up, so TapVow must
    // refuse locally with no reservation and no second PaymentIntent.
    const beforeOver = countStripeSptRows();
    if (aborting) throw new ExitError(130, "interrupted");
    const over = await stripe.payWithSpt(auth, { sptId, amountCents: AMOUNT_CENTS + 1, currency: CURRENCY });
    if (over.ok) throw new ExitError(1, "over-cap SPT payment was not refused locally");
    if (over.code !== "token_cap_exceeded" && over.code !== "token_deactivated") {
      throw new ExitError(1, `over-cap SPT payment was refused for an unexpected reason: ${over.code}`);
    }
    if (over.reservationId !== undefined) {
      throw new ExitError(1, "over-cap SPT payment created a reservation");
    }
    const afterOver = countStripeSptRows();
    if (afterOver !== beforeOver) {
      throw new ExitError(1, `over-cap SPT payment changed the stripe_spt reservation count from ${beforeOver} to ${afterOver}`);
    }
    log(`Over-cap attempt refused locally: ${over.code} (no new stripe_spt reservation).`);

    const t0 = Math.floor(Date.now() / 1000);
    if (aborting) throw new ExitError(130, "interrupted");
    const revoked = await client.revokeToken(sptId);
    if (!revoked.ok) throw new ExitError(1, `revoking the SPT returned HTTP ${revoked.status}`);
    const revokedBody = revoked.body as GrantedToken;

    let eventRecord: { id: string; reason: string; at: number } | null = null;
    const deadline = Date.now() + 90_000;
    const webhookPromise = receiver.received.then((event) => eventMatches(event, sptId));
    let webhookSettled = false;
    webhookPromise.then((match) => {
      if (match) {
        webhookSettled = true;
        eventRecord = match;
      }
    }).catch(() => {});
    while (Date.now() < deadline && eventRecord === null) {
      const listed = await client.listEvents({ type: EVENT, createdGte: t0, limit: 10 });
      if (listed.ok) {
        const data = (listed.body as { data?: unknown }).data;
        if (Array.isArray(data)) {
          for (const event of data) {
            const match = typeof event === "object" && event !== null ? eventMatches(event as Record<string, unknown>, sptId) : null;
            if (match) {
              eventRecord = match;
              break;
            }
          }
        }
      }
      if (eventRecord !== null) break;
      await sleep(2000);
    }
    if (eventRecord === null && webhookSettled) eventRecord = await webhookPromise;

    if (eventRecord === null) {
      stripe.recordDeactivation({
        sptId,
        deactivatedReason: String(revokedBody.deactivated_reason ?? "revoked"),
        deactivatedAt: Number(revokedBody.deactivated_at ?? t0),
        eventId: null,
        source: "retrieve",
      });
      throw new ExitError(
        1,
        "no verified deactivation webhook or shared_payment.granted_token.deactivated event arrived within 90 s",
      );
    }

    stripe.recordDeactivation({
      sptId,
      deactivatedReason: eventRecord.reason,
      deactivatedAt: eventRecord.at,
      eventId: eventRecord.id,
      source: "event",
    });

    const verify = rail.ledger.verify(rail.trustedLedgerKeys);
    if (!verify.ok) throw new ExitError(1, `ledger verify failed: ${verify.reason}`);
    log(`Ledger verify: ok`);
    for (const entry of rail.ledger.entries()) {
      if (entry.kind.startsWith("stripe_spt.")) log(`ledger seq ${entry.seq}: ${entry.kind}`);
    }
    log(`PaymentIntent id: ${paid.paymentIntentId}`);
    log(`Deactivation event id: ${eventRecord.id}`);
    log(`Ledger: ${ledgerDir}/budget.db`);
    return 0;
  } finally {
    rail?.close();
  }
}

mainPromise = main();
mainPromise
  .then(async (code) => {
    // On an interrupted run the shutdown path set `aborting`; it owns cleanup
    // and exits 130, so this path must not race it with a different code.
    if (aborting) return;
    await cleanup();
    // A signal that arrived during cleanup still makes this an interrupted run.
    process.exit(aborting ? 130 : code);
  })
  .catch(async (err: unknown) => {
    if (aborting) {
      log(`step7-e2e interrupted: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const exitCode = err instanceof ExitError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    log(`step7-e2e failed (exit ${exitCode}): ${message}`);
    await cleanup();
    process.exit(aborting ? 130 : exitCode);
  });
