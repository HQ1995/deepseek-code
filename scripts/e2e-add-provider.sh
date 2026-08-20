#!/usr/bin/env bash
# End-to-end add-provider: isolated DSH_HOME + tmux TUI + mock gateway.
# Flow: /provider -> "+ Add provider…" -> Custom -> submit fake-gw, then
# assert (1) the scratch settings.yaml gained the provider, (2) /provider
# lists it, (3) a second boot with the same scratch home still works.
# Artifacts (frames, logs, settings snapshots) land in /tmp/addprov-e2e/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/third_party/grok-build/target/release/dscode"
OUT=/tmp/addprov-e2e
mkdir -p "$OUT"
RUN_ID="$$"
SCRATCH="$OUT/home-$RUN_ID"
SOCK="$OUT/leader-$RUN_ID.sock"
SOCK2="$OUT/leader-$RUN_ID-boot2.sock"
PORT=$((22000 + (RUN_ID % 20000)))
GW_URL="http://127.0.0.1:$PORT/v1"
SESSION="addprov-$RUN_ID"

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
DSH_HOME="$SCRATCH" "$ROOT/bin/dsh" plugin --profile dscode add "file:$ROOT/bridge/grok-leader" >"$OUT/plugin-$RUN_ID.log" 2>&1   || fail "dsh plugin add failed"

export TERM=xterm-256color
export DSH_HOME="$SCRATCH"
export DSCODE_SOCKET="$SOCK"
export DSH_TELEMETRY_DISABLED=1
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

# 3. First boot: add the provider through the modal.
boot_and_wait boot1 "$SOCK"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider add" Enter
for _ in $(seq 1 60); do
  snap modal
  if grep -q 'Add provider' "$OUT/frame-$RUN_ID-modal.txt" 2>/dev/null; then break; fi
  sleep 1
done
grep -q 'Add provider' "$OUT/frame-$RUN_ID-modal.txt" || fail "add-provider modal did not open"

# Custom preset (5 Down presses from "DeepSeek official"), then fill the form.
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Down Down Down Down Down
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "fake-gw"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "Fake GW"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "FAKE_KEY"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Tab "$GW_URL"
snap filled
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" Enter
for _ in $(seq 1 60); do
  snap after-add
  if grep -q 'Provider added' "$OUT/frame-$RUN_ID-after-add.txt" 2>/dev/null; then break; fi
  sleep 1
done
grep -q 'Provider added' "$OUT/frame-$RUN_ID-after-add.txt" || fail "bridge did not confirm the add"

# 4. settings.yaml gained the provider through the official seam.
cp "$SCRATCH/settings.yaml" "$OUT/settings-$RUN_ID-after.yaml"
grep -q 'fake-gw:' "$SCRATCH/settings.yaml" || fail "settings.yaml missing fake-gw"
grep -q 'fake-model' "$SCRATCH/settings.yaml" || fail "settings.yaml missing discovered model"

# 5. /provider lists it.
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
snap provider-list
grep -q 'Fake GW' "$OUT/frame-$RUN_ID-provider-list.txt" || fail "/provider does not list Fake GW"
tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true

# 6. Subsequent boot with the same scratch home still works.
export DSCODE_SOCKET="$SOCK2"
boot_and_wait boot2 "$SOCK2"
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION:0.0" "/provider fake"
sleep 2
snap boot2-provider
grep -q 'Fake GW' "$OUT/frame-$RUN_ID-boot2-provider.txt" || fail "second boot lost the provider"
tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true

echo "PASS add-provider e2e run $RUN_ID"
echo "  artifacts: $OUT (frame-*-$RUN_ID*.txt, settings-$RUN_ID-after.yaml)"
