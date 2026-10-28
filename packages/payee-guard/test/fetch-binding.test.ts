import test from "node:test";
import assert from "node:assert/strict";
import { fetchBinding } from "../src/index.js";
import { startServer } from "./helpers.js";

function jsonServer(body: string, status = 200): Parameters<typeof startServer>[0] {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
}

test("fetchBinding returns the parsed document", async () => {
  const server = await startServer(jsonServer(JSON.stringify({ hello: "world" })));
  try {
    const result = await fetchBinding(server.origin);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.doc, { hello: "world" });
  } finally {
    await server.close();
  }
});

test("fetchBinding fails on 404", async () => {
  const server = await startServer(jsonServer("nope", 404));
  try {
    const result = await fetchBinding(server.origin);
    assert.equal(result.ok, false);
  } finally {
    await server.close();
  }
});

test("fetchBinding fails on a redirect", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  try {
    const result = await fetchBinding(server.origin);
    assert.equal(result.ok, false);
  } finally {
    await server.close();
  }
});

test("fetchBinding fails on invalid JSON", async () => {
  const server = await startServer(jsonServer("{not json"));
  try {
    const result = await fetchBinding(server.origin);
    assert.equal(result.ok, false);
  } finally {
    await server.close();
  }
});

test("fetchBinding fails when the body exceeds maxBytes", async () => {
  const server = await startServer(jsonServer(JSON.stringify({ blob: "x".repeat(500) })));
  try {
    const result = await fetchBinding(server.origin, { maxBytes: 64 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /exceeds/);
  } finally {
    await server.close();
  }
});

test("fetchBinding times out without throwing", async () => {
  const server = await startServer(() => {
    // never respond
  });
  try {
    const result = await fetchBinding(server.origin, { timeoutMs: 50 });
    assert.equal(result.ok, false);
  } finally {
    await server.close();
  }
});

test("fetchBinding never throws on a network error", async () => {
  const result = await fetchBinding("http://127.0.0.1:1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(typeof result.reason, "string");
});
