#!/usr/bin/env bash
# Build the vendored grok TUI (Apache-2.0); the crate [[bin]] is dscode and lands
# at third_party/grok-build/target/release/dscode. The harness side is
# TypeScript; the TUI is built once and cached. NUMA note: this host pins
# non-SORT work to node 1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/third_party/grok-build"
BIN="$VENDOR/target/release/dscode"

cd "$VENDOR"
numactl --cpunodebind=1 --membind=1 cargo build --release -p xai-grok-pager-bin
echo "built: $BIN"
