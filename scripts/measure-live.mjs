// Measures how long a governed call takes to show up on the dashboard's
// Server-Sent Events stream. No browser: it reads /api/events with fetch.
// Usage: node scripts/measure-live.mjs <gatewayUrl> <dashboardToken> <virtualKey> [runs]
const [base, token, key, runsArg] = process.argv.slice(2);
if (!base || !token || !key) {
  console.error("usage: measure-live.mjs <gatewayUrl> <dashboardToken> <virtualKey> [runs]");
  process.exit(2);
}
const runs = Number(runsArg ?? 5);

const ac = new AbortController();
const res = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
if (res.status !== 200) {
  console.error(`events stream answered ${res.status}`);
  process.exit(1);
}
const waiters = [];
let headSeq = null;
(async () => {
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        const t = performance.now();
        if (event === "hello") headSeq = obj.head?.seq ?? obj.seq ?? 0;
        if (event === "entry") for (const w of waiters.splice(0)) w(obj, t);
      }
    }
  } catch {}
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && headSeq === null; i++) await sleep(20);
if (headSeq === null) {
  console.error("no hello event");
  process.exit(1);
}

const results = [];
for (let r = 0; r < runs; r++) {
  const seen = new Promise((resolve) => {
    const want = (obj, t) => {
      const kind = obj.kind ?? obj.entry?.kind;
      if (kind === "llm.settle") resolve({ obj, t });
      else waiters.push(want);
    };
    waiters.push(want);
  });
  const t0 = performance.now();
  const call = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: `live run ${r}` }], max_tokens: 40 }),
  });
  await call.text();
  const tResp = performance.now();
  const timeout = sleep(5000).then(() => null);
  const got = await Promise.race([seen, timeout]);
  if (!got) {
    console.log(`run ${r + 1}: status ${call.status}, no ledger event within 5000 ms`);
    results.push(Infinity);
    continue;
  }
  const afterResp = Math.max(0, got.t - tResp);
  const fromStart = got.t - t0;
  results.push(afterResp);
  console.log(`run ${r + 1}: status ${call.status}, seq ${got.obj.seq}, event ${afterResp.toFixed(1)} ms after the response, ${fromStart.toFixed(1)} ms after the request`);
}
ac.abort();
const worst = Math.max(...results);
console.log(`live view: worst ${worst.toFixed(1)} ms over ${runs} calls, limit 2000 ms, ${worst < 2000 ? "PASS" : "FAIL"}`);
process.exit(worst < 2000 ? 0 : 1);
