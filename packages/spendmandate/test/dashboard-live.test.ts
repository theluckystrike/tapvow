import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DASHBOARD_HTML } from "../src/dashboard.html.js";

// This test drives the real inline dashboard script extracted from
// DASHBOARD_HTML. It stubs only the browser transport (fetch, EventSource,
// timers, DOM) so the observable card/row behaviour of the shipped script is
// what runs. The fake clock means timeouts are deterministic (no real sleeps).

interface Row {
  seq: number;
  ts: string;
  kind: string;
  agent_id?: string;
  payee?: string;
  model?: string;
  amount: number | null;
  outcome?: string;
  code?: string;
  decision?: string;
  hash: string;
}

class El {
  id: string;
  children: El[] = [];
  className = "";
  href = "";
  style: Record<string, string> = {};
  private text = "";

  constructor(id: string) {
    this.id = id;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
  }

  get firstChild(): El | null {
    return this.children[0] ?? null;
  }

  appendChild(child: El): El {
    this.children.push(child);
    return child;
  }

  insertBefore(child: El, ref: El | null): El {
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child: El): El {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
}

interface Deferred {
  url: string;
  options: { signal?: AbortSignal };
  aborted: boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Clock {
  now: number;
  setTimeout: (fn: () => void, delay?: number) => number;
  clearTimeout: (id: number) => void;
  tick: (ms: number) => void;
  pendingCount: () => number;
}

function fakeClock(): Clock {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    get now() {
      return now;
    },
    setTimeout(fn: () => void, delay = 0): number {
      const id = ++next;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id: number): void {
      timers.delete(id);
    },
    tick(ms: number): void {
      const until = now + ms;
      let steps = 0;
      while (true) {
        let best: { id: number; timer: { at: number; fn: () => void } } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= until && (!best || timer.at < best.timer.at)) best = { id, timer };
        }
        if (!best) break;
        if (++steps > 100000) throw new Error("timer loop");
        now = best.timer.at;
        timers.delete(best.id);
        best.timer.fn();
      }
      now = until;
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

function row(seq: number, kind = "llm.settle", amount = 1000): Row {
  return {
    seq,
    ts: `2026-10-30T00:00:0${seq}Z`,
    kind,
    agent_id: "openai-client",
    payee: "fake-upstream",
    model: "gpt-4.1",
    amount,
    outcome: kind === "llm.denied" ? "denied" : "settled",
    hash: `ledger-${String(seq).padStart(5, "0")}`,
  };
}

interface SnapshotOpts {
  headSeq: number;
  budget?: number | null;
  spent?: number;
  remaining?: number | null;
  entries?: Row[];
  hash?: string;
}

function snapshot(opts: SnapshotOpts): Record<string, unknown> {
  const spent = opts.spent ?? opts.headSeq * 1000;
  const budget = opts.budget === undefined ? 50000 : opts.budget;
  const remaining = opts.remaining === undefined ? (budget === null ? null : budget - spent) : opts.remaining;
  return {
    mandate: { id: "mandate-test" },
    budget_micros: budget,
    spent_micros: spent,
    remaining_micros: remaining,
    head: {
      seq: opts.headSeq,
      hash: opts.hash ?? `ledger-${String(opts.headSeq).padStart(5, "0")}`,
    },
    entries:
      opts.entries ??
      Array.from({ length: Math.max(0, opts.headSeq) }, (_, index) => row(opts.headSeq - index)),
  };
}

interface Harness {
  els: Record<string, El>;
  calls: Deferred[];
  clock: Clock;
  source: { emit: (type: string, payload?: unknown) => void };
  start: () => void;
}

function harness(): Harness {
  const ids = ["json", "pdf", "dot", "status", "mandate", "budget", "spent", "remaining", "head", "rows", "empty"];
  const els: Record<string, El> = {};
  for (const id of ids) els[id] = new El(id);
  for (const id of ["mandate", "budget", "spent", "remaining", "head"]) els[id].textContent = "-";

  const document = {
    getElementById: (id: string) => els[id] ?? null,
    createElement: () => new El("cell"),
  };

  const clock = fakeClock();
  const calls: Deferred[] = [];
  function fetchStub(url: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request: Deferred = { url, options, aborted: false, resolve, reject };
      // Deliberately do not reject on abort: a real late reply must be ignored
      // by the script on its own, not because the stub honoured the signal.
      options.signal?.addEventListener("abort", () => {
        request.aborted = true;
      });
      calls.push(request);
    });
  }

  const listeners: Record<string, Array<(ev: { data?: string }) => void>> = {};
  class FakeEventSource {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(type: string, fn: (ev: { data?: string }) => void): void {
      (listeners[type] ??= []).push(fn);
    }
    close(): void {}
  }

  const context = {
    document,
    location: { search: "?token=fake-token" },
    fetch: fetchStub,
    EventSource: FakeEventSource,
    URLSearchParams,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    AbortController,
    DOMException,
  };

  const match = DASHBOARD_HTML.match(/<script>\n([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded dashboard script is present");
  const script = match[1];

  return {
    els,
    calls,
    clock,
    source: {
      emit(type: string, payload?: unknown) {
        for (const fn of listeners[type] ?? []) {
          fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
        }
      },
    },
    start() {
      vm.runInNewContext(script, context);
    },
  };
}

function ok(value: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => value };
}

function failed(status = 503): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: false, status, json: async () => ({ error: "unavailable" }) };
}

function rowSeqs(els: Record<string, El>): number[] {
  return els.rows.children.map((tr) => Number(tr.children[0].textContent));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function tick(h: Harness, ms: number): Promise<void> {
  h.clock.tick(ms);
  await flush();
}

async function boot(h: Harness, opts: SnapshotOpts = { headSeq: 8, spent: 8000 }): Promise<void> {
  h.start();
  h.source.emit("open");
  assert.equal(h.calls.length, 1, "one initial state read");
  h.calls[0].resolve(ok(snapshot(opts)));
  await flush();
  assert.equal(h.els.status.textContent, "live");
}

test("dashboard live: cards update after a streamed entry once a matching snapshot arrives", async () => {
  const h = harness();
  h.start();
  assert.equal(h.calls.length, 1, "one initial state read");
  assert.match(h.calls[0].url, /^\/api\/state\?token=fake-token$/);

  h.source.emit("open");
  h.source.emit("entry", row(9, "llm.settle", 1000));
  assert.equal(h.els.head.textContent, "9 ledger-00009", "entry advances the head immediately");
  assert.equal(h.els.status.textContent, "stale", "a newer ledger makes older cards stale immediately");

  h.calls[0].resolve(ok(snapshot({ headSeq: 8, spent: 10973, entries: [row(8)] })));
  await flush();
  assert.equal(h.els.status.textContent, "stale", "a snapshot behind the known ledger is not accepted");
  assert.equal(h.els.spent.textContent, "-", "no stale snapshot values are shown as fresh");
  assert.deepEqual(rowSeqs(h.els), [9, 8], "newer streamed row survives the late initial snapshot");

  await tick(h, 250);
  assert.equal(h.calls.length, 2, "one bounded state read after the entry, not a poll loop");
  h.calls[1].resolve(ok(snapshot({ headSeq: 9, spent: 11973, entries: [row(9), row(8)] })));
  await flush();

  assert.equal(h.els.spent.textContent, "$0.011973", "Spent card is live without a reload");
  assert.equal(h.els.remaining.textContent, "$0.038027", "Remaining card is live without a reload");
  assert.equal(h.els.head.textContent, "9 ledger-00009");
  assert.deepEqual(rowSeqs(h.els), [9, 8], "no duplicated ledger rows");
  assert.equal(h.els.status.textContent, "live");
});

test("dashboard live: a late initial snapshot cannot drop rows or regress the head", async () => {
  const h = harness();
  h.start();
  h.source.emit("open");
  h.source.emit("entry", row(10));
  h.source.emit("entry", row(9));

  h.calls[0].resolve(ok(snapshot({ headSeq: 8, spent: 8000, entries: [row(8), row(7)] })));
  await flush();

  assert.deepEqual(rowSeqs(h.els), [10, 9, 8, 7], "late snapshot merges instead of clearing newer rows");
  assert.equal(h.els.head.textContent, "10 ledger-00010", "head does not regress to the snapshot head");
  assert.deepEqual(rowSeqs(h.els).filter((seq) => seq === 10), [10], "the streamed row is not duplicated");
  assert.equal(h.els.status.textContent, "stale", "cards behind the ledger are stale");

  await tick(h, 250);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(ok(snapshot({ headSeq: 10, spent: 10000, entries: [row(10), row(9)] })));
  await flush();

  assert.deepEqual(rowSeqs(h.els), [10, 9, 8, 7], "refresh neither duplicates nor silently drops older rows");
  assert.equal(h.els.head.textContent, "10 ledger-00010");
  assert.equal(h.els.spent.textContent, "$0.010000");
  assert.equal(h.els.status.textContent, "live");
});

test("dashboard live: a failed refresh is shown stale and keeps the last honest cards", async () => {
  const h = harness();
  await boot(h, { headSeq: 8, spent: 10973 });

  h.source.emit("entry", row(9));
  await tick(h, 250);
  assert.equal(h.calls.length, 2, "refresh attempted exactly once");
  h.calls[1].resolve(failed(503));
  await flush();

  assert.equal(h.els.status.textContent, "stale", "failed state read is labelled stale, not live");
  assert.equal(h.els.dot.className, "dot", "live indicator is off");
  assert.equal(h.els.spent.textContent, "$0.010973", "last known value is retained, not invented");
  assert.equal(h.els.remaining.textContent, "$0.039027", "last known remaining is retained");
});

test("dashboard live: entries during an in-flight read coalesce into one follow-up read", async () => {
  const h = harness();
  h.start();
  h.source.emit("open");
  h.source.emit("entry", row(9));
  h.source.emit("entry", row(10));

  await tick(h, 250);
  assert.equal(h.calls.length, 1, "no overlapping request while the first read is pending");

  h.calls[0].resolve(ok(snapshot({ headSeq: 8, spent: 9000, entries: [row(8)] })));
  await flush();
  assert.equal(h.calls.length, 2, "a single follow-up read runs after the pending one settles");

  h.calls[1].resolve(ok(snapshot({ headSeq: 10, spent: 11000, entries: [row(10), row(9), row(8)] })));
  await flush();
  assert.equal(h.els.spent.textContent, "$0.011000");
  assert.deepEqual(rowSeqs(h.els), [10, 9, 8]);
  assert.equal(h.els.head.textContent, "10 ledger-00010");
  assert.equal(h.els.status.textContent, "live");
});

test("dashboard live: a never-settling fetch times out, releases, and recovers on a new event", async () => {
  const h = harness();
  await boot(h);

  h.source.emit("entry", row(9));
  await tick(h, 250);
  assert.equal(h.calls.length, 2);
  assert.equal(h.els.status.textContent, "stale");

  for (let seq = 10; seq <= 50; seq++) h.source.emit("entry", row(seq));
  await tick(h, 8000);

  assert.equal(h.calls[1].aborted, true, "the hung request is aborted at the deadline");
  assert.equal(h.calls.length, 3, "the queued follow-up is released exactly once, no storm");
  assert.equal(h.els.status.textContent, "stale", "hung cards are not labelled live");
  assert.equal(h.els.spent.textContent, "$0.008000", "last honest value is preserved");
  assert.equal(h.els.head.textContent, "50 ledger-00050", "head still advances independently");

  // A real late reply after the timeout must not overwrite newer state.
  h.calls[1].resolve(ok(snapshot({ headSeq: 9, spent: 9000 })));
  await flush();
  assert.equal(h.els.spent.textContent, "$0.008000", "late success from an expired request is discarded");
  assert.equal(h.els.status.textContent, "stale");

  h.calls[2].resolve(ok(snapshot({ headSeq: 50, spent: 50000, remaining: 0 })));
  await flush();
  assert.equal(h.els.spent.textContent, "$0.050000");
  assert.equal(h.els.status.textContent, "live");

  await tick(h, 60000);
  assert.equal(h.calls.length, 3, "idle time creates no further requests");
  assert.equal(h.clock.pendingCount(), 0, "all timers are cleaned up");
});

test("dashboard live: a hung response body is covered by the same timeout", async () => {
  const h = harness();
  await boot(h);

  h.source.emit("entry", row(9));
  await tick(h, 250);
  assert.equal(h.calls.length, 2);

  let resolveBody: ((value: unknown) => void) | null = null;
  const body = new Promise<unknown>((resolve) => {
    resolveBody = resolve;
  });
  h.calls[1].resolve({ ok: true, status: 200, json: () => body });
  await flush();
  assert.equal(h.els.status.textContent, "stale");

  await tick(h, 8000);
  assert.equal(h.calls[1].aborted, true, "timeout spans the body read");
  assert.equal(h.els.status.textContent, "stale");
  assert.equal(h.els.spent.textContent, "$0.008000");

  resolveBody!(snapshot({ headSeq: 9, spent: 9000 }));
  await flush();
  assert.equal(h.els.spent.textContent, "$0.008000", "late body from an expired request is discarded");
  assert.equal(h.els.status.textContent, "stale");

  h.source.emit("entry", row(10));
  await tick(h, 250);
  assert.equal(h.calls.length, 3, "a new event after the timeout starts a fresh read");
  h.calls[2].resolve(ok(snapshot({ headSeq: 10, spent: 10000 })));
  await flush();
  assert.equal(h.els.spent.textContent, "$0.010000");
  assert.equal(h.els.status.textContent, "live");
});

test("dashboard live: malformed snapshot {} is stale and keeps the last good cards", async () => {
  const h = harness();
  await boot(h, { headSeq: 8, spent: 8000 });

  h.source.emit("entry", row(9));
  await tick(h, 250);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(ok({}));
  await flush();

  assert.equal(h.els.status.textContent, "stale", "empty object is not a valid snapshot");
  assert.equal(h.els.dot.className, "dot", "live indicator is off");
  assert.equal(h.els.spent.textContent, "$0.008000", "last good spent is preserved, not '-'");
  assert.equal(h.els.remaining.textContent, "$0.042000", "last good remaining is preserved");
  assert.equal(h.els.head.textContent, "9 ledger-00009", "ledger head still advanced from the entry");
});

test("dashboard live: invalid numeric fields and regressed heads are rejected", async () => {
  const h = harness();
  await boot(h, { headSeq: 8, spent: 8000 });

  h.source.emit("entry", row(9));
  await tick(h, 250);
  h.calls[1].resolve(ok({ ...snapshot({ headSeq: 9, spent: 9000 }), spent_micros: Number.NaN }));
  await flush();
  assert.equal(h.els.status.textContent, "stale", "non-finite spent is rejected");
  assert.equal(h.els.spent.textContent, "$0.008000");

  h.source.emit("entry", row(10));
  await tick(h, 250);
  h.calls[2].resolve(ok(snapshot({ headSeq: 7, spent: 7000 })));
  await flush();
  assert.equal(h.els.status.textContent, "stale", "a snapshot head behind the ledger is rejected");
  assert.equal(h.els.spent.textContent, "$0.008000", "regressed snapshot does not rewrite cards");
  assert.equal(h.els.head.textContent, "10 ledger-00010", "head does not regress");

  h.source.emit("entry", row(11));
  await tick(h, 250);
  h.calls[3].resolve(ok(snapshot({ headSeq: 11, spent: 11000 })));
  await flush();
  assert.equal(h.els.status.textContent, "live");
  assert.equal(h.els.spent.textContent, "$0.011000");
});

test("dashboard live: an empty initial ledger is valid and shows zero spend", async () => {
  const h = harness();
  h.start();
  h.source.emit("open");
  h.calls[0].resolve(ok(snapshot({ headSeq: 0, spent: 0, budget: 50000, remaining: 50000, entries: [] })));
  await flush();

  assert.equal(h.els.status.textContent, "live");
  assert.equal(h.els.spent.textContent, "$0.000000");
  assert.equal(h.els.remaining.textContent, "$0.050000");
  assert.equal(h.els.head.textContent, "0 ledger-00000");
  assert.deepEqual(rowSeqs(h.els), []);
  assert.equal(h.els.empty.style.display, "block");
});

test("dashboard live: reconnect does not label old cards live before a matching state read", async () => {
  const h = harness();
  await boot(h, { headSeq: 8, spent: 8000 });

  h.source.emit("error");
  assert.equal(h.els.status.textContent, "offline");
  assert.equal(h.els.dot.className, "dot");

  h.source.emit("open");
  assert.equal(h.els.status.textContent, "stale", "reconnect alone does not restore live cards");

  h.source.emit("hello", { seq: 10, hash: "ledger-00010" });
  assert.equal(h.els.status.textContent, "stale", "new ledger head keeps old cards stale");
  assert.equal(h.els.head.textContent, "10 ledger-00010");

  await tick(h, 250);
  assert.equal(h.calls.length, 2, "reconnect triggers one state read");
  assert.equal(h.els.status.textContent, "stale", "still stale while the matching read is pending");

  h.calls[1].resolve(ok(snapshot({ headSeq: 10, spent: 10000 })));
  await flush();
  assert.equal(h.els.status.textContent, "live", "matching state read restores live");
  assert.equal(h.els.spent.textContent, "$0.010000");
});

test("dashboard live: matching hello after a reconnect still requires a state read", async () => {
  const h = harness();
  await boot(h, { headSeq: 8, spent: 8000 });

  h.source.emit("error");
  h.source.emit("open");
  h.source.emit("hello", { seq: 8, hash: "ledger-00008" });
  assert.equal(h.els.status.textContent, "stale", "same head on reconnect is still stale until read");

  await tick(h, 250);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(ok(snapshot({ headSeq: 8, spent: 8000 })));
  await flush();
  assert.equal(h.els.status.textContent, "live");
  assert.equal(h.els.spent.textContent, "$0.008000");
});

test("dashboard live: HTTP, malformed JSON and network failures all mark stale and recover", async () => {
  const kinds = ["http", "json", "network"] as const;
  for (const kind of kinds) {
    const h = harness();
    await boot(h, { headSeq: 8, spent: 8000 });

    h.source.emit("entry", row(9));
    await tick(h, 250);
    assert.equal(h.calls.length, 2, `${kind}: refresh requested`);

    if (kind === "http") h.calls[1].resolve(failed(503));
    else if (kind === "json") {
      h.calls[1].resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("invalid JSON");
        },
      });
    } else h.calls[1].reject(new TypeError("network unavailable"));
    await flush();

    assert.equal(h.els.status.textContent, "stale", `${kind}: failure is stale`);
    assert.equal(h.els.spent.textContent, "$0.008000", `${kind}: last honest spent retained`);

    h.source.emit("error");
    assert.equal(h.els.status.textContent, "offline", `${kind}: SSE error is offline`);
    h.source.emit("open");
    h.source.emit("hello", { seq: 9, hash: "ledger-00009" });
    await tick(h, 250);

    assert.equal(h.calls.length, 3, `${kind}: one recovery read`);
    h.calls[2].resolve(ok(snapshot({ headSeq: 9, spent: 9000 })));
    await flush();
    assert.equal(h.els.status.textContent, "live", `${kind}: recovery restores live`);
    assert.equal(h.els.spent.textContent, "$0.009000", `${kind}: recovered value`);
    assert.equal(h.clock.pendingCount(), 0, `${kind}: no timers left behind`);
  }
});

test("dashboard live: a burst is bounded and idle time does not poll", async () => {
  const h = harness();
  h.start();
  h.source.emit("open");
  for (let seq = 1; seq <= 100; seq++) h.source.emit("entry", row(seq));
  await tick(h, 250);
  assert.equal(h.calls.length, 1, "one in-flight request while the burst arrives");

  h.calls[0].resolve(ok(snapshot({ headSeq: 0, spent: 0, entries: [] })));
  await flush();
  assert.equal(h.calls.length, 2, "exactly one coalesced follow-up");

  h.calls[1].resolve(ok(snapshot({ headSeq: 100, spent: 100000, budget: 200000 })));
  await flush();
  assert.equal(h.els.status.textContent, "live");
  assert.equal(h.els.head.textContent, "100 ledger-00100");

  await tick(h, 60000);
  assert.equal(h.calls.length, 2, "no polling after idle time");
  assert.equal(h.clock.pendingCount(), 0, "timers are cleaned up");
});
