import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockSentMessage {
  messageId: number;
  chatId: number;
  text: string;
  replyMarkup: any;
}

export interface MockTelegram {
  baseUrl: string;
  token: string;
  sent: Array<{ messageId: number; chatId: number; text: string; replyMarkup: any }>;
  edits: Array<{ messageId: number; text: string; replyMarkup: any }>;
  answers: Array<{ callbackQueryId: string; text?: string }>;
  calls: Array<{ method: string; params: any }>;
  /** Queue a callback_query update. By default it presses that message's real button. */
  press(opts: { messageId: number; button: "Approve" | "Deny"; fromUserId: number; chatId?: number; data?: string }): void;
  /** Resolve once the count-th message has been sent. */
  waitForMessage(count?: number, timeoutMs?: number): Promise<MockSentMessage>;
  /** Make the next calls of method fail. */
  failNext(method: string, times?: number): void;
  close(): Promise<void>;
}

const DEFAULT_TOKEN = "123456:TEST-token-for-the-mock-server-only";

interface PollWaiter {
  offset: number;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MessageWaiter {
  count: number;
  resolve: (value: MockSentMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

export function startMockTelegram(opts: { token?: string } = {}): Promise<MockTelegram> {
  const token = opts.token ?? DEFAULT_TOKEN;

  const sent: MockTelegram["sent"] = [];
  const edits: MockTelegram["edits"] = [];
  const answers: MockTelegram["answers"] = [];
  const calls: MockTelegram["calls"] = [];

  const queue: any[] = [];
  const pendingPolls: PollWaiter[] = [];
  const messageWaiters: MessageWaiter[] = [];
  const failCounts = new Map<string, number>();
  let updateId = 0;
  let messageId = 0;

  function tryDeliver(): void {
    if (pendingPolls.length === 0) return;
    for (let i = pendingPolls.length - 1; i >= 0; i -= 1) {
      const waiter = pendingPolls[i]!;
      const available = queue.filter((u) => u.update_id >= waiter.offset);
      if (available.length === 0) continue;
      for (const u of available) {
        const index = queue.indexOf(u);
        if (index >= 0) queue.splice(index, 1);
      }
      clearTimeout(waiter.timer);
      pendingPolls.splice(i, 1);
      waiter.resolve({ ok: true, result: available });
    }
  }

  function notifyMessageWaiters(): void {
    for (let i = messageWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = messageWaiters[i]!;
      if (sent.length < waiter.count) continue;
      const message = sent[waiter.count - 1]!;
      clearTimeout(waiter.timer);
      messageWaiters.splice(i, 1);
      waiter.resolve({ ...message });
    }
  }

  function getUpdates(params: any): Promise<unknown> {
    const offset = Number(params?.offset ?? 0);
    return new Promise((resolve) => {
      const available = queue.filter((u) => u.update_id >= offset);
      if (available.length > 0) {
        for (const u of available) {
          const index = queue.indexOf(u);
          if (index >= 0) queue.splice(index, 1);
        }
        resolve({ ok: true, result: available });
        return;
      }
      const timeoutSec = Math.max(0, Number(params?.timeout ?? 0));
      const waiter: PollWaiter = {
        offset,
        resolve,
        timer: setTimeout(
          () => {
            const index = pendingPolls.indexOf(waiter);
            if (index >= 0) pendingPolls.splice(index, 1);
            resolve({ ok: true, result: [] });
          },
          timeoutSec * 1000 + 25,
        ),
      };
      pendingPolls.push(waiter);
    });
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = req.url ?? "";
      const match = /^\/bot([^/]+)\/([^/?]+)/.exec(path);
      if (!match || match[1] !== token) {
        sendJson(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
        return;
      }
      const method = match[2]!;
      let params: any = {};
      try {
        const raw = await readBody(req);
        if (raw.length > 0) params = JSON.parse(raw);
      } catch {
        params = {};
      }
      calls.push({ method, params });

      const remaining = failCounts.get(method) ?? 0;
      if (remaining > 0) {
        failCounts.set(method, remaining - 1);
        sendJson(res, 200, { ok: false, error_code: 500, description: "mock failure" });
        return;
      }

      if (method === "getUpdates") {
        const result = await getUpdates(params);
        sendJson(res, 200, result);
        return;
      }

      if (method === "sendMessage") {
        messageId += 1;
        const chatId = Number(params.chat_id);
        const text = String(params.text ?? "");
        const replyMarkup = params.reply_markup ?? null;
        sent.push({ messageId, chatId, text, replyMarkup });
        notifyMessageWaiters();
        sendJson(res, 200, {
          ok: true,
          result: {
            message_id: messageId,
            from: { id: 1, is_bot: true, first_name: "MockBot", username: "mock_bot" },
            chat: { id: chatId, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text,
          },
        });
        return;
      }

      if (method === "editMessageText") {
        const editId = Number(params.message_id);
        const text = String(params.text ?? "");
        const replyMarkup = params.reply_markup ?? null;
        edits.push({ messageId: editId, text, replyMarkup });
        sendJson(res, 200, {
          ok: true,
          result: {
            message_id: editId,
            from: { id: 1, is_bot: true, first_name: "MockBot", username: "mock_bot" },
            chat: { id: Number(params.chat_id), type: "private" },
            date: Math.floor(Date.now() / 1000),
            text,
          },
        });
        return;
      }

      if (method === "answerCallbackQuery") {
        const callbackQueryId = String(params.callback_query_id ?? "");
        const entry: { callbackQueryId: string; text?: string } = { callbackQueryId };
        if (typeof params.text === "string") entry.text = params.text;
        answers.push(entry);
        sendJson(res, 200, { ok: true, result: true });
        return;
      }

      sendJson(res, 200, { ok: false, error_code: 404, description: "Not Found" });
    })().catch(() => {
      try {
        sendJson(res, 500, { ok: false, error_code: 500, description: "mock error" });
      } catch {
        // ignore
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        sent,
        edits,
        answers,
        calls,
        press(opts2) {
          const message = sent.find((m) => m.messageId === opts2.messageId);
          let data = opts2.data;
          if (data === undefined) {
            const buttons: any[] = message?.replyMarkup?.inline_keyboard?.[0] ?? [];
            data = buttons.find((b) => b?.text === opts2.button)?.callback_data;
          }
          updateId += 1;
          const chatId = opts2.chatId ?? message?.chatId ?? 0;
          queue.push({
            update_id: updateId,
            callback_query: {
              id: `cbq_${updateId}`,
              from: { id: opts2.fromUserId, is_bot: false, first_name: "Mock" },
              message: {
                message_id: opts2.messageId,
                from: { id: 1, is_bot: true, first_name: "MockBot" },
                chat: { id: chatId, type: "private" },
                date: Math.floor(Date.now() / 1000),
                text: message?.text ?? "",
              },
              chat_instance: "1",
              data,
            },
          });
          tryDeliver();
        },
        waitForMessage(count = 1, timeoutMs = 5000) {
          return new Promise<MockSentMessage>((resolveWait, rejectWait) => {
            if (sent.length >= count) {
              resolveWait({ ...sent[count - 1]! });
              return;
            }
            const waiter: MessageWaiter = {
              count,
              resolve: resolveWait,
              reject: rejectWait,
              timer: setTimeout(
                () => {
                  const index = messageWaiters.indexOf(waiter);
                  if (index >= 0) messageWaiters.splice(index, 1);
                  rejectWait(new Error(`waitForMessage(${count}) timed out`));
                },
                timeoutMs,
              ),
            };
            messageWaiters.push(waiter);
          });
        },
        failNext(method, times = 1) {
          failCounts.set(method, (failCounts.get(method) ?? 0) + times);
        },
        close() {
          for (const waiter of [...pendingPolls]) {
            clearTimeout(waiter.timer);
            waiter.resolve({ ok: true, result: [] });
          }
          pendingPolls.length = 0;
          for (const waiter of [...messageWaiters]) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("mock telegram closed"));
          }
          messageWaiters.length = 0;
          return new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}
