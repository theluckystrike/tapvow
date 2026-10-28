import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TelegramApiError, TelegramClient } from "../src/telegram.js";
import { startMockTelegram } from "../src/mock-telegram.js";

async function closedPort(): Promise<number> {
  const server: Server = createServer();
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("the constructor rejects a malformed token without echoing it", () => {
  const bad = "not-a-token";
  assert.throws(
    () => new TelegramClient({ token: bad }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(bad));
      return true;
    },
  );
});

test("a network error never contains the token", async () => {
  const token = "999999:abcdefghijklmnopqrstuvwxyz012345";
  const port = await closedPort();
  const client = new TelegramClient({ token, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
  let caught: unknown;
  try {
    await client.call("getUpdates", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.ok(!caught.message.includes(token), `token leaked in: ${caught.message}`);
  assert.ok(!JSON.stringify(caught).includes(token));
});

test("a non-ok response is a TelegramApiError without the token", async () => {
  const mock = await startMockTelegram();
  const wrong = "123456:WRONG-token-for-the-mock-server-x";
  const client = new TelegramClient({ token: wrong, baseUrl: mock.baseUrl });
  await assert.rejects(
    () => client.call("getUpdates", {}),
    (err: unknown) => {
      assert.ok(err instanceof TelegramApiError);
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes(wrong));
      return true;
    },
  );
  await mock.close();
});

test("a successful call returns the result", async () => {
  const mock = await startMockTelegram();
  const client = new TelegramClient({ token: mock.token, baseUrl: mock.baseUrl });
  const result = await client.call<{ message_id: number }>("sendMessage", { chat_id: 1, text: "hi" });
  assert.equal(typeof result.message_id, "number");
  await mock.close();
});
