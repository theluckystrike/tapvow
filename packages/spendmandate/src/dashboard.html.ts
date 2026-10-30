export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TapVow ledger</title>
<style>
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #14181f;
  --muted: #5b6472;
  --line: #e2e6ec;
  --accent: #2f6df6;
  --good: #1a9f5c;
  --bad: #cf3a3a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101317;
    --panel: #181d24;
    --text: #e8ecf1;
    --muted: #9aa4b2;
    --line: #2a313b;
    --accent: #6ea0ff;
    --good: #46c98a;
    --bad: #ff7a7a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: 16px;
}
.wrap { max-width: 1100px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }
h1 { font-size: 18px; margin: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; }
.dot.live { background: var(--good); }
.status { color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
.links { margin-left: auto; display: flex; gap: 10px; }
.links a { color: var(--accent); text-decoration: none; font-size: 13px; }
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  flex: 1 1 150px;
  min-width: 130px;
}
.card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.card .v { font-size: 15px; margin-top: 3px; word-break: break-all; }
.tablebox { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 640px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); font-size: 12px; white-space: nowrap; }
th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: none; }
.kind { color: var(--muted); }
.empty { color: var(--muted); padding: 14px 10px; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>TapVow ledger</h1>
    <span class="status"><span id="dot" class="dot"></span><span id="status">connecting</span></span>
    <span class="links">
      <a id="json" href="/api/export">Download JSON pack</a>
      <a id="pdf" href="/api/export.pdf">Download PDF</a>
    </span>
  </header>
  <div class="cards">
    <div class="card"><div class="k">Mandate</div><div class="v" id="mandate">-</div></div>
    <div class="card"><div class="k">Budget</div><div class="v" id="budget">-</div></div>
    <div class="card"><div class="k">Spent</div><div class="v" id="spent">-</div></div>
    <div class="card"><div class="k">Remaining</div><div class="v" id="remaining">-</div></div>
    <div class="card"><div class="k">Head</div><div class="v" id="head">-</div></div>
  </div>
  <div class="tablebox">
    <table>
      <thead>
        <tr><th>Seq</th><th>Time</th><th>Kind</th><th>Agent</th><th>Payee</th><th>Model</th><th>Amount</th><th>Outcome</th><th>Hash</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty" id="empty">Waiting for the first entry.</div>
  </div>
</div>
<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("token") || "";
  var qs = "?token=" + encodeURIComponent(token);
  document.getElementById("json").href = "/api/export" + qs;
  document.getElementById("pdf").href = "/api/export.pdf" + qs;

  var rowsBySeq = Object.create(null);
  var headSeq = -1;
  var headHash = "";
  var connected = false;
  var everOpened = false;
  var stateStatus = "connecting";
  var ledgerSeq = -1;
  var budgetSeq = -1;
  var requestSeq = 0;
  var inFlight = false;
  var queued = false;
  var refreshTimer = null;
  var STATE_TIMEOUT_MS = 8000;

  function usd(micros) {
    if (typeof micros !== "number") return "-";
    return "$" + (micros / 1000000).toFixed(6);
  }
  function setText(id, value) {
    document.getElementById(id).textContent = value == null ? "-" : String(value);
  }
  function short(hash) {
    return typeof hash === "string" ? hash.slice(0, 12) : "-";
  }
  function cell(value, className) {
    var td = document.createElement("td");
    if (className) td.className = className;
    td.textContent = value == null ? "-" : String(value);
    return td;
  }
  function rowElement(e) {
    var outcome = e.outcome || e.code || e.decision || "";
    var tr = document.createElement("tr");
    tr.appendChild(cell(e.seq));
    tr.appendChild(cell(e.ts));
    tr.appendChild(cell(e.kind, "kind"));
    tr.appendChild(cell(e.agent_id || "-"));
    tr.appendChild(cell(e.payee || "-"));
    tr.appendChild(cell(e.model || "-"));
    tr.appendChild(cell(usd(e.amount)));
    tr.appendChild(cell(outcome));
    tr.appendChild(cell(short(e.hash)));
    return tr;
  }
  function isNumber(value) {
    return typeof value === "number" && isFinite(value);
  }
  function cardsFresh() {
    return stateStatus === "fresh" && budgetSeq >= 0 && budgetSeq >= ledgerSeq;
  }
  function renderStatus() {
    var on = connected && cardsFresh();
    document.getElementById("dot").className = "dot" + (on ? " live" : "");
    var text = "connecting";
    if (!connected) text = "offline";
    else if (cardsFresh()) text = "live";
    else if (stateStatus === "stale") text = "stale";
    document.getElementById("status").textContent = text;
  }
  function mergeHead(seq, hash) {
    if (!isNumber(seq)) return;
    if (seq > headSeq) {
      headSeq = seq;
      headHash = typeof hash === "string" ? hash : "";
      setText("head", seq + " " + short(headHash));
    } else if (seq === headSeq && !headHash && typeof hash === "string") {
      headHash = hash;
      setText("head", seq + " " + short(headHash));
    }
  }
  // The ledger head can be known from SSE before the budget snapshot matches
  // it. Rows/head may advance independently, but the money cards are only
  // fresh while the snapshot version covers the newest known ledger version.
  function noteLedger(seq, hash) {
    if (!isNumber(seq) || seq < 0) return false;
    var advanced = seq > ledgerSeq;
    if (advanced) ledgerSeq = seq;
    mergeHead(seq, hash);
    if (budgetSeq < ledgerSeq) stateStatus = "stale";
    if (advanced) renderStatus();
    return advanced;
  }
  function validState(s) {
    if (!s || typeof s !== "object") return false;
    if (!s.head || typeof s.head !== "object") return false;
    if (!isNumber(s.head.seq) || s.head.seq < 0) return false;
    if (typeof s.head.hash !== "string") return false;
    if (!isNumber(s.spent_micros)) return false;
    if (!(s.budget_micros === null || isNumber(s.budget_micros))) return false;
    if (!(s.remaining_micros === null || isNumber(s.remaining_micros))) return false;
    if (!Array.isArray(s.entries)) return false;
    return true;
  }
  function renderRows() {
    var tbody = document.getElementById("rows");
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    var seqs = [];
    for (var key in rowsBySeq) seqs.push(Number(key));
    seqs.sort(function (a, b) { return b - a; });
    for (var i = 0; i < seqs.length; i++) tbody.appendChild(rowsBySeq[seqs[i]]);
    document.getElementById("empty").style.display = seqs.length ? "none" : "block";
  }
  function applyState(s) {
    if (!validState(s)) {
      stateStatus = "stale";
      renderStatus();
      return;
    }
    noteLedger(s.head.seq, s.head.hash);
    var entries = s.entries;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || !isNumber(entry.seq)) continue;
      if (!rowsBySeq[entry.seq]) rowsBySeq[entry.seq] = rowElement(entry);
    }
    renderRows();
    if (s.head.seq >= ledgerSeq) {
      setText("mandate", s.mandate && s.mandate.id);
      setText("budget", usd(s.budget_micros));
      setText("spent", usd(s.spent_micros));
      setText("remaining", usd(s.remaining_micros));
      budgetSeq = s.head.seq;
      stateStatus = "fresh";
    } else {
      stateStatus = "stale";
    }
    renderStatus();
  }
  function startRefresh() {
    if (inFlight) { queued = true; return; }
    if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
    inFlight = true;
    var id = ++requestSeq;
    var settled = false;
    var timer = null;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    function finish() {
      if (settled) return;
      settled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (id !== requestSeq) return;
      inFlight = false;
      renderStatus();
      if (queued) { queued = false; startRefresh(); }
    }
    timer = setTimeout(function () {
      if (settled || id !== requestSeq) return;
      if (controller) { try { controller.abort(); } catch (err) { /* ignore */ } }
      stateStatus = "stale";
      finish();
    }, STATE_TIMEOUT_MS);
    var opts = { headers: { accept: "application/json" } };
    if (controller) opts.signal = controller.signal;
    fetch("/api/state" + qs, opts)
      .then(function (r) {
        if (settled || id !== requestSeq) throw new Error("expired state read");
        if (!r || r.ok === false) throw new Error("state read failed");
        return r.json();
      })
      .then(function (s) {
        if (settled || id !== requestSeq) return;
        applyState(s);
      })
      .catch(function () {
        if (settled || id !== requestSeq) return;
        stateStatus = "stale";
      })
      .then(function () { finish(); });
  }
  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      startRefresh();
    }, 250);
  }

  startRefresh();

  var source = new EventSource("/api/events" + qs);
  source.addEventListener("open", function () {
    var reconnected = everOpened;
    everOpened = true;
    connected = true;
    // A reconnect must not present pre-disconnect cards as fresh: require a
    // state read at least as new as the reconnected ledger before "live".
    if (reconnected) stateStatus = "stale";
    renderStatus();
    if (reconnected) scheduleRefresh();
  });
  source.addEventListener("error", function () {
    connected = false;
    stateStatus = "stale";
    renderStatus();
  });
  source.addEventListener("hello", function (ev) {
    try {
      var s = JSON.parse(ev.data);
      if (!s || !isNumber(s.seq)) return;
      if (noteLedger(s.seq, s.hash)) scheduleRefresh();
    } catch (err) { /* ignore */ }
  });
  source.addEventListener("entry", function (ev) {
    try {
      var entry = JSON.parse(ev.data);
      if (!entry || !isNumber(entry.seq)) return;
      rowsBySeq[entry.seq] = rowElement(entry);
      renderRows();
      if (noteLedger(entry.seq, entry.hash)) scheduleRefresh();
    } catch (err) { /* ignore */ }
  });
})();
</script>
</body>
</html>
`;
