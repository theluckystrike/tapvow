// A paid resource server for tests and offline demos, built from the real
// @x402/core server classes. It answers 402 with real PAYMENT-REQUIRED headers,
// verifies and settles through a facilitator, and echoes PAYMENT-RESPONSE.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HTTPFacilitatorClient,
  type FacilitatorConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
  type RouteConfig,
} from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import type { Network } from "@x402/core/types";

const REASON_MAX = 80;
const DETAIL_MAX = 200;
const LINE_MAX = 200;
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const URL_RE = /https?:\/\/\S+/g;
const HEX_RE = /(?:0x)?[0-9a-fA-F]{16,}/g;

function stripControl(value: string): string {
  return value.replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

export function formatSettleFailure(reason: string, message?: string): string {
  const cleanReason = stripControl(reason).slice(0, REASON_MAX);
  let line = `demo resource: settle failed: ${cleanReason}`;
  if (message) {
    const lines = message.split(/\r?\n/);
    let detail = lines[0] ?? "";
    for (const candidate of lines) {
      const trimmed = candidate.trimStart();
      if (trimmed.startsWith("Details:")) {
        detail = trimmed.slice("Details:".length).trim();
        break;
      }
    }
    detail = stripControl(detail).replace(URL_RE, "<url>").replace(HEX_RE, "<hex>").slice(0, DETAIL_MAX);
    line += ` (${detail})`;
  }
  return line.slice(0, LINE_MAX);
}

export interface PaidRoute {
  path: string;
  /** e.g. "$0.01" */
  price: string;
  body: unknown;
}

export interface PaidResource {
  url: string;
  origin: string;
  paidRequests: number;
  close(): Promise<void>;
}

export interface StartPaidResourceOptions {
  facilitatorUrl: string;
  /** Per-path auth headers, e.g. cdpFacilitatorAuth(key). Sent with every facilitator request. */
  facilitatorAuth?: NonNullable<FacilitatorConfig["createAuthHeaders"]>;
  network: string;
  payTo: string;
  routes: PaidRoute[];
  /** Served as JSON at /.well-known/spendmandate-payees.json when set. */
  wellKnown?: unknown;
}

export async function startPaidResource(opts: StartPaidResourceOptions): Promise<PaidResource> {
  const facilitator = new HTTPFacilitatorClient(
    {
      url: opts.facilitatorUrl,
      ...(opts.facilitatorAuth ? { createAuthHeaders: opts.facilitatorAuth } : {}),
    },
  );
  const resourceServer = new x402ResourceServer(facilitator);
  registerExactEvmScheme(resourceServer, { networks: [opts.network as Network] });

  const routeConfigs: Record<string, RouteConfig> = {};
  for (const route of opts.routes) {
    routeConfigs[route.path] = {
      accepts: { scheme: "exact", payTo: opts.payTo, price: route.price, network: opts.network as Network },
    };
  }
  const httpServer = new x402HTTPResourceServer(resourceServer, routeConfigs);
  await httpServer.initialize();

  const state = { paidRequests: 0 };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (
          (req.method ?? "GET") === "GET" &&
          path === "/.well-known/spendmandate-payees.json" &&
          opts.wellKnown !== undefined
        ) {
          writeBody(res, 200, { "content-type": "application/json" }, JSON.stringify(opts.wellKnown));
          return;
        }

        const adapter: HTTPAdapter = {
          getHeader: (name) => {
            const value = req.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
          getMethod: () => req.method ?? "GET",
          getPath: () => path,
          getUrl: () => `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`,
          getAcceptHeader: () => String(req.headers.accept ?? ""),
          getUserAgent: () => String(req.headers["user-agent"] ?? ""),
        };
        const context = { adapter, path, method: adapter.getMethod() };

        const result = await httpServer.processHTTPRequest(context);
        if (result.type === "no-payment-required") {
          const route = opts.routes.find((r) => r.path === path);
          if (route) {
            writeBody(res, 200, { "content-type": "application/json" }, JSON.stringify(route.body));
          } else {
            writeBody(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "not found" }));
          }
          return;
        }
        if (result.type === "payment-error") {
          writeInstructions(res, result.response);
          return;
        }

        state.paidRequests += 1;
        const route = opts.routes.find((r) => r.path === path);
        const settle = await httpServer.processSettlement(
          result.paymentPayload,
          result.paymentRequirements,
          result.declaredExtensions,
          { request: context },
        );
        if (!settle.success) {
          console.error(formatSettleFailure(settle.errorReason, settle.errorMessage));
          if (process.env.X402_DEMO_DEBUG === "1" && settle.errorMessage) console.error(settle.errorMessage);
          writeInstructions(res, settle.response);
          return;
        }
        writeBody(
          res,
          200,
          { "content-type": "application/json", ...settle.headers },
          JSON.stringify(route?.body ?? {}),
        );
      } catch (err) {
        writeBody(
          res,
          500,
          { "content-type": "application/json" },
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        );
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        get url() {
          return `http://127.0.0.1:${port}/`;
        },
        origin: `http://127.0.0.1:${port}`,
        get paidRequests() {
          return state.paidRequests;
        },
        close(): Promise<void> {
          return new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

function writeBody(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, { ...headers, "content-length": String(payload.length) });
  res.end(payload);
}

function writeInstructions(
  res: ServerResponse,
  instructions: { status: number; headers: Record<string, string>; body?: unknown },
): void {
  let body: string;
  if (typeof instructions.body === "string") body = instructions.body;
  else body = JSON.stringify(instructions.body ?? {});
  writeBody(res, instructions.status, instructions.headers, body);
}
