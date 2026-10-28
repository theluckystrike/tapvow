import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUpstream {
  url: string;
  requests: Array<{ path: string; headers: Record<string, string | undefined>; body: any }>;
  /** What the fake provider would bill: one row per 200 response it produced. */
  billed: Array<{ path: string; model: string; inputTokens: number; outputTokens: number }>;
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  latencyMs?: [number, number];
  completion?: "max" | "random";
  seed?: number;
  failEvery?: number;
  streamChunkDelayMs?: number;
  /** When set, put `cost: <value>` in the OpenAI usage object (body and streamed chunk). */
  reportCostUsd?: number;
  /** When set, send this response header on OpenAI responses. */
  costHeader?: { name: string; value: string };
  /** When set, add completion_tokens_details.reasoning_tokens to OpenAI usage. */
  reasoningTokens?: { count: number; insideCompletion: boolean };
  /** When set, emit these exact OpenAI usage numbers instead of deriving them from the request. */
  usageOverride?: FakeUsageOverride;
}

export interface FakeUsageOverride {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  /** total_tokens; defaults to promptTokens + completionTokens. */
  totalTokens?: number;
  /** usage.cost in USD. */
  costUsd?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(body: any): { text: string; count: number } {
  let text = "";
  for (const part of [body?.system]) {
    if (typeof part === "string") text += part;
    else if (Array.isArray(part)) {
      for (const p of part) if (p && typeof p.text === "string") text += p.text;
    }
  }
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = m.content;
    if (typeof content === "string") text += content;
    else if (Array.isArray(content)) {
      for (const p of content) if (p && typeof p.text === "string") text += p.text;
    }
  }
  return { text, count: messages.length };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function startFakeUpstream(opts: FakeUpstreamOptions = {}): Promise<FakeUpstream> {
  const latencyMs = opts.latencyMs ?? [20, 80];
  const completion = opts.completion ?? "max";
  const failEvery = opts.failEvery ?? 0;
  const streamChunkDelayMs = opts.streamChunkDelayMs ?? 0;
  const rng = mulberry32(opts.seed ?? 1);
  const requests: FakeUpstream["requests"] = [];
  const billed: FakeUpstream["billed"] = [];
  let counter = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = req.url ?? "/";
      const raw = await readBody(req);
      let body: any = null;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = raw.toString("utf8");
      }
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      requests.push({ path, headers, body });
      counter += 1;

      if (failEvery > 0 && counter % failEvery === 0) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake upstream failure", type: "server_error" } }));
        return;
      }

      const { text, count } = messageText(body);
      const derivedPrompt = Math.ceil(Buffer.byteLength(text, "utf8") / 4) + 8 * count;
      const maxTokens = Number(body?.max_completion_tokens ?? body?.max_tokens ?? 16);
      let derivedCompletion: number;
      if (completion === "max") {
        derivedCompletion = maxTokens;
      } else {
        const half = Math.ceil(maxTokens / 2);
        derivedCompletion = half + Math.floor(rng() * (maxTokens - half + 1));
      }
      const promptTokens = opts.usageOverride?.promptTokens ?? derivedPrompt;
      const completionTokens = opts.usageOverride?.completionTokens ?? derivedCompletion;

      const [lo, hi] = latencyMs;
      const delay = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
      await sleep(delay);

      const streaming = body?.stream === true;
      if (path === "/v1/chat/completions" || path === "/v1/messages") {
        billed.push({ path, model: String(body?.model), inputTokens: promptTokens, outputTokens: completionTokens });
      }
      if (path === "/v1/chat/completions") {
        if (streaming) await emitOpenAIStream(res, body, promptTokens, completionTokens, streamChunkDelayMs, opts);
        else emitOpenAIMessage(res, body, promptTokens, completionTokens, opts);
      } else if (path === "/v1/messages") {
        if (streaming) await emitAnthropicStream(res, body, promptTokens, completionTokens, streamChunkDelayMs);
        else emitAnthropicMessage(res, body, promptTokens, completionTokens);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
      }
    })().catch((err) => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      } catch {
        // ignore
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        billed,
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

function openAIUsagePayload(promptTokens: number, completionTokens: number, opts: FakeUpstreamOptions): any {
  const override = opts.usageOverride;
  const usage: any = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: override?.totalTokens ?? promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: override?.cachedTokens ?? 0 },
  };
  if (override?.reasoningTokens !== undefined) {
    usage.completion_tokens_details = { reasoning_tokens: override.reasoningTokens };
  } else if (opts.reasoningTokens) {
    const { count, insideCompletion } = opts.reasoningTokens;
    usage.completion_tokens_details = { reasoning_tokens: count };
    // When reasoning is reported outside completion_tokens the total still
    // counts it, so it cannot be lost by an upstream that only trusts the total.
    if (!insideCompletion) usage.total_tokens = promptTokens + completionTokens + count;
  }
  const costUsd = override?.costUsd ?? opts.reportCostUsd;
  if (costUsd !== undefined) usage.cost = costUsd;
  return usage;
}

function openAIResponseHeaders(opts: FakeUpstreamOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.costHeader) headers[opts.costHeader.name] = opts.costHeader.value;
  return headers;
}

function emitOpenAIMessage(
  res: ServerResponse,
  body: any,
  promptTokens: number,
  completionTokens: number,
  opts: FakeUpstreamOptions,
): void {
  const payload = {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body?.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "fake completion" },
        finish_reason: "stop",
      },
    ],
    usage: openAIUsagePayload(promptTokens, completionTokens, opts),
  };
  res.writeHead(200, openAIResponseHeaders(opts));
  res.end(JSON.stringify(payload));
}

function emitAnthropicMessage(res: ServerResponse, body: any, promptTokens: number, completionTokens: number): void {
  const payload = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: body?.model,
    content: [{ type: "text", text: "fake completion" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function emitOpenAIStream(
  res: ServerResponse,
  body: any,
  promptTokens: number,
  completionTokens: number,
  chunkDelayMs = 0,
  opts: FakeUpstreamOptions = {},
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...(opts.costHeader ? { [opts.costHeader.name]: opts.costHeader.value } : {}),
  });
  const base = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body?.model,
  };
  const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const pace = async () => {
    if (chunkDelayMs > 0) await sleep(chunkDelayMs);
  };
  return (async () => {
    write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    await pace();
    write({ ...base, choices: [{ index: 0, delta: { content: "fake completion" }, finish_reason: null }] });
    await pace();
    write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    await pace();
    write({
      ...base,
      choices: [],
      usage: openAIUsagePayload(promptTokens, completionTokens, opts),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  })();
}

function emitAnthropicStream(
  res: ServerResponse,
  body: any,
  promptTokens: number,
  completionTokens: number,
  chunkDelayMs = 0,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const event = (name: string, data: unknown) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const pace = async () => {
    if (chunkDelayMs > 0) await sleep(chunkDelayMs);
  };
  return (async () => {
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: body?.model,
        content: [],
        usage: {
          input_tokens: promptTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    await pace();
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    await pace();
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fake completion" } });
    await pace();
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    await pace();
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: completionTokens },
    });
    event("message_stop", { type: "message_stop" });
    res.end();
  })();
}
