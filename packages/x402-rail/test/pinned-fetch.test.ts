// Threat-model issue 4: the fetched connection must go to the address that was
// checked, so a host that rebinds after the private-address check cannot reach
// the local network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPinnedFetch, type PinnedResolvedAddress } from "../src/pinned-fetch.js";
import { isPrivateAddress } from "../src/private-address.js";
import { createX402Rail } from "../src/rail.js";
import {
  NETWORK,
  allowlistGuard,
  baseMandate,
  closeServer,
  openTestRail,
  signTestMandate,
  tokenWallet,
} from "./helpers.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mandate-x402-tm4-"));
  dirs.push(d);
  return d;
}

function report(name: string, outcome: string): void {
  console.log(`# tm4 ${name}: ${outcome}`);
}

function listenAt(server: Server, address: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, address);
  });
}

function listenTcp(server: TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
    server.listen(0, "127.0.0.1");
  });
}

function countingServer(onRequest: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): {
  server: Server;
  hits: () => number;
} {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    onRequest(req, res);
  });
  return { server, hits: () => hits };
}

async function closeQuiet(server: Server): Promise<void> {
  try {
    await closeServer(server);
  } catch {
    server.closeAllConnections();
  }
}

test("tm4 rebinding: the connection goes only to the address the resolver returned", async () => {
  const primary = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("primary");
  });
  const other = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("other");
  });

  let primaryAddress = "127.0.0.2";
  let otherAddress = "127.0.0.3";
  let primaryFamily: 4 | 6 = 4;
  let otherFamily: 4 | 6 = 4;
  let fallback = false;
  let port: number;
  try {
    port = await listenAt(primary.server, primaryAddress);
    try {
      await listenAt(other.server, otherAddress, port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRNOTAVAIL" && code !== "EADDRINUSE") throw err;
      await closeQuiet(primary.server);
      await closeQuiet(other.server);
      primaryAddress = "::1";
      otherAddress = "127.0.0.1";
      primaryFamily = 6;
      otherFamily = 4;
      fallback = true;
      port = await listenAt(primary.server, primaryAddress);
      await listenAt(other.server, otherAddress, port);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRNOTAVAIL" && code !== "EADDRINUSE") throw err;
    await closeQuiet(primary.server);
    await closeQuiet(other.server);
    primaryAddress = "::1";
    otherAddress = "127.0.0.1";
    primaryFamily = 6;
    otherFamily = 4;
    fallback = true;
    port = await listenAt(primary.server, primaryAddress);
    await listenAt(other.server, otherAddress, port);
  }

  let resolveCalls = 0;
  const addresses: PinnedResolvedAddress[] = [
    { address: primaryAddress, family: primaryFamily },
    { address: otherAddress, family: otherFamily },
  ];
  const pinned = createPinnedFetch({
    resolve: async () => {
      const answer = addresses[Math.min(resolveCalls, addresses.length - 1)]!;
      resolveCalls += 1;
      return [answer];
    },
    isBlocked: () => false,
  });

  try {
    const response = await pinned(`http://rebind.test:${port}/data`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text, "primary");
    assert.equal(resolveCalls, 1, "the host must be resolved exactly once");
    assert.equal(primary.hits(), 1, "the checked address must serve the request");
    assert.equal(other.hits(), 0, "the rebinding address must see no request");
    report(
      "rebinding",
      `pinned to ${primaryAddress}; resolveCalls=1; ${otherAddress} hits=0${fallback ? " (127.0.0.2 unavailable, used ::1 and 127.0.0.1)" : ""}`,
    );
  } finally {
    await closeQuiet(primary.server);
    await closeQuiet(other.server);
  }
});

test("tm4 blocked resolver: refused before any connection", async () => {
  const target = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  });
  const port = await listenAt(target.server, "127.0.0.1");
  try {
    const pinned = createPinnedFetch({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await assert.rejects(
      pinned(`http://blocked.test:${port}/x`),
      /resolves to a private, loopback or link-local address/,
    );
    assert.equal(target.hits(), 0, "the blocked target must see no request");
    report("blocked", "refused with private-address error; target hits=0");
  } finally {
    await closeQuiet(target.server);
  }
});

test("tm4 ip literal and POST body round trip", async () => {
  const echo = countingServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method} ${Buffer.concat(chunks).toString("utf8")}`);
    });
  });
  const port = await listenAt(echo.server, "127.0.0.1");
  const pinned = createPinnedFetch({ allowPrivate: true });
  try {
    const got = await pinned(`http://127.0.0.1:${port}/ip`, { method: "GET" });
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "GET ");

    const posted = await pinned(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-case": "post" },
      body: "hello pinned",
    });
    assert.equal(posted.status, 200);
    assert.equal(await posted.text(), "POST hello pinned");
    report("ip-literal-post", "ip literal reached the server and POST body round-tripped");
  } finally {
    await closeQuiet(echo.server);
  }
});

test("tm4 response status and headers pass through", async () => {
  const target = countingServer((_req, res) => {
    res.writeHead(201, { "content-type": "text/plain", "x-test-header": "yes" });
    res.end("created");
  });
  const port = await listenAt(target.server, "127.0.0.1");
  const pinned = createPinnedFetch({ allowPrivate: true });
  try {
    const response = await pinned(`http://127.0.0.1:${port}/head`);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-test-header"), "yes");
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(await response.text(), "created");
    report("status-headers", "status 201 and response headers passed through");
  } finally {
    await closeQuiet(target.server);
  }
});

test("tm4 redirect: a 302 is returned without being followed", async () => {
  const destination = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("destination");
  });
  const destinationPort = await listenAt(destination.server, "127.0.0.1");
  const source = countingServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/next` });
    res.end();
  });
  const sourcePort = await listenAt(source.server, "127.0.0.1");
  const pinned = createPinnedFetch({ allowPrivate: true });
  try {
    const response = await pinned(`http://127.0.0.1:${sourcePort}/start`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `http://127.0.0.1:${destinationPort}/next`);
    assert.equal(destination.hits(), 0, "the redirect must not be followed");
    report("redirect", "302 returned as is; destination hits=0");
  } finally {
    await closeQuiet(source.server);
    await closeQuiet(destination.server);
  }
});

test("tm4 abort: an aborted signal rejects", async () => {
  const hanging = countingServer(() => {
    // Never answer: the request must be torn down by the abort.
  });
  const port = await listenAt(hanging.server, "127.0.0.1");
  const pinned = createPinnedFetch({ allowPrivate: true });
  const controller = new AbortController();
  try {
    const pending = pinned(`http://127.0.0.1:${port}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
    report("abort", "request rejected with AbortError");
  } finally {
    await closeQuiet(hanging.server);
  }
});

test("tm4 rail: the default fetch still blocks a private host with the old reason", async () => {
  const target = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  });
  const port = await listenAt(target.server, "127.0.0.1");
  const payer = tokenWallet();
  const mandate = baseMandate();
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);
  const x402 = createX402Rail({
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: allowlistGuard([]),
  });
  try {
    const result = await x402.pay(
      { agentId: "agent-01", mandateId: mandate.id },
      { url: `http://127.0.0.1:${port}/x` },
    );
    assert.equal(result.status, 403);
    const body = JSON.parse(result.body) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "host_not_allowed");
    assert.equal(body.error.message, "host 127.0.0.1 resolves to a private, loopback or link-local address");
    assert.equal(target.hits(), 0, "the private target must see no request");
    report("rail-default", "status 403 host_not_allowed with the original message; target hits=0");
  } finally {
    rail.close();
    await closeQuiet(target.server);
  }
});

test("tm4 h2 private-address: mapped, compatible, NAT64, site-local and new IPv4 ranges", () => {
  const blocked = [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "fec0::1",
    "198.18.0.1",
    "192.0.0.8",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
  ];
  for (const a of blocked) assert.equal(isPrivateAddress(a), true, `${a} must be blocked`);
  const allowed = ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const a of allowed) assert.equal(isPrivateAddress(a), false, `${a} must not be blocked`);
  // The URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1]. That is the
  // bracketed string url.hostname carries when the rail checks it.
  const bracketed = new URL("http://[::ffff:7f00:1]:9/").hostname;
  assert.equal(bracketed, "[::ffff:7f00:1]");
  assert.equal(isPrivateAddress(bracketed), true);
  report("h2-private-address", "IPv4-mapped/compatible/NAT64/site-local and 198.18/15, 192.0.0.0/24 blocked; 8.8.8.8 and a public v6 not");
});

test("tm4 h2 rail: a bracketed IPv4-mapped loopback URL is refused without allowPrivateNetwork", async () => {
  const target = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  });
  const port = await listenAt(target.server, "127.0.0.1");
  const payer = tokenWallet();
  const mandate = baseMandate();
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);
  const x402 = createX402Rail({
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: allowlistGuard([]),
  });
  try {
    const result = await x402.pay(
      { agentId: "agent-01", mandateId: mandate.id },
      { url: `http://[::ffff:127.0.0.1]:${port}/x` },
    );
    assert.equal(result.status, 403);
    const body = JSON.parse(result.body) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "host_not_allowed");
    assert.match(body.error.message, /private, loopback or link-local/);
    assert.equal(target.hits(), 0, "the loopback target must see no request");
    report("h2-rail-mapped-loopback", "403 host_not_allowed for [::ffff:127.0.0.1]; loopback target hits=0");
  } finally {
    rail.close();
    await closeQuiet(target.server);
  }
});

test("tm4 h1 bad status: a 999 response rejects with a TypeError and does not kill the process", async () => {
  const sockets: Socket[] = [];
  const raw = createTcpServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.end("HTTP/1.1 999 Odd\r\ncontent-length: 0\r\n\r\n");
    });
  });
  const port = await listenTcp(raw);
  const pinned = createPinnedFetch({ allowPrivate: true, timeoutMs: 5000 });

  let uncaught = 0;
  const trap = (): void => {
    uncaught += 1;
  };
  process.on("uncaughtException", trap);
  try {
    await assert.rejects(pinned(`http://127.0.0.1:${port}/odd`), (err: unknown) => {
      assert.ok(err instanceof TypeError, `expected a TypeError, got ${String(err)}`);
      assert.match((err as Error).message, /999/);
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(uncaught, 0, "no uncaughtException may fire");
    report("h1-bad-status", "status 999 rejected with a TypeError naming 999; process alive");
  } finally {
    process.off("uncaughtException", trap);
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  }
});

test("tm4 m1 timeout: a server that accepts and never answers rejects within the deadline", async () => {
  const hanging = countingServer(() => {
    // Accept the connection and never answer.
  });
  const port = await listenAt(hanging.server, "127.0.0.1");
  const pinned = createPinnedFetch({ allowPrivate: true, timeoutMs: 150 });
  const started = Date.now();
  try {
    await assert.rejects(pinned(`http://127.0.0.1:${port}/hang`), (err: unknown) => {
      assert.equal((err as Error).name, "TimeoutError");
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `rejected within the deadline (${elapsed} ms)`);
    report("m1-timeout", `rejected with TimeoutError after ${elapsed} ms (deadline 150 ms)`);
  } finally {
    await closeQuiet(hanging.server);
  }
});

test("tm4 m2 abort before request: an abort during DNS lookup rejects and sends nothing", async () => {
  const target = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("late");
  });
  const port = await listenAt(target.server, "127.0.0.1");
  const pinned = createPinnedFetch({
    allowPrivate: true,
    resolve: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  const controller = new AbortController();
  try {
    const pending = pinned(`http://slow.test:${port}/x`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => {
      assert.equal((err as Error).name, "AbortError");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(target.hits(), 0, "an aborted lookup must start no request");
    report("m2-abort-lookup", "AbortError during the 50 ms DNS lookup; server hits=0");
  } finally {
    await closeQuiet(target.server);
  }
});

test("tm4 h1 upgrade: a 101 response rejects quickly with a TypeError", async () => {
  const sockets: Socket[] = [];
  const raw = createTcpServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
    });
  });
  const port = await listenTcp(raw);
  const pinned = createPinnedFetch({ allowPrivate: true, timeoutMs: 10000 });
  const started = Date.now();
  try {
    await assert.rejects(pinned(`http://127.0.0.1:${port}/upgrade`), (err: unknown) => {
      assert.ok(err instanceof TypeError, `expected a TypeError, got ${String(err)}`);
      assert.match((err as Error).message, /unexpected 101 upgrade response/);
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `rejected well before the deadline (${elapsed} ms)`);
    report("h1-upgrade", `101 rejected with a TypeError after ${elapsed} ms (deadline 10000 ms)`);
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  }
});

test("tm4 h2b private-address: IPv4-translated and 6to4 ranges", () => {
  const blocked = ["::ffff:0:7f00:1", "2002:7f00:1::"];
  for (const a of blocked) assert.equal(isPrivateAddress(a), true, `${a} must be blocked`);
  const allowed = ["2002:808:808::"];
  for (const a of allowed) assert.equal(isPrivateAddress(a), false, `${a} must not be blocked`);
  report(
    "h2b-private-address",
    "::ffff:0:7f00:1 and 2002:7f00:1:: blocked; 2002:808:808:: (8.8.8.8) not blocked",
  );
});

test("tm4 lookup deadline: a resolver that never answers is bounded", async () => {
  const pinned = createPinnedFetch({
    allowPrivate: true,
    timeoutMs: 120,
    resolve: () => new Promise<PinnedResolvedAddress[]>(() => {}),
  });
  const started = Date.now();
  await assert.rejects(pinned("http://never-resolves.test/x"), (err: unknown) => {
    assert.equal((err as Error).name, "TimeoutError");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `rejected within the deadline (${elapsed} ms)`);
  report("lookup-deadline", `never-resolving lookup rejected with TimeoutError after ${elapsed} ms (deadline 120 ms)`);
});

test("tm4 ip literal check: 127.0.0.1 is checked directly and the resolver is not called", async () => {
  let resolveCalls = 0;
  const pinned = createPinnedFetch({
    resolve: async () => {
      resolveCalls += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    },
  });
  await assert.rejects(
    pinned("http://127.0.0.1/"),
    /resolves to a private, loopback or link-local address/,
  );
  assert.equal(resolveCalls, 0, "an IP literal must not be sent to the resolver");
  report("ip-literal-check", "resolver calls=0; 127.0.0.1 refused without allowPrivate");
});

test("tm4 rebinding (rail): the default fetch re-checks the resolver and never reaches the private server", async () => {
  const priv = countingServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  });
  const port = await listenAt(priv.server, "127.0.0.1");
  const payer = tokenWallet();
  const mandate = baseMandate();
  const { issuer, signed } = signTestMandate(mandate);
  const { rail } = openTestRail(join(tmp(), "rail.db"), signed, issuer.publicKey);

  let resolveCalls = 0;
  const answers: PinnedResolvedAddress[] = [
    { address: "127.0.0.2", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const x402 = createX402Rail({
    rail,
    account: payer.account,
    networks: [NETWORK],
    guard: allowlistGuard([]),
    resolve: async () => {
      const answer = answers[Math.min(resolveCalls, answers.length - 1)]!;
      resolveCalls += 1;
      return [answer];
    },
    // Public-looking first answer is allowed; the private one is refused. Both
    // are loopback, so this test never touches a non-loopback interface.
    isBlocked: (address) => address === "127.0.0.1",
  });
  try {
    const result = await x402.pay(
      { agentId: "agent-01", mandateId: mandate.id },
      { url: `http://rebind.test:${port}/x` },
    );
    assert.equal(result.status, 502, "blocked before any payment was signed");
    assert.equal(priv.hits(), 0, "the private server must see no request");
    assert.ok(resolveCalls >= 2, "the early check and the pinned fetch each resolved");
    report(
      "rail-rebinding",
      `early check saw 127.0.0.2 (allowed), pinned fetch saw 127.0.0.1 (blocked); private hits=0; resolveCalls=${resolveCalls}`,
    );
  } finally {
    rail.close();
    await closeQuiet(priv.server);
  }
});
