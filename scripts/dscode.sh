#!/usr/bin/env bash
# deepseek-code launcher: the installed official npm dsh CLI boots the
# deepseek-leader profile (bridge leader server); the vendored grok TUI
# connects to it. The deepseek-harness submodule build is never used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="${DEEPSEEK_LEADER_SOCKET:-/tmp/deepseek-leader-$UID.sock}"
TUI="$ROOT/third_party/grok-build/target/release/dscode"
DSH_BIN=""

# The INSTALLED official dsh first, npx on demand. Resolve through npm's own
# global prefix so a stale ~/.local/bin/dsh shim on PATH can never win.
if command -v npm >/dev/null 2>&1; then
  DSH_BIN="$(npm prefix -g 2>/dev/null || true)/bin/dsh"
fi
if [[ -x "$DSH_BIN" ]]; then
  DSH_RUN=("$DSH_BIN")
else
  DSH_RUN=(npx --yes @deepseek-ai/dsh)
fi

# Single-owner socket: remove a stale file from a crashed run before booting
# the leader, so the TUI can never connect to a dead peer.
rm -f "$SOCKET"

if [[ ! -x "$TUI" ]]; then
  echo "dscode: TUI binary not present; run scripts/install.sh first" >&2
  exit 1
fi

# Start the leader server (the profile is initialized by scripts/install.sh).
# numactl node-1 pinning is this host's policy, not a public requirement: keep
# it when available, drop it cleanly elsewhere.
LOG="${DEEPSEEK_LEADER_LOG:-/tmp/deepseek-leader.log}"
if command -v numactl >/dev/null 2>&1; then
  DSH_TELEMETRY_DISABLED=1 DEEPSEEK_LEADER_SOCKET="$SOCKET" \
    numactl --cpunodebind=1 --membind=1 "${DSH_RUN[@]}" --profile deepseek-leader \
    >"$LOG" 2>&1 &
else
  DSH_TELEMETRY_DISABLED=1 DEEPSEEK_LEADER_SOCKET="$SOCKET" \
    "${DSH_RUN[@]}" --profile deepseek-leader \
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
