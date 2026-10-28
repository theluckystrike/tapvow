export const TOOL_OVERHEAD_TOKENS = 1000;

export type Dialect = "openai" | "anthropic";

export type WorstCase =
  | {
      ok: true;
      maxInputTokens: number;
      maxOutputTokens: number;
      body: any;
      /** The largest max token field the client sent, null when it sent none. */
      requestedOutputTokens: number | null;
      /** True when the output bound was lowered to the model's maxOutputTokens. */
      clamped: boolean;
    }
  | { ok: false; status: number; reason: string };

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function contentError(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return null;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part == null) continue;
      const type = (part as { type?: unknown }).type;
      if (type !== "text") {
        return `content type ${String(type)} is not supported by budget estimation`;
      }
    }
    return null;
  }
  if (typeof content === "object") {
    const type = (content as { type?: unknown }).type;
    if (type !== "text") {
      return `content type ${String(type)} is not supported by budget estimation`;
    }
    return null;
  }
  return null;
}

export function worstCase(
  dialect: Dialect,
  body: any,
  rawBodyBytes: number,
  defaultMaxTokens: number,
  maxOutputTokens?: number,
): WorstCase {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, reason: "request body must be a JSON object" };
  }

  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (message == null || typeof message !== "object") continue;
    const err = contentError((message as { content?: unknown }).content);
    if (err) return { ok: false, status: 400, reason: err };
  }

  // Features billed outside input/output tokens, or able to push output past
  // the max_tokens bound, are refused so the reservation stays a true upper bound.
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      const type = t && typeof t === "object" ? (t as { type?: unknown }).type : undefined;
      const clientTool = dialect === "openai" ? type === "function" : type === undefined || type === "custom";
      if (!clientTool) {
        return { ok: false, status: 400, reason: `tool type ${String(type)} is billed outside token usage and is not supported` };
      }
    }
  }
  for (const k of ["web_search_options", "audio", "prediction", "mcp_servers", "container"]) {
    if (body[k] != null) return { ok: false, status: 400, reason: `${k} is not supported by budget estimation` };
  }
  if (Array.isArray(body.modalities) && body.modalities.some((m: unknown) => m !== "text")) {
    return { ok: false, status: 400, reason: "only text modalities are supported by budget estimation" };
  }
  // "auto" can resolve to a pricier tier (OpenAI project default, Anthropic priority), so only the standard tier passes.
  if (body.service_tier != null && body.service_tier !== "default" && body.service_tier !== "standard_only") {
    return { ok: false, status: 400, reason: `service_tier ${String(body.service_tier)} is priced differently and is not supported` };
  }

  const bytes = Math.max(0, Math.ceil(rawBodyBytes));
  // Providers add a hidden system prompt when tools are present (Anthropic
  // documents roughly 300-350 tokens for tool use), so add a fixed allowance.
  const toolAllowance = Array.isArray(body.tools) && body.tools.length > 0 ? TOOL_OVERHEAD_TOKENS : 0;
  const maxInputTokens = bytes + 16 * messages.length + 64 + toolAllowance;

  if (dialect === "openai" && body.n != null && Number(body.n) > 1) {
    return { ok: false, status: 400, reason: "n > 1 is not supported by budget estimation" };
  }

  // Both dialects accept max_tokens and max_completion_tokens (an Anthropic
  // request reaching here may carry the OpenAI name; it is forwarded as
  // max_tokens). A field that is undefined or null counts as not sent.
  const limit = isPositiveInt(maxOutputTokens) ? maxOutputTokens : Infinity;
  const sent: Array<{ field: "max_tokens" | "max_completion_tokens"; value: number }> = [];
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const value = body[field];
    if (value == null) continue;
    if (!isPositiveInt(value)) {
      const reason = dialect === "openai" ? "max tokens must be a positive integer" : "max_tokens must be a positive integer";
      return { ok: false, status: 400, reason };
    }
    sent.push({ field, value });
  }

  let bound: number;
  let requestedOutputTokens: number | null;
  let clamped: boolean;
  if (sent.length === 0) {
    bound = Math.min(defaultMaxTokens, limit);
    requestedOutputTokens = null;
    clamped = bound < defaultMaxTokens;
  } else {
    requestedOutputTokens = Math.max(...sent.map((s) => s.value));
    bound = Math.min(requestedOutputTokens, limit);
    clamped = requestedOutputTokens > limit;
  }

  const forwarded: any = { ...body };
  if (dialect === "openai") {
    // Each sent field is clamped in place; an unsent field stays absent.
    for (const { field, value } of sent) forwarded[field] = Math.min(value, limit);
    if (sent.length === 0) forwarded.max_tokens = bound;
  } else {
    // The Anthropic API rejects max_completion_tokens, so only max_tokens is forwarded.
    delete forwarded.max_completion_tokens;
    forwarded.max_tokens = bound;
  }

  return { ok: true, maxInputTokens, maxOutputTokens: bound, body: forwarded, requestedOutputTokens, clamped };
}
