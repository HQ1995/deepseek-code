#!/usr/bin/env bash
# Real dscode product loop: TUI -> dsh profile -> bridge -> mock OpenAI gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${DSCODE_E2E_NODE_BIN:-$(command -v node || true)}"
TUI_BIN="${DSCODE_TUI_BIN:-$ROOT/third_party/grok-build/target/release/dscode}"
OUT="${DSCODE_E2E_OUT_DIR:-/tmp/dscode-tui-e2e}"
RUN_ID="$$"
SCRATCH="$OUT/home-$RUN_ID"
SESSION="dscode-tui-$RUN_ID"
SOCKET="$OUT/leader-$RUN_ID.sock"
RESUME_SOCKET="$OUT/leader-$RUN_ID-resume.sock"
HEADLESS_SOCKET="$OUT/leader-$RUN_ID-headless.sock"
HEADLESS_RESUME_SOCKET="$OUT/leader-$RUN_ID-headless-resume.sock"
HEADLESS_FORK_SOCKET="$OUT/leader-$RUN_ID-headless-fork.sock"
HEADLESS_REJECT_SOCKET="$OUT/leader-$RUN_ID-headless-reject.sock"
LEADER_LOG="$OUT/leader-$RUN_ID.log"
FRAME="$OUT/frame-$RUN_ID.txt"
MOCK_LOG="$OUT/mock-$RUN_ID.log"
PLUGIN_LOG="$OUT/plugin-$RUN_ID.log"
HEADLESS_OUT="$OUT/headless-$RUN_ID.json"
HEADLESS_ERR="$OUT/headless-$RUN_ID.log"
HEADLESS_RESUME_OUT="$OUT/headless-resume-$RUN_ID.json"
HEADLESS_RESUME_ERR="$OUT/headless-resume-$RUN_ID.log"
HEADLESS_FORK_OUT="$OUT/headless-fork-$RUN_ID.json"
HEADLESS_FORK_ERR="$OUT/headless-fork-$RUN_ID.log"
HEADLESS_REJECT_OUT="$OUT/headless-reject-$RUN_ID.json"
HEADLESS_REJECT_ERR="$OUT/headless-reject-$RUN_ID.log"
MOCK_PID=""
ACTIVE_SOCKET="$SOCKET"

fail() {
  echo "FAIL: $1" >&2
  capture >/dev/null 2>&1 || true
  exit 1
}

cleanup() {
  tmux -L "$SESSION" -f /dev/null kill-server >/dev/null 2>&1 || true
  for socket in \
    "$SOCKET" "$RESUME_SOCKET" "$HEADLESS_SOCKET" \
    "$HEADLESS_RESUME_SOCKET" "$HEADLESS_FORK_SOCKET" "$HEADLESS_REJECT_SOCKET"; do
    if [[ -f "$socket.lock" ]]; then
      pid="$(cat "$socket.lock" 2>/dev/null || true)"
      [[ "$pid" =~ ^[0-9]+$ ]] && kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ -x "$TUI_BIN" ]] || fail "TUI binary is missing: $TUI_BIN"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node is unavailable"
command -v tmux >/dev/null 2>&1 || fail "tmux is required"
"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)' \
  || fail "Node ^22.19.0 or >=24 is required (got $($NODE_BIN --version))"

mkdir -p "$OUT" "$SCRATCH" "$SCRATCH/e2e-bin" "$SCRATCH/fixture-plugin"
export PATH="$(dirname "$NODE_BIN"):$SCRATCH/e2e-bin:$PATH"

if command -v pnpm >/dev/null 2>&1; then
  :
elif command -v corepack >/dev/null 2>&1; then
  COREPACK_BIN="$(command -v corepack)"
  cat >"$SCRATCH/e2e-bin/pnpm" <<EOF
#!/bin/sh
exec "$COREPACK_BIN" pnpm "\$@"
EOF
  chmod +x "$SCRATCH/e2e-bin/pnpm"
else
  fail "pnpm or corepack is required to create the isolated dsh profile"
fi

if [[ -n "${DSCODE_E2E_DSH_BIN:-}" ]]; then
  DSH_BIN="$DSCODE_E2E_DSH_BIN"
elif command -v dsh >/dev/null 2>&1; then
  DSH_BIN="$(command -v dsh)"
else
  DSH_PREFIX="$SCRATCH/dsh-cli"
  npm install --prefix "$DSH_PREFIX" --ignore-scripts --no-audit --no-fund \
    @deepseek-ai/dsh@0.1.0-rc.8 >"$OUT/dsh-install-$RUN_ID.log" 2>&1 \
    || fail "could not install the pinned dsh CLI"
  DSH_BIN="$DSH_PREFIX/node_modules/.bin/dsh"
fi
[[ -x "$DSH_BIN" ]] || fail "dsh executable is invalid: $DSH_BIN"

PORT=$((24000 + (RUN_ID % 16000)))
GATEWAY="http://127.0.0.1:$PORT/v1"
cat >"$SCRATCH/settings.yaml" <<EOF
llm-pi-ai:
  providers:
    fake:
      displayName: Fake Gateway
      apiKeyEnv: FAKE_KEY
      api: openai-completions
      baseURL: $GATEWAY
      models:
        - id: fake-model
agent-default-model:
  provider: fake
  model: fake-model
EOF

cat >"$SCRATCH/fixture-plugin/package.json" <<'EOF'
{
  "name": "dscode-e2e-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js"
}
EOF
printf 'export default function () {}\n' >"$SCRATCH/fixture-plugin/index.js"

cat >"$SCRATCH/mock-gateway.mjs" <<'EOF'
import { appendFileSync } from 'node:fs'
import http from 'node:http'

const [portText, logPath] = process.argv.slice(2)
const port = Number(portText)
const chunk = (text, finishReason = null) => JSON.stringify({
  id: 'dscode-e2e',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fake-model',
  choices: [{ index: 0, delta: text === '' ? {} : { role: 'assistant', content: text }, finish_reason: finishReason }],
})

http.createServer((request, response) => {
  let body = ''
  request.on('data', part => { body += part })
  request.on('end', () => {
    appendFileSync(logPath, request.method + ' ' + request.url + ' ' + body + '\n')
    const path = request.url?.split('?')[0] ?? ''
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'fake-model', name: 'Fake Model' }] }))
      return
    }
    if (request.method === 'POST' && path.endsWith('/chat/completions')) {
      const titleRequest = body.includes('Create a concise title')
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: ' + chunk(titleRequest ? 'E2E Session' : 'E2E_STREAM_OK') + '\n\n')
      response.write('data: ' + chunk('', 'stop') + '\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404)
    response.end()
  })
}).listen(port, '127.0.0.1', () => appendFileSync(logPath, 'READY\n'))
EOF

"$NODE_BIN" "$SCRATCH/mock-gateway.mjs" "$PORT" "$MOCK_LOG" &
MOCK_PID=$!
for _ in $(seq 1 80); do
  grep -q '^READY$' "$MOCK_LOG" 2>/dev/null && break
  sleep 0.1
done
grep -q '^READY$' "$MOCK_LOG" 2>/dev/null || fail "mock gateway did not start"

DSH_HOME="$SCRATCH" "$DSH_BIN" plugin --profile dscode add \
  "file:$ROOT/bridge/grok-leader" >"$PLUGIN_LOG" 2>&1 \
  || fail "could not install the bridge into the isolated dsh profile"

echo "[headless] compiled dscode -> dsh -> bridge -> mock gateway"
completion_count_before="$(grep -c 'POST /v1/chat/completions' "$MOCK_LOG" 2>/dev/null || true)"
env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-headless" \
  DSCODE_SOCKET="$HEADLESS_SOCKET" DSCODE_LOG="$LEADER_LOG" DSH_BIN="$DSH_BIN" \
  FAKE_KEY=e2e-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
  "$TUI_BIN" -p "reply with the test marker" --output-format json \
  --model fake-model --no-plan --always-approve \
  >"$HEADLESS_OUT" 2>"$HEADLESS_ERR" \
  || fail "headless dscode process failed"
"$NODE_BIN" -e '
  const fs = require("node:fs")
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (value.text !== "E2E_STREAM_OK") process.exit(1)
' "$HEADLESS_OUT" || fail "headless output did not contain the mock marker"
completion_count_after="$(grep -c 'POST /v1/chat/completions' "$MOCK_LOG" 2>/dev/null || true)"
[[ "$completion_count_after" -gt "$completion_count_before" ]] \
  || fail "headless dscode did not call the mock gateway"
if grep -Eqi 'grok-4|api\.x\.ai|xai\.com' "$HEADLESS_OUT" "$HEADLESS_ERR"; then
  fail "headless dscode leaked to the embedded xAI path"
fi

echo "[headless] durable resume through a fresh leader"
env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-headless-resume" \
  DSCODE_SOCKET="$HEADLESS_RESUME_SOCKET" DSCODE_LOG="$LEADER_LOG" DSH_BIN="$DSH_BIN" \
  FAKE_KEY=e2e-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
  "$TUI_BIN" -p "reply with the test marker" --resume --output-format json \
  >"$HEADLESS_RESUME_OUT" 2>"$HEADLESS_RESUME_ERR" \
  || fail "headless resume through a fresh leader failed"
"$NODE_BIN" -e '
  const fs = require("node:fs")
  const first = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  const resumed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  if (resumed.text !== "E2E_STREAM_OK" || resumed.sessionId !== first.sessionId) process.exit(1)
' "$HEADLESS_OUT" "$HEADLESS_RESUME_OUT" \
  || fail "headless resume did not reuse the durable dsh session"

echo "[headless] durable fork through a fresh leader"
FORK_ID="$("$NODE_BIN" -e 'console.log(require("node:crypto").randomUUID())')"
env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-headless-fork" \
  DSCODE_SOCKET="$HEADLESS_FORK_SOCKET" DSCODE_LOG="$LEADER_LOG" DSH_BIN="$DSH_BIN" \
  FAKE_KEY=e2e-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
  "$TUI_BIN" -p "reply with the test marker" --resume --fork-session \
  --session-id "$FORK_ID" --output-format json \
  >"$HEADLESS_FORK_OUT" 2>"$HEADLESS_FORK_ERR" \
  || fail "headless fork through a fresh leader failed"
"$NODE_BIN" -e '
  const fs = require("node:fs")
  const forked = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (forked.text !== "E2E_STREAM_OK" || forked.sessionId !== process.argv[2]) process.exit(1)
' "$HEADLESS_FORK_OUT" "$FORK_ID" \
  || fail "headless fork did not create the requested durable child"

echo "[headless] unsupported CLI metadata fails closed"
completion_count_before_reject="$(grep -c 'POST /v1/chat/completions' "$MOCK_LOG" 2>/dev/null || true)"
if env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-headless-reject" \
  DSCODE_SOCKET="$HEADLESS_REJECT_SOCKET" DSCODE_LOG="$LEADER_LOG" DSH_BIN="$DSH_BIN" \
  FAKE_KEY=e2e-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
  "$TUI_BIN" -p "must not reach the model" --output-format json \
  --system-prompt-override "unsupported override" \
  >"$HEADLESS_REJECT_OUT" 2>"$HEADLESS_REJECT_ERR"; then
  fail "unsupported headless CLI metadata was silently accepted"
fi
grep -q 'refusing to run with silently weakened CLI settings' \
  "$HEADLESS_REJECT_OUT" "$HEADLESS_REJECT_ERR" \
  || fail "unsupported headless CLI metadata did not report a fail-closed error"
completion_count_after_reject="$(grep -c 'POST /v1/chat/completions' "$MOCK_LOG" 2>/dev/null || true)"
[[ "$completion_count_after_reject" -eq "$completion_count_before_reject" ]] \
  || fail "rejected headless CLI metadata still reached the mock model"

capture() {
  tmux -L "$SESSION" -f /dev/null capture-pane -p -S - -t "$SESSION:0.0" >"$FRAME" 2>/dev/null
}

wait_frame() {
  label="$1"
  pattern="$2"
  tries="${3:-100}"
  for _ in $(seq 1 "$tries"); do
    capture || true
    grep -Eq "$pattern" "$FRAME" 2>/dev/null && return 0
    tmux -L "$SESSION" -f /dev/null has-session -t "$SESSION" 2>/dev/null \
      || fail "$label: TUI exited before '$pattern'"
    sleep 0.2
  done
  fail "$label: never saw '$pattern'"
}

send_line() {
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "$1" Enter
}

clear_prompt() {
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" C-c
  sleep 0.3
}

boot() {
  socket="$1"
  shift
  ACTIVE_SOCKET="$socket"
  cmd="cd '$ROOT' && exec env PATH='$PATH' DSH_HOME='$SCRATCH' DSC_HOME='$SCRATCH/dsc-tui' DSCODE_SOCKET='$socket' DSCODE_LOG='$LEADER_LOG' DSH_BIN='$DSH_BIN' FAKE_KEY='e2e-key' DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color '$TUI_BIN'"
  for argument in "$@"; do cmd="$cmd '$argument'"; done
  tmux -L "$SESSION" -f /dev/null new-session -d -s "$SESSION" -x 180 -y 48 "$cmd"
  for _ in $(seq 1 120); do
    if [[ -S "$socket" ]]; then
      wait_frame "boot" 'Fake Model|fake-model' 100
      return 0
    fi
    tmux -L "$SESSION" -f /dev/null has-session -t "$SESSION" 2>/dev/null \
      || fail "TUI exited before the leader socket appeared"
    sleep 0.2
  done
  fail "leader socket did not appear: $socket"
}

stop_client() {
  tmux -L "$SESSION" -f /dev/null kill-server >/dev/null 2>&1 || true
  sleep 3
}

echo "[tui] booting isolated dsh profile"
boot "$SOCKET"

echo "[tui] preset picker"
send_line "/preset"
wait_frame "preset picker" 'Presets'
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Home Enter
wait_frame "preset selection" 'preset: standard'

echo "[tui] provider and model selection"
clear_prompt
send_line "/provider fake"
wait_frame "provider selection" 'Already on|Fake Model|Fake Gateway'
clear_prompt
send_line "/model"
wait_frame "model selection" 'Already on|Fake Model'

echo "[tui] bridge-owned plugin lifecycle"
clear_prompt
send_line "/dsh plugins"
wait_frame "plugin list" 'Plugins in'
grep -q '@hqzhao95/dscode' "$FRAME" || fail "core bridge is missing from /dsh plugins"
clear_prompt
send_line "/dsh add file:$SCRATCH/fixture-plugin"
wait_frame "plugin add" 'Installed or updated dscode-e2e-plugin' 600
grep -q 'dscode-e2e-plugin' "$SCRATCH/profiles/dscode/package.json" \
  || fail "plugin add did not update the profile manifest"
clear_prompt
send_line "/dsh inspect dscode-e2e-plugin"
wait_frame "plugin inspect" 'installed but has no live plugin instance'
clear_prompt
send_line "/dsh remove dscode-e2e-plugin"
wait_frame "plugin remove" 'Removed dscode-e2e-plugin' 600
if grep -q 'dscode-e2e-plugin' "$SCRATCH/profiles/dscode/package.json"; then
  fail "plugin remove left the dependency in the profile manifest"
fi

echo "[tui] streamed prompt through the real bridge"
clear_prompt
send_line "reply with the test marker"
wait_frame "streamed prompt" 'E2E_STREAM_OK' 300
grep -q 'POST /v1/chat/completions' "$MOCK_LOG" \
  || fail "the mock gateway never received a completion request"

echo "[tui] durable resume through a fresh leader"
stop_client
boot "$RESUME_SOCKET" --resume
wait_frame "resume" 'E2E_STREAM_OK|reply with the test marker' 300

echo "PASS real TUI + dsh + bridge E2E run $RUN_ID"
echo "  artifacts: $OUT (*-$RUN_ID.*)"
