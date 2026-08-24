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
PRESET_ROSTER_LOG="$OUT/preset-rosters-$RUN_ID.log"
PRESET_SOCKETS=()
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
WORKTREE_LIST_OUT="$OUT/worktree-list-$RUN_ID.json"
WORKTREE_SHOW_OUT="$OUT/worktree-show-$RUN_ID.txt"
WORKTREE_GC_OUT="$OUT/worktree-gc-$RUN_ID.txt"
WORKTREE_RM_OUT="$OUT/worktree-rm-$RUN_ID.txt"
RESTORE_CODE_ERR="$OUT/restore-code-$RUN_ID.log"
MOCK_PID=""
ACTIVE_SOCKET="$SOCKET"
BOOT_CWD="$ROOT"

WORKTREE_PATH=""
WORKTREE_SESSION_ID=""
WORKTREE_LABEL="e2e-$RUN_ID"

fail() {
  echo "FAIL: $1" >&2
  capture >/dev/null 2>&1 || true
  exit 1
}

leader_pid() {
  local socket="$1"
  local lock="${socket%.*}.lock"
  local pid
  pid="$(cat "$lock" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
    printf '%s\n' "$pid"
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -t "$socket" 2>/dev/null | head -n 1 || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pid="$(fuser "$socket" 2>/dev/null | tr -cd '0-9\n' | head -n 1 || true)"
  else
    pid=""
  fi
  [[ "$pid" =~ ^[0-9]+$ ]] && printf '%s\n' "$pid"
  return 0
}

wait_leader_exit() {
  local socket="$1"
  local pid
  for _ in $(seq 1 80); do
    pid="$(leader_pid "$socket")"
    [[ -z "$pid" ]] && return 0
    sleep 0.1
  done
  fail "leader did not exit after its last client disconnected: $socket"
}

cleanup() {
  tmux -L "$SESSION" -f /dev/null kill-server >/dev/null 2>&1 || true
  for socket in \
    "$SOCKET" "$RESUME_SOCKET" "$HEADLESS_SOCKET" \
    "$HEADLESS_RESUME_SOCKET" "$HEADLESS_FORK_SOCKET" "$HEADLESS_REJECT_SOCKET"; do
    pid="$(leader_pid "$socket")"
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done
  for socket in "${PRESET_SOCKETS[@]-}"; do
    [[ -z "$socket" ]] && continue
    pid="$(leader_pid "$socket")"
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" >/dev/null 2>&1 || true
  if [[ -n "$WORKTREE_PATH" ]]; then
    git -C "$ROOT" worktree remove --force "$WORKTREE_PATH" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ -x "$TUI_BIN" ]] || fail "TUI binary is missing: $TUI_BIN"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node is unavailable"
command -v tmux >/dev/null 2>&1 || fail "tmux is required"
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || fail "pinned dsh requires Node >=22.19.0 (got $($NODE_BIN --version))"

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

# Install the bridge as the tarball users receive, not as a live file: link.
# A later `dsh add` must not make pnpm resolve runtime peers from the checkout.
BRIDGE_ARCHIVE_NAME="$(npm pack --silent --pack-destination "$SCRATCH" "$ROOT/bridge/grok-leader")" \
  || fail "could not pack the local bridge"
BRIDGE_ARCHIVE_NAME="${BRIDGE_ARCHIVE_NAME##*$'\n'}"
BRIDGE_ARCHIVE="$SCRATCH/$BRIDGE_ARCHIVE_NAME"
[[ -f "$BRIDGE_ARCHIVE" ]] || fail "packed bridge archive is missing: $BRIDGE_ARCHIVE"

DSH_BIN_DIR="$(cd "$(dirname "$DSH_BIN")" && pwd)"
SHIPPED_MINIMAL=""
for candidate in \
  "$DSH_BIN_DIR/../lib/node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml" \
  "$DSH_BIN_DIR/../@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml"; do
  if [[ -f "$candidate" ]]; then
    SHIPPED_MINIMAL="$candidate"
    break
  fi
done
[[ -n "$SHIPPED_MINIMAL" ]] || fail "could not locate the pinned dsh minimal preset"

install_fixture_custom_preset() {
CUSTOM_PRESET="$SCRATCH/.agent-presets/fixture-custom"
mkdir -p "$CUSTOM_PRESET"
cp "$SHIPPED_MINIMAL" "$CUSTOM_PRESET/agent.cordis.yml"
cat >"$CUSTOM_PRESET/preset.yml" <<'EOF'
name: Fixture custom preset
description: User-authored minimal preset with one arbitrary plugin tool.
order: 99
EOF
cat >"$CUSTOM_PRESET/fixture-tool.mjs" <<'EOF'
export const name = 'fixture-tool'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'fixture_echo',
    description: 'Echo one string from a custom preset plugin.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      render: (_args, value) => [{ type: 'text', text: value.value }],
    },
    execute: async args => ({ value: args.value }),
  })
}
EOF
cat >>"$CUSTOM_PRESET/agent.cordis.yml" <<'EOF'

- id: fixture-tool
  name: './fixture-tool.mjs'
EOF
}

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
const responsesEvent = (type, sequenceNumber, response) => JSON.stringify({
  type,
  sequence_number: sequenceNumber,
  ...response,
})

http.createServer((request, response) => {
  let body = ''
  request.on('data', part => { body += part })
  request.on('end', () => {
    appendFileSync(logPath, request.method + ' ' + request.url + ' ' + body + '\n')
    const path = request.url?.split('?')[0] ?? ''
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      const model = path.includes('/responses-api/')
        ? { id: 'fake-responses-model', name: 'Fake Responses Model' }
        : { id: 'fake-model', name: 'Fake Model' }
      response.end(JSON.stringify({ data: [model] }))
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
    if (request.method === 'POST' && path.endsWith('/responses')) {
      const titleRequest = body.includes('Create a concise title')
      const text = titleRequest ? 'E2E Session' : 'E2E_RESPONSES_OK'
      const responseId = titleRequest ? 'resp_title' : 'resp_preset'
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: ' + responsesEvent('response.created', 0, {
        response: {
          id: responseId,
          object: 'response',
          created_at: 1,
          model: 'fake-responses-model',
          status: 'in_progress',
          output: [],
        },
      }) + '\n\n')
      response.write('data: ' + responsesEvent('response.output_item.added', 1, {
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_preset',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }) + '\n\n')
      response.write('data: ' + responsesEvent('response.output_text.delta', 2, {
        item_id: 'item_preset',
        output_index: 0,
        content_index: 0,
        delta: text,
      }) + '\n\n')
      response.write('data: ' + responsesEvent('response.output_item.done', 3, {
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_preset',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      }) + '\n\n')
      response.write('data: ' + responsesEvent('response.completed', 4, {
        response: {
          id: responseId,
          object: 'response',
          created_at: 1,
          model: 'fake-responses-model',
          status: 'completed',
          output: [{
            type: 'message',
            id: 'msg_preset',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }) + '\n\n')
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
  "file:$BRIDGE_ARCHIVE" >"$PLUGIN_LOG" 2>&1 \
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
"$NODE_BIN" -e '
  const fs = require("node:fs")
  const prefix = "POST /v1/chat/completions "
  const requests = fs.readFileSync(process.argv[1], "utf8").split("\n")
    .filter(line => line.startsWith(prefix))
    .map(line => JSON.parse(line.slice(prefix.length)))
  const request = requests.find(body => JSON.stringify(body.messages).includes("reply with the test marker"))
  if (!request) throw new Error("minimal request was not captured")
  const names = (request.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort()
  const expected = ["bash", "str_replace_editor"]
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`minimal tool roster drifted: ${JSON.stringify(names)}`)
  }
' "$MOCK_LOG" || fail "minimal preset did not expose exactly bash + str_replace_editor"
if grep -Eqi 'grok-4|api\.x\.ai|xai\.com' "$HEADLESS_OUT" "$HEADLESS_ERR"; then
  fail "headless dscode leaked to the embedded xAI path"
fi
wait_leader_exit "$HEADLESS_SOCKET"

audit_responses_preset() {
  preset="$1"
  socket="$OUT/leader-$RUN_ID-preset-$preset.sock"
  output="$OUT/preset-$preset-$RUN_ID.json"
  error="$OUT/preset-$preset-$RUN_ID.log"
  marker="capture responses roster for $preset"
  PRESET_SOCKETS+=("$socket")

  env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-preset-$preset" \
    DSCODE_SOCKET="$socket" DSCODE_LOG="$LEADER_LOG" DSH_BIN="$DSH_BIN" \
    FAKE_KEY=e2e-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
    "$TUI_BIN" -p "$marker" --output-format json --agent "$preset" \
    --model fake-responses-model --no-plan --always-approve \
    >"$output" 2>"$error" \
    || fail "$preset preset failed through the Responses API"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (value.text !== "E2E_RESPONSES_OK") process.exit(1)
  ' "$output" || fail "$preset preset did not return the Responses API marker"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const [logPath, preset, marker, rosterPath] = process.argv.slice(1)
    const requests = fs.readFileSync(logPath, "utf8").split("\n")
      .map(line => line.match(/^POST \S*\/responses (.*)$/))
      .filter(Boolean)
      .map(match => JSON.parse(match[1]))
    const request = requests.find(body => JSON.stringify(body.input).includes(marker))
    if (!request) throw new Error(`${preset} Responses request was not captured`)
    const names = (request.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort()
    fs.appendFileSync(rosterPath, `${preset}\t${JSON.stringify(names)}\n`)
    const standard = [
      "ask_user_question", "bash", "create_goal", "edit", "exit_plan_mode",
      "get_goal", "glob", "grep", "interrupt_agent", "job_kill", "job_list",
      "job_output", "list_agents", "ralph", "read", "read_image", "send_message",
      "skill", "subagent", "subagent_fork", "todo_write", "update_goal",
      "web_search", "workflow", "write",
    ].sort()
    const expected = {
      minimal: ["bash", "str_replace_editor"],
      standard,
      code: ["run_code"],
      cordis: [
        ...standard,
        "cordis_define", "cordis_inspect_list", "cordis_inspect_query",
        "cordis_inspect_self", "cordis_run", "cordis_stop", "cordis_undefine",
      ].sort(),
      "fixture-custom": ["bash", "fixture_echo", "str_replace_editor"],
    }
    const wanted = expected[preset]
    if (JSON.stringify(names) !== JSON.stringify(wanted)) {
      throw new Error(`${preset} tool roster drifted: ${JSON.stringify(names)}`)
    }
  ' "$MOCK_LOG" "$preset" "$marker" "$PRESET_ROSTER_LOG" \
    || fail "$preset preset roster capture failed"
  wait_leader_exit "$socket"
}

audit_all_responses_presets() {
  echo "[headless] shipped + custom presets through the Responses API"
  install_fixture_custom_preset
  "$NODE_BIN" -e '
  const fs = require("node:fs")
  const path = process.argv[1]
  const gateway = process.argv[2]
  const source = fs.readFileSync(path, "utf8")
  const current = "agent-default-model:\n  provider: fake\n  model: fake-model\n"
  const provider = [
    "    fake-responses:",
    "      displayName: Fake Responses Gateway",
    "      apiKeyEnv: FAKE_KEY",
    "      api: openai-responses",
    `      baseURL: ${gateway}/responses-api`,
    "      models:",
    "        - id: fake-responses-model",
    "",
  ].join("\n")
  const replacement = provider + "agent-default-model:\n  provider: fake-responses\n  model: fake-responses-model\n"
  if (!source.includes(current)) throw new Error("fake default model block was not found")
  fs.writeFileSync(path, source.replace(current, replacement))
  ' "$SCRATCH/settings.yaml" "$GATEWAY" || fail "could not switch the isolated profile to the Responses API provider"
  for preset in minimal standard code cordis fixture-custom; do
    audit_responses_preset "$preset"
  done
  cat "$PRESET_ROSTER_LOG"
  "$NODE_BIN" -e '
  const fs = require("node:fs")
  const path = process.argv[1]
  const source = fs.readFileSync(path, "utf8")
  const current = /    fake-responses:\n(?:      .*\n|        .*\n)+agent-default-model:\n  provider: fake-responses\n  model: fake-responses-model\n/
  const replacement = "agent-default-model:\n  provider: fake\n  model: fake-model\n"
  if (!current.test(source)) throw new Error("fake Responses provider block was not found")
  fs.writeFileSync(path, source.replace(current, replacement))
  ' "$SCRATCH/settings.yaml" || fail "could not restore the isolated completion provider"
}

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
wait_leader_exit "$HEADLESS_RESUME_SOCKET"

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
wait_leader_exit "$HEADLESS_FORK_SOCKET"

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
wait_leader_exit "$HEADLESS_REJECT_SOCKET"

audit_all_responses_presets

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

wait_frame_absent() {
  label="$1"
  pattern="$2"
  tries="${3:-100}"
  for _ in $(seq 1 "$tries"); do
    capture || true
    ! grep -Eq "$pattern" "$FRAME" 2>/dev/null && return 0
    tmux -L "$SESSION" -f /dev/null has-session -t "$SESSION" 2>/dev/null \
      || fail "$label: TUI exited while '$pattern' was still visible"
    sleep 0.2
  done
  fail "$label: '$pattern' never disappeared"
}

send_line() {
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "$1" Enter
}

clear_prompt() {
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" C-c
  sleep 0.3
}

worktree_cli() {
  env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-tui" \
    DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
    "$TUI_BIN" worktree "$@"
}

boot() {
  socket="$1"
  shift
  ACTIVE_SOCKET="$socket"
  cmd="cd '$BOOT_CWD' && exec env PATH='$PATH' DSH_HOME='$SCRATCH' DSC_HOME='$SCRATCH/dsc-tui' DSCODE_SOCKET='$socket' DSCODE_LOG='$LEADER_LOG' DSH_BIN='$DSH_BIN' FAKE_KEY='e2e-key' DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color '$TUI_BIN'"
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

echo "[tui] unsupported restore-code fails closed"
if env PATH="$PATH" DSH_HOME="$SCRATCH" DSC_HOME="$SCRATCH/dsc-tui" \
  DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
  "$TUI_BIN" --resume 11111111-1111-4111-8111-111111111111 --restore-code \
  >/dev/null 2>"$RESTORE_CODE_ERR"; then
  fail "unsupported --restore-code was accepted"
fi
grep -q -- '--restore-code is not supported by dscode' "$RESTORE_CODE_ERR" \
  || fail "unsupported --restore-code did not explain the dsh limitation"

echo "[tui] booting CLI-managed worktree"
boot "$SOCKET" "--worktree=$WORKTREE_LABEL" --worktree-ref HEAD
wait_frame "worktree creation" 'Worktree ready:' 300
worktree_matches=("$SCRATCH/dsc-tui/worktrees"/*/"$WORKTREE_LABEL")
WORKTREE_PATH="${worktree_matches[0]}"
[[ -d "$WORKTREE_PATH" ]] || fail "managed worktree path was not created"
git -C "$WORKTREE_PATH" rev-parse --is-inside-work-tree >/dev/null \
  || fail "managed worktree is not a usable git checkout"
worktree_cli list --json >"$WORKTREE_LIST_OUT"
grep -q "\"label\": \"$WORKTREE_LABEL\"" "$WORKTREE_LIST_OUT" \
  || fail "worktree list did not include the CLI-created worktree"
worktree_cli show "$WORKTREE_PATH" >"$WORKTREE_SHOW_OUT"
grep -q "$WORKTREE_LABEL" "$WORKTREE_SHOW_OUT" \
  || fail "worktree show did not resolve the managed path"
worktree_cli db path >/dev/null
worktree_cli db stats >/dev/null
worktree_cli gc --dry-run --max-age 0s >"$WORKTREE_GC_OUT"
grep -q 'Dry run' "$WORKTREE_GC_OUT" \
  || fail "worktree gc dry-run did not report its mode"


echo "[tui] preset picker"
send_line "/preset"
wait_frame "preset picker" 'Presets'
grep -q 'Fixture custom preset' "$FRAME" || fail "custom preset was missing from the picker"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Home Enter
wait_frame "preset selection" 'preset: standard'
capture
if grep -q 'Presets' "$FRAME"; then
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Escape
fi
wait_frame_absent "preset picker close" 'Presets'

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
for _ in $(seq 1 100); do
  worktree_session_roots=("$SCRATCH/sessions"/*"$WORKTREE_LABEL"*)
  if [[ -d "${worktree_session_roots[0]}" ]]; then
    worktree_session_dirs=("${worktree_session_roots[0]}"/*)
    if [[ -d "${worktree_session_dirs[0]}" ]]; then
      WORKTREE_SESSION_ID="${worktree_session_dirs[0]##*/}"
      break
    fi
  fi
  sleep 0.1
done
[[ "$WORKTREE_SESSION_ID" =~ ^[0-9a-f-]+$ ]] \
  || fail "worktree session was not persisted"

echo "[tui] durable resume through a fresh leader"
stop_client
wait_leader_exit "$SOCKET"
BOOT_CWD="$WORKTREE_PATH"
boot "$RESUME_SOCKET" --resume "$WORKTREE_SESSION_ID"
wait_frame "resume" 'E2E_STREAM_OK|reply with the test marker' 300
stop_client
wait_leader_exit "$RESUME_SOCKET"
worktree_cli rm "$WORKTREE_PATH" >"$WORKTREE_RM_OUT"
grep -q 'removed:' "$WORKTREE_RM_OUT" \
  || fail "worktree rm did not report the removed path"
[[ ! -e "$WORKTREE_PATH" ]] || fail "worktree rm left the checkout on disk"
WORKTREE_PATH=""

echo "PASS real TUI + dsh + bridge E2E run $RUN_ID"
echo "  artifacts: $OUT (*-$RUN_ID.*)"
