import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { canonicalize } from "@mandate/core";
import type { TrustedCredential } from "@mandate/passkey";
import { sanitize } from "./sanitize.js";
import type { ApprovalDecision, ApprovalRequest, Approver } from "./types.js";

export const CHALLENGE_PREFIX = "spendmandate/approval/v1\n";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING = 2;
const RETENTION_MS = 10 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;
const EXPIRED_TEXT = "Expired";
const DECIDED_TEXT = "already decided";
const NO_LONGER_OPEN_TEXT = "This request is no longer open.";
const IN_PROGRESS_TEXT = "decision in progress";
const REPLAYED_ASSERTION_TEXT = "assertion already used";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface PasskeyApproverOptions {
  /** Trusted passkey credentials, from @mandate/passkey. */
  credentials: TrustedCredential[];
  /** WebAuthn relying party id, for example "localhost" or "approve.example". */
  rpID: string;
  /** Exact page origin, for example "https://approve.example" or "http://localhost:47831". */
  origin: string;
  /** Where the page is reachable, used to build links, for example origin. */
  baseUrl: string;
  /** Delivers the link (Telegram, push, a log line). A throw is a deny. */
  notify: (link: string, req: ApprovalRequest) => void | Promise<void>;
  /** Default 60_000. */
  timeoutMs?: number;
  /** Default 2. Open prompts allowed per agent at once; more are denied immediately. */
  maxPendingPerAgent?: number;
  now?: () => number;
  onDecision?: (req: ApprovalRequest, decision: ApprovalDecision) => void;
  /** Persist counters; called after a successful assertion. */
  onCounter?: (credentialId: string, newCounter: number) => void;
}

interface Pending {
  requestId: string;
  token: string;
  nonce: string;
  req: ApprovalRequest;
  startedAt: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  /** True while a decision POST is awaiting verification; blocks a second one. */
  verifying: boolean;
  /** Assertion signatures already presented for this request; replays are refused. */
  usedAssertions: Set<string>;
  resolve: (decision: ApprovalDecision) => void;
}

interface Settled {
  token: string;
  decision: ApprovalDecision;
  timer: ReturnType<typeof setTimeout> | null;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function usd(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type BodyResult = { ok: true; buf: Buffer } | { ok: false; tooLarge: true };

function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      length += chunk.length;
      if (length > maxBytes) {
        done = true;
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve({ ok: true, buf: Buffer.concat(chunks) });
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The page a link points at. It reads r and t from the query string, fetches
 * the challenges, asks the platform authenticator for an assertion over the
 * challenge of the pressed button and posts it back. No external scripts and
 * no inline script.
 */
export const APPROVAL_APP_JS = `(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var r = params.get("r") || "";
  var t = params.get("t") || "";
  var statusEl = document.getElementById("status");
  var challenges = null;
  var rpId = "";
  var timeoutMs = 60000;
  var allowCredentials = [];

  function b64urlToBytes(value) {
    var s = String(value).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function bytesToB64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }

  function show(message) {
    if (statusEl) statusEl.textContent = message;
  }

  var ready = fetch("/approve/options?r=" + encodeURIComponent(r) + "&t=" + encodeURIComponent(t), {
    headers: { accept: "application/json" }
  })
    .then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : "options failed");
        return body;
      });
    })
    .then(function (opts) {
      challenges = opts.challenges;
      rpId = opts.rpId;
      timeoutMs = opts.timeoutMs;
      allowCredentials = (opts.allowCredentials || []).map(function (c) {
        return { id: b64urlToBytes(c.id), type: c.type || "public-key" };
      });
      show("Waiting for your passkey.");
    })
    .catch(function (err) {
      show("Could not load this request. " + err.message);
    });

  function decide(decision) {
    // Wait for the challenges before asking the authenticator, so a click that
    // lands during load still works.
    ready.then(function () {
      if (!challenges) {
        show("Could not load this request.");
        return;
      }
      show("Waiting for your passkey.");
      var challenge = b64urlToBytes(challenges[decision]);
      return navigator.credentials
      .get({
        publicKey: {
          challenge: challenge,
          rpId: rpId,
          allowCredentials: allowCredentials,
          userVerification: "required",
          timeout: timeoutMs
        }
      })
      .then(function (cred) {
        if (!cred || !cred.response) throw new Error("no assertion returned");
        var response = cred.response;
        var assertion = {
          id: cred.id,
          rawId: bytesToB64url(cred.rawId),
          type: "public-key",
          response: {
            clientDataJSON: bytesToB64url(response.clientDataJSON),
            authenticatorData: bytesToB64url(response.authenticatorData),
            signature: bytesToB64url(response.signature),
            userHandle: response.userHandle ? bytesToB64url(response.userHandle) : null
          },
          clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
        };
        return fetch("/approve/decision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ r: r, t: t, decision: decision, assertion: assertion })
        });
      })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (out) {
        if (out.body && out.body.decision) {
          show("Decision " + out.body.decision + ".");
        } else if (out.body && out.body.error) {
          show("Refused. " + out.body.error);
        } else {
          show("Done (" + out.status + ").");
        }
      })
      .catch(function (err) {
        show("Failed. " + (err && err.message ? err.message : "unknown error"));
      });
    });
  }

  document.getElementById("approve").addEventListener("click", function () { decide("approve"); });
  document.getElementById("deny").addEventListener("click", function () { decide("deny"); });
})();
`;

export class PasskeyApprover implements Approver {
  static readonly DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

  private readonly credentials: TrustedCredential[];
  private readonly rpID: string;
  private readonly origin: string;
  private readonly baseUrl: string;
  private readonly notify: (link: string, req: ApprovalRequest) => void | Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxPendingPerAgent: number;
  private readonly now: () => number;
  private readonly onDecision:
    | ((req: ApprovalRequest, decision: ApprovalDecision) => void)
    | undefined;
  private readonly onCounter: ((credentialId: string, newCounter: number) => void) | undefined;

  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Map<string, Settled>();
  private readonly counters = new Map<string, number>();
  private closed = false;

  constructor(opts: PasskeyApproverOptions) {
    this.credentials = opts.credentials;
    this.rpID = opts.rpID;
    this.origin = opts.origin;
    this.baseUrl = opts.baseUrl;
    this.notify = opts.notify;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPendingPerAgent = opts.maxPendingPerAgent ?? DEFAULT_MAX_PENDING;
    this.now = opts.now ?? (() => Date.now());
    this.onDecision = opts.onDecision;
    this.onCounter = opts.onCounter;
    for (const credential of opts.credentials) {
      if (!this.counters.has(credential.id)) this.counters.set(credential.id, credential.counter);
    }
  }

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const requestId = "apr_" + randomBytes(18).toString("base64url");
    const startedAt = this.now();

    if (this.closed) {
      const decision = this.timeoutDecision(requestId, startedAt);
      this.safeOnDecision(req, decision);
      return Promise.resolve(decision);
    }

    // An agent firing many parallel calls must not flood the owner with
    // prompts; extra requests are denied at once (fail closed).
    let open = 0;
    for (const p of this.pending.values()) if (!p.settled && p.req.agentId === req.agentId) open++;
    if (open >= this.maxPendingPerAgent) {
      const decision = this.timeoutDecision(requestId, startedAt);
      this.safeOnDecision(req, decision);
      return Promise.resolve(decision);
    }

    const token = randomBytes(32).toString("base64url");
    const nonce = randomBytes(18).toString("base64url");

    return new Promise<ApprovalDecision>((resolve) => {
      const pending: Pending = {
        requestId,
        token,
        nonce,
        req,
        startedAt,
        deadline: startedAt + this.timeoutMs,
        timer: null,
        settled: false,
        verifying: false,
        usedAssertions: new Set<string>(),
        resolve,
      };
      pending.timer = setTimeout(() => this.settleTimeout(pending), this.timeoutMs);
      this.pending.set(requestId, pending);

      const link = this.baseUrl + "/approve?r=" + encodeURIComponent(requestId) + "&t=" + encodeURIComponent(token);
      void (async () => {
        try {
          await this.notify(link, req);
        } catch {
          // Fail closed: the owner never got the link, so the call is denied.
          this.settleTimeout(pending);
        }
      })();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) this.settleTimeout(pending);
    // Settled requests are kept after close so a late POST still answers 409
    // rather than 404. Their unref'd retention timers drop them on the normal
    // ten minute schedule.
  }

  routes(): Record<string, RouteHandler> {
    return {
      "GET /approve": (req, res) => this.handlePage(req, res),
      "GET /approve/app.js": (req, res) => this.handleAppJs(req, res),
      "GET /approve/options": (req, res) => this.handleOptions(req, res),
      "POST /approve/decision": (req, res) => this.handleDecision(req, res),
    };
  }

  private challengeFor(pending: Pending, decision: "approve" | "deny"): string {
    const canonical = canonicalize({
      request_id: pending.requestId,
      nonce: pending.nonce,
      decision,
      mandate_id: pending.req.mandateId,
      agent_id: pending.req.agentId,
      rail: pending.req.rail,
      payee: pending.req.payee,
      amount_micros: pending.req.amountMicros,
    });
    return createHash("sha256").update(CHALLENGE_PREFIX + canonical, "utf8").digest("base64url");
  }

  private timeoutDecision(requestId: string, startedAt: number): ApprovalDecision {
    const at = this.now();
    return {
      decision: "timeout",
      requestId,
      decidedAt: new Date(at).toISOString(),
      latencyMs: Math.max(0, at - startedAt),
    };
  }

  private decideDecision(requestId: string, startedAt: number, approved: boolean, credentialId: string): ApprovalDecision {
    const at = this.now();
    return {
      decision: approved ? "approved" : "denied",
      requestId,
      decidedBy: "passkey:" + credentialId,
      decidedAt: new Date(at).toISOString(),
      latencyMs: Math.max(0, at - startedAt),
    };
  }

  private safeOnDecision(req: ApprovalRequest, decision: ApprovalDecision): void {
    try {
      this.onDecision?.(req, decision);
    } catch {
      // a broken callback must not affect the decision
    }
  }

  private settleTimeout(pending: Pending): void {
    if (pending.settled) return;
    this.settle(pending, this.timeoutDecision(pending.requestId, pending.startedAt));
  }

  private settle(pending: Pending, decision: ApprovalDecision): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(pending.requestId);

    const timer = setTimeout(() => {
      this.settled.delete(pending.requestId);
    }, RETENTION_MS);
    if (typeof (timer as { unref?: () => void }).unref === "function") timer.unref();
    this.settled.set(pending.requestId, { token: pending.token, decision, timer });

    this.safeOnDecision(pending.req, decision);
    pending.resolve(decision);
  }

  private lookup(requestId: string, token: string): { kind: "open"; pending: Pending } | { kind: "settled"; settled: Settled } | null {
    const pending = this.pending.get(requestId);
    if (pending && sameToken(pending.token, token)) return { kind: "open", pending };
    const settled = this.settled.get(requestId);
    if (settled && sameToken(settled.token, token)) return { kind: "settled", settled };
    return null;
  }

  private send(res: ServerResponse, status: number, contentType: string, body: string, extra: Record<string, string> = {}): void {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }
    const payload = Buffer.from(body, "utf8");
    res.writeHead(status, {
      "content-type": contentType,
      "content-length": String(payload.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...extra,
    });
    res.end(payload);
  }

  private sendJson(res: ServerResponse, status: number, obj: unknown): void {
    this.send(res, status, "application/json", JSON.stringify(obj));
  }

  private notFound(res: ServerResponse): void {
    // Says nothing about why the request was refused.
    this.send(res, 404, "text/plain; charset=utf-8", "Not found");
  }

  private async handlePage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const r = url.searchParams.get("r") ?? "";
    const t = url.searchParams.get("t") ?? "";
    const found = this.lookup(r, t);
    if (!found) {
      this.notFound(res);
      return;
    }

    // L1: once a request is decided or expired the page is gone for good, with
    // no buttons to press. A stale tab must not be able to post a decision.
    if (found.kind === "settled") {
      this.send(res, 409, "text/plain; charset=utf-8", NO_LONGER_OPEN_TEXT);
      return;
    }
    if (this.now() > found.pending.deadline) {
      this.send(res, 409, "text/plain; charset=utf-8", NO_LONGER_OPEN_TEXT);
      return;
    }

    const pending = found.pending;
    const seconds = Math.max(0, Math.ceil((pending.deadline - this.now()) / 1000));
    const req0 = pending.req;
    const rows = [
      "<p>Agent: " + esc(sanitize(req0.agentId)) + "</p>",
      "<p>Rail: " + esc(sanitize(req0.rail)) + "</p>",
      "<p>Payee: " + esc(sanitize(req0.payee)) + "</p>",
      "<p>Amount: " + usd(req0.amountMicros) + " USD</p>",
      "<p>Summary: " + esc(sanitize(req0.summary, 300)) + "</p>",
      "<p>Seconds left: " + seconds + "</p>",
    ];

    const html = [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>TapVow approval</title>",
      "</head>",
      "<body>",
      "<h1>TapVow approval</h1>",
      ...rows,
      '<button id="approve" type="button">Approve</button>',
      '<button id="deny" type="button">Deny</button>',
      '<p id="status"></p>',
      '<script src="/approve/app.js"></script>',
      "</body>",
      "</html>",
      "",
    ].join("\n");

    this.send(res, 200, "text/html; charset=utf-8", html, { "content-security-policy": CSP });
  }

  private async handleAppJs(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.send(res, 200, "application/javascript; charset=utf-8", APPROVAL_APP_JS);
  }

  private async handleOptions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const r = url.searchParams.get("r") ?? "";
    const t = url.searchParams.get("t") ?? "";
    const found = this.lookup(r, t);
    if (!found) {
      this.notFound(res);
      return;
    }
    if (found.kind === "settled") {
      this.sendJson(res, 409, { error: this.settledReason(found.settled.decision) });
      return;
    }

    const pending = found.pending;
    this.sendJson(res, 200, {
      rpId: this.rpID,
      timeoutMs: Math.max(0, pending.deadline - this.now()),
      // The nonce is one of the challenge inputs. It is not a secret (the
      // challenge hash is already returned, and an assertion still needs the
      // credential's private key), so the page may see it.
      nonce: pending.nonce,
      allowCredentials: this.credentials.map((c) => ({ id: c.id, type: "public-key" })),
      challenges: {
        approve: this.challengeFor(pending, "approve"),
        deny: this.challengeFor(pending, "deny"),
      },
    });
  }

  private settledReason(decision: ApprovalDecision): string {
    return decision.decision === "timeout" ? EXPIRED_TEXT : DECIDED_TEXT;
  }

  private async handleDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const read = await readBody(req, MAX_BODY_BYTES);
    if (!read.ok) {
      this.sendJson(res, 413, { error: "request body too large" });
      req.destroy();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(read.buf.toString("utf8"));
    } catch {
      this.sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (!isPlainObject(body)) {
      this.sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const r = typeof body.r === "string" ? body.r : "";
    const t = typeof body.t === "string" ? body.t : "";
    const decisionValue = body.decision;
    if (decisionValue !== "approve" && decisionValue !== "deny") {
      this.sendJson(res, 400, { error: "decision must be approve or deny" });
      return;
    }
    const decision: "approve" | "deny" = decisionValue;

    const found = this.lookup(r, t);
    if (!found) {
      this.notFound(res);
      return;
    }
    if (found.kind === "settled") {
      this.sendJson(res, 409, { error: this.settledReason(found.settled.decision) });
      return;
    }

    const pending = found.pending;
    const assertion = body.assertion;
    if (!isPlainObject(assertion) || typeof assertion.id !== "string" || assertion.id.length === 0) {
      this.sendJson(res, 403, { error: "invalid assertion" });
      return;
    }
    const credential = this.credentials.find((c) => c.id === assertion.id);
    if (!credential) {
      this.sendJson(res, 403, { error: "credential not trusted" });
      return;
    }

    // H1: one verification at a time per request. A second POST while a
    // verification is in flight is refused, so approve and deny cannot race.
    if (pending.verifying) {
      this.sendJson(res, 409, { error: IN_PROGRESS_TEXT });
      return;
    }

    // H1: an assertion is one-time. A signature already presented for this
    // request (for example a replay of the winning one before it settles) is
    // refused even if the request is still open.
    const assertionResponse = assertion.response;
    const signature =
      isPlainObject(assertionResponse) && typeof assertionResponse.signature === "string"
        ? assertionResponse.signature
        : "";
    if (signature.length > 0 && pending.usedAssertions.has(signature)) {
      this.sendJson(res, 409, { error: REPLAYED_ASSERTION_TEXT });
      return;
    }

    pending.verifying = true;
    if (signature.length > 0) pending.usedAssertions.add(signature);

    const verifyCounter = this.counters.get(credential.id) ?? credential.counter;
    let newCounter: number;
    try {
      const result = await verifyAuthenticationResponse({
        response: assertion as unknown as AuthenticationResponseJSON,
        expectedChallenge: this.challengeFor(pending, decision),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        expectedType: "webauthn.get",
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
          counter: verifyCounter,
        },
      });
      if (!result.verified) {
        this.sendJson(res, 403, { error: "assertion not verified" });
        return;
      }
      if (result.authenticationInfo.userVerified !== true) {
        this.sendJson(res, 403, { error: "user was not verified" });
        return;
      }
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      // Never echo the verifier's error text: it includes the expected challenge.
      this.sendJson(res, 403, { error: "assertion not verified" });
      return;
    } finally {
      pending.verifying = false;
    }

    // H1: the await can span a timeout or another settlement. Only this same,
    // still-open, unexpired request may be settled; otherwise refuse and leave
    // the counters untouched.
    if (this.pending.get(pending.requestId) !== pending || pending.settled) {
      const settled = this.settled.get(pending.requestId);
      this.sendJson(res, 409, {
        error: settled ? this.settledReason(settled.decision) : NO_LONGER_OPEN_TEXT,
      });
      return;
    }
    if (this.now() > pending.deadline) {
      this.sendJson(res, 409, { error: EXPIRED_TEXT });
      return;
    }

    // H1: read the counter again now that the await is over; a parallel request
    // for the same credential may have advanced it, and a stored counter is
    // never lowered.
    const storedCounter = this.counters.get(credential.id) ?? credential.counter;
    if (storedCounter > 0 || newCounter > 0) {
      if (!(newCounter > storedCounter)) {
        this.sendJson(res, 403, { error: "signature counter did not increase" });
        return;
      }
    }

    this.counters.set(credential.id, newCounter);
    try {
      this.onCounter?.(credential.id, newCounter);
    } catch {
      // persisting the counter is best effort; the decision still stands
    }

    const settledDecision = this.decideDecision(
      pending.requestId,
      pending.startedAt,
      decision === "approve",
      credential.id,
    );
    this.settle(pending, settledDecision);
    this.sendJson(res, 200, { decision: settledDecision.decision });
  }
}
