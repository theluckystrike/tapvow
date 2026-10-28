import http from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  trailers: http.IncomingHttpHeaders;
  text: string;
}

export function post(baseUrl: string, path: string, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  const url = new URL(baseUrl + path);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
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
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, trailers: res.trailers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

const PROMPT = "x".repeat(2000);

/** 4-way rotation: OpenAI and Anthropic, each streaming and not. */
export function shape(i: number) {
  const openai = i % 2 === 0;
  const model = openai ? "gpt-4o" : "claude-sonnet-4-5";
  const stream = Math.floor(i / 2) % 2 === 1;
  const body: Record<string, unknown> = { model, max_tokens: 2000, messages: [{ role: "user", content: PROMPT }] };
  if (stream) body.stream = true;
  return {
    model,
    path: openai ? "/v1/chat/completions" : "/v1/messages",
    body,
    headers: (key: string): Record<string, string> =>
      openai ? { authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" },
  };
}

/** One agent: call until the gateway answers 402, return calls made and micros charged. */
export async function agentUntilDenied(baseUrl: string, key: string, offset: number) {
  let calls = 0;
  let charged = 0;
  for (let i = offset; ; i++) {
    const s = shape(i);
    const r = await post(baseUrl, s.path, s.headers(key), s.body);
    if (r.status === 402) return { calls, charged };
    if (r.status !== 200) throw new Error(`unexpected ${r.status}: ${r.text.slice(0, 200)}`);
    calls++;
    const c = r.headers["x-mandate-charged-micros"] ?? r.trailers["x-mandate-charged-micros"];
    charged += Number(c);
  }
}
