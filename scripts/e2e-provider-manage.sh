#!/usr/bin/env bash
# End-to-end provider manage: isolated DSH_HOME + tmux TUI + mock gateway.
# Flow: add fake-gw through the modal (the e2e-add-provider path), edit it
# through the prefilled modal (Ctrl+E), assert the update preserved models
# and the roster refreshed, then delete it (Ctrl+D, y confirm) and assert
# the route left settings.yaml; the current provider's delete is refused
# with the switch-first message. A second boot proves the edited settings
# persist. Artifacts land in /tmp/provmanage-e2e/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${DSCODE_TUI_BIN:-$ROOT/third_party/grok-build/target/release/dscode}"
NODE_BIN="${DSCODE_E2E_NODE_BIN:-$(command -v node || true)}"
OUT=/tmp/provmanage-e2e
mkdir -p "$OUT"
RUN_ID="$$"
SCRATCH="$OUT/home-$RUN_ID"
SOCK="$OUT/leader-$RUN_ID.sock"
SOCK2="$OUT/leader-$RUN_ID-boot2.sock"
PORT=$((23000 + (RUN_ID % 15000)))
GW_URL="http://127.0.0.1:$PORT/v1"
SESSION="provmanage-$RUN_ID"
MOCK_PID=""

cleanup() { tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true; if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi; }
fail() { echo "FAIL: $1" >&2; cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-FAIL.yaml" 2>/dev/null || true; tmux -L "$SESSION" -f /dev/null capture-pane -p -t "$SESSION:0.0" > "$OUT/frame-$RUN_ID-FAIL.txt" 2>/dev/null || true; exit 1; }
trap cleanup EXIT

[[ -x "$BIN" ]] || fail "TUI binary is missing: $BIN"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "Node is unavailable"
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || fail "pinned dsh requires Node >=22.19.0 (got $($NODE_BIN --version))"
export PATH="$(dirname "$NODE_BIN"):$PATH"

# 1. Mock gateway (node stdlib): GET .../models answers one fake model.
"$NODE_BIN" -e '
const http = require("http");
const port = Number(process.argv[1]);
http.createServer((req, res) => {
  if (req.method === "GET" && req.url.split("?")[0].endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "fake-model", name: "Fake Model" }] }));
  } else { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1", () => console.log("mock ready " + port));
' "$PORT" >"$OUT/mock-$RUN_ID.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q 'mock ready' "$OUT/mock-$RUN_ID.log" 2>/dev/null && break; sleep 0.25; done
grep -q 'mock ready' "$OUT/mock-$RUN_ID.log" || fail "mock gateway did not start"

# 2. Fully isolated DSH_HOME with one deterministic seed provider.
mkdir -p "$SCRATCH/e2e-bin"
if ! command -v pnpm >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || fail "pnpm or corepack is required"
  COREPACK_BIN="$(command -v corepack)"
  cat >"$SCRATCH/e2e-bin/pnpm" <<EOF
#!/bin/sh
exec "$COREPACK_BIN" pnpm "\$@"
EOF
  chmod +x "$SCRATCH/e2e-bin/pnpm"
fi
export PATH="$SCRATCH/e2e-bin:$PATH"
if [[ -n "${DSCODE_E2E_DSH_BIN:-}" ]]; then
  DSH_BIN="$DSCODE_E2E_DSH_BIN"
elif command -v dsh >/dev/null 2>&1 \
  && [[ "$(dsh --version 2>/dev/null | head -1 || true)" == "0.1.0-rc.8" ]]; then
  DSH_BIN="$(command -v dsh)"
else
  DSH_PREFIX="$SCRATCH/dsh-cli"
  npm install --prefix "$DSH_PREFIX" --ignore-scripts --no-audit --no-fund \
    @deepseek-ai/dsh@0.1.0-rc.8 >"$OUT/dsh-install-$RUN_ID.log" 2>&1 \
    || fail "could not install the pinned dsh CLI"
  DSH_BIN="$DSH_PREFIX/node_modules/.bin/dsh"
fi
cat >"$SCRATCH/settings.yaml" <<EOF
llm-pi-ai:
  providers:
    seed:
      displayName: Seed Provider
      apiKeyEnv: FAKE_KEY
      api: openai-completions
      baseURL: $GW_URL
      models:
        - id: fake-model
agent-default-model:
  provider: seed
  model: fake-model
EOF
DSH_HOME="$SCRATCH" "$DSH_BIN" plugin --profile dscode add "file:$ROOT/bridge/grok-leader" >"$OUT/plugin-$RUN_ID.log" 2>&1 || fail "dsh plugin add failed"

export TERM=xterm-256color
export DSH_HOME="$SCRATCH"
export DSCODE_SOCKET="$SOCK"
export DSH_TELEMETRY_DISABLED=1
export DSH_BIN
export FAKE_KEY=e2e-fake-key
export NO_COLOR=1

snap() { tmux -L "$SESSION" -f /dev/null capture-pane -p -t "$SESSION:0.0" > "$OUT/frame-$RUN_ID-$1.txt" 2>/dev/null || true; }

boot_and_wait() {
  local label="$1" sock="$2"
  local cmd="$BIN"
  if command -v numactl >/dev/null 2>&1; then
    cmd="numactl --cpunodebind=1 --membind=1 $BIN"
  fi
  tmux -L "$SESSION" -f /dev/null new-session -d -s "$SESSION" -x 200 -y 50 "cd $ROOT && exec $cmd"
  for _ in $(seq 1 120); do
    snap "$label-wait"
    if [ -S "$sock" ] && [ -s "$OUT/frame-$RUN_ID-$label-wait.txt" ]; then sleep 5; return 0; fi
    sleep 1
  done
  fail "TUI did not come up ($label)"
}

wait_frame() {
  local label="$1" needle="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    snap "$label"
    if grep -q "$needle" "$OUT/frame-$RUN_ID-$label.txt" 2>/dev/null; then return 0; fi
    sleep 1
  done
  snap "$label"
  grep -q "$needle" "$OUT/frame-$RUN_ID-$label.txt" || fail "$label: never saw '$needle'"
}

clear_prompt() { tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" C-c; sleep 1; }

wait_default_selection() {
  local provider="$1" model="$2"
  for _ in $(seq 1 40); do
    if awk -v provider="$provider" -v model="$model" '
      /^agent-default-model:/ { in_default = 1; next }
      in_default && /^[^[:space:]]/ { in_default = 0 }
      in_default && $1 == "provider:" && $2 == provider { provider_ok = 1 }
      in_default && $1 == "model:" && $2 == model { model_ok = 1 }
      END { exit !(provider_ok && model_ok) }
    ' "$SCRATCH/settings.yaml"; then
      return 0
    fi
    sleep 0.25
  done
  fail "default selection did not become $provider/$model"
}

# 3. First boot: Custom is the neutral default; add fake-gw.
boot_and_wait boot1 "$SOCK"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider add" Enter
wait_frame modal "Add provider"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Down "fake-gw"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "Fake GW"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "FAKE_KEY"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab Right
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "$GW_URL"
snap filled
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Enter
wait_frame after-add "Provider added"
cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-after-add.yaml"
grep -q 'fake-gw:' "$SCRATCH/settings.yaml" || fail "settings.yaml missing fake-gw"
grep -q 'fake-model' "$SCRATCH/settings.yaml" || fail "settings.yaml missing discovered model"

# 4. Both providers expose fake-model. Switching providers keeps that raw
# model id, while persisting the exact provider/model route.
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake-gw" Enter
wait_default_selection fake-gw fake-model
snap same-model-switch
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider seed" Enter
wait_default_selection seed fake-model

# 5. Edit fake-gw: Ctrl+E opens the modal prefilled; rename displayName.
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
snap pre-edit-list
grep -q 'Fake GW' "$OUT/frame-$RUN_ID-pre-edit-list.txt" || fail "/provider does not list Fake GW before the edit"
grep -q '1 model' "$OUT/frame-$RUN_ID-pre-edit-list.txt" || fail "new provider still shows no models before restart"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" C-e
wait_frame edit-modal "Edit provider"
grep -q 'fake-gw' "$OUT/frame-$RUN_ID-edit-modal.txt" || fail "edit modal does not show the locked id"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "Fake GW Renamed"
snap edit-filled
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Enter
wait_frame after-edit "Provider updated"
cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-after-edit.yaml"
grep -q 'displayName: Fake GW Renamed' "$SCRATCH/settings.yaml" || fail "settings.yaml missing the renamed displayName"
grep -q 'apiKeyEnv: FAKE_KEY' "$SCRATCH/settings.yaml" || fail "edit dropped apiKeyEnv"
grep -q 'fake-model' "$SCRATCH/settings.yaml" || fail "edit dropped the discovered models"
grep -q "$GW_URL" "$SCRATCH/settings.yaml" || fail "edit dropped baseURL"
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
snap post-edit-list
grep -q 'Fake GW Renamed' "$OUT/frame-$RUN_ID-post-edit-list.txt" || fail "/provider does not show the renamed provider"
tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true

# 6. Second boot: the edited settings persist, then delete and the blocked check.
export DSCODE_SOCKET="$SOCK2"
boot_and_wait boot2 "$SOCK2"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
snap boot2-list
grep -q 'Fake GW Renamed' "$OUT/frame-$RUN_ID-boot2-list.txt" || fail "second boot lost the edited provider"

# Delete: Ctrl+D arms the confirm, y removes the route.
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" C-d
wait_frame delete-arm "y confirm"
grep -q 'Fake GW Renamed' "$OUT/frame-$RUN_ID-delete-arm.txt" || fail "delete confirm does not name the provider"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "y"
wait_frame after-delete "Provider removed"
cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-after-delete.yaml"
if grep -q 'fake-gw:' "$SCRATCH/settings.yaml"; then fail "settings.yaml still has fake-gw after delete"; fi

# Blocked delete: the provider owning the current model cannot be removed.
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider "
sleep 2
snap all-rows
CUR_ID="seed"
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider $CUR_ID"
sleep 2
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" C-d
wait_frame blocked-arm "switch provider first"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "n"
sleep 1
snap after-block-dismiss
tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""

echo "PASS provider-manage e2e run $RUN_ID"
echo "  artifacts: $OUT (frame-*-$RUN_ID*.txt, settings-$RUN_ID-*.yaml)"
