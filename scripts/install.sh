#!/usr/bin/env bash
# deepseek-code one-line installer: clone, build both sides, link dscode.
set -euo pipefail

DEST="${DEEPSEEK_CODE_HOME:-$HOME/deepseek-code}"
BRANCH="${DEEPSEEK_CODE_BRANCH:-main}"

echo "deepseek-code installer"
echo "  dest:   $DEST"

if [[ ! -d "$DEST/.git" ]]; then
  git clone --depth 1 --branch "$BRANCH" https://github.com/HQ1995/deepseek-code.git "$DEST"
else
  git -C "$DEST" pull --ff-only
fi

echo "  building harness (pnpm)..."
( cd "$DEST" && pnpm install --frozen-lockfile && pnpm run build:lib:host )

echo "  building TUI (cargo, first build takes minutes)..."
( cd "$DEST/third_party/grok-build" && cargo build --release -p xai-grok-pager-bin )

mkdir -p "$HOME/.local/bin"
ln -sf "$DEST/bin/dscode" "$HOME/.local/bin/dscode"

echo
echo "done. run: dscode"
echo "  (make sure $HOME/.local/bin is on PATH)"
