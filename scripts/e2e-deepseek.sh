#!/usr/bin/env bash
# End-to-end: mock LLM -> bin/deepseek (leader server + real grok TUI) -> one prompt.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="deepseek-e2e-$$"
SOCK="/tmp/deepseek-e2e-$$.sock"
HOME_DIR="$(mktemp -d /tmp/deepseek-e2e-home-XXXX)"

# Start the mock LLM (module resolution needs apps/cli cwd).
MOCK_LOG="$HOME_DIR/mock.log"
( cd "$ROOT/apps/cli" && node -e '
import("@deepseek-ai/dsh-llm-mock-server").then(async ({ startMockLlmServer }) => {
  const s = await startMockLlmServer({ sequence: ["success","success","success","success"], apiKey: "k", successText: "hello from deepseek-build" })
  console.log(s.baseURL)
  process.on("SIGTERM", () => { s.close().then(() => process.exit(0)) })
  setInterval(() => {}, 1000)
})' ) >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 40); do grep -q 'http://' "$MOCK_LOG" 2>/dev/null && break; sleep 0.25; done
BASE_URL="$(grep -o 'http://[^ ]*' "$MOCK_LOG" | head -1)"
echo "mock at $BASE_URL"

export TERM=xterm-256color
export DEEPSEEK_LEADER_SOCKET="$SOCK"
export DSH_HOME="$HOME_DIR"
export DSH_TELEMETRY_DISABLED=1
export DEEPSEEK_API_KEY=k
export DEEPSEEK_BASE_URL="$BASE_URL"
export NO_COLOR=1

tmux -L "$SESSION" -f /dev/null new-session -d -x 240 -y 50 "cd $ROOT && exec ./bin/deepseek"
sleep 14
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION" 'say hi' Enter
ANSWER=0
for _ in $(seq 1 60); do
  CAP="$(tmux -L "$SESSION" -f /dev/null capture-pane -p -t "$SESSION" 2>/dev/null || true)"
  if echo "$CAP" | grep -q 'hello from deepseek-build'; then ANSWER=1; break; fi
  sleep 1
done
tmux -L "$SESSION" -f /dev/null send-keys -t "$SESSION" q
sleep 3
tmux -L "$SESSION" -f /dev/null kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
echo "answer rendered: $ANSWER"
echo "mock base: $BASE_URL"
grep -c 'chat/completions' "$HOME_DIR"/sessions/*/*/session.jsonl* 2>/dev/null | head -1 || true
[ "$ANSWER" = "1" ] && exit 0 || exit 1
