import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { worstCaseMicros, settleMicros, PRICING, type Usage } from "./pricing.js";
import { worstCase, type Dialect } from "./estimate.js";
import type { BudgetStore, Deny, SettleEvent } from "./store.js";

export interface GatewayOptions {
  store: BudgetStore;
  upstreams: {
    openai?: { baseUrl: string; apiKey: string };
    anthropic?: { baseUrl: string; apiKey: string };
  };
  /** Overrides the per-model defaultOutputTokens of the price table for every model. Still clamped to the model's maxOutputTokens. */
  defaultMaxTokens?: number;
  maxBodyBytes?: number;
  /** Upstream idle timeout in ms: no response headers or body bytes from the provider for this long aborts the call. Default 600000 (the OpenAI and Anthropic SDK default). */
  upstreamTimeoutMs?: number;
  /** Response headers that carry the call's USD cost. Default ["x-cost-usd", "x-upstream-cost-usd"]. */
  costHeaders?: string[];
  /** anthropic-beta values allowed through. Betas can switch on pricier features (1M context, server tools), so none by default. */
  allowedAnthropicBetas?: string[];
  /** Extra routes served by the same gateway, keyed "METHOD /path". The path is matched exactly and the query string is ignored, e.g. the x402 rail at "POST /v1/x402/fetch". */
  routes?: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>;
  /**
   * Optional human step-up approval. When a reservation only fails because it
   * crosses the mandate's approval threshold, the gateway asks this approver and
   * retries the reservation with the decision. Declared structurally so the LLM
   * rail never depends on the approval package.
   */
  approver?: {
    request(req: {
      mandateId: string;
      agentId: string;
      rail: "llm" | "x402";
      payee: string;
      amountMicros: number;
      summary: string;
    }): Promise<{ decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string }>;
  };
}

// Upstream error bodies can echo part of the key ("Incorrect API key provided: sk-...abcd").
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out.replace(/\b(sk|mk)[-_][A-Za-z0-9_*.-]{6,}/g, "[redacted]");
}

type ReadResult = { kind: "ok"; buf: Buffer } | { kind: "tooLarge" };
type IdleTimer = ReturnType<typeof setTimeout> & { unref?: () => void };

function sendJson(
  res: ServerResponse,
  status: number,
  obj: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}

function denyPayload(dialect: Dialect, code: string, message: string): unknown {
  if (dialect === "anthropic") {
    return { type: "error", error: { type: "mandate_denied", message }, code };
  }
  return { error: { message, type: "mandate_denied", code } };
}

function apiErrorPayload(dialect: Dialect, message: string): unknown {
  if (dialect === "anthropic") {
    return { type: "error", error: { type: "invalid_request_error", message } };
  }
  return { error: { message, type: "invalid_request_error" } };
}

/**
 * The largest output bound k in [0, maxOutput] with worstCaseMicros(model, inputTokens, k, mayWriteCache) <= limitMicros,
 * found by binary search (the cost grows with k). Returns 0 when even k = 0 is above the limit.
 */
export function fittingMaxTokens(model: string, inputTokens: number, mayWriteCache: boolean, limitMicros: number, maxOutput: number): number {
  const fits = (k: number): boolean => worstCaseMicros(model, inputTokens, k, mayWriteCache) <= limitMicros;
  if (!fits(0)) return 0;
  let lo = 0;
  let hi = Math.max(0, Math.floor(maxOutput));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A per_call_cap refusal that also tells the client which max_tokens would fit. */
function perCallCapPayload(dialect: Dialect, message: string, suggestedMaxTokens: number): unknown {
  const error = { message, type: "mandate_denied", param: "max_tokens", suggested_max_tokens: suggestedMaxTokens };
  if (dialect === "anthropic") {
    return { type: "error", error, code: "per_call_cap" };
  }
  return { error: { ...error, code: "per_call_cap" } };
}

function mandateHeaders(
  reserved: number | null,
  charged: number | null,
  extra: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = {};
  if (reserved != null) h["X-Mandate-Reserved-Micros"] = String(reserved);
  if (charged != null) h["X-Mandate-Charged-Micros"] = String(charged);
  return { ...h, ...extra };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      length += chunk.length;
      if (length > maxBytes) {
        done = true;
        resolve({ kind: "tooLarge" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve({ kind: "ok", buf: Buffer.concat(chunks) });
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

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

function extractKey(req: IncomingMessage, dialect: Dialect): string | null {
  if (dialect === "openai") return bearer(req);
  const apiKey = req.headers["x-api-key"];
  const auth = bearer(req);
  // A client can send a real provider key in x-api-key (left over in the
  // shell) next to the virtual key as a bearer token. Prefer the virtual key;
  // the real one is never forwarded or stored either way.
  if (typeof apiKey === "string" && apiKey.startsWith("mk_")) return apiKey;
  if (auth !== null && auth.startsWith("mk_")) return auth;
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  return auth;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The model name of a denied call is written to the signed ledger, so it must
// never be the raw, attacker-controlled string (up to the 4 MB body limit).
// Keep it only when it looks like a model id; anything else (including
// "<img src=x onerror=alert(1)>") becomes "invalid".
function safeModel(model: unknown): string {
  return typeof model === "string" && /^[A-Za-z0-9._:\/-]{1,64}$/.test(model) ? model : "invalid";
}

function openAIUsage(usage: any): Usage | null {
  if (!usage || typeof usage !== "object") return null;
  const input = numOrNull(usage.prompt_tokens);
  const completion = numOrNull(usage.completion_tokens);
  if (input == null && completion == null) return null;
  const cached = numOrNull(usage.prompt_tokens_details?.cached_tokens) ?? 0;
  const reasoning =
    numOrNull(usage.completion_tokens_details?.reasoning_tokens) ?? numOrNull(usage.reasoning_tokens) ?? 0;
  let output = completion ?? 0;
  // Reasoning tokens are inside completion_tokens on the providers this rail
  // sees, so a reasoning count larger than completion_tokens alone does not mean
  // they are billed separately (three dogfood calls metered this way over-booked
  // by exactly the reasoning count). Bill them outside completion_tokens only on
  // an explicit signal: total_tokens counts more than prompt + completion. The
  // extra is total - prompt - completion, never more than the reported reasoning
  // count when one is reported, so a stray total cannot inflate the bill.
  const total = numOrNull(usage.total_tokens);
  if (total != null && total > (input ?? 0) + output) {
    let extra = total - (input ?? 0) - output;
    if (reasoning > 0) extra = Math.min(extra, reasoning);
    output += extra;
  }
  return { inputTokens: input ?? 0, outputTokens: output, cachedInputTokens: cached, reasoningTokens: reasoning };
}

/**
 * The USD cost an upstream reports for a call, if any. OpenRouter and Nous put
 * the number in usage.cost, others use usage.cost_usd / usage.total_cost, and
 * some send it as a response header. A numeric string is accepted; anything
 * missing, non-finite or negative is ignored so a placeholder never overrides
 * the price table.
 */
function upstreamCostUsd(usage: any, headers: Headers | undefined, headerNames: string[]): number | null {
  const fromValue = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  if (usage && typeof usage === "object") {
    for (const value of [usage.cost, usage.cost_usd, usage.total_cost]) {
      const n = fromValue(value);
      if (n != null) return n;
    }
  }
  if (headers) {
    for (const name of headerNames) {
      const n = fromValue(headers.get(name));
      if (n != null) return n;
    }
  }
  return null;
}

function anthropicUsage(usage: any): Usage | null {
  if (!usage || typeof usage !== "object") return null;
  const input = numOrNull(usage.input_tokens);
  if (input == null) return null;
  const creation = numOrNull(usage.cache_creation_input_tokens) ?? 0;
  const read = numOrNull(usage.cache_read_input_tokens) ?? 0;
  // Anthropic's output_tokens already includes thinking tokens, and its usage
  // has no separate reasoning/total split to reconcile, so output is billed as
  // reported. There is no equivalent of the OpenAI overcount rule to fix here.
  const output = numOrNull(usage.output_tokens) ?? 0;
  return { inputTokens: input + creation + read, outputTokens: output, cachedInputTokens: read, cacheWriteTokens: creation };
}

function combineAnthropic(startUsage: any, outputTokens: number | null): Usage | null {
  if (!startUsage || outputTokens == null) return null;
  return anthropicUsage({ ...startUsage, output_tokens: outputTokens });
}

function parseSseData(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function createGateway(opts: GatewayOptions): Server {
  const store = opts.store;
  const approver = opts.approver;
  const maxBodyBytes = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const costHeaders = opts.costHeaders ?? ["x-cost-usd", "x-upstream-cost-usd"];
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 600_000;

  async function proxy(req: IncomingMessage, res: ServerResponse, dialect: Dialect): Promise<void> {
    const upstream = opts.upstreams[dialect];
    const path = dialect === "openai" ? "/v1/chat/completions" : "/v1/messages";

    // Authenticate before reading the body, so an unauthenticated client
    // cannot make the gateway buffer up to maxBodyBytes.
    const key = extractKey(req, dialect);
    const auth = key !== null ? store.authenticate(key) : null;
    if (!auth) {
      sendJson(res, 401, denyPayload(dialect, "invalid_key", "invalid or missing API key"));
      req.resume();
      return;
    }

    const read = await readBody(req, maxBodyBytes);
    if (read.kind === "tooLarge") {
      sendJson(res, 413, apiErrorPayload(dialect, "request body exceeds limit"));
      req.destroy();
      return;
    }

    const policy = store.getPolicy(auth.mandateId);
    const budget = policy?.budgetMicros ?? null;
    // The output bound is only known once the request body is estimated; it is
    // echoed on every later response so a client can see the reserved bound.
    let reservedOutputTokens: number | null = null;
    const remainingHeaders = (): Record<string, string> => {
      const h: Record<string, string> = {};
      if (reservedOutputTokens != null) h["X-Mandate-Max-Tokens"] = String(reservedOutputTokens);
      if (budget == null) return h;
      const spend = store.spent(auth.mandateId);
      h["X-Mandate-Remaining-Micros"] = String(budget - spend.committedMicros);
      return h;
    };

    let body: any;
    try {
      body = JSON.parse(read.buf.toString("utf8"));
    } catch {
      sendJson(res, 400, apiErrorPayload(dialect, "invalid JSON body"));
      return;
    }

    const model = typeof body?.model === "string" ? body.model : null;
    const price = model ? PRICING[model] : undefined;
    if (!model || !price || price.provider !== dialect) {
      store.recordDenial({
        mandateId: auth.mandateId,
        agentId: auth.agentId,
        provider: price?.provider ?? dialect,
        model: safeModel(model),
        amountMicros: 0,
        code: "model_not_allowed",
        reason: "model is not allowed on this route",
      });
      sendJson(
        res,
        403,
        denyPayload(dialect, "model_not_allowed", `model ${String(model).slice(0, 64)} is not allowed on this route`),
        remainingHeaders(),
      );
      return;
    }

    const estimate = worstCase(
      dialect,
      body,
      read.buf.length,
      opts.defaultMaxTokens ?? price.defaultOutputTokens,
      price.maxOutputTokens,
    );
    if (!estimate.ok) {
      sendJson(res, estimate.status, apiErrorPayload(dialect, estimate.reason));
      return;
    }
    reservedOutputTokens = estimate.maxOutputTokens;

    let forwardBody = estimate.body;
    const streaming = forwardBody?.stream === true;
    if (streaming && dialect === "openai") {
      forwardBody = {
        ...forwardBody,
        stream_options: { ...(forwardBody.stream_options ?? {}), include_usage: true },
      };
    }

    if (!upstream) {
      sendJson(res, 502, apiErrorPayload(dialect, "upstream not configured"));
      return;
    }

    const betas = typeof req.headers["anthropic-beta"] === "string" ? req.headers["anthropic-beta"] : null;
    if (dialect === "anthropic" && betas) {
      const allowed = new Set(opts.allowedAnthropicBetas ?? []);
      const bad = betas.split(",").map((b) => b.trim()).filter((b) => b && !allowed.has(b));
      if (bad.length > 0) {
        sendJson(
          res,
          400,
          apiErrorPayload(
            dialect,
            `anthropic-beta ${bad.join(",")} is not allowed by this gateway; add it to allowed_anthropic_betas in config.json if it does not change the price`,
          ),
        );
        return;
      }
    }

    // Bound the input by the bytes actually forwarded (the gateway may have
    // added max_tokens or stream_options), not the bytes the client sent.
    const forwardBytes = Buffer.from(JSON.stringify(forwardBody), "utf8");
    const extraBytes = Math.max(0, forwardBytes.length - read.buf.length);
    // A cache write needs a cache_control marker somewhere in the request.
    const mayWriteCache = dialect === "anthropic" && forwardBytes.includes("cache_control");
    const reservedMicros = worstCaseMicros(model, estimate.maxInputTokens + extraBytes, estimate.maxOutputTokens, mayWriteCache);

    // A denied or timed-out approval can still tell the agent which output bound
    // would have stayed under the approval threshold and needed no approval.
    const approvalFitHint = (): { k: number; sentence: string } | null => {
      if (!policy) return null;
      const inputBound = estimate.maxInputTokens + extraBytes;
      const thresholdMicros = policy.approvalThresholdMicros;
      const k = fittingMaxTokens(model, inputBound, mayWriteCache, thresholdMicros, estimate.maxOutputTokens);
      if (k < 1 || k >= estimate.maxOutputTokens) return null;
      const usd = (thresholdMicros / 1_000_000).toFixed(6);
      return {
        k,
        sentence: `A request with max_tokens ${k} or less stays under the approval line of ${usd} USD and needs no approval.`,
      };
    };

    // A per-call cap refusal names the biggest output bound that would fit, so
    // the client can retry instead of guessing.
    const perCallCapDeny = (): unknown => {
      const inputBound = estimate.maxInputTokens + extraBytes;
      const capMicros = policy?.perCallCapMicros ?? 0;
      const usd = (micros: number): string => (micros / 1_000_000).toFixed(6);
      const k = fittingMaxTokens(model, inputBound, mayWriteCache, capMicros, estimate.maxOutputTokens);
      let message: string;
      if (k >= 1) {
        const lowered =
          estimate.clamped && estimate.requestedOutputTokens != null
            ? ` Your max_tokens ${estimate.requestedOutputTokens} was lowered to the model limit ${estimate.maxOutputTokens}.`
            : "";
        message =
          `amount exceeds per-call cap. This call reserves up to ${usd(reservedMicros)} USD ` +
          `(input bound ${inputBound} tokens and max_tokens ${estimate.maxOutputTokens} on ${model}), ` +
          `above the per-call cap of ${usd(capMicros)} USD.${lowered} Lower max_tokens to ${k} or less, or shorten the prompt.`;
      } else {
        const r0 = worstCaseMicros(model, inputBound, 0, mayWriteCache);
        message =
          `amount exceeds per-call cap. The prompt alone reserves up to ${usd(r0)} USD on ${model}, ` +
          `above the per-call cap of ${usd(capMicros)} USD. Shorten the prompt or ask the mandate owner to raise per_call_cap.`;
      }
      return perCallCapPayload(dialect, message, k);
    };

    // Remember a disconnect during a step-up approval: the approval still runs
    // to completion, but nothing is forwarded upstream afterwards.
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableEnded) clientGone = true;
    });

    const reserveArgs = {
      mandateId: auth.mandateId,
      agentId: auth.agentId,
      model,
      provider: price.provider,
      amountMicros: reservedMicros,
    };
    const reserved = store.reserve({ ...reserveArgs, deferApproval: approver !== undefined });
    let reservationId: string;
    if (!reserved.ok) {
      if (reserved.code === "per_call_cap") {
        sendJson(res, reserved.status, perCallCapDeny(), {
          "X-Mandate-Reserved-Micros": String(reservedMicros),
          ...remainingHeaders(),
        });
        return;
      }
      if (reserved.code !== "approval_required" || !approver) {
        sendJson(
          res,
          reserved.status,
          denyPayload(dialect, reserved.code, reserved.reason),
          { "X-Mandate-Reserved-Micros": String(reservedMicros), ...remainingHeaders() },
        );
        return;
      }

      let outcome: { decision: "approved" | "denied" | "timeout"; requestId: string; decidedBy?: string };
      try {
        outcome = await approver.request({
          mandateId: auth.mandateId,
          agentId: auth.agentId,
          rail: "llm",
          payee: price.provider,
          amountMicros: reservedMicros,
          summary: `model ${model}, up to ${(reservedMicros / 1_000_000).toFixed(6)} USD`,
        });
      } catch {
        // An approver that throws is a failed approval, never an approval.
        outcome = { decision: "denied", requestId: "" };
      }

      // Anything other than an explicit approval with a request id is a deny.
      if (outcome?.decision !== "approved" || typeof outcome.requestId !== "string" || outcome.requestId.length === 0) {
        if (outcome?.decision !== "timeout") outcome = { decision: "denied", requestId: "" };
      }
      // The human decision is signed before the response or any retry, so it is
      // in the ledger whether the call is then allowed or stopped.
      store.recordApproval({
        mandateId: auth.mandateId,
        agentId: auth.agentId,
        rail: "llm",
        provider: price.provider,
        model,
        amountMicros: reservedMicros,
        decision: outcome.decision,
        requestId: outcome.requestId,
        decidedBy: outcome.decidedBy ?? "unknown",
      });
      if (outcome.decision === "denied") {
        const fit = approvalFitHint();
        const message = fit
          ? `the owner denied this call. ${fit.sentence}`
          : "the owner denied this call";
        sendJson(res, 403, denyPayload(dialect, "approval_denied", message), {
          "X-Mandate-Reserved-Micros": String(reservedMicros),
          ...(fit ? { "X-Mandate-Fit-Max-Tokens": String(fit.k) } : {}),
          ...remainingHeaders(),
        });
        return;
      }
      if (outcome.decision === "timeout") {
        const fit = approvalFitHint();
        const message = fit
          ? `the owner did not answer in time. ${fit.sentence}`
          : "the owner did not answer in time";
        sendJson(res, 403, denyPayload(dialect, "approval_timeout", message), {
          "X-Mandate-Reserved-Micros": String(reservedMicros),
          ...(fit ? { "X-Mandate-Fit-Max-Tokens": String(fit.k) } : {}),
          ...remainingHeaders(),
        });
        return;
      }
      if (clientGone) return;

      // The human approved this exact call: skip only the threshold. Caps,
      // rate limits and the budget still apply and can still deny.
      const approved = store.reserve({
        ...reserveArgs,
        approval: { requestId: outcome.requestId, decidedBy: outcome.decidedBy ?? "unknown" },
      });
      if (!approved.ok) {
        sendJson(
          res,
          approved.status,
          approved.code === "per_call_cap" ? perCallCapDeny() : denyPayload(dialect, approved.code, approved.reason),
          {
            "X-Mandate-Reserved-Micros": String(reservedMicros),
            ...remainingHeaders(),
          },
        );
        return;
      }
      reservationId = approved.reservationId;
    } else {
      reservationId = reserved.reservationId;
    }

    let finalized = false;
    const finalize = (
      kind: "settle" | "release" | "chargeFull",
      usage: Usage | null = null,
      charged = 0,
      details?: Record<string, unknown>,
    ): SettleEvent | null => {
      if (finalized) return null;
      // Marked closed only after the store call succeeds, so a throwing store
      // call leaves the hold to the finally block below instead of open.
      let ev: SettleEvent;
      if (kind === "settle") ev = store.settle(reservationId, usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, charged, details);
      else if (kind === "release") ev = store.release(reservationId);
      else ev = store.chargeFull(reservationId);
      finalized = true;
      return ev;
    };

    let upstreamStarted = false;
    let timedOut = false;
    let idleTimer: IdleTimer | null = null;
    const clearIdleTimer = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    try {
      // Reservation sizing keeps using costMicros so it stays an upper bound; the
      // settle charge below may be raised to the upstream's reported cost.
      const settleDetails = (
        usage: Usage,
        basis: "price_table" | "upstream_cost",
        tableMicros: number,
        upstreamCostMicros: number | null,
      ): Record<string, unknown> => ({
        price_basis: basis,
        table_micros: tableMicros,
        upstream_cost_micros: upstreamCostMicros,
        reasoning_tokens: usage.reasoningTokens ?? 0,
      });

      const forwardHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: streaming ? "text/event-stream" : "application/json",
      };
      if (dialect === "openai") {
        forwardHeaders.authorization = `Bearer ${upstream.apiKey}`;
      } else {
        forwardHeaders["x-api-key"] = upstream.apiKey;
        forwardHeaders["anthropic-version"] =
          typeof req.headers["anthropic-version"] === "string"
            ? req.headers["anthropic-version"]
            : "2023-06-01";
        if (betas) forwardHeaders["anthropic-beta"] = betas;
      }

      const abortController = new AbortController();
      let aborted = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          aborted = true;
          abortController.abort();
        }
      });

      const upstreamUrl = upstream.baseUrl.replace(/\/+$/, "") + path;

      const armIdleTimer = (): void => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, upstreamTimeoutMs) as IdleTimer;
        idleTimer.unref?.();
      };

      let upstreamRes: Response;
      try {
        upstreamStarted = true;
        armIdleTimer();
        upstreamRes = await fetch(upstreamUrl, {
          method: "POST",
          headers: forwardHeaders,
          body: forwardBytes,
          signal: abortController.signal,
        });
        armIdleTimer();
      } catch (err) {
        if (timedOut) {
          const event = finalize("chargeFull");
          sendJson(
            res,
            504,
            apiErrorPayload(dialect, `upstream timed out after ${upstreamTimeoutMs} ms`),
            mandateHeaders(reservedMicros, event?.chargedMicros ?? 0, remainingHeaders()),
          );
          return;
        }
        if (aborted) {
          finalize("chargeFull");
          return;
        }
        // Release only when the request provably never reached the provider
        // (connection refused, DNS failure). A reset or timeout after the body
        // was sent may still be billed, so it is charged in full.
        const code = (err as { cause?: { code?: string } })?.cause?.code;
        const neverSent = code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
        const event = finalize(neverSent ? "release" : "chargeFull");
        sendJson(
          res,
          502,
          apiErrorPayload(dialect, "upstream request failed"),
          mandateHeaders(reservedMicros, event?.chargedMicros ?? 0, remainingHeaders()),
        );
        return;
      }

      if (!upstreamRes.ok) {
        let text = "";
        let readFailed = false;
        try {
          text = await upstreamRes.text();
        } catch {
          text = "";
          readFailed = true;
        }
        clearIdleTimer();
        if (readFailed && timedOut) {
          // An error answer is not billed, so the hold is released even when its body stalls.
          const event = finalize("release");
          sendJson(
            res,
            504,
            apiErrorPayload(dialect, `upstream timed out after ${upstreamTimeoutMs} ms`),
            mandateHeaders(reservedMicros, event?.chargedMicros ?? 0, remainingHeaders()),
          );
          return;
        }
        if (aborted) {
          finalize("chargeFull");
          return;
        }
        const event = finalize("release");
        res.writeHead(upstreamRes.status, {
          "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
          ...mandateHeaders(reservedMicros, event?.chargedMicros ?? 0, remainingHeaders()),
        });
        res.end(redact(text, [upstream.apiKey, key ?? ""]));
        return;
      }

      const upstreamContentType =
        upstreamRes.headers.get("content-type") ??
        (streaming ? "text/event-stream" : "application/json");

      if (!streaming) {
        let text = "";
        try {
          text = await upstreamRes.text();
        } catch {
          clearIdleTimer();
          if (timedOut) {
            const event = finalize("chargeFull");
            sendJson(
              res,
              504,
              apiErrorPayload(dialect, `upstream timed out after ${upstreamTimeoutMs} ms`),
              mandateHeaders(reservedMicros, event?.chargedMicros ?? 0, remainingHeaders()),
            );
            return;
          }
          if (aborted) {
            finalize("chargeFull");
            return;
          }
          const event = finalize("chargeFull");
          if (!res.headersSent) {
            res.writeHead(200, {
              "content-type": upstreamContentType,
              ...mandateHeaders(reservedMicros, event?.chargedMicros ?? reservedMicros, remainingHeaders()),
            });
          }
          res.end();
          return;
        }
        clearIdleTimer();
        if (aborted) {
          finalize("chargeFull");
          return;
        }
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        const usage = dialect === "openai" ? openAIUsage(json?.usage) : anthropicUsage(json?.usage);
        let event: SettleEvent | null;
        if (usage) {
          const cost = upstreamCostUsd(json?.usage, upstreamRes.headers, costHeaders);
          const settlement = settleMicros(model, usage, cost);
          event = finalize(
            "settle",
            usage,
            settlement.chargedMicros,
            settleDetails(usage, settlement.basis, settlement.tableMicros, settlement.upstreamCostMicros),
          );
        } else {
          event = finalize("chargeFull");
        }
        res.writeHead(upstreamRes.status, {
          "content-type": upstreamContentType,
          ...mandateHeaders(reservedMicros, event?.chargedMicros ?? 0, remainingHeaders()),
        });
        res.end(text);
        return;
      }

      const trailer = "X-Mandate-Charged-Micros, X-Mandate-Remaining-Micros";
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamContentType,
        "cache-control": "no-cache",
        connection: "keep-alive",
        trailer,
        ...mandateHeaders(reservedMicros, null, remainingHeaders()),
      });

      let sseBuffer = "";
      let openaiStreamUsage: Usage | null = null;
      let anthropicStartUsage: any = null;
      let anthropicOutputTokens: number | null = null;
      let streamCostUsd: number | null = null;
      let relayError = false;

      const stream = upstreamRes.body as unknown as AsyncIterable<Uint8Array> | null;
      if (stream) {
        try {
          for await (const chunk of stream) {
            armIdleTimer();
            const buf = Buffer.from(chunk);
            res.write(buf);
            sseBuffer += buf.toString("utf8");
            let index: number;
            while ((index = sseBuffer.indexOf("\n")) !== -1) {
              const line = sseBuffer.slice(0, index).replace(/\r$/, "");
              sseBuffer = sseBuffer.slice(index + 1);
              const parsed = parseSseData(line);
              if (parsed === null) continue;
              if (dialect === "openai") {
                if (parsed.usage) {
                  const usage = openAIUsage(parsed.usage);
                  if (usage) openaiStreamUsage = usage;
                  const cost = upstreamCostUsd(parsed.usage, undefined, []);
                  if (cost != null) streamCostUsd = cost;
                }
              } else if (parsed.type === "message_start" && parsed.message?.usage) {
                anthropicStartUsage = parsed.message.usage;
                const cost = upstreamCostUsd(parsed.message.usage, undefined, []);
                if (cost != null) streamCostUsd = cost;
              } else if (parsed.type === "message_delta" && parsed.usage) {
                const output = numOrNull(parsed.usage.output_tokens);
                if (output != null) anthropicOutputTokens = output;
                const cost = upstreamCostUsd(parsed.usage, undefined, []);
                if (cost != null) streamCostUsd = cost;
              }
            }
          }
        } catch {
          relayError = true;
        }
      } else {
        relayError = true;
      }
      clearIdleTimer();
      if (timedOut) relayError = true;

      const usage =
        dialect === "openai"
          ? openaiStreamUsage
          : combineAnthropic(anthropicStartUsage, anthropicOutputTokens);

      let event: SettleEvent | null;
      if (aborted || relayError) {
        event = finalize("chargeFull");
      } else if (usage) {
        const cost = streamCostUsd ?? upstreamCostUsd(null, upstreamRes.headers, costHeaders);
        const settlement = settleMicros(model, usage, cost);
        event = finalize(
          "settle",
          usage,
          settlement.chargedMicros,
          settleDetails(usage, settlement.basis, settlement.tableMicros, settlement.upstreamCostMicros),
        );
      } else {
        event = finalize("chargeFull");
      }

      if (!aborted) {
        try {
          res.addTrailers({
            "X-Mandate-Charged-Micros": String(event?.chargedMicros ?? reservedMicros),
            ...remainingHeaders(),
          });
        } catch {
          // ignore trailer failures
        }
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    } finally {
      clearIdleTimer();
      if (!finalized) {
        try {
          finalize(upstreamStarted ? "chargeFull" : "release");
        } catch {
          // the reservation may already be closed
        }
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    // Claude Code calls POST /v1/messages?beta=true, so the provider routes match
    // on the path alone. The query string is never forwarded upstream.
    const path = url.split("?")[0] ?? url;
    if (method === "GET" && url === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/v1/chat/completions") {
      await proxy(req, res, "openai");
      return;
    }
    if (method === "POST" && path === "/v1/messages") {
      await proxy(req, res, "anthropic");
      return;
    }
    // Extra routes are keyed "METHOD /path" and matched on the path alone, so a
    // handler can read its own query string (for example the approval page).
    const routeKey = `${method} ${path}`;
    const extra = opts.routes ? Object.prototype.hasOwnProperty.call(opts.routes, routeKey) : false;
    if (extra) {
      await opts.routes![routeKey]!(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
  }

  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "internal error", type: "invalid_request_error" } }));
        } else {
          res.end();
        }
      } catch {
        // ignore
      }
    });
  });
}

export type { Deny };
