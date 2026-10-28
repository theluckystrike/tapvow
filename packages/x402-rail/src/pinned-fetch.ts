// A fetch implementation that pins the connection to the address it checked.
//
// A plain fetch resolves the host for the private-address check and then lets
// the network stack resolve it again. A host that answers with a public address
// first and a private one later (DNS rebinding) would slip through. Here the
// host is resolved once and every request carries that exact address into
// node:http/node:https, so the connection cannot go anywhere else.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateAddress } from "./private-address.js";

export interface PinnedResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolve a host to the address(es) a request may connect to. */
export type ResolveHost = (host: string) => Promise<PinnedResolvedAddress[]>;

export interface PinnedFetchOptions {
  /** Resolve a host to one or more addresses. Defaults to node:dns/promises. */
  resolve?: ResolveHost;
  /** Whether an address must be refused. Defaults to isPrivateAddress. */
  isBlocked?: (address: string) => boolean;
  /** Allow private, loopback and link-local addresses. Default false. */
  allowPrivate?: boolean;
  /**
   * Total deadline in milliseconds for connect, headers and body, plus the
   * socket idle timeout. Default 30000.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const NULL_BODY_STATUS = new Set([204, 205, 304]);

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/** Resolve a host with node:dns, passing IP literals straight through. */
export function defaultResolveHost(host: string): Promise<PinnedResolvedAddress[]> {
  const bare = bareHost(host);
  const literal = isIP(bare);
  if (literal === 4 || literal === 6) return Promise.resolve([{ address: bare, family: literal }]);
  return lookup(bare, { all: true }).then((found) =>
    found.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 })),
  );
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

function timeoutError(message: string): Error {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

function bodyToBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError("unsupported request body: expected a string, Uint8Array or ArrayBuffer");
}

function headersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

export function createPinnedFetch(opts: PinnedFetchOptions = {}): typeof fetch {
  const resolveHost = opts.resolve ?? defaultResolveHost;
  const isBlocked = opts.isBlocked ?? isPrivateAddress;
  const allowPrivate = opts.allowPrivate === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function pinnedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : isRequest ? (input as Request).url : String(input);
    const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
    const signal = init?.signal ?? (isRequest ? (input as Request).signal : undefined);

    return new Promise<Response>((resolve, reject) => {
      let req: ClientRequest | null = null;
      let response: IncomingMessage | null = null;
      let settled = false;
      let deadline: NodeJS.Timeout | null = null;

      const clearDeadline = (): void => {
        if (deadline !== null) {
          clearTimeout(deadline);
          deadline = null;
        }
      };
      const settleResolve = (value: Response): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const onAbort = (): void => {
        clearDeadline();
        const err = abortError();
        response?.destroy(err);
        req?.destroy(err);
        settleReject(err);
      };
      const failTimeout = (where: string): void => {
        clearDeadline();
        const err = timeoutError(`request to ${rawUrl} timed out after ${timeoutMs} ms (${where})`);
        response?.destroy(err);
        req?.destroy(err);
        settleReject(err);
      };

      // The abort listener is added before any await, so an abort during the
      // DNS lookup or before the request starts is not lost.
      if (signal) {
        if (signal.aborted) {
          settleReject(abortError());
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      void (async () => {
        try {
          const url = new URL(rawUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new TypeError(`only http and https URLs are allowed, got ${url.protocol}`);
          }

          const hostname = url.hostname;
          const host = bareHost(hostname);

          // The deadline starts before the lookup so a resolver that never
          // answers is bounded too.
          deadline = setTimeout(() => failTimeout("deadline"), timeoutMs);

          const literal = isIP(host);
          let resolved: PinnedResolvedAddress[];
          if (literal === 4 || literal === 6) {
            // An IP literal is its own resolution: check it and connect to it
            // without asking the resolver, which could answer otherwise.
            resolved = [{ address: host, family: literal }];
          } else {
            resolved = await resolveHost(host);
          }
          if (settled) return;
          if (resolved.length === 0) throw new Error(`host ${hostname} does not resolve`);

          if (!allowPrivate) {
            for (const entry of resolved) {
              if (isBlocked(entry.address)) {
                throw new Error(`host ${hostname} resolves to a private, loopback or link-local address`);
              }
            }
          }
          // An abort that fired during the lookup must not start a request.
          if (signal?.aborted) {
            onAbort();
            return;
          }
          const pinned = resolved[0]!;

          const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
          headers.set("host", url.host);

          let body: Buffer | undefined;
          if (init?.body !== undefined) {
            body = bodyToBuffer(init.body);
          } else if (isRequest && (input as Request).body !== null) {
            body = Buffer.from(await (input as Request).arrayBuffer());
          }
          if (settled) return;
          if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
            headers.set("content-length", String(body.length));
          }

          const lookupPinned: LookupFunction = (_hostname, options, callback) => {
            const wantsAll = typeof options === "object" && options !== null && options.all === true;
            if (wantsAll) {
              callback(null, [{ address: pinned.address, family: pinned.family }]);
            } else {
              callback(null, pinned.address, pinned.family);
            }
          };

          const requestOptions: import("node:http").RequestOptions = {
            hostname: host,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method,
            headers: headersRecord(headers),
            agent: false,
            lookup: lookupPinned,
          };
          if (url.protocol === "https:" && isIP(host) === 0) {
            (requestOptions as import("node:https").RequestOptions).servername = host;
          }

          const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;

          // The deadline was armed before the lookup and covers connect,
          // headers and body. It stays armed after the headers resolve, and
          // destroying the response errors the body stream if it fires
          // mid-download.
          req = requestFn(requestOptions, (res) => {
            response = res;
            res.once("close", clearDeadline);
            try {
              const responseHeaders = new Headers();
              for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
                responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
              }
              const status = res.statusCode ?? 0;
              const statusText = res.statusMessage ?? "";
              if (NULL_BODY_STATUS.has(status) || method === "HEAD") {
                res.resume();
                settleResolve(new Response(null, { status, statusText, headers: responseHeaders }));
                return;
              }
              const stream = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
              settleResolve(new Response(stream, { status, statusText, headers: responseHeaders }));
            } catch {
              const status = res.statusCode ?? 0;
              res.destroy();
              settleReject(new TypeError(`the server returned an invalid response status ${status}`));
            }
          });

          req.on("error", (err) => {
            clearDeadline();
            if (signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
            settleReject(err);
          });
          req.on("upgrade", (_res, socket) => {
            clearDeadline();
            socket.destroy();
            settleReject(new TypeError("unexpected 101 upgrade response"));
          });
          req.on("close", () => {
            if (signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
          });

          req.setTimeout(timeoutMs, () => failTimeout("socket idle"));

          if (body !== undefined) req.end(body);
          else req.end();
        } catch (err) {
          clearDeadline();
          settleReject(err);
        }
      })();
    });
  }

  return pinnedFetch as typeof fetch;
}
