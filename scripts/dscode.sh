#!/usr/bin/env bash
# deepseek-code launcher: harness leader server (built from the submodule) +
# the vendored grok TUI. The single entrypoint is `bin/dscode`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="${DEEPSEEK_LEADER_SOCKET:-/tmp/deepseek-leader-$UID.sock}"
TUI="$ROOT/third_party/grok-build/target/release/dscode"
DSH="$ROOT/deepseek-harness/apps/cli/lib/bin.js"

# Single-owner socket: remove a stale file from a crashed run before booting
# the leader, so the TUI can never connect to a dead peer.
rm -f "$SOCKET"

if [[ ! -x "$TUI" ]]; then
  echo "dscode: TUI binary not built; run scripts/build-deepseek-tui.sh first" >&2
  exit 1
fi
if [[ ! -f "$DSH" ]]; then
  echo "dscode: harness not built; run scripts/install.sh first" >&2
  exit 1
fi

# Start the harness leader server (auto-initializes the deepseek-leader profile).
# numactl node-1 pinning is this host's policy, not a public requirement: keep
# it when available, drop it cleanly elsewhere.
LOG="${DEEPSEEK_LEADER_LOG:-/tmp/deepseek-leader.log}"
if command -v numactl >/dev/null 2>&1; then
  DSH_TELEMETRY_DISABLED=1 DEEPSEEK_LEADER_SOCKET="$SOCKET" \
    numactl --cpunodebind=1 --membind=1 node "$DSH" --profile deepseek-leader \
    >"$LOG" 2>&1 &
else
  DSH_TELEMETRY_DISABLED=1 DEEPSEEK_LEADER_SOCKET="$SOCKET" \
    node "$DSH" --profile deepseek-leader \
    >"$LOG" 2>&1 &
fi
LEADER_PID=$!
trap 'kill "$LEADER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  [[ -S "$SOCKET" ]] && break
  sleep 0.05
done
if [[ ! -S "$SOCKET" ]]; then
  echo "dscode: leader server did not bind $SOCKET; log: $LOG" >&2
  exit 1
fi

exec "$TUI" --leader --leader-socket "$SOCKET" --sandbox off --no-auto-update "$@"
