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
