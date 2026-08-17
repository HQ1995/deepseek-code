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
BIN="$ROOT/third_party/grok-build/target/release/dscode"
OUT=/tmp/provmanage-e2e
mkdir -p "$OUT"
RUN_ID="$$"
SCRATCH="$OUT/home-$RUN_ID"
SOCK="$OUT/leader-$RUN_ID.sock"
SOCK2="$OUT/leader-$RUN_ID-boot2.sock"
PORT=$((23000 + (RUN_ID % 15000)))
GW_URL="http://127.0.0.1:$PORT/v1"
SESSION="provmanage-$RUN_ID"

fail() { echo "FAIL: $1" >&2; cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-FAIL.yaml" 2>/dev/null || true; tmux -L "$SESSION" -f /dev/null capture-pane -p -t "$SESSION:0.0" > "$OUT/frame-$RUN_ID-FAIL.txt" 2>/dev/null || true; tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true; kill "$MOCK_PID" 2>/dev/null || true; exit 1; }

# 1. Mock gateway (node stdlib): GET .../models answers one fake model.
node -e '
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

# 2. Isolated DSH_HOME seeded with the real settings, bridge installed.
mkdir -p "$SCRATCH"
cp "$HOME/.dsh/settings.yaml" "$SCRATCH/settings.yaml"
DSH_HOME="$SCRATCH" "$ROOT/bin/dsh" plugin --profile deepseek-leader add "file:$ROOT/bridge/grok-leader" >"$OUT/plugin-$RUN_ID.log" 2>&1 || fail "dsh plugin add failed"

export TERM=xterm-256color
export DSH_HOME="$SCRATCH"
export DEEPSEEK_LEADER_SOCKET="$SOCK"
export DSH_TELEMETRY_DISABLED=1
export FAKE_KEY=e2e-fake-key
export NO_COLOR=1

snap() { tmux -L "$SESSION" -f /dev/null capture-pane -p -t "$SESSION:0.0" > "$OUT/frame-$RUN_ID-$1.txt" 2>/dev/null || true; }

boot_and_wait() {
  local label="$1" sock="$2"
  tmux -L "$SESSION" -f /dev/null new-session -d -s "$SESSION" -x 200 -y 50 "cd $ROOT && exec numactl --cpunodebind=1 --membind=1 $BIN"
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

# 3. First boot: add fake-gw through the modal (same flow as e2e-add-provider).
boot_and_wait boot1 "$SOCK"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider add" Enter
wait_frame modal "Add provider"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Down Down Down Down Down
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "fake-gw"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "Fake GW"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "FAKE_KEY"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "$GW_URL"
snap filled
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Enter
wait_frame after-add "Provider added"
cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-after-add.yaml"
grep -q 'fake-gw:' "$SCRATCH/settings.yaml" || fail "settings.yaml missing fake-gw"
grep -q 'fake-model' "$SCRATCH/settings.yaml" || fail "settings.yaml missing discovered model"

# 4. Edit fake-gw: Ctrl+E opens the modal prefilled; rename displayName.
clear_prompt
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
snap pre-edit-list
grep -q 'Fake GW' "$OUT/frame-$RUN_ID-pre-edit-list.txt" || fail "/provider does not list Fake GW before the edit"
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

# 5. Second boot: the edited settings persist, then delete and the blocked check.
export DEEPSEEK_LEADER_SOCKET="$SOCK2"
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
CUR_ID="deepseek"
if grep -q 'OpenCodex (current)' "$OUT/frame-$RUN_ID-all-rows.txt" 2>/dev/null; then CUR_ID="ocx"; fi
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

echo "PASS provider-manage e2e run $RUN_ID"
echo "  artifacts: $OUT (frame-*-$RUN_ID*.txt, settings-$RUN_ID-*.yaml)"
