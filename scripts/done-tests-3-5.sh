#!/bin/bash
# Runs the plan done tests for steps 3, 4 and 5 and appends the real output to
# logs/<date>.txt. Usage: scripts/done-tests-3-5.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/$(date +%Y-%m-%d).txt"
mkdir -p "$ROOT/logs"
run() { # package, files...
  local pkg=$1; shift
  (cd "$ROOT/packages/$pkg" && timeout 600 node --no-warnings --import tsx --test --test-timeout=120000 "$@" 2>&1)
}
pick() { grep -E "^(ok|not ok) |^# (tests|pass|fail) |^# (x402|step|blocked|\\\\# blocked)"; }
{
  echo "================================================================"
  echo "TapVow done tests for steps 3 to 5, $(date -u +%Y-%m-%dT%H:%M:%SZ), commit $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo none)"
  echo "local time $(date '+%Y-%m-%d %H:%M %Z')"
  echo "node $(node --version), host $(uname -sm), free disk $(df -m /System/Volumes/Data | tail -1 | awk '{print $4}') MB"
  echo
  echo "---- STEP 3: x402 rail through the gateway (packages/x402-rail, local facilitator) ----"
  run x402-rail test/step3.test.ts test/governance.test.ts test/hardening.test.ts | pick
  echo "x402-rail exit ${PIPESTATUS[0]}"
  echo
  echo "---- STEP 3: anvil fork of Base Sepolia with the real USDC contract ----"
  (cd "$ROOT/packages/x402-rail" || exit 9; timeout 300 npm run --silent fork-e2e 2>&1 | grep -E "^(x402 fork|fork-e2e|blocked|FAIL|Error)"; exit "${PIPESTATUS[0]}")
  echo "fork-e2e exit $?"
  echo
  echo "---- STEP 3: Base Sepolia testnet ----"
  (cd "$ROOT/packages/x402-rail" || exit 9; timeout 300 npm run --silent testnet 2>&1 | grep -E "^(testnet|BLOCKED|ledger)"; exit "${PIPESTATUS[0]}")
  echo "testnet exit $? (3 means blocked on testnet funds, see BLOCKERS.md)"
  echo
  echo "---- STEP 4: Telegram step-up approval (packages/approval, llm-rail, x402-rail) ----"
  run approval test/*.test.ts | pick
  echo "approval exit ${PIPESTATUS[0]}"
  run llm-rail test/approval.test.ts | pick
  echo "llm-rail approval exit ${PIPESTATUS[0]}"
  run x402-rail test/done-steps.test.ts --test-name-pattern "step 4" | pick
  echo "x402 approval exit ${PIPESTATUS[0]}"
  echo
  echo "---- STEP 5: payee binding and injection block (packages/payee-guard, x402-rail) ----"
  run payee-guard test/*.test.ts | pick
  echo "payee-guard exit ${PIPESTATUS[0]}"
  run x402-rail test/done-steps.test.ts --test-name-pattern "step 5" | pick
  echo "x402 step 5 exit ${PIPESTATUS[0]}"
  echo
  echo "---- regression: steps 1 and 2 suites ----"
  run core test/*.test.ts | grep -E "^# (tests|pass|fail) "
  run llm-rail test/*.test.ts | grep -E "^# (tests|pass|fail) "
  echo
  echo "---- typecheck ----"
  (cd "$ROOT" && timeout 300 npx tsc -p tsconfig.json --noEmit && echo "tsc: no errors")
} 2>&1 | tee -a "$LOG"
