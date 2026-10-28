#!/bin/bash
# Runs the plan done test for step 6 (passkey-signed mandate, passkey-gated
# edits) and appends the real output to logs/<date>.txt.
# Usage: scripts/done-tests-6.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/$(date +%Y-%m-%d).txt"
mkdir -p "$ROOT/logs"
run() { # package, files...
  local pkg=$1; shift
  (cd "$ROOT/packages/$pkg" && timeout 600 node --no-warnings --import tsx --test --test-timeout=120000 "$@" 2>&1)
}
pick() { grep -E "^(ok|not ok) |^# (tests|pass|fail) |^# (\\\\# )?(step6|passkey) "; }
{
  echo "================================================================"
  echo "TapVow done test for step 6, $(date -u +%Y-%m-%dT%H:%M:%SZ), commit $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo none)"
  echo "local time $(date '+%Y-%m-%d %H:%M %Z')"
  echo "node $(node --version), host $(uname -sm), free disk $(df -m /System/Volumes/Data | tail -1 | awk '{print $4}') MB"
  echo "@simplewebauthn/server $(node -p "require('$ROOT/node_modules/@simplewebauthn/server/package.json').version")"
  echo
  echo "---- STEP 6: passkey verification, registry and software authenticator (packages/passkey) ----"
  run passkey test/*.test.ts | pick
  echo "passkey exit ${PIPESTATUS[0]}"
  echo
  echo "---- STEP 6 DONE TEST: gateway with passkey-signed mandates (packages/llm-rail test/passkey*.test.ts) ----"
  run llm-rail test/passkey*.test.ts | pick
  echo "llm-rail passkey exit ${PIPESTATUS[0]}"
  echo
  echo "---- regression: all other suites ----"
  for p in core llm-rail approval payee-guard x402-rail; do
    printf "%s " "$p"; run "$p" test/*.test.ts | grep -E "^# (tests|pass|fail) " | tr '\n' ' '; echo "exit ${PIPESTATUS[0]}"
  done
  echo
  echo "---- typecheck ----"
  (cd "$ROOT" && timeout 300 npx tsc -p tsconfig.json --noEmit && echo "tsc: no errors")
} 2>&1 | tee -a "$LOG"
