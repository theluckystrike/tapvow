#!/bin/bash
# Runs the plan done tests for steps 1 and 2 and appends the real output to
# logs/<date>.txt. Usage: scripts/done-tests.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/$(date +%Y-%m-%d).txt"
mkdir -p "$ROOT/logs"
run() { # package, files...
  local pkg=$1; shift
  (cd "$ROOT/packages/$pkg" && timeout 600 node --no-warnings --import tsx --test --test-timeout=120000 "$@" 2>&1)
}
{
  echo "================================================================"
  echo "Mandate done tests, $(date -u +%Y-%m-%dT%H:%M:%SZ), commit $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo none)"
  echo "node $(node --version), host $(uname -sm)"
  echo
  echo "---- STEP 1: signed SQLite hash-chain ledger (packages/core) ----"
  run core test/ledger.test.ts test/exhaustive.test.ts test/schema.test.ts test/schema-file.test.ts test/canonical.test.ts test/money.test.ts \
    | grep -E "^(ok|not ok) |^# (tests|pass|fail)|exhaustive"
  echo "core exit ${PIPESTATUS[0]}"
  echo
  echo "---- STEP 2: LLM rail, 10 concurrent agents vs 5.00 USD (packages/llm-rail) ----"
  run llm-rail test/concurrency.test.ts test/governed.test.ts test/multiprocess.test.ts test/store.test.ts test/gateway.test.ts test/hardening.test.ts test/review-fixes.test.ts \
    | grep -E "^(ok|not ok) |^# (tests|pass|fail)|run [0-9]:|multiprocess:"
  echo "llm-rail exit ${PIPESTATUS[0]}"
  echo
  echo "---- typecheck ----"
  (cd "$ROOT" && timeout 300 npx tsc -p tsconfig.json --noEmit && echo "tsc: no errors")
} 2>&1 | tee -a "$LOG"
