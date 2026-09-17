#!/usr/bin/env bash
# Sustained product-loop soak: real TUI -> real dsh profile -> bridge -> a
# minimal streaming gateway. The contract E2E asserts individual behaviors;
# this asserts steady state. It records per-turn latency next to TUI and leader
# RSS/descriptor counts, and checks that the leader exits after its last client
# disconnects, so a leak or a drift shows up as a failing row rather than an
# anecdote.
#
# Knobs: SOAK_TURNS (default 60), SOAK_TOOL_EVERY (default 5, 0 disables the
# tool step), SOAK_PAUSE_MS, SOAK_SESSION_ID, SOAK_PORT, DSCODE_E2E_OUT_DIR.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/test-environment.sh"
dscode_clear_test_overrides

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${DSCODE_E2E_NODE_BIN:-$(command -v node || true)}"
TUI_BIN="${DSCODE_TUI_BIN:-$ROOT/third_party/grok-build/target/release/dscode}"
OUT="${DSCODE_E2E_OUT_DIR:-/tmp/dscode-soak}"
RUN_ID="$$"
TURNS="${SOAK_TURNS:-60}"
TOOL_EVERY="${SOAK_TOOL_EVERY:-5}"
PAUSE_MS="${SOAK_PAUSE_MS:-0}"
PER_TURN_TIMEOUT_S="${SOAK_TURN_TIMEOUT_S:-120}"
PORT="${SOAK_PORT:-$((26000 + (RUN_ID % 16000)))}"
SCRATCH="$OUT/home-$RUN_ID"
SESSION="dscode-soak-$RUN_ID"
SOCKET="$OUT/leader-$RUN_ID.sock"
GATEWAY_LOG="$OUT/gateway-$RUN_ID.log"
LEADER_LOG="$OUT/leader-$RUN_ID.log"
PLUGIN_LOG="$OUT/plugin-$RUN_ID.log"
TURNS_LOG="$OUT/turns-$RUN_ID.jsonl"
SAMPLES_LOG="$OUT/samples-$RUN_ID.jsonl"
SUMMARY="$OUT/soak-summary-$RUN_ID.json"
WORKSPACE="$SCRATCH/workspace"
MOCK_PID=""
LEADER_EXIT="untested"
LEADER_PID=""
SESSION_ID="${SOAK_SESSION_ID:-}"

fail() { echo "FAIL: $1" >&2; exit 1; }
ms() { perl -MTime::HiRes=time -e 'print int(time()*1000)'; }
capture() { tmux -L "$SESSION" -f /dev/null capture-pane -p -S - -t "$SESSION:0.0" 2>/dev/null; }
pane_pid() { tmux -L "$SESSION" -f /dev/null list-panes -F '#{pane_pid}' -t "$SESSION:0.0" 2>/dev/null | head -1; }
leader_pid() {
  local pid
  pid="$(cat "${SOCKET%.*}.lock" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then printf '%s' "$pid"; return 0; fi
  pid=""
  if command -v lsof >/dev/null 2>&1; then pid="$(lsof -t "$SOCKET" 2>/dev/null | head -1 || true)"; fi
  [[ "$pid" =~ ^[0-9]+$ ]] && printf '%s' "$pid"
  return 0
}
rss_of() { local out; [[ -z "$1" ]] && { printf 'null'; return 0; }; out="$(ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || true)"; printf '%s' "${out:-null}"; }
fds_of() { local out; [[ -z "$1" ]] && { printf 'null'; return 0; }; out="$(lsof -p "$1" 2>/dev/null | wc -l | tr -d ' ' || true)"; printf '%s' "${out:-null}"; }
sample() {
  printf '{"turn":%s,"scope":"%s","pid":%s,"rssKiB":%s,"fds":%s}\n' \
    "$3" "$1" "${2:-null}" "$(rss_of "$2")" "$(fds_of "$2")" >>"$SAMPLES_LOG"
}
# The gateway logs one line per model request, timestamp first, body last. The
# session-title request replays the same prompt text, so it is skipped here;
# the turn's own request is the one that gates the render clock.
provider_ms() {
  grep -v -F 'Create a concise title' "$GATEWAY_LOG" 2>/dev/null \
    | grep -m 1 -F "SOAK_TURN_$1 probe" 2>/dev/null | cut -d' ' -f1 || true
}

cleanup() {
  local pid="$LEADER_PID" waited=0
  tmux -L "$SESSION" -f /dev/null kill-server >/dev/null 2>&1 || true
  # The lock file disappears together with the leader, so the exit contract is
  # measured against the pid seen while the TUI was up, not a fresh lookup.
  [[ -n "$pid" ]] || pid="$(leader_pid)"
  if [[ -n "$pid" ]]; then
    while [[ $waited -lt 300 ]]; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; waited=$((waited + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
      LEADER_EXIT="forced-after-${waited}00ms"
      kill -TERM "$pid" >/dev/null 2>&1 || true
      for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$pid" 2>/dev/null && { LEADER_EXIT="killed"; kill -KILL "$pid" >/dev/null 2>&1 || true; }
    else
      LEADER_EXIT="exited-after-${waited}00ms"
    fi
  else
    LEADER_EXIT="absent"
  fi
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ -x "$TUI_BIN" ]] || fail "TUI binary is missing: $TUI_BIN"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node is unavailable"
command -v tmux >/dev/null 2>&1 || fail "tmux is required"
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || fail "pinned dsh requires Node >=22.19.0 (got $($NODE_BIN --version))"
[[ -n "$SESSION_ID" ]] || SESSION_ID="$("$NODE_BIN" -e 'console.log(crypto.randomUUID())')"

mkdir -p "$OUT" "$SCRATCH" "$SCRATCH/dsc-tui" "$WORKSPACE"
dscode_prepare_test_runtime "$ROOT" "$SCRATCH" "$NODE_BIN" "$OUT/payload-build-$RUN_ID.log" \
  || fail "could not prepare the pinned test runtime"
{ IFS= read -r -d '' DSH_BIN && IFS= read -r -d '' BRIDGE_ARCHIVE; } <"$SCRATCH/runtime-paths"
export PATH="$SCRATCH/e2e-bin:$(dirname "$NODE_BIN"):$PATH"
[[ -d "$WORKSPACE/.git" ]] || git init -q "$WORKSPACE"
# Trust the soak workspace up front: the release TUI gates session creation
# behind the folder-trust question for roots with repo-local code-exec config.
printf '[folders."%s"]\ntrusted = true\ndecided_at = 0\n' "$WORKSPACE" >"$SCRATCH/dsc-tui/trusted_folders.toml"
printf '[cli]\nauto_update = false\n' >"$SCRATCH/dsc-tui/config.toml"

cat >"$SCRATCH/settings.yaml" <<EOF
llm-pi-ai:
  providers:
    fake:
      displayName: Fake Gateway
      apiKeyEnv: FAKE_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:$PORT/v1
      models:
        - name: Fake Model
          id: fake-model
          contextWindow: 32768
          input:
            - text
            - image
agent-default-model:
  provider: fake
  model: fake-model
EOF

# One deterministic turn per prompt. Tool turns exercise the tool loop; every
# other turn is a plain streamed reply. Nothing here reads repo state.
cat >"$SCRATCH/soak-model.mjs" <<'EOF'
export function contractReply(body) {
  const messages = body?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
    const match = text.match(/SOAK_TURN_(\d+)/)
    if (!match) continue
    const turn = Number(match[1])
    const results = messages.slice(index + 1).filter(item => item.role === 'tool').length
    const every = Number(process.env.SOAK_TOOL_EVERY ?? '5')
    if (every > 0 && turn % every === 0 && results === 0) {
      return { name: 'bash', arguments: { command: 'printf SOAK_TOOL_' + turn, description: 'SOAK tool step ' + turn } }
    }
    return { text: 'SOAK_OK_' + turn }
  }
  return undefined
}
EOF

# Minimal OpenAI-compatible stream: timestamps every model request so the
# harness can separate provider wait from render time.
cat >"$SCRATCH/soak-gateway.mjs" <<'EOF'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import http from 'node:http'

const { contractReply } = await import(pathToFileURL(process.env.SOAK_MODEL_FIXTURE).href)
const [portText, logPath] = process.argv.slice(2)
const envelope = (choices, usage) => JSON.stringify({ id: 'dscode-soak', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices, ...(usage === undefined ? {} : { usage }) })
const textChunk = (text, finishReason = null, usage = undefined) => envelope([{ index: 0, delta: text === '' ? {} : { role: 'assistant', content: text }, finish_reason: finishReason }], usage)
const toolChunk = (name, argumentsJson) => envelope([{ index: 0, delta: { role: 'assistant', content: null,
  tool_calls: [{ index: 0, id: 'soak-call', type: 'function', function: { name, arguments: argumentsJson } }] }, finish_reason: null }])

http.createServer((request, response) => {
  let body = ''
  request.on('data', part => { body += part })
  request.on('end', () => {
    const path = request.url?.split('?')[0] ?? ''
    if (request.method !== 'POST' || !path.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return }
    appendFileSync(logPath, Date.now() + ' ' + body + '\n')
    // The title request embeds the same user turn, so the fixture is held back
    // from it; the reply must also stay clear of the SOAK_OK_<n> render probe.
    const titleRequest = body.includes('Create a concise title')
    const fixture = titleRequest ? undefined : contractReply(JSON.parse(body))
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    if (fixture?.name) response.write('data: ' + toolChunk(fixture.name, JSON.stringify(fixture.arguments)) + '\n\n')
    else response.write('data: ' + textChunk(fixture?.text ?? (titleRequest ? 'SOAK Session' : 'SOAK_STREAM_OK')) + '\n\n')
    response.write('data: ' + textChunk('', 'stop', { prompt_tokens: 2400, completion_tokens: 17 }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
}).listen(Number(portText), '127.0.0.1', () => appendFileSync(logPath, 'READY\n'))
EOF

: >"$GATEWAY_LOG"; : >"$TURNS_LOG"; : >"$SAMPLES_LOG"
SOAK_MODEL_FIXTURE="$SCRATCH/soak-model.mjs" SOAK_TOOL_EVERY="$TOOL_EVERY" \
  "$NODE_BIN" "$SCRATCH/soak-gateway.mjs" "$PORT" "$GATEWAY_LOG" &
MOCK_PID=$!
for _ in $(seq 1 100); do grep -q '^READY$' "$GATEWAY_LOG" 2>/dev/null && break; sleep 0.1; done
grep -q '^READY$' "$GATEWAY_LOG" 2>/dev/null || fail "the soak gateway did not start"

# The pinned runtime ships no profile; the bridge is installed exactly like the
# E2E does, from the release payload matching this checkout.
DSH_HOME="$SCRATCH" "$DSH_BIN" plugin --profile dscode add "file:$BRIDGE_ARCHIVE" >"$PLUGIN_LOG" 2>&1 \
  || fail "could not install the bridge into the isolated dsh profile"

# HOME is isolated too: compatibility discovery would otherwise import the
# developer's MCP configuration into the fixture profile.
CMD="$(dscode_shell_command env "PATH=$PATH" "HOME=$SCRATCH" "DSH_HOME=$SCRATCH" "DSC_HOME=$SCRATCH/dsc-tui" \
  "DSCODE_SOCKET=$SOCKET" "DSCODE_LOG=$LEADER_LOG" "DSH_BIN=$DSH_BIN" \
  FAKE_KEY=soak-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color TERM_PROGRAM=WezTerm \
  "$TUI_BIN" --model fake-model --no-plan --session-id "$SESSION_ID")"
tmux -L "$SESSION" -f /dev/null new-session -d -s "$SESSION" -x 180 -y 48 -c "$WORKSPACE" "exec $CMD"
BOOT_STARTED="$(ms)"
for _ in $(seq 1 900); do
  if [[ -S "$SOCKET" ]]; then
    for _ in $(seq 1 600); do capture | grep -qE 'Fake Model|fake-model' && break; sleep 0.2; done
    capture | grep -qE 'Fake Model|fake-model' || fail "the TUI never rendered the model row"
    break
  fi
  tmux -L "$SESSION" -f /dev/null has-session -t "$SESSION" 2>/dev/null || fail "the TUI exited before its leader socket appeared"
  sleep 0.2
done
[[ -S "$SOCKET" ]] || fail "the leader socket did not appear"
LEADER_PID="$(leader_pid)"
echo "soak: $TURNS turns, socket $SOCKET, leader ${LEADER_PID:-unknown}, boot $(( $(ms) - BOOT_STARTED ))ms"

completed=0
for turn in $(seq 1 "$TURNS"); do
  started="$(ms)"
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" -l "SOAK_TURN_$turn probe"
  sleep 0.15
  tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Enter
  deadline=$((SECONDS + PER_TURN_TIMEOUT_S)); rendered=""
  while [[ $SECONDS -lt $deadline ]]; do
    if capture | grep -qE "SOAK_OK_$turn([^0-9]|$)"; then rendered="$(ms)"; break; fi
    sleep 0.05
  done
  provider="$(provider_ms "$turn")"
  if [[ -z "$rendered" ]]; then
    printf '{"turn":%s,"error":"not rendered within %ss","startedMs":%s}\n' "$turn" "$PER_TURN_TIMEOUT_S" "$started" >>"$TURNS_LOG"
    capture >"$OUT/timeout-$RUN_ID-turn-$turn.txt" || true
    fail "turn $turn never rendered SOAK_OK_$turn"
  fi
  if [[ -n "$provider" ]]; then
    printf '{"turn":%s,"startedMs":%s,"providerMs":%s,"renderedMs":%s,"totalMs":%s,"providerWaitMs":%s}\n' \
      "$turn" "$started" "$provider" "$rendered" "$((rendered - started))" "$((provider - started))" >>"$TURNS_LOG"
  else
    printf '{"turn":%s,"startedMs":%s,"providerMs":null,"renderedMs":%s,"totalMs":%s,"providerWaitMs":null}\n' \
      "$turn" "$started" "$rendered" "$((rendered - started))" >>"$TURNS_LOG"
  fi
  sample tui "$(pane_pid)" "$turn"
  sample leader "$(leader_pid)" "$turn"
  completed=$((completed + 1))
  if (( turn % 10 == 0 )); then echo "turn $turn ok in $((rendered - started))ms"; fi
  if [[ "$PAUSE_MS" -gt 0 ]]; then sleep "$(perl -e "print $PAUSE_MS / 1000")"; fi
done

cleanup
trap - EXIT
cat >"$SCRATCH/soak-summary.mjs" <<'EOF'
import { existsSync, readFileSync } from 'node:fs'
const read = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const [turnsPath, samplesPath, leaderExit] = process.argv.slice(2)
const turns = read(turnsPath), samples = read(samplesPath)
const ok = turns.filter(turn => !turn.error)
const numeric = (list, key) => list.map(item => item[key]).filter(value => typeof value === 'number')
const pick = (list, fraction) => list.length ? list[Math.min(list.length - 1, Math.floor(list.length * fraction))] : null
const totals = numeric(ok, 'totalMs').sort((a, b) => a - b)
const waits = numeric(ok, 'providerWaitMs').sort((a, b) => a - b)
const series = (scope, key) => samples.filter(sample => sample.scope === scope).map(sample => sample[key]).filter(value => typeof value === 'number')
const average = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : null
const scope = name => {
  const rss = series(name, 'rssKiB'), fds = series(name, 'fds'), half = Math.floor(rss.length / 2)
  return { samples: rss.length, firstRssKiB: rss[0] ?? null, lastRssKiB: rss.at(-1) ?? null,
    maxRssKiB: rss.length ? Math.max(...rss) : null, firstHalfAvgRssKiB: average(rss.slice(0, half)), secondHalfAvgRssKiB: average(rss.slice(half)),
    firstFds: fds[0] ?? null, lastFds: fds.at(-1) ?? null, maxFds: fds.length ? Math.max(...fds) : null }
}
console.log(JSON.stringify({ turns: turns.length, completed: ok.length, errors: turns.filter(turn => turn.error).length,
  totalMs: { p50: pick(totals, 0.5), p90: pick(totals, 0.9), max: totals.at(-1) ?? null, first5: ok.slice(0, 5).map(turn => turn.totalMs), last5: ok.slice(-5).map(turn => turn.totalMs) },
  providerWaitMs: { p50: pick(waits, 0.5), p90: pick(waits, 0.9), max: waits.at(-1) ?? null },
  rss: { tui: scope('tui'), leader: scope('leader') }, leaderExit }, null, 2))
EOF
"$NODE_BIN" "$SCRATCH/soak-summary.mjs" "$TURNS_LOG" "$SAMPLES_LOG" "$LEADER_EXIT" | tee "$SUMMARY"
echo "soak: $completed/$TURNS turns, evidence $OUT (leader $LEADER_EXIT)"
