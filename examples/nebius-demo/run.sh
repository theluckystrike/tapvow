#!/usr/bin/env bash
# TapVow on Nebius Token Factory with NVIDIA Nemotron, in one command.
#
#   NEBIUS_API_KEY=... examples/nebius-demo/run.sh     real calls, real (tiny) spend
#   NEBIUS_API_KEY_FILE=<file> examples/nebius-demo/run.sh   the same, key read from a 0600 file
#   examples/nebius-demo/run.sh --fake                 no key, no spend, for CI
#
# What it does
#   1. tapvow init --provider nebius with a small daily budget (DEMO_BUDGET, default 0.05 USD)
#   2. starts the gateway; only the gateway process gets the real Nebius key
#   3. runs a small coding agent (agent.mjs) on a Nemotron model through the gateway
#      until the gateway refuses a call with HTTP 402
#   4. exports the signed receipt ledger and verifies it
#
# Settings (environment)
#   DEMO_BUDGET      daily budget in USD (default 0.05, at most 0.20)
#   DEMO_MODEL       model id (default nvidia/nemotron-3-super-120b-a12b)
#   DEMO_MAX_TOKENS  max_tokens per call (default 2048)
#   DEMO_REASONING   off (default) or on. Off asks Nemotron to skip its reasoning tokens
#   DEMO_DIR         run folder (default examples/nebius-demo/.run, wiped at start)
#   DEMO_PACE        seconds to pause between steps, for screen recording (default 0)
set -euo pipefail

MODE=real
if [[ "${1:-}" == "--fake" ]]; then MODE=fake; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="$ROOT/packages/spendmandate/dist/cli.js"
BUDGET="${DEMO_BUDGET:-0.05}"
MODEL="${DEMO_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
MAX_TOKENS="${DEMO_MAX_TOKENS:-2048}"
REASONING="${DEMO_REASONING:-off}"
RUN="${DEMO_DIR:-$HERE/.run}"
PACE="${DEMO_PACE:-0}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; sleep "$PACE"; }
die() { printf 'run.sh: %s\n' "$*" >&2; exit 2; }

if [[ "$MODE" == "real" && -z "${NEBIUS_API_KEY:-}" && -n "${NEBIUS_API_KEY_FILE:-}" ]]; then
  [[ -r "$NEBIUS_API_KEY_FILE" ]] || die "NEBIUS_API_KEY_FILE $NEBIUS_API_KEY_FILE is not readable"
  case "$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$NEBIUS_API_KEY_FILE")" in
    600|400) ;;
    *) die "NEBIUS_API_KEY_FILE must be mode 600 or 400" ;;
  esac
  NEBIUS_API_KEY="$(tr -d '[:space:]' < "$NEBIUS_API_KEY_FILE")"
fi
if [[ "$MODE" == "real" && -z "${NEBIUS_API_KEY:-}" ]]; then
  die "NEBIUS_API_KEY is not set. Get a key at https://tokenfactory.nebius.com, or run with --fake for a no-spend run."
fi
node -e 'const b=Number(process.argv[1]); if(!(b>0 && b<=0.20)) process.exit(1)' "$BUDGET" \
  || die "DEMO_BUDGET must be above 0 and at most 0.20 USD"
command -v node >/dev/null || die "node 22 or later is needed"

# The run folder is ours alone; refuse anything that does not look like it.
case "$RUN" in
  */.run|*/nebius-demo-run*) ;;
  *) die "DEMO_DIR must end in /.run or contain nebius-demo-run (it is wiped at start)" ;;
esac
rm -rf "$RUN"
mkdir -p "$RUN"
HOME_DIR="$RUN/home"

if [[ ! -x "$CLI" ]]; then
  (cd "$ROOT/packages/spendmandate" && node build.mjs >/dev/null)
fi
tapvow() { node --no-warnings "$CLI" "$@"; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
wait_for() {
  for _ in $(seq 1 100); do
    if node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "$1" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  die "timed out waiting for $1"
}

PORT="$(free_port)"
UPSTREAM_ARGS=()
if [[ "$MODE" == "fake" ]]; then
  say "Fake mode. A local stand-in answers like Nebius Token Factory. No key, no spend."
  FAKE_KEY="fake-nebius-key-for-ci"
  node "$HERE/fake-nebius.mjs" "$RUN/fake.port" "$FAKE_KEY" &
  PIDS+=($!)
  for _ in $(seq 1 100); do [[ -s "$RUN/fake.port" ]] && break; sleep 0.05; done
  [[ -s "$RUN/fake.port" ]] || die "the fake Nebius server did not start"
  UPSTREAM_ARGS=(--nebius-base-url "http://127.0.0.1:$(cat "$RUN/fake.port")")
  GATEWAY_KEY="$FAKE_KEY"
else
  say "Real mode. Calls go to Nebius Token Factory and cost real money, capped at $BUDGET USD by TapVow."
  GATEWAY_KEY="$NEBIUS_API_KEY"
fi

say "1. One signed spending limit: $BUDGET USD a day, Nebius only"
tapvow init --home "$HOME_DIR" --provider nebius --budget "$BUDGET" --period day --port "$PORT" \
  | grep -E '^(TapVow initialized|mandate|budget|providers)'

say "2. Start the gateway. Only this process holds the Nebius key."
NEBIUS_API_KEY="$GATEWAY_KEY" node --no-warnings "$CLI" start --home "$HOME_DIR" --port "$PORT" ${UPSTREAM_ARGS[@]+"${UPSTREAM_ARGS[@]}"} \
  > "$RUN/gateway.log" 2>&1 &
PIDS+=($!)
wait_for "http://127.0.0.1:$PORT/healthz"
grep -E '^(TapVow gateway|Upstreams)' "$RUN/gateway.log" || true

say "3. A coding agent on $MODEL works until the limit stops it"
set +e
(
  # The agent gets the virtual key from nebius.env and never sees the real one.
  unset NEBIUS_API_KEY
  # shellcheck disable=SC1091
  source "$HOME_DIR/clients/nebius.env"
  TAPVOW_MODEL="$MODEL" DEMO_WORKDIR="$RUN/code" DEMO_MAX_TOKENS="$MAX_TOKENS" DEMO_REASONING="$REASONING" FORCE_COLOR=1 \
    node "$HERE/agent.mjs"
)
AGENT_EXIT=$?
set -e

if [[ -s "$RUN/code/passing/duration.mjs" ]]; then
  say "What the agent built (its last version whose own tests pass)"
  sed -n '1,24p' "$RUN/code/passing/duration.mjs"
  (cd "$RUN/code/passing" && node --test duration.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)') || true
fi

say "4. Export the signed receipts and verify them"
tapvow export --home "$HOME_DIR" --out "$RUN/receipts.json" --pdf "$RUN/receipts.pdf" >/dev/null
tapvow verify "$RUN/receipts.json" --home "$HOME_DIR"
tapvow verify --live --home "$HOME_DIR"
node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const rows = p.entries.slice(-3).map((e) => {
  const q = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
  const amt = q.charged_micros ?? q.amount_micros;
  const usd = typeof amt === "number" ? `${(amt / 1e6).toFixed(6)} USD` : "";
  return `  seq ${e.seq}  ${e.kind.padEnd(11)} ${String(q.payee ?? "").padEnd(7)} ${String(q.model ?? "").padEnd(35)} ${usd.padEnd(12)}  ${q.code ?? q.outcome ?? ""}  sig ${e.sig.slice(0, 10)}`;
});
console.log("last ledger entries\n" + rows.join("\n"));
' "$RUN/receipts.json"

if [[ "$AGENT_EXIT" -ne 0 ]]; then
  die "the agent did not end with a 402 refusal (exit $AGENT_EXIT); see $RUN/gateway.log"
fi
say "Done. Run folder $RUN"
