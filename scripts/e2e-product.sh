#!/usr/bin/env bash
# Product-level dscode E2E matrix. No real model credentials are used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=platform.sh
source "$ROOT/scripts/platform.sh"
BRIDGE="$ROOT/bridge/grok-leader"
TUI_BIN="${DSCODE_TUI_BIN:-$ROOT/third_party/grok-build/target/release/dscode}"
FULL=0
PROVIDER_UI=0
PREBUILT=0

usage() {
  cat <<'EOF'
Usage: scripts/e2e-product.sh [--full | --prebuilt] [--provider-ui]

  default        Portable launcher + bridge + Rust contract suite.
  --full         Build the current TUI and run real headless + PTY dsh/bridge E2E.
  --prebuilt     Run the full matrix with DSCODE_TUI_BIN already built.
  --provider-ui  Run the tmux provider add/edit/delete persistence flow.

The suite uses isolated homes and mock services. It never calls a paid model.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --prebuilt) FULL=1; PREBUILT=1 ;;
    --provider-ui) PROVIDER_UI=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "${DSCODE_E2E_NODE_BIN:-}" ]]; then
  NODE_BIN="$DSCODE_E2E_NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "error: Node >=22.19.0 is required" >&2
  exit 1
fi
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || { echo "error: pinned dsh requires Node >=22.19.0 (got $($NODE_BIN --version))" >&2; exit 1; }
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

if [[ -n "$CARGO_BIN" ]]; then
  if [[ -n "${DSCODE_E2E_RUST_TOOLCHAIN:-}" ]]; then
    export RUSTUP_TOOLCHAIN="$DSCODE_E2E_RUST_TOOLCHAIN"
  elif [[ -z "${RUSTUP_TOOLCHAIN:-}" ]]; then
    RUSTC_BIN="$(dirname "$CARGO_BIN")/rustc"
    rustc_minor=0
    if [[ -x "$RUSTC_BIN" ]]; then
      rustc_minor="$(cd "$ROOT/third_party/grok-build" && "$RUSTC_BIN" --version | awk '{print $2}' | cut -d. -f2)"
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
  echo "  rust: $(cd "$ROOT/third_party/grok-build" && "$(dirname "$CARGO_BIN")/rustc" --version 2>/dev/null || echo unknown)"
fi
echo "  full PTY: $FULL"
echo "  provider UI: $PROVIDER_UI"

echo
echo "[1/5] packaging and platform contracts"
bash "$ROOT/scripts/check.sh"

if [[ "$FULL" == 1 && "$PREBUILT" == 0 ]]; then
  if [[ -z "$CARGO_BIN" ]]; then
    echo "error: --full requires cargo" >&2
    exit 1
  fi
  echo
  echo "[2/5] building the current TUI"
  CARGO="$CARGO_BIN" bash "$ROOT/scripts/build-deepseek-tui.sh"
elif [[ "$PREBUILT" == 1 ]]; then
  [[ -x "$TUI_BIN" ]] || { echo "error: prebuilt TUI is missing: $TUI_BIN" >&2; exit 1; }
  echo "[2/5] using prebuilt current TUI: $TUI_BIN"
else
  echo
  echo "[2/5] TUI build skipped (pass --full to rebuild)"
fi

echo
echo "[3/5] launcher, compiled CLI, and bridge socket E2E"
if [[ -n "$("$NODE_BIN" -p "require('$BRIDGE/package.json').dsh?.sourceCommit || ''")" ]]; then
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dscode-product-e2e.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  RELEASE_DIR="${DSCODE_RELEASE_DIR:-$STAGE/assets}"
  PLATFORM="$("$NODE_BIN" -p "({'linux/x64':'linux-x86_64','darwin/arm64':'macos-aarch64'})[process.platform+'/'+process.arch] || ''")"
  [[ -n "$PLATFORM" ]] || { echo "error: unsupported runtime platform" >&2; exit 1; }
  if [[ -z "${DSCODE_RELEASE_DIR:-}" ]]; then
    BUILD_ARGS=(--out "$RELEASE_DIR" --version "$(cat "$ROOT/VERSION")")
    [[ -z "${DSCODE_SOURCE_DIR:-}" ]] || BUILD_ARGS+=(--source "$DSCODE_SOURCE_DIR")
    [[ -z "${DSCODE_RUNTIME_CONSUMER:-}" ]] || BUILD_ARGS+=(--consumer "$DSCODE_RUNTIME_CONSUMER")
    "$NODE_BIN" "$ROOT/scripts/build-release-payload.mjs" "${BUILD_ARGS[@]}"
  fi
  mkdir -p "$STAGE/runtime" "$STAGE/bridge/grok-leader"
  tar -xzf "$RELEASE_DIR/dscode-runtime-$PLATFORM.tar.gz" -C "$STAGE/runtime"
  for entry in src bin tests presets package.json tsconfig.json cordis.patch.yml; do
    cp -R "$BRIDGE/$entry" "$STAGE/bridge/grok-leader/$entry"
  done
  cp "$ROOT/VERSION" "$STAGE/VERSION"
  ln -s "$STAGE/runtime/node_modules" "$STAGE/bridge/grok-leader/node_modules"
  export DSCODE_E2E_DSH_BIN="${DSCODE_E2E_DSH_BIN:-$STAGE/runtime/bin/dsh}"
  export DSCODE_E2E_PLUGIN_TGZ="${DSCODE_E2E_PLUGIN_TGZ:-$RELEASE_DIR/dscode-plugin.tgz}"
  (
    cd "$STAGE/bridge/grok-leader"
    "$NODE_BIN" node_modules/typescript/bin/tsc -p tsconfig.json --tsBuildInfoFile "$STAGE/bridge.tsbuildinfo"
    DSCODE_TUI_BIN="$TUI_BIN" "$NODE_BIN" node_modules/vitest/vitest.mjs run
  )
else
  (
    cd "$BRIDGE"
    dscode_pnpm install --frozen-lockfile
    "$NODE_BIN" node_modules/typescript/bin/tsc -b tsconfig.json
    DSCODE_TUI_BIN="$TUI_BIN" "$NODE_BIN" node_modules/vitest/vitest.mjs run
  )
fi

echo
echo "[4/5] Rust CLI metadata and slash-command contracts"
if [[ -n "$CARGO_BIN" ]]; then
  (
    cd "$ROOT/third_party/grok-build"
    "$CARGO_BIN" test -p xai-grok-pager to_meta_
    "$CARGO_BIN" test -p xai-grok-pager unsupported_dsh_extension_commands_are_hard_hidden
  )
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
