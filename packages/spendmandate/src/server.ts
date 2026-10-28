import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { createPrivateKey, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { HeadAnchor, Ledger, sha256Hex, type LedgerEntry, type Signer, type SignedMandate } from "@mandate/core";
import {
  createGateway,
  openGovernedRail,
  startFakeUpstream,
  type FakeUpstream,
  type GovernedRail,
} from "@mandate/llm-rail";
import { ensureDir, readJson } from "./home.js";
import { buildPack } from "./pack.js";
import { buildPdf, pdfLinesForPack } from "./pdf.js";
import { DASHBOARD_HTML } from "./dashboard.html.js";

interface UpstreamConfig {
  base_url: string;
  api_key_env: string;
}

interface GatewayConfig {
  version: number;
  host: string;
  port: number;
  db: string;
  mandate_file: string;
  owner_public_key: string;
  ledger_key_file: string;
  dashboard_token: string;
  upstreams: { openai?: UpstreamConfig; anthropic?: UpstreamConfig };
  /** anthropic-beta values the gateway lets through. Missing means DEFAULT_ANTHROPIC_BETAS. */
  allowed_anthropic_betas?: string[];
}

/**
 * Betas that Claude Code 2.x and OpenCode 1.x send on every call, seen on
 * 23 Oct 2026. None of them changes the per-token price, and output stays
 * bounded by max_tokens. Betas that do change the price, such as the 1M
 * context or fast mode betas, are not in the list and get HTTP 400.
 */
export const DEFAULT_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-11-13",
  "thinking-binding-controls-2026-08-01",
];

interface StoredKey {
  key_id: string;
  public_key: string;
  private_key_pkcs8: string;
}

const SECURITY_HEADERS: OutgoingHttpHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function withSecurity(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  return { ...headers, ...SECURITY_HEADERS };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export interface EntryRow {
  seq: number;
  ts: string;
  kind: string;
  agent_id: string | null;
  payee: string | null;
  model: string | null;
  amount: number | null;
  outcome: string | null;
  code: string | null;
  decision: string | null;
  hash: string;
}

export function rowOf(entry: LedgerEntry): EntryRow {
  const p = asRecord(entry.payload);
  const isSettle = entry.kind.endsWith(".settle");
  const charged = p.charged_micros;
  const amountField = p.amount_micros;
  const amount =
    isSettle && typeof charged === "number"
      ? charged
      : typeof amountField === "number"
        ? amountField
        : null;
  return {
    seq: entry.seq,
    ts: entry.ts,
    kind: entry.kind,
    agent_id: str(p.agent_id),
    payee: str(p.payee) ?? str(p.provider),
    model: str(p.model) ?? str(p.asset),
    amount,
    outcome: str(p.outcome),
    code: str(p.code),
    decision: str(p.decision),
    hash: entry.hash.slice(0, 12),
  };
}

export interface StartOptions {
  home: string;
  host?: string;
  port?: number;
  fakeUpstream?: boolean;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  /**
   * The seq printed by the last entry of a pre-existing ledger, to adopt it
   * once for a home that never had signed head files. It must equal the current
   * ledger head seq, so it cannot be passed blindly.
   */
  adoptHead?: number;
  /** Where the adoption notice goes. Default: nothing (the CLI writes to stdout). */
  log?: (line: string) => void;
}

/** The last signed ledger entry, or null when the database has no entries yet. */
function lastLedgerEntry(dbPath: string): { seq: number; hash: string; ts: string } | null {
  let ledger: Ledger | null = null;
  try {
    ledger = Ledger.openReadOnly(dbPath);
    const head = ledger.head();
    if (head.seq === 0) return null;
    const entry = ledger.entries(head.seq)[0];
    if (!entry) return null;
    return { seq: entry.seq, hash: entry.hash, ts: entry.ts };
  } catch {
    return null;
  } finally {
    ledger?.close();
  }
}

export interface RunningGateway {
  server: Server;
  host: string;
  port: number;
  url: string;
  dashboardUrl: string;
  rail: GovernedRail;
  close(): Promise<void>;
}

function resolveUpstream(cfg: UpstreamConfig | undefined, override: string | undefined): { baseUrl: string; apiKey: string } | null {
  if (!cfg) return null;
  const baseUrl = override && override.length > 0 ? override : cfg.base_url;
  const value = process.env[cfg.api_key_env];
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("mk_")) {
    throw new Error(`${cfg.api_key_env} looks like a TapVow virtual key; set a real provider key or use --fake-upstream`);
  }
  return { baseUrl, apiKey: value };
}

export async function startGateway(opts: StartOptions): Promise<RunningGateway> {
  const cfg = readJson<GatewayConfig>(join(opts.home, "config.json"));
  const signed = readJson<SignedMandate>(cfg.mandate_file);
  const ledgerKey = readJson<StoredKey>(cfg.ledger_key_file);
  const host = opts.host && opts.host.length > 0 ? opts.host : cfg.host;
  const requestedPort = typeof opts.port === "number" ? opts.port : cfg.port;

  const privateKey = createPrivateKey({
    key: Buffer.from(ledgerKey.private_key_pkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const ledgerSigner: Signer = { keyId: ledgerKey.key_id, privateKey };

  // The signed ledger head lives outside the database in two places, so a
  // rollback has to roll back both. The second path sits in a 700 folder.
  const headFiles = [join(opts.home, "ledger.head.json"), join(opts.home, "heads", "ledger.head.json")];
  const headMarker = join(opts.home, "heads", ".anchored");
  ensureDir(join(opts.home, "heads"), 0o700);

  // Adoption is a one-time escape for a home made before the head files
  // existed. It needs the exact current head seq and is refused on a home that
  // ever published a head (the marker), where a missing head means the files
  // were deleted rather than never written.
  let allowMissingHead = false;
  let adoptedUnverified = false;
  if (opts.adoptHead !== undefined) {
    const log = opts.log ?? (() => {});
    const seq = opts.adoptHead;
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error("--adopt-head needs the current ledger head seq (an integer >= 1)");
    }
    if (existsSync(headMarker)) {
      throw new Error(
        `refusing --adopt-head: ${headMarker} shows this home has used signed head files before, ` +
          `so a missing head means it was deleted; restore the head files from a backup or investigate`,
      );
    }
    const trustedHead = { [ledgerKey.key_id]: ledgerKey.public_key };
    const reader = new HeadAnchor(headFiles, ledgerSigner, { trusted: trustedHead });
    const hasValidHead = reader.readAll(trustedHead).some((r) => r.head !== null);
    if (!hasValidHead) {
      const last = lastLedgerEntry(cfg.db);
      if (!last) throw new Error("--adopt-head: the ledger is empty, there is no head to adopt");
      if (last.seq !== seq) {
        throw new Error(`refusing --adopt-head: the current ledger head is seq ${last.seq}, not ${seq}`);
      }
      log(`last ledger entry: seq ${last.seq}, hash ${last.hash.slice(0, 12)}, time ${last.ts}`);
      log("missing head files can mean entries were deleted; restore them from a backup if you can");
      allowMissingHead = true;
      adoptedUnverified = true;
    }
  }

  const rail = openGovernedRail({
    dbPath: cfg.db,
    signedMandate: signed,
    trustedIssuerKey: cfg.owner_public_key,
    ledgerSigner,
    requireStoreBinding: true,
    headFiles,
    allowMissingHead,
    // Report the first publish failure per path without a secret and without
    // stopping the gateway: the entry is committed and a later publish repairs
    // the mirror once the permission is fixed.
    onHeadPublishError: (path, err) => {
      const code = (err as NodeJS.ErrnoException).code;
      process.stderr.write(
        `warning: could not publish the signed ledger head to ${path}${code ? ` (${code})` : ""}\n`,
      );
    },
  });
  if (adoptedUnverified) {
    (opts.log ?? (() => {}))(
      "warning: no valid signed head file was found; the current ledger head was adopted unverified",
    );
  }

  let fake: FakeUpstream | null = null;
  const upstreams: {
    openai?: { baseUrl: string; apiKey: string };
    anthropic?: { baseUrl: string; apiKey: string };
  } = {};
  try {
    if (opts.fakeUpstream) {
      fake = await startFakeUpstream({ completion: "random", seed: 1 });
      upstreams.openai = { baseUrl: fake.url, apiKey: "fake-upstream-key" };
      upstreams.anthropic = { baseUrl: fake.url, apiKey: "fake-upstream-key" };
    } else {
      const openai = resolveUpstream(cfg.upstreams.openai, opts.openaiBaseUrl);
      if (openai) upstreams.openai = openai;
      const anthropic = resolveUpstream(cfg.upstreams.anthropic, opts.anthropicBaseUrl);
      if (anthropic) upstreams.anthropic = anthropic;
    }

    const allowedAnthropicBetas = Array.isArray(cfg.allowed_anthropic_betas)
      ? cfg.allowed_anthropic_betas.filter((b): b is string => typeof b === "string")
      : DEFAULT_ANTHROPIC_BETAS;
    const gateway = createGateway({ store: rail.store, upstreams, allowedAnthropicBetas });

    const clients = new Set<{ res: ServerResponse; lastSeq: number }>();

    const flushClient = (client: { res: ServerResponse; lastSeq: number }): void => {
      try {
        const head = rail.ledger.head();
        if (head.seq <= client.lastSeq) return;
        for (const entry of rail.ledger.entries(client.lastSeq + 1)) {
          client.lastSeq = entry.seq;
          client.res.write(`id: ${entry.seq}\nevent: entry\ndata: ${JSON.stringify(rowOf(entry))}\n\n`);
        }
      } catch {
        // a client that has gone away is cleaned up by its close handler
      }
    };

    const poll = setInterval(() => {
      for (const client of clients) flushClient(client);
    }, 200);
    poll.unref?.();
    const ping = setInterval(() => {
      for (const client of clients) {
        try {
          client.res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }
    }, 15_000);
    ping.unref?.();

    const authed = (req: IncomingMessage, url: URL): boolean => {
      const header = req.headers.authorization;
      let provided: string | null = null;
      if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
        provided = header.slice(7).trim();
      } else {
        provided = url.searchParams.get("token");
      }
      if (provided === null) return false;
      const a = Buffer.from(provided, "utf8");
      const b = Buffer.from(cfg.dashboard_token, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    };

    const connectSse = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
      res.writeHead(
        200,
        withSecurity({
          "content-type": "text/event-stream",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        }),
      );
      const head = rail.ledger.head();
      const sinceHeader = req.headers["last-event-id"];
      const sinceRaw = url.searchParams.get("since") ?? (typeof sinceHeader === "string" ? sinceHeader : null);
      const since = sinceRaw !== null && sinceRaw.length > 0 && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : null;
      res.write(`event: hello\ndata: ${JSON.stringify({ seq: head.seq, hash: head.hash })}\n\n`);
      const client = { res, lastSeq: since !== null ? since : head.seq };
      clients.add(client);
      const cleanup = (): void => {
        clients.delete(client);
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
      flushClient(client);
    };

    const handleDashboard = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
      const path = url.pathname;
      const mandate = signed.mandate;
      if (req.method === "GET" && path === "/dashboard") {
        const body = Buffer.from(DASHBOARD_HTML, "utf8");
        res.writeHead(
          200,
          withSecurity({ "content-type": "text/html; charset=utf-8", "content-length": String(body.length) }),
        );
        res.end(body);
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        const budgetMicros = rail.store.getPolicy(mandate.id)?.budgetMicros ?? null;
        const spend = rail.store.spent(mandate.id);
        const head = rail.ledger.head();
        const fromSeq = Math.max(1, head.seq - 199);
        const entries = rail.ledger
          .entries(fromSeq)
          .map(rowOf)
          .reverse();
        const body = Buffer.from(
          JSON.stringify({
            mandate: {
              id: mandate.id,
              budget: mandate.budget,
              per_call_cap: mandate.per_call_cap,
              agents: mandate.agents,
              expires_at: mandate.expires_at,
            },
            budget_micros: budgetMicros,
            spent_micros: spend.committedMicros,
            remaining_micros: budgetMicros === null ? null : budgetMicros - spend.committedMicros,
            head,
            entries,
          }),
          "utf8",
        );
        res.writeHead(
          200,
          withSecurity({ "content-type": "application/json", "content-length": String(body.length) }),
        );
        res.end(body);
        return;
      }
      if (req.method === "GET" && path === "/api/events") {
        connectSse(req, res, url);
        return;
      }
      if (req.method === "GET" && path === "/api/export") {
        const pack = buildPack({ home: opts.home });
        const body = Buffer.from(JSON.stringify(pack, null, 2), "utf8");
        res.writeHead(
          200,
          withSecurity({
            "content-type": "application/json",
            "content-length": String(body.length),
            "content-disposition": `attachment; filename="tapvow-receipt-pack.json"`,
          }),
        );
        res.end(body);
        return;
      }
      if (req.method === "GET" && path === "/api/export.pdf") {
        const pack = buildPack({ home: opts.home });
        const sha = sha256Hex(JSON.stringify(pack, null, 2));
        const body = buildPdf(pdfLinesForPack(pack, sha));
        res.writeHead(
          200,
          withSecurity({
            "content-type": "application/pdf",
            "content-length": String(body.length),
            "content-disposition": `attachment; filename="tapvow-receipts.pdf"`,
          }),
        );
        res.end(body);
        return;
      }
      res.writeHead(404, withSecurity({ "content-type": "text/plain" }));
      res.end("not found\n");
    };

    const front = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path === "/dashboard" || path.startsWith("/api/")) {
        if (!authed(req, url)) {
          res.writeHead(401, withSecurity({ "content-type": "text/plain" }));
          res.end("unauthorized\n");
          return;
        }
        handleDashboard(req, res, url);
        return;
      }
      gateway.emit("request", req, res);
    });

    await new Promise<void>((resolve, reject) => {
      front.once("error", reject);
      front.listen(requestedPort, host, () => resolve());
    });

    const address = front.address() as AddressInfo;
    const port = address.port;
    const url = `http://${host}:${port}`;

    return {
      server: front,
      host,
      port,
      url,
      dashboardUrl: `${url}/dashboard?token=${cfg.dashboard_token}`,
      rail,
      async close(): Promise<void> {
        clearInterval(poll);
        clearInterval(ping);
        for (const client of clients) {
          try {
            client.res.end();
          } catch {
            // ignore
          }
        }
        clients.clear();
        await new Promise<void>((resolve) => {
          front.closeAllConnections?.();
          front.close(() => resolve());
        });
        try {
          gateway.close();
        } catch {
          // ignore
        }
        try {
          rail.close();
        } catch {
          // ignore
        }
        if (fake) await fake.close();
      },
    };
  } catch (err) {
    try {
      rail.close();
    } catch {
      // ignore
    }
    if (fake) await fake.close();
    throw err;
  }
}
