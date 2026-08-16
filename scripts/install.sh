#!/usr/bin/env bash
# deepseek-code one-line installer: clone this repo with its deepseek-harness
# submodule, build dsh from the submodule (the EMFILE watch-capacity fix ships
# only in that build), install the grok-leader bridge into the leader profile,
# download the prebuilt TUI, and link the launchers.
set -euo pipefail

DEST="${DEEPSEEK_CODE_HOME:-$HOME/deepseek-code}"
# Pinned release tag. Tracking main is opt-in via DEEPSEEK_CODE_BRANCH=main.
RELEASE="${DEEPSEEK_CODE_RELEASE:-v0.1.0}"
# The prebuilt TUI is unchanged by harness migrations, so it keeps its own
# release tag (v0.0.1) rather than tracking the repo release.
TUI_RELEASE="${DEEPSEEK_CODE_TUI_RELEASE:-v0.0.1}"
BRANCH="${DEEPSEEK_CODE_BRANCH:-}"
REPO="${DEEPSEEK_CODE_REPO:-https://github.com/HQ1995/deepseek-code.git}"

echo "deepseek-code installer"
echo "  dest: $DEST"
echo "  ref: ${BRANCH:-$RELEASE}"

# Toolchain gates: the harness requires node ^22.19.0 || >=24.0.0 and pnpm
# 11.7.0 (its packageManager pin); fail with a clear message instead of an
# opaque pnpm/build failure deep into the submodule install.
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
pnpm_version="$(pnpm -v 2>/dev/null || true)"
pnpm_major="$(echo "$pnpm_version" | cut -d. -f1)"
if [[ -z "$pnpm_version" || "$pnpm_major" -lt 11 ]]; then
  echo "error: pnpm >= 11 required (harness pins 11.7.0), found ${pnpm_version:-none}; enable it with: corepack enable && corepack use pnpm@11.7.0" >&2
  exit 1
fi

# Checkout (or update) with the harness submodule materialized.
if [[ ! -d "$DEST/.git" ]]; then
  REF="$RELEASE"
  [[ -n "$BRANCH" ]] && REF="$BRANCH"
  git clone --depth 1 --branch "$REF" --recurse-submodules --shallow-submodules "$REPO" "$DEST"
else
  git -C "$DEST" fetch --tags --force --prune
  if [[ -n "$BRANCH" ]]; then
    git -C "$DEST" checkout "$BRANCH"
    git -C "$DEST" pull --ff-only
  else
    git -C "$DEST" checkout --detach "$RELEASE"
  fi
  git -C "$DEST" submodule update --init --recursive
fi

# Build dsh from the harness submodule so the launcher runs a binary that
# contains the EMFILE/ENOSPC watch-capacity degradation (npm 0.1.0-rc.6 lacks
# it). This also materializes the packages the bridge's peers resolve to.
echo "  building dsh from deepseek-harness (pnpm; several minutes)..."
( cd "$DEST/deepseek-harness" && pnpm install --frozen-lockfile && pnpm run build:lib:host )

# Build the bridge against the same harness tree, then install it as a plugin
# into the deepseek-leader profile.
echo "  building the grok-leader bridge..."
( cd "$DEST/bridge/grok-leader" && pnpm install && pnpm run build )
echo "  installing the bridge into the deepseek-leader profile..."
"$DEST/bin/dsh" plugin --profile deepseek-leader add "$DEST/bridge/grok-leader"

# Prebuilt TUI binary (unchanged by this migration).
mkdir -p "$DEST/third_party/grok-build/target/release"
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  if [[ -x "$DEST/third_party/grok-build/target/release/dscode" ]]; then
    echo "  prebuilt dscode already present; skipping download"
  else
    echo "  downloading prebuilt dscode ($TUI_RELEASE)..."
    curl -fL -o "$DEST/third_party/grok-build/target/release/dscode" \
      "https://github.com/HQ1995/deepseek-code/releases/download/$TUI_RELEASE/dscode-linux-x86_64"
    chmod +x "$DEST/third_party/grok-build/target/release/dscode"
  fi
else
  echo "  no prebuilt binary for this platform; building TUI with cargo (takes minutes)..."
  ( cd "$DEST/third_party/grok-build" && cargo build --release -p xai-grok-pager-bin )
fi

mkdir -p "$HOME/.local/bin"
ln -sf "$DEST/bin/dscode" "$HOME/.local/bin/dscode"
ln -sf "$DEST/bin/dsh" "$HOME/.local/bin/dsh"

echo
echo "done. run: dscode"
echo "  (make sure $HOME/.local/bin is on PATH)"
