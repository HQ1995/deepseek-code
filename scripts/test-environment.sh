#!/usr/bin/env bash
# Clear product overrides before a test assigns its own HOME/profile/socket.
# Keep test/build inputs, which callers resolve before launching the product.
dscode_clear_test_overrides() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      DSCODE_E2E_*|DSCODE_TUI_BIN|DSCODE_RELEASE_DIR|DSCODE_SOURCE_DIR|DSCODE_RUNTIME_CONSUMER|DSCODE_DEV_*|DSCODE_RUST_TESTS_ISOLATED) ;;
      DSCODE_*|DSH_*|DSC_HOME|GROK_*|XAI_*|NODE_OPTIONS|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN) unset "$name" ;;
    esac
  done
}

# tmux's single shell-command must preserve literal argv, including quotes and
# newlines, regardless of the user's default shell. No eval or shell expansion.
dscode_shell_command() {
  local argument quote="'" escaped="'\"'\"'"
  for argument in "$@"; do printf "'%s' " "${argument//"$quote"/$escaped}"; done
}

# Both product E2Es consume this interface. Artifact selection, building and
# provenance live in test-runtime.mjs; stdout is two NUL-delimited paths.
dscode_prepare_test_runtime() {
  local root="$1" scratch="$2" node="$3" build_log="$4"
  mkdir -p "$scratch/e2e-bin" || return 1
  if ! command -v pnpm >/dev/null 2>&1; then
    command -v corepack >/dev/null 2>&1 || { echo 'pnpm or corepack is required' >&2; return 1; }
    corepack enable --install-directory "$scratch/e2e-bin" pnpm || return 1
  fi
  export PATH="$scratch/e2e-bin:$PATH"
  "$node" "$root/scripts/test-runtime.mjs" "$root" "$scratch" "$build_log" >"$scratch/runtime-paths" || return 1
  { IFS= read -r -d '' DSH_BIN && IFS= read -r -d '' BRIDGE_ARCHIVE; } <"$scratch/runtime-paths"
}
