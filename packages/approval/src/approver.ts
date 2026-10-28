import { randomBytes } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest, Approver } from "./types.js";
import { sanitize } from "./sanitize.js";
import type { TelegramClient } from "./telegram.js";

function usd(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Update {
  update_id?: number;
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
  };
}

interface Pending {
  requestId: string;
  nonce: string;
  req: ApprovalRequest;
  text: string;
  messageId: number | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  pendingEditText: string | null;
  resolve: (decision: ApprovalDecision) => void;
}

export interface TelegramApproverOptions {
  client: TelegramClient;
  chatId: number;
  approverUserIds: number[];
  /** Default 60_000. */
  timeoutMs?: number;
  /** Long-poll hold in seconds. Default 25. */
  pollTimeoutSec?: number;
  now?: () => number;
  onDecision?: (req: ApprovalRequest, decision: ApprovalDecision) => void;
  /** Open prompts allowed per agent at once; more are denied immediately. Default 2. */
  maxPendingPerAgent?: number;
}

const CALLBACK_RE = /^sm1:([ad]):(.+)$/;
const EXPIRED_TEXT = "Expired, auto-denied";

export class TelegramApprover implements Approver {
  static readonly DEFAULT_TIMEOUT_MS = 60_000;

  private readonly client: TelegramClient;
  private readonly chatId: number;
  private readonly approverUserIds: Set<number>;
  private readonly timeoutMs: number;
  private readonly maxPendingPerAgent: number;
  private readonly pollTimeoutSec: number;
  private readonly now: () => number;
  private readonly onDecision: ((req: ApprovalRequest, decision: ApprovalDecision) => void) | undefined;

  private readonly pending = new Map<string, Pending>();
  private offset = 0;
  private running = false;
  private closed = false;
  private pollAbort: AbortController | null = null;

  constructor(opts: TelegramApproverOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.approverUserIds = new Set(opts.approverUserIds);
    this.timeoutMs = opts.timeoutMs ?? TelegramApprover.DEFAULT_TIMEOUT_MS;
    this.maxPendingPerAgent = opts.maxPendingPerAgent ?? 2;
    if (!Number.isSafeInteger(opts.chatId) || opts.approverUserIds.length === 0 || !opts.approverUserIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new Error("chatId and approverUserIds must be safe integers, with at least one approver");
    }
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.now = opts.now ?? (() => Date.now());
    this.onDecision = opts.onDecision;
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

    const nonce = randomBytes(18).toString("base64url");
    const text = this.buildText(req, requestId);

    return new Promise<ApprovalDecision>((resolve) => {
      const pending: Pending = {
        requestId,
        nonce,
        req,
        text,
        messageId: null,
        startedAt,
        timer: null as unknown as ReturnType<typeof setTimeout>,
        settled: false,
        pendingEditText: null,
        resolve,
      };
      pending.timer = setTimeout(() => this.onTimeout(nonce), this.timeoutMs);
      this.pending.set(nonce, pending);
      void this.sendMessage(pending);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pollAbort?.abort();
    for (const nonce of [...this.pending.keys()]) {
      const pending = this.pending.get(nonce);
      if (!pending) continue;
      this.settle(nonce, this.timeoutDecision(pending.requestId, pending.startedAt), EXPIRED_TEXT);
    }
  }

  private buildText(req: ApprovalRequest, requestId: string): string {
    const seconds = this.timeoutMs / 1000;
    const secs = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
    return [
      "TapVow approval",
      `Agent: ${sanitize(req.agentId)}`,
      `Rail: ${sanitize(req.rail)}`,
      `Payee: ${sanitize(req.payee)}`,
      `Amount: ${usd(req.amountMicros)} USD`,
      `Mandate: ${sanitize(req.mandateId)}`,
      `Request: ${requestId}`,
      `Auto-deny in ${secs} s`,
      sanitize(req.summary, 300),
    ].join("\n");
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

  private safeOnDecision(req: ApprovalRequest, decision: ApprovalDecision): void {
    try {
      this.onDecision?.(req, decision);
    } catch {
      // a broken callback must not affect the decision
    }
  }

  private async sendMessage(pending: Pending): Promise<void> {
    try {
      const res = await this.client.call<{ message_id?: number }>("sendMessage", {
        chat_id: this.chatId,
        text: pending.text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve", callback_data: `sm1:a:${pending.nonce}` },
              { text: "Deny", callback_data: `sm1:d:${pending.nonce}` },
            ],
          ],
        },
      });
      pending.messageId = typeof res?.message_id === "number" ? res.message_id : null;
      if (pending.settled) {
        if (pending.messageId != null && pending.pendingEditText != null) {
          await this.editMessage(pending.messageId, pending.pendingEditText);
        }
        return;
      }
      this.ensurePolling();
    } catch {
      // Fail closed: we could not ask the owner, so the call is denied.
      this.settle(pending.nonce, this.timeoutDecision(pending.requestId, pending.startedAt), null);
    }
  }

  private onTimeout(nonce: string): void {
    const pending = this.pending.get(nonce);
    if (!pending || pending.settled) return;
    this.settle(nonce, this.timeoutDecision(pending.requestId, pending.startedAt), EXPIRED_TEXT);
  }

  private settle(nonce: string, decision: ApprovalDecision, editText: string | null): void {
    const pending = this.pending.get(nonce);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pending.delete(nonce);
    clearTimeout(pending.timer);

    if (editText != null) {
      if (pending.messageId != null) void this.editMessage(pending.messageId, editText);
      else pending.pendingEditText = editText;
    }

    this.safeOnDecision(pending.req, decision);
    pending.resolve(decision);
  }

  private async editMessage(messageId: number, text: string): Promise<void> {
    try {
      await this.client.call("editMessageText", {
        chat_id: this.chatId,
        message_id: messageId,
        text,
      });
    } catch {
      // follow-up calls are best effort
    }
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    try {
      await this.client.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    } catch {
      // follow-up calls are best effort
    }
  }

  private ensurePolling(): void {
    if (this.running || this.closed || this.pending.size === 0) return;
    this.running = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let backoff = 250;
    while (!this.closed && this.pending.size > 0) {
      const controller = new AbortController();
      this.pollAbort = controller;
      try {
        const updates = await this.client.call<Update[]>(
          "getUpdates",
          { offset: this.offset, timeout: this.pollTimeoutSec, allowed_updates: ["callback_query"] },
          { signal: controller.signal, timeoutMs: (this.pollTimeoutSec + 10) * 1000 },
        );
        backoff = 250;
        for (const update of Array.isArray(updates) ? updates : []) {
          const updateId = Number(update?.update_id);
          if (Number.isFinite(updateId)) this.offset = Math.max(this.offset, updateId + 1);
          if (this.closed) break;
          try {
            await this.handleUpdate(update);
          } catch {
            // a malformed update must not stop the loop
          }
        }
      } catch {
        if (this.closed) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      } finally {
        this.pollAbort = null;
      }
    }
    this.running = false;
  }

  private async handleUpdate(update: Update): Promise<void> {
    const query = update?.callback_query;
    if (!query) return;

    const callbackQueryId = String(query.id ?? "");
    const data = typeof query.data === "string" ? query.data : "";
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const fromId = query.from?.id;

    const match = CALLBACK_RE.exec(data);
    const action = match?.[1];
    const nonce = match?.[2] ?? null;

    // Only the configured owner in the configured chat may decide.
    if (chatId !== this.chatId || !this.approverUserIds.has(fromId as number)) {
      await this.answerCallbackQuery(callbackQueryId, "Not authorized");
      return;
    }

    const pending = nonce ? this.pending.get(nonce) : undefined;
    if (!pending || pending.messageId == null || pending.messageId !== messageId) {
      await this.answerCallbackQuery(callbackQueryId, "Expired");
      return;
    }

    const userId = fromId as number;
    const approved = action === "a";
    const at = this.now();
    const decision: ApprovalDecision = {
      decision: approved ? "approved" : "denied",
      requestId: pending.requestId,
      decidedBy: `telegram:${userId}`,
      decidedAt: new Date(at).toISOString(),
      latencyMs: Math.max(0, at - pending.startedAt),
    };
    const editText = pending.text + (approved ? `\nApproved by ${userId}` : `\nDenied by ${userId}`);

    // Remove the nonce before resolving: the first valid press wins and a
    // replayed update (or a second press) can only be "Expired".
    this.settle(nonce as string, decision, editText);
    await this.answerCallbackQuery(callbackQueryId, approved ? "Approved" : "Denied");
  }
}
