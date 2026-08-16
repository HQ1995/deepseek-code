#!/usr/bin/env bash
# deepseek-code one-line installer: clone the harness, install the prebuilt
# dscode binary, build the (fast) TypeScript side, link dscode.
set -euo pipefail

DEST="${DEEPSEEK_CODE_HOME:-$HOME/deepseek-code}"
BRANCH="${DEEPSEEK_CODE_BRANCH:-main}"
RELEASE="v0.0.1"

echo "deepseek-code installer"
echo "  dest: $DEST"

if [[ ! -d "$DEST/.git" ]]; then
  git clone --depth 1 --branch "$BRANCH" https://github.com/HQ1995/deepseek-code.git "$DEST"
else
  git -C "$DEST" pull --ff-only
fi

echo "  building harness (pnpm, ~1 min)..."
( cd "$DEST" && pnpm install --frozen-lockfile && pnpm run build:lib:host )

mkdir -p "$DEST/third_party/grok-build/target/release"
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  echo "  downloading prebuilt dscode ($RELEASE)..."
  curl -fL -o "$DEST/third_party/grok-build/target/release/dscode" \
    "https://github.com/HQ1995/deepseek-code/releases/download/$RELEASE/dscode-linux-x86_64"
  chmod +x "$DEST/third_party/grok-build/target/release/dscode"
else
  echo "  no prebuilt binary for this platform; building TUI with cargo (takes minutes)..."
  ( cd "$DEST/third_party/grok-build" && cargo build --release -p xai-grok-pager-bin )
fi

mkdir -p "$HOME/.local/bin"
ln -sf "$DEST/bin/dscode" "$HOME/.local/bin/dscode"

echo
echo "done. run: dscode"
echo "  (make sure $HOME/.local/bin is on PATH)"
