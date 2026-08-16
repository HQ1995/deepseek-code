#!/usr/bin/env bash
# Selective manual sync of the vendored grok-build TUI.
# Usage: scripts/update-tui.sh [upstream-ref]   (default: upstream HEAD)
# This script only PREPARES the sync; porting is manual by design. It clones
# the upstream release next to our tree, prints the diff summary, then prints
# the rebuild + sync-gate steps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUI="$ROOT/third_party/grok-build"
SCRATCH="$(mktemp -d /tmp/grok-upstream.XXXXXX)"
REF="$1"
if [ -z "$REF" ]; then REF=HEAD; fi
echo "cloning upstream grok-build @ $REF into $SCRATCH"
git clone --depth 1 https://github.com/xai-org/grok-build.git "$SCRATCH/upstream"
git -C "$SCRATCH/upstream" rev-parse HEAD > "$TUI/UPSTREAM_REV.new"
echo "=== upstream baseline ==="
cat "$TUI/UPSTREAM_REV.new"
echo
echo "=== changed paths vs our tree (excluding target/node_modules) ==="
diff -rq --exclude target --exclude node_modules --exclude UPSTREAM_REV --exclude TUI-DIVERGENCE.md "$SCRATCH/upstream" "$TUI" | head -80 || true
echo
echo "Now port selected changes by hand into $TUI. Record the new baseline with:"
echo "  mv $TUI/UPSTREAM_REV.new $TUI/UPSTREAM_REV   (after updating the file's notes)"
echo "  update TUI-DIVERGENCE.md"
echo "Then rebuild and run the sync gate:"
echo "  numactl --cpunodebind=1 --membind=1 cargo build --release"
echo "  fake-leader replay + one real deepseek-v4-flash turn must pass"
echo
echo "scratch upstream kept at: $SCRATCH/upstream"
