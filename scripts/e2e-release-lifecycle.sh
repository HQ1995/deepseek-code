#!/usr/bin/env bash
# Black-box lifecycle test for an already-published dscode npm package.
# Uses an isolated HOME and a local mock model; no user state or paid API.
set -euo pipefail

PACKAGE_SPEC="${DSCODE_E2E_PACKAGE_SPEC:-@hqzhao95/dscode@beta}"
KEEP="${DSCODE_E2E_KEEP:-0}"
NODE_BIN="${DSCODE_E2E_NODE_BIN:-$(command -v node || true)}"
NPM_BIN="${DSCODE_E2E_NPM_BIN:-$(command -v npm || true)}"
NPX_BIN="${DSCODE_E2E_NPX_BIN:-$(command -v npx || true)}"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node is unavailable"
[[ -n "$NPM_BIN" && -x "$NPM_BIN" ]] || fail "npm is unavailable"
[[ -n "$NPX_BIN" && -x "$NPX_BIN" ]] || fail "npx is unavailable"
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || fail "dscode requires Node >=22.19.0 (got $($NODE_BIN --version))"

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dscode-release-e2e.XXXXXX")"
TEST_HOME="$RUN_ROOT/home"
WORK_DIR="$RUN_ROOT/work"
TOOL_BIN="$RUN_ROOT/tool-bin"
MOCK_SCRIPT="$RUN_ROOT/mock-gateway.mjs"
MOCK_READY="$RUN_ROOT/mock-ready"
MOCK_LOG="$RUN_ROOT/mock.log"
MOCK_PID=""

cleanup() {
  result=$?
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP" == 1 || "$result" != 0 ]]; then
    echo "  lifecycle artifacts: $RUN_ROOT" >&2
  else
    find "$RUN_ROOT" -depth -delete
  fi
  trap - EXIT
  exit "$result"
}
trap cleanup EXIT

mkdir -p "$TEST_HOME" "$WORK_DIR" "$TOOL_BIN" "$RUN_ROOT/npm-cache"
ln -s "$NODE_BIN" "$TOOL_BIN/node"
ln -s "$NPM_BIN" "$TOOL_BIN/npm"
ln -s "$NPX_BIN" "$TOOL_BIN/npx"
: >"$RUN_ROOT/npmrc"
export HOME="$TEST_HOME"
export DSH_HOME="$TEST_HOME/.dsh"
export XDG_CACHE_HOME="$TEST_HOME/.cache"
export XDG_CONFIG_HOME="$TEST_HOME/.config"
export XDG_DATA_HOME="$TEST_HOME/.local/share"
export NPM_CONFIG_CACHE="$RUN_ROOT/npm-cache"
export NPM_CONFIG_USERCONFIG="$RUN_ROOT/npmrc"
export PATH="$TOOL_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
unset NPM_TOKEN NODE_AUTH_TOKEN DSH_BIN DSCODE_BIN

EXPECTED_VERSION="${DSCODE_E2E_EXPECTED_VERSION:-$($NPM_BIN view "$PACKAGE_SPEC" version)}"
PROFILE="$DSH_HOME/profiles/dscode"
LAUNCHER="$TEST_HOME/.local/bin/dscode"
TUI_BIN="$PROFILE/bin/dscode"
DSH_BIN="$PROFILE/runtime/bin/dsh"
PROFILE_LAUNCHER="$PROFILE/node_modules/@hqzhao95/dscode/bin/dscode.mjs"

echo "dscode published-release lifecycle E2E"
echo "  host: $(uname -s)-$(uname -m)"
echo "  node: $($NODE_BIN --version)"
echo "  package: $PACKAGE_SPEC -> $EXPECTED_VERSION"

echo "[1/6] cold install from npm"
(
  cd "$WORK_DIR"
  "$NPX_BIN" --yes "$PACKAGE_SPEC" --version \
    >"$RUN_ROOT/install.out" 2>"$RUN_ROOT/install.err"
)
grep -Fq "dscode $EXPECTED_VERSION" "$RUN_ROOT/install.out" \
  || fail "installed binary did not report $EXPECTED_VERSION"
[[ -x "$TUI_BIN" ]] || fail "TUI binary was not installed"
[[ -x "$DSH_BIN" ]] || fail "private dsh runtime was not installed"
[[ -L "$LAUNCHER" ]] || fail "launcher link was not installed"
"$NODE_BIN" - "$PROFILE/node_modules/@hqzhao95/dscode/package.json" "$EXPECTED_VERSION" <<'NODE'
const fs = require('node:fs')
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (pkg.version !== process.argv[3]) process.exit(1)
NODE

echo "[2/6] legacy direct-link stale-profile handoff"
"$NODE_BIN" - "$PROFILE/node_modules/@hqzhao95/dscode/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.version = '0.0.0-legacy'
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
NODE
rm "$LAUNCHER"
ln -s "$TUI_BIN" "$LAUNCHER"
(
  cd "$WORK_DIR"
  "$LAUNCHER" inspect --json \
    >"$RUN_ROOT/handoff-inspect.json" 2>"$RUN_ROOT/handoff-inspect.err"
)
"$NODE_BIN" - "$LAUNCHER" "$PROFILE_LAUNCHER" \
  "$PROFILE/node_modules/@hqzhao95/dscode/package.json" \
  "$PROFILE/runtime/lib/node_modules/@deepseek-ai/dsh/package.json" \
  "$RUN_ROOT/handoff-inspect.json" "$EXPECTED_VERSION" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const link = process.argv[2]
const target = path.resolve(path.dirname(link), fs.readlinkSync(link))
if (target !== process.argv[3]) throw new Error(`legacy link points to ${target}`)
const pkg = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
const runtime = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'))
if (pkg.version !== process.argv[7]) throw new Error(`profile stayed at ${pkg.version}`)
const inspect = JSON.parse(fs.readFileSync(process.argv[6], 'utf8'))
if (inspect.grokVersion !== process.argv[7]) {
  throw new Error(`handoff ran TUI ${inspect.grokVersion}`)
}
if (pkg.dsh?.testedVersion !== runtime.version) {
  throw new Error(`runtime ${runtime.version} does not match ${pkg.dsh?.testedVersion}`)
}
NODE

wait_leader_exit() {
  socket="$1"
  lock="${socket%.*}.lock"
  for _ in $(seq 1 100); do
    pid="$(cat "$lock" 2>/dev/null || true)"
    if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  fail "leader remained alive after client exit: $socket"
}

echo "[3/6] provider-neutral first use"
ONBOARDING_SOCKET="$RUN_ROOT/onboarding.sock"
if env DSCODE_SOCKET="$ONBOARDING_SOCKET" DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 \
  "$LAUNCHER" -p "must not reach a model" --output-format json --agent minimal \
  >"$RUN_ROOT/onboarding.out" 2>"$RUN_ROOT/onboarding.err"; then
  fail "fresh profile unexpectedly completed a turn without a provider"
fi
grep -Eiq 'no model selected|use /provider|provider.*model' \
  "$RUN_ROOT/onboarding.out" "$RUN_ROOT/onboarding.err" \
  || fail "fresh profile did not explain how to select a provider"
wait_leader_exit "$ONBOARDING_SOCKET"

cat >"$MOCK_SCRIPT" <<'NODE'
import { appendFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'

const [readyPath, logPath] = process.argv.slice(2)
const chunk = (text, finishReason = null) => JSON.stringify({
  id: 'dscode-release-e2e',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fixture-model',
  choices: [{
    index: 0,
    delta: text === '' ? {} : { role: 'assistant', content: text },
    finish_reason: finishReason,
  }],
})

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', part => { body += part })
  request.on('end', () => {
    appendFileSync(logPath, `${request.method} ${request.url} ${body}\n`)
    const path = request.url?.split('?')[0] ?? ''
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'fixture-model', name: 'Fixture Model' }] }))
      return
    }
    if (request.method === 'POST' && path.endsWith('/chat/completions')) {
      const text = body.includes('Create a concise title') ? 'Release E2E' : 'E2E_RELEASE_OK'
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.write(`data: ${chunk(text)}\n\n`)
      response.write(`data: ${chunk('', 'stop')}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404)
    response.end()
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') process.exit(1)
  writeFileSync(readyPath, String(address.port))
})
NODE

"$NODE_BIN" "$MOCK_SCRIPT" "$MOCK_READY" "$MOCK_LOG" &
MOCK_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$MOCK_READY" ]] && break
  kill -0 "$MOCK_PID" >/dev/null 2>&1 || fail "mock gateway exited early"
  sleep 0.1
done
[[ -s "$MOCK_READY" ]] || fail "mock gateway did not start"
MOCK_PORT="$(cat "$MOCK_READY")"

cat >"$DSH_HOME/settings.yaml" <<EOF
llm-pi-ai:
  providers:
    fixture:
      displayName: Fixture Gateway
      apiKeyEnv: DSCODE_E2E_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:$MOCK_PORT/v1
      models:
        - id: fixture-model
agent-default-model:
  provider: fixture
  model: fixture-model
EOF

echo "[4/6] real headless turn through the bridge"
USE_SOCKET="$RUN_ROOT/use.sock"
(
  cd "$WORK_DIR"
  env DSCODE_SOCKET="$USE_SOCKET" DSCODE_E2E_KEY=e2e-key \
    DSH_TELEMETRY_DISABLED=1 NO_COLOR=1 TERM=xterm-256color \
    "$LAUNCHER" -p "reply with the release marker" \
      --output-format json --agent minimal \
      >"$RUN_ROOT/use.json" 2>"$RUN_ROOT/use.err"
)
"$NODE_BIN" - "$RUN_ROOT/use.json" <<'NODE'
const fs = require('node:fs')
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!result.text?.includes('E2E_RELEASE_OK') || !result.sessionId) process.exit(1)
NODE
grep -Fq 'POST /v1/chat/completions' "$MOCK_LOG" \
  || fail "installed product did not call the mock provider"
wait_leader_exit "$USE_SOCKET"

echo "[5/6] uninstall owned product state"
mkdir -p "$DSH_HOME/sessions" "$DSH_HOME/storages"
printf 'keep\n' >"$DSH_HOME/sessions/shared.keep"
printf 'keep\n' >"$DSH_HOME/storages/shared.keep"
"$LAUNCHER" uninstall >"$RUN_ROOT/uninstall.out" 2>"$RUN_ROOT/uninstall.err"
[[ ! -e "$PROFILE" ]] || fail "uninstall kept the dscode profile"
[[ ! -e "$LAUNCHER" && ! -L "$LAUNCHER" ]] || fail "uninstall kept the launcher link"
[[ -f "$DSH_HOME/settings.yaml" ]] || fail "uninstall removed shared dsh settings"
[[ -f "$DSH_HOME/sessions/shared.keep" ]] || fail "uninstall removed shared sessions"
[[ -f "$DSH_HOME/storages/shared.keep" ]] || fail "uninstall removed shared storages"

echo "[6/6] cleanup isolation boundary"
echo "PASS install -> legacy handoff -> provider onboarding -> use -> uninstall ($EXPECTED_VERSION)"
