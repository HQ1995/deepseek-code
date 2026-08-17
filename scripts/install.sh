#!/usr/bin/env bash
# deepseek-code installer: the official @deepseek-ai/dsh CLI from npm, the
# grok-leader bridge as an out-of-tree plugin in the deepseek-leader profile,
# the prebuilt grok TUI into this repo tree, and launchers into ~/.local/bin.
# The deepseek-harness submodule is dev/upgrade-only and never required.
#
# Known gap: published dsh 0.1.0-rc.6 lacks the EMFILE/ENOSPC watch-capacity
# fix carried by the fork (upstream PR planned); watch-driven hot reload can
# degrade under heavy watch pressure until it lands upstream.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The prebuilt TUI is unchanged by harness migrations, so it keeps its own
# release tag rather than tracking the repo release.
TUI_RELEASE="${DEEPSEEK_CODE_TUI_RELEASE:-v0.0.4}"

echo "deepseek-code installer"
echo "  repo: $ROOT"

# Toolchain gates: node ^22.19.0 || >=24.0.0, npm beside it, and pnpm (the
# official dsh plugin command forwards to pnpm). Fail with a clear message
# instead of an opaque pnpm failure deep in the plugin step.
node_version="$(node -p 'process.version.slice(1)' 2>/dev/null || true)"
if [[ -z "$node_version" ]]; then
  echo "error: node is required (^22.19.0 || >=24.0.0); install it first" >&2
  exit 1
fi
node_major="$(echo "$node_version" | cut -d. -f1)"
node_minor="$(echo "$node_version" | cut -d. -f2)"
if ! { [[ "$node_major" == 22 && "$node_minor" -ge 19 ]] || [[ "$node_major" -ge 24 ]]; }; then
  echo "error: node ^22.19.0 || >=24.0.0 required, found $node_version" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required alongside node" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required by 'dsh plugin'; enable it with: corepack enable" >&2
  exit 1
fi

# Official dsh CLI. The launcher prefers this global binary and falls back to
# npx on demand, so a failed global install is a warning, not a stop.
DSH_BIN="$(npm prefix -g)/bin/dsh"
if npm install -g @deepseek-ai/dsh@next >/dev/null; then
  echo "  installed @deepseek-ai/dsh@next ($("$DSH_BIN" --version))"
else
  echo "  warning: 'npm install -g @deepseek-ai/dsh@next' failed; the launcher will use: npx --yes @deepseek-ai/dsh" >&2
fi
if [[ -x "$DSH_BIN" ]]; then
  DSH_RUN=("$DSH_BIN")
else
  DSH_RUN=(npx --yes @deepseek-ai/dsh)
fi

# Build the bridge against its pinned npm peers, then install it as a plugin
# into the deepseek-leader profile. The official CLI initializes the profile
# with the dsh-base bundle and reconciles the bridge's cordis.patch.yml layer.
echo "  building the grok-leader bridge..."
( cd "$ROOT/bridge/grok-leader" && pnpm install && pnpm run build )
echo "  installing the bridge into the deepseek-leader profile..."
"${DSH_RUN[@]}" plugin --profile deepseek-leader add "file:$ROOT/bridge/grok-leader"

# Prebuilt TUI binary into the repo tree.
mkdir -p "$ROOT/third_party/grok-build/target/release"
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  if [[ -x "$ROOT/third_party/grok-build/target/release/dscode" ]]; then
    echo "  prebuilt dscode already present; verifying its SHA-256 before use"
    case "$TUI_RELEASE" in
      v0.0.4) expected_sha256='70e2541281b1f4afdab7d0d18cc2ceaf192d822370004cfee5b2fc4120a1f11f' ;;
      *) expected_sha256='' ;;
    esac
    if [[ -n "$expected_sha256" ]] && ! command -v sha256sum >/dev/null 2>&1; then
      echo "error: sha256sum is required to verify the prebuilt dscode" >&2
      exit 1
    fi
    if [[ -n "$expected_sha256" ]]; then
      actual_sha256="$(sha256sum "$ROOT/third_party/grok-build/target/release/dscode" | cut -d' ' -f1)"
      if [[ "$actual_sha256" == "$expected_sha256" ]]; then
        echo "  prebuilt dscode verified"
      else
        echo "  prebuilt dscode differs from the pinned release (got $actual_sha256); re-downloading $TUI_RELEASE"
        rm -f "$ROOT/third_party/grok-build/target/release/dscode"
        echo "  downloading prebuilt dscode ($TUI_RELEASE)..."
        curl -fL -o "$ROOT/third_party/grok-build/target/release/dscode" \
          "https://github.com/HQ1995/deepseek-code/releases/download/$TUI_RELEASE/dscode-linux-x86_64"
        actual_sha256="$(sha256sum "$ROOT/third_party/grok-build/target/release/dscode" | cut -d' ' -f1)"
        if [[ "$actual_sha256" != "$expected_sha256" ]]; then
          echo "error: downloaded dscode failed its SHA-256 check (got $actual_sha256)" >&2
          exit 1
        fi
      fi
    fi
    chmod +x "$ROOT/third_party/grok-build/target/release/dscode"
  else
    echo "  downloading prebuilt dscode ($TUI_RELEASE)..."
    curl -fL -o "$ROOT/third_party/grok-build/target/release/dscode" \
      "https://github.com/HQ1995/deepseek-code/releases/download/$TUI_RELEASE/dscode-linux-x86_64"
    # SHA-256 pin for THIS release; update the pin whenever TUI_RELEASE bumps.
    case "$TUI_RELEASE" in
      v0.0.4) expected_sha256='70e2541281b1f4afdab7d0d18cc2ceaf192d822370004cfee5b2fc4120a1f11f' ;;
      *) expected_sha256='' ;;
    esac
    actual_sha256="$(sha256sum "$ROOT/third_party/grok-build/target/release/dscode" | cut -d' ' -f1)"
    if [[ -n "$expected_sha256" && "$actual_sha256" != "$expected_sha256" ]]; then
      rm -f "$ROOT/third_party/grok-build/target/release/dscode"
      echo "error: downloaded dscode failed its SHA-256 check (got $actual_sha256)" >&2
      exit 1
    fi
    chmod +x "$ROOT/third_party/grok-build/target/release/dscode"
  fi
else
  echo "  no prebuilt binary for this platform; building TUI with cargo (takes minutes)..."
  ( cd "$ROOT/third_party/grok-build" && cargo build --release -p xai-grok-pager-bin )
fi

# Launchers. dscode links DIRECTLY to the prebuilt TUI binary - it bootstraps
# the dsh leader itself (no shell wrapper). dsh is linked only when no working
# dsh is reachable on PATH (the official CLI usually owns that name); a foreign
# regular file is left alone.
mkdir -p "$HOME/.local/bin"
dscode_link="$HOME/.local/bin/dscode"
if [[ -e "$dscode_link" && ! -L "$dscode_link" ]]; then
  echo "  warning: $dscode_link exists and is not a symlink; leaving it alone" >&2
elif [[ -L "$dscode_link" ]]; then
  target="$(readlink "$dscode_link" 2>/dev/null || true)"
  if [[ "$target" == "$ROOT/third_party/grok-build/target/release/dscode" ]]; then
    ln -sf "$ROOT/third_party/grok-build/target/release/dscode" "$dscode_link"
    echo "  linked dscode"
  else
    echo "  warning: $dscode_link points elsewhere ($target); leaving it alone" >&2
  fi
else
  ln -sf "$ROOT/third_party/grok-build/target/release/dscode" "$dscode_link"
  echo "  linked dscode"
fi
if dsh --version >/dev/null 2>&1; then
  echo "  dsh already reachable on PATH; leaving it in place"
elif [[ -e "$HOME/.local/bin/dsh" && ! -L "$HOME/.local/bin/dsh" ]]; then
  echo "  warning: $HOME/.local/bin/dsh exists and is not a symlink; leaving it alone" >&2
else
  ln -sf "$ROOT/bin/dsh" "$HOME/.local/bin/dsh"
  echo "  linked dsh"
fi

echo
echo "done. run: dscode"
echo "  (make sure $HOME/.local/bin is on PATH)"
echo "  note: published dsh 0.1.0-rc.6 lacks the EMFILE/ENOSPC watch-capacity"
echo "  fix carried by the fork; watch-driven hot reload may degrade under load."
