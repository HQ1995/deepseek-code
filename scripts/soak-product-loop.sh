#!/usr/bin/env bash
# Sustained product-loop soak: real TUI -> real dsh profile -> bridge -> a
# minimal streaming gateway. The contract E2E asserts individual behaviors;
# this asserts steady state. It records per-turn latency next to per-client and
# leader RSS/descriptor counts, and checks that the leader exits after its last
# client disconnects, so a leak or a drift shows up as a failing row rather than
# an anecdote.
#
# SOAK_WINDOWS>1 drives that loop from several real clients at once against one
# leader: each window prompts and renders its own tagged turn, so a reply that
# reaches the wrong client, or a leader that dies while clients remain, fails
# the run instead of passing as another client's render.
#
# Knobs: SOAK_TURNS (default 60), SOAK_TOOL_EVERY (default 5, 0 disables the
# tool step), SOAK_WINDOWS (default 1), SOAK_PAUSE_MS, SOAK_TURN_TIMEOUT_S,
# SOAK_SESSION_ID, SOAK_PORT, DSCODE_E2E_OUT_DIR.
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
WINDOWS="${SOAK_WINDOWS:-1}"
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
CROSSTALK_LOG="$OUT/crosstalk-$RUN_ID.jsonl"
SUMMARY="$OUT/soak-summary-$RUN_ID.json"
WORKSPACE="$SCRATCH/workspace"
# The soak server keeps a deep history so the final cross-client sweep can see
# replies that scrolled off the visible pane during a long run.
TMUX_CONF="$SCRATCH/tmux-soak.conf"
MOCK_PID=""
LEADER_EXIT="untested"
LEADER_PID=""
LAST_CLIENT="untested"
CROSS_TALK=0
SESSION_ID="${SOAK_SESSION_ID:-}"

fail() { echo "FAIL: $1" >&2; exit 1; }
ms() { perl -MTime::HiRes=time -e 'print int(time()*1000)'; }
# Window k (1-based) is tmux window index k-1 with a single pane.
pane_target() { printf '%s:%s.0' "$SESSION" "$(( $1 - 1 ))"; }
capture() { tmux -L "$SESSION" -f "$TMUX_CONF" capture-pane -p -t "$(pane_target "${1:-1}")" 2>/dev/null; }
capture_scrollback() { tmux -L "$SESSION" -f "$TMUX_CONF" capture-pane -p -S - -t "$(pane_target "${1:-1}")" 2>/dev/null; }
pane_pid() { tmux -L "$SESSION" -f "$TMUX_CONF" list-panes -F '#{pane_pid}' -t "$(pane_target "${1:-1}")" 2>/dev/null | head -1; }
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
# the turn's own request is the first line carrying it, which is the one that
# gates the render clock. Each window's prompt carries its own tag, so one
# client's clock can never be satisfied by another client's request.
provider_ms() {
  grep -v -F 'Create a concise title' "$GATEWAY_LOG" 2>/dev/null \
    | grep -m 1 -F "SOAK_W$1_TURN_$2 probe" 2>/dev/null | cut -d' ' -f1 || true
}
scope_name() { if [[ "$WINDOWS" -eq 1 ]]; then printf 'tui'; else printf 'tui-w%s' "$1"; fi; }
session_id_for() { printf '%s' "${SESSION_IDS[$1]}"; }
# Every client must render exactly its own tagged turns: a reply delivered to
# the wrong client is a routing failure, not noise.
cross_check() {
  local turn="$1" w other
  for w in $(seq 1 "$WINDOWS"); do
    for other in $(seq 1 "$WINDOWS"); do
      if [[ "$other" != "$w" ]] && capture "$other" | grep -qE "SOAK_W${w}_OK_${turn}([^0-9]|$)"; then
        CROSS_TALK=$((CROSS_TALK + 1))
        # Cross-talk rows stay out of the turn ledger: the ledger counts
        # measured turns, this file is failure evidence.
        printf '{"turn":%s,"window":%s,"error":"cross-talk: window %s rendered SOAK_W%s_OK_%s"}\n' \
          "$turn" "$other" "$other" "$w" "$turn" >>"$CROSSTALK_LOG"
      fi
    done
  done
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
if ! [[ "$WINDOWS" =~ ^[0-9]+$ ]] || [[ "$WINDOWS" -lt 1 ]]; then
  fail "SOAK_WINDOWS must be a positive integer (got $WINDOWS)"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node is unavailable"
command -v tmux >/dev/null 2>&1 || fail "tmux is required"
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || fail "pinned dsh requires Node >=22.19.0 (got $($NODE_BIN --version))"
[[ -n "$SESSION_ID" ]] || SESSION_ID="$("$NODE_BIN" -e 'console.log(crypto.randomUUID())')"
# --session-id only accepts a bare UUID, so a window cannot be namespaced by
# suffixing one id: every window gets its own generated UUID up front.
SESSION_IDS=()
SESSION_IDS[1]="$SESSION_ID"
for (( w = 2; w <= WINDOWS; w += 1 )); do
  SESSION_IDS["$w"]="$("$NODE_BIN" -e 'console.log(crypto.randomUUID())')"
done

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

# One deterministic turn per prompt, answered only to the window that asked.
# Tool turns exercise the tool loop; every other turn is a plain streamed
# reply. Nothing here reads repo state.
cat >"$SCRATCH/soak-model.mjs" <<'EOF'
export function contractReply(body) {
  const messages = body?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
    const match = text.match(/SOAK_W(\d+)_TURN_(\d+)/)
    if (!match) continue
    const window = Number(match[1])
    const turn = Number(match[2])
    const results = messages.slice(index + 1).filter(item => item.role === 'tool').length
    const every = Number(process.env.SOAK_TOOL_EVERY ?? '5')
    if (every > 0 && turn % every === 0 && results === 0) {
      return { name: 'bash', arguments: { command: 'printf SOAK_W' + window + '_TOOL_' + turn, description: 'SOAK tool step ' + turn } }
    }
    return { text: 'SOAK_W' + window + '_OK_' + turn }
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

: >"$GATEWAY_LOG"; : >"$TURNS_LOG"; : >"$SAMPLES_LOG"; : >"$CROSSTALK_LOG"
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
# Every window shares the profile, the socket and the state dir; each one
# drives its own session id.
cli_command() {
  dscode_shell_command env "PATH=$PATH" "HOME=$SCRATCH" "DSH_HOME=$SCRATCH" "DSC_HOME=$SCRATCH/dsc-tui" \
    "DSCODE_SOCKET=$SOCKET" "DSCODE_LOG=$LEADER_LOG" "DSH_BIN=$DSH_BIN" \
    FAKE_KEY=soak-key DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color TERM_PROGRAM=WezTerm \
    "$TUI_BIN" --model fake-model --no-plan --session-id "$(session_id_for "$1")"
}
# The per-turn polls stay visible-only so the measurement loop never pays for a
# scrollback read; the server keeps a deep history so a failed turn can dump
# the full scrollback as evidence, and a dead client keeps its pane so its exit
# message survives.
printf 'set-option -g history-limit 20000\nset-option -g remain-on-exit on\n' >"$TMUX_CONF"
tmux -L "$SESSION" -f "$TMUX_CONF" new-session -d -s "$SESSION" -n w1 -x 180 -y 48 -c "$WORKSPACE" "exec $(cli_command 1)"
BOOT_STARTED="$(ms)"
for _ in $(seq 1 900); do
  if [[ -S "$SOCKET" ]]; then
    for _ in $(seq 1 600); do capture 1 | grep -qE 'Fake Model|fake-model' && break; sleep 0.2; done
    capture 1 | grep -qE 'Fake Model|fake-model' || fail "the TUI never rendered the model row"
    break
  fi
  tmux -L "$SESSION" -f "$TMUX_CONF" has-session -t "$SESSION" 2>/dev/null || fail "the TUI exited before its leader socket appeared"
  sleep 0.2
done
[[ -S "$SOCKET" ]] || fail "the leader socket did not appear"
LEADER_PID="$(leader_pid)"
# Later windows attach to the leader the first one started: the flock on the
# sibling lock file makes connect-or-spawn pick the live leader.
for (( w = 2; w <= WINDOWS; w += 1 )); do
  tmux -L "$SESSION" -f "$TMUX_CONF" new-window -d -t "$SESSION:$(( w - 1 ))" -n "w$w" -c "$WORKSPACE" "exec $(cli_command "$w")"
done
for (( w = 2; w <= WINDOWS; w += 1 )); do
  for _ in $(seq 1 600); do capture "$w" | grep -qE 'Fake Model|fake-model' && break; sleep 0.2; done
  capture "$w" | grep -qE 'Fake Model|fake-model' || fail "window $w never rendered the model row"
done
echo "soak: $TURNS turns x $WINDOWS window(s), socket $SOCKET, leader ${LEADER_PID:-unknown}, boot $(( $(ms) - BOOT_STARTED ))ms"

completed=0
for turn in $(seq 1 "$TURNS"); do
  step=false
  if [[ "$TOOL_EVERY" -gt 0 ]] && (( turn % TOOL_EVERY == 0 )); then step=true; fi
  # Every client gets its own tagged prompt, each in one tmux send-keys call
  # the way the contract E2E drives it: a separate Enter call would inject a
  # harness-controlled gap into the keypress-to-provider time being measured.
  # Each window's clock starts at its own keypress.
  window_started=()
  for w in $(seq 1 "$WINDOWS"); do
    window_started["$w"]="$(ms)"
    tmux -L "$SESSION" -f "$TMUX_CONF" send-keys -t "$(pane_target "$w")" "SOAK_W${w}_TURN_$turn probe" Enter
  done
  rendered=()
  pending="$WINDOWS"
  deadline=$((SECONDS + PER_TURN_TIMEOUT_S))
  while [[ $SECONDS -lt $deadline && "$pending" -gt 0 ]]; do
    for w in $(seq 1 "$WINDOWS"); do
      [[ -n "${rendered[$w]:-}" ]] && continue
      if capture "$w" | grep -qE "SOAK_W${w}_OK_$turn([^0-9]|$)"; then
        rendered["$w"]="$(ms)"
        pending=$((pending - 1))
      fi
    done
    [[ "$pending" -gt 0 ]] && sleep 0.02
  done
  missed=""
  for w in $(seq 1 "$WINDOWS"); do
    if [[ -z "${rendered[$w]:-}" ]]; then
      printf '{"turn":%s,"window":%s,"error":"not rendered within %ss","startedMs":%s}\n' \
        "$turn" "$w" "$PER_TURN_TIMEOUT_S" "${window_started[$w]}" >>"$TURNS_LOG"
      capture_scrollback "$w" >"$OUT/timeout-$RUN_ID-turn-$turn-w$w.txt" || true
      missed="$missed w$w"
    fi
  done
  [[ -z "$missed" ]] || fail "turn $turn never rendered for$missed (scrollback in $OUT/timeout-$RUN_ID-turn-$turn-w*.txt)"
  for w in $(seq 1 "$WINDOWS"); do
    started="${window_started[$w]}"; probe="$(provider_ms "$w" "$turn")"
    if [[ -n "$probe" ]]; then
      printf '{"turn":%s,"window":%s,"tool":%s,"startedMs":%s,"providerMs":%s,"renderedMs":%s,"totalMs":%s,"providerWaitMs":%s}\n' \
        "$turn" "$w" "$step" "$started" "$probe" "${rendered[$w]}" "$(( rendered[w] - started ))" "$(( probe - started ))" >>"$TURNS_LOG"
    else
      printf '{"turn":%s,"window":%s,"tool":%s,"startedMs":%s,"providerMs":null,"renderedMs":%s,"totalMs":%s,"providerWaitMs":null}\n' \
        "$turn" "$w" "$step" "$started" "${rendered[$w]}" "$(( rendered[w] - started ))" >>"$TURNS_LOG"
    fi
    sample "$(scope_name "$w")" "$(pane_pid "$w")" "$turn"
  done
  sample leader "$(leader_pid)" "$turn"
  cross_check "$turn"
  if [[ "$CROSS_TALK" -gt 0 ]]; then
    for w in $(seq 1 "$WINDOWS"); do capture_scrollback "$w" >"$OUT/crosstalk-$RUN_ID-turn-$turn-w$w.txt" || true; done
    fail "cross-talk on turn $turn: a window rendered another window's reply (evidence $OUT/crosstalk-$RUN_ID-turn-$turn-w*.txt)"
  fi
  completed=$((completed + 1))
  if (( turn % 10 == 0 )); then
    progress="turn $turn ok"
    for w in $(seq 1 "$WINDOWS"); do progress="$progress w$w=$(( rendered[w] - window_started[w] ))ms"; done
    echo "$progress"
  fi
  if [[ "$PAUSE_MS" -gt 0 ]]; then sleep "$(perl -e "print $PAUSE_MS / 1000")"; fi
done

# The leader's 2000ms idle exit may only fire once its last client is gone, so
# this wait is deliberate: with every window still open the leader must
# outlive it, and every client must still be up next to it.
sleep 2.5
clients_alive=0
for w in $(seq 1 "$WINDOWS"); do
  if [[ "$(tmux -L "$SESSION" -f /dev/null list-panes -t "$(pane_target "$w")" -F '#{pane_dead}' 2>/dev/null | head -1)" == "0" ]]; then
    clients_alive=$((clients_alive + 1))
  fi
done
if [[ -n "$(leader_pid)" ]]; then
  LAST_CLIENT="alive-with-$clients_alive-of-$WINDOWS-client(s)"
else
  LAST_CLIENT="exited-with-$clients_alive-of-$WINDOWS-client(s)-connected"
fi
[[ "$clients_alive" -eq "$WINDOWS" ]] || fail "only $clients_alive of $WINDOWS TUI client(s) survived the run"
[[ "$LAST_CLIENT" == alive-* ]] || fail "the leader exited while $clients_alive client(s) were still connected"

cleanup
trap - EXIT
cat >"$SCRATCH/soak-summary.mjs" <<'EOF'
import { existsSync, readFileSync } from 'node:fs'
const read = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const [turnsPath, samplesPath, leaderExit, lastClient, crossTalk] = process.argv.slice(2)
const turns = read(turnsPath), samples = read(samplesPath)
const ok = turns.filter(turn => !turn.error)
const numeric = (list, key) => list.map(item => item[key]).filter(value => typeof value === 'number')
const pick = (list, fraction) => list.length ? list[Math.min(list.length - 1, Math.floor(list.length * fraction))] : null
const totals = numeric(ok, 'totalMs').sort((a, b) => a - b)
const stat = list => {
  const values = numeric(list, 'totalMs').sort((a, b) => a - b)
  const waits = numeric(list, 'providerWaitMs').sort((a, b) => a - b)
  return { rows: list.length, p50: pick(values, 0.5), p90: pick(values, 0.9), max: values.at(-1) ?? null, providerWaitP50: pick(waits, 0.5) }
}
const waits = numeric(ok, 'providerWaitMs').sort((a, b) => a - b)
const series = (scope, key) => samples.filter(sample => sample.scope === scope).map(sample => sample[key]).filter(value => typeof value === 'number')
const average = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : null
const scope = name => {
  const rss = series(name, 'rssKiB'), fds = series(name, 'fds'), half = Math.floor(rss.length / 2)
  return { samples: rss.length, firstRssKiB: rss[0] ?? null, lastRssKiB: rss.at(-1) ?? null,
    maxRssKiB: rss.length ? Math.max(...rss) : null, firstHalfAvgRssKiB: average(rss.slice(0, half)), secondHalfAvgRssKiB: average(rss.slice(half)),
    firstFds: fds[0] ?? null, lastFds: fds.at(-1) ?? null, maxFds: fds.length ? Math.max(...fds) : null }
}
const windows = [...new Set(ok.map(turn => turn.window ?? 1))].sort((a, b) => a - b)
const multi = windows.length > 1
const scopes = [...(multi ? windows.map(w => 'tui-w' + w) : ['tui']), 'leader']
const done = [...new Set(ok.map(turn => turn.turn))]
console.log(JSON.stringify({ rows: turns.length, completedTurns: done.length, completedRows: ok.length, windows: windows.length,
  errors: turns.filter(turn => turn.error).length,
  totalMs: { p50: pick(totals, 0.5), p90: pick(totals, 0.9), max: totals.at(-1) ?? null, first5: ok.slice(0, 5).map(turn => turn.totalMs), last5: ok.slice(-5).map(turn => turn.totalMs) },
  totalMsByStep: { plain: stat(ok.filter(turn => turn.tool !== true)), tool: stat(ok.filter(turn => turn.tool === true)) },
  totalMsByWindow: Object.fromEntries(windows.map(w => ['w' + w, stat(ok.filter(turn => (turn.window ?? 1) === w))])),
  providerWaitMs: { p50: pick(waits, 0.5), p90: pick(waits, 0.9), max: waits.at(-1) ?? null },
  rss: Object.fromEntries(scopes.map(name => [name, scope(name)])), leaderExit, lastClient, crossTalk: Number(crossTalk) }, null, 2))
EOF
"$NODE_BIN" "$SCRATCH/soak-summary.mjs" "$TURNS_LOG" "$SAMPLES_LOG" "$LEADER_EXIT" "$LAST_CLIENT" "$CROSS_TALK" | tee "$SUMMARY"
echo "soak: $completed/$TURNS turns x $WINDOWS window(s), evidence $OUT (leader $LEADER_EXIT, last client $LAST_CLIENT)"
