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
# Local paste fixtures must not inherit the host's SSH clipboard routing.
unset SSH_CONNECTION SSH_CLIENT SSH_TTY
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/third_party/grok-build"
cargo check -p xai-grok-pager-bin
cargo test -p xai-grok-pager-bin --bin dscode -- dsh_launch dscode_aliases dashboard_subcommand
cargo test -p xai-grok-shell-base util::tests:: --lib
cargo test -p xai-grok-shell --lib -- leader:: image_normalize util::config
cargo test -p xai-grok-tools --lib ask_user_question
cargo test -p xai-grok-update --lib
cargo test -p xai-grok-pager -p xai-grok-pager-render --lib -- \
  to_meta_ native_controls native_question dsh_patch dsh_mcp_patch dsh_leader model_switch switch_model slash:: slash_ default_model question_view doctor tasks shortcuts_help subagent mode_switch prompt_stash overlay_post_flush mcps_modal startup_failure \
  presenter_ send_now_awaiting_current background_tasks queue_and_adoption turn_completion \
  settings_modal theme open_settings_focus open_settings_enter_picker prompt_ack headless
echo 'PASS Rust product contracts'
