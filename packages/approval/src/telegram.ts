const TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{20,64}$/;

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly description: string;

  constructor(method: string, status: number, description: string) {
    super(`telegram ${method} failed (${status}): ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Minimal Telegram Bot API client. The bot token is validated on construction
 * and is never echoed: every error message has it replaced with "<redacted>".
 */
export class TelegramClient {
  readonly #token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: TelegramClientOptions) {
    if (!opts || typeof opts.token !== "string" || !TOKEN_RE.test(opts.token)) {
      throw new Error("invalid Telegram bot token");
    }
    this.#token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => f(input, init);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private redact(text: string): string {
    return text.split(this.#token).join("<redacted>");
  }

  async call<T>(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.#token}/${method}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params ?? {}),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) throw new TelegramApiError(method, 0, "request timed out");
        const message = err instanceof Error ? err.message : String(err);
        throw new TelegramApiError(method, 0, this.redact(message));
      }

      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "";
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      const body = parsed as { ok?: unknown; description?: unknown; result?: unknown } | null;
      if (!res.ok || !body || body.ok !== true) {
        const description =
          body && typeof body.description === "string" ? body.description : `HTTP ${res.status}`;
        throw new TelegramApiError(method, res.status, this.redact(description));
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  }
}
