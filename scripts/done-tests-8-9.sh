#!/bin/bash
# Step 8 and 9 done tests. Installs the packed tapvow tarball into a
# clean temporary HOME inside the repo, times install -> first governed call
# against the built-in fake upstream, then exports a receipt pack, verifies it,
# verifies tampered copies, and measures the live dashboard stream.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TH="$REPO/.tmp-home-step8"
PORT=18787
now_ms() { node -e 'console.log(Date.now())'; }

free=$(df -m /System/Volumes/Data | awk 'NR==2{print $4}')
echo "disk free ${free} MB"
if [ "$free" -lt 20000 ]; then echo "disk under 20000 MB, stopping"; exit 9; fi

rm -rf "$TH"
mkdir -p "$TH/project" "$TH/pack"
echo "== pack (stands in for the npm registry, not timed)"
(cd "$REPO" && npm pack --workspace tapvow --pack-destination "$TH/pack" --silent) || exit 1
TGZ=$(ls "$TH"/pack/tapvow-*.tgz)
echo "tarball $(basename "$TGZ") $(wc -c < "$TGZ" | tr -d ' ') bytes"

export HOME="$TH"
unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENAI_BASE_URL ANTHROPIC_BASE_URL TAPVOW_HOME SPENDMANDATE_HOME CLAUDE_CONFIG_DIR CODEX_HOME
T0=$(now_ms)
echo "== install into a clean user directory"
(cd "$TH/project" && npm init -y >/dev/null && npm install --no-audit --no-fund --offline "$TGZ" 2>&1 | tail -2) || exit 1
echo "== npx tapvow init"
# Stand-in "real" keys in the environment during init. None may reach a file.
(cd "$TH/project" && OPENAI_API_KEY=sk-realcheck-openai-0001 ANTHROPIC_API_KEY=sk-ant-realcheck-0002 npx --no-install tapvow init --port $PORT) | tee "$TH/init.out" || exit 1
echo "== npx tapvow start --fake-upstream"
(cd "$TH/project" && exec npx --no-install tapvow start --fake-upstream) > "$TH/gateway.log" 2>&1 &
GW=$!
for i in $(seq 1 100); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 0.1; done
head -3 "$TH/gateway.log"
echo "== first governed call through the OpenAI-compatible client config"
CALL=$( . "$TH/.tapvow/clients/openai.env"; curl -s -D "$TH/h.txt" -o "$TH/b.json" -w '%{http_code}' "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"max_tokens":50}')
T1=$(now_ms)
echo "HTTP $CALL"; grep -i '^x-mandate' "$TH/h.txt"
ELAPSED=$((T1 - T0))
echo "install to first governed call: ${ELAPSED} ms (limit 300000 ms) $([ "$CALL" = 200 ] && [ $ELAPSED -lt 300000 ] && echo PASS || echo FAIL)"

echo "== Claude Code wiring (anthropic messages with the claude-code key)"
( . "$TH/.tapvow/clients/claude-code.env"; curl -s -o /dev/null -w 'HTTP %{http_code}\n' "$ANTHROPIC_BASE_URL/v1/messages" \
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$ANTHROPIC_MODEL\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" )
echo "== Codex wiring (chat completions with the codex key)"
( . "$TH/.tapvow/clients/codex.env"; curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Authorization: Bearer $TAPVOW_CODEX_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}],"max_tokens":50}' )
echo "== over the per-call cap is denied and signed"
( . "$TH/.tapvow/clients/openai.env"; curl -s -o /dev/null -w 'HTTP %{http_code}\n' "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"big"}],"max_tokens":100000}' )

echo "== step 9 live view, measured without a browser"
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dashboard_token)' "$TH/.tapvow/config.json")
KEY=$( . "$TH/.tapvow/clients/openai.env"; echo "$OPENAI_API_KEY")
node "$REPO/scripts/measure-live.mjs" "http://127.0.0.1:$PORT" "$TOKEN" "$KEY" 5
echo "dashboard page HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dashboard?token=$TOKEN"), without token HTTP $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dashboard")"

echo "== export and verify the real pack"
(cd "$TH/project" && npx --no-install tapvow export --out "$TH/pack.json" --pdf "$TH/pack.pdf") || exit 1
head -c 8 "$TH/pack.pdf"; echo " ... $(wc -c < "$TH/pack.pdf" | tr -d ' ') bytes PDF"
(cd "$TH/project" && npx --no-install tapvow verify "$TH/pack.json"); echo "exit $?"
echo "== verify tampered packs (each must FAIL with exit 1)"
node - "$TH/pack.json" "$TH" <<'JS'
const fs = require("fs");
const [file, dir] = process.argv.slice(2);
const pack = JSON.parse(fs.readFileSync(file, "utf8"));
const cases = {};
const clone = () => JSON.parse(JSON.stringify(pack));
{ const p = clone(); const e = p.entries.find((x) => x.kind === "llm.settle"); e.payload = e.payload.replace(/"charged_micros":(\d)/, (m, d) => `"charged_micros":${(Number(d) + 1) % 10}`); cases["charge-digit"] = p; }
{ const p = clone(); p.totals.settled_micros -= 1; cases["totals"] = p; }
{ const p = clone(); p.entries.pop(); cases["drop-tail"] = p; }
{ const p = clone(); p.entries.splice(1, 1); cases["drop-middle"] = p; }
{ const p = clone(); const e = p.entries.find((x) => x.kind === "llm.denied"); if (e) { e.payload = e.payload.replace("per_call_cap", "budget_exceeded"); cases["denial-code"] = p; } }
for (const [name, p] of Object.entries(cases)) fs.writeFileSync(`${dir}/tampered-${name}.json`, JSON.stringify(p, null, 2));
console.log(Object.keys(cases).join(" "));
JS
echo "== verify with keys taken from the pack (not pinned) must not say PASS"
(cd "$TH/project" && npx --no-install tapvow verify "$TH/pack.json" --trust-pack-keys > "$TH/trust.out" 2>&1); echo "exit $? (3 means consistent but not pinned)"; head -1 "$TH/trust.out"
for f in "$TH"/tampered-*.json; do
  out=$(cd "$TH/project" && npx --no-install tapvow verify "$f" 2>&1); code=$?
  echo "$(basename "$f" .json): exit $code, $out" | head -1
done

kill $GW 2>/dev/null; sleep 0.5; pkill -f "$TH/project" 2>/dev/null
echo "== real-key check: the stand-in keys appear in no file, no init output, no pack and no PDF"
hits=$(grep -rl "realcheck" "$TH/.tapvow" "$TH/init.out" "$TH/pack.json" "$TH/pack.pdf" 2>/dev/null | wc -l | tr -d ' ')
echo "files containing a stand-in real key: $hits $([ "$hits" = 0 ] && echo PASS || echo FAIL)"
echo "== cleanup"
rm -rf "$TH"
echo "temp home removed: $([ -e "$TH" ] && echo no || echo yes)"
