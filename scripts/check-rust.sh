#!/usr/bin/env bash
# Product contracts shared by PR checks and the release gate.
set -euo pipefail
# Process-lifecycle tests must not be able to signal unrelated host processes.
if [[ "$(uname -s)" == Linux && "${DSCODE_RUST_TESTS_ISOLATED:-}" != 1 ]]; then
  # util-linux 2.37 leaves SIGINT/SIGTERM ignored in its forked child.
  exec unshare --user --map-root-user --pid --fork --mount-proc \
    env --default-signal=INT,TERM DSCODE_RUST_TESTS_ISOLATED=1 bash "$0" "$@"
fi
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/third_party/grok-build"
cargo check -p xai-grok-pager-bin
cargo test -p xai-grok-pager-bin --bin dscode dsh_launch
cargo test -p xai-grok-shell-base util::tests:: --lib
cargo test -p xai-grok-shell --lib -- leader:: image_normalize
cargo test -p xai-grok-update --lib
cargo test -p xai-grok-pager --lib -- \
  to_meta_ native_controls dsh_leader doctor tasks shortcuts_help subagent mode_switch prompt_stash overlay_post_flush \
  presenter_ send_now_awaiting_current
echo 'PASS Rust product contracts'
