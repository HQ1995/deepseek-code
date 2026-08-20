#!/usr/bin/env bash
# Product-level dscode E2E matrix. No real model credentials are used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=platform.sh
source "$ROOT/scripts/platform.sh"
BRIDGE="$ROOT/bridge/grok-leader"
PAGER_MANIFEST="$ROOT/third_party/grok-build/crates/codegen/xai-grok-pager/Cargo.toml"
TUI_BIN="${DSCODE_TUI_BIN:-$ROOT/third_party/grok-build/target/release/dscode}"
FULL=0
PROVIDER_UI=0

usage() {
  cat <<'EOF'
Usage: scripts/e2e-product.sh [--full] [--provider-ui]

  default        Portable launcher + bridge + Rust contract suite.
  --full         Build the current TUI and run real headless + PTY dsh/bridge E2E.
  --provider-ui  Run the tmux provider add/edit/delete persistence flow.

The suite uses isolated homes and mock services. It never calls a paid model.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --provider-ui) PROVIDER_UI=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

node_supported() {
  "$1" -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit((M===22&&m>=19)||M>=24?0:1)' >/dev/null 2>&1
}

if [[ -n "${DSCODE_E2E_NODE_BIN:-}" ]]; then
  NODE_BIN="$DSCODE_E2E_NODE_BIN"
elif command -v node >/dev/null 2>&1 && node_supported "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
elif command -v npx >/dev/null 2>&1; then
  NODE_BIN="$(npx --yes node@24 -p 'process.execPath')"
else
  echo "error: Node ^22.19.0 or >=24 is required (and npx is unavailable)" >&2
  exit 1
fi
if ! node_supported "$NODE_BIN"; then
  echo "error: unsupported Node at $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || true))" >&2
  exit 1
fi
export DSCODE_E2E_NODE_BIN="$NODE_BIN"
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ -n "${CARGO:-}" ]]; then
  CARGO_BIN="$CARGO"
elif command -v cargo >/dev/null 2>&1; then
  CARGO_BIN="$(command -v cargo)"
elif [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
else
  CARGO_BIN=""
fi
if [[ -n "$CARGO_BIN" ]]; then
  export PATH="$(dirname "$CARGO_BIN"):$PATH"
fi

if [[ -n "$CARGO_BIN" && "$FULL" == 1 ]]; then
  if [[ -n "${DSCODE_E2E_RUST_TOOLCHAIN:-}" ]]; then
    export RUSTUP_TOOLCHAIN="$DSCODE_E2E_RUST_TOOLCHAIN"
  else
    RUSTC_BIN="$(dirname "$CARGO_BIN")/rustc"
    rustc_minor=0
    if [[ -x "$RUSTC_BIN" ]]; then
      rustc_minor="$($RUSTC_BIN --version | awk '{print $2}' | cut -d. -f2)"
    fi
    if [[ "$rustc_minor" -lt 91 ]] \
        && command -v rustup >/dev/null 2>&1 \
        && rustup run 1.94.0 rustc --version >/dev/null 2>&1; then
      export RUSTUP_TOOLCHAIN=1.94.0
    fi
  fi
fi

echo "dscode product E2E"
echo "  host: $(uname -s)-$(uname -m)"
echo "  node: $($NODE_BIN --version)"
if [[ -n "$CARGO_BIN" ]]; then
  echo "  rust: $($(dirname "$CARGO_BIN")/rustc --version 2>/dev/null || echo unknown)"
fi
echo "  full PTY: $FULL"
echo "  provider UI: $PROVIDER_UI"

echo
echo "[1/5] packaging and platform contracts"
bash "$ROOT/scripts/check.sh"

if [[ "$FULL" == 1 ]]; then
  if [[ -z "$CARGO_BIN" ]]; then
    echo "error: --full requires cargo" >&2
    exit 1
  fi
  echo
  echo "[2/5] building the current TUI"
  CARGO="$CARGO_BIN" bash "$ROOT/scripts/build-deepseek-tui.sh"
else
  echo
  echo "[2/5] TUI build skipped (pass --full to rebuild)"
fi

echo
echo "[3/5] launcher, compiled CLI, and bridge socket E2E"
(
  cd "$BRIDGE"
  dscode_pnpm install --frozen-lockfile
  "$NODE_BIN" node_modules/typescript/bin/tsc -b tsconfig.json
  DSCODE_TUI_BIN="$TUI_BIN" "$NODE_BIN" node_modules/vitest/vitest.mjs run
)

echo
echo "[4/5] Rust CLI metadata and slash-command contracts"
if [[ -n "$CARGO_BIN" ]]; then
  "$CARGO_BIN" test --manifest-path "$PAGER_MANIFEST" to_meta_
  "$CARGO_BIN" test --manifest-path "$PAGER_MANIFEST" unsupported_dsh_extension_commands_are_hard_hidden
else
  echo "  skipped: cargo is unavailable"
fi

if [[ "$FULL" == 1 ]]; then
  echo
  echo "[5/5] real headless/TUI + dsh profile + bridge E2E"
  DSCODE_TUI_BIN="$TUI_BIN" bash "$ROOT/scripts/e2e-tui-bridge.sh"
else
  echo
  echo "[5/5] PTY E2E skipped (pass --full to run)"
fi

if [[ "$PROVIDER_UI" == 1 ]]; then
  if ! command -v tmux >/dev/null 2>&1; then
    echo "error: --provider-ui requires tmux" >&2
    exit 1
  fi
  echo
  echo "[provider] real TUI + bridge + mock gateway add/edit/delete E2E"
  bash "$ROOT/scripts/e2e-provider-manage.sh"
fi

echo
echo "PASS dscode product E2E"
