#!/usr/bin/env bash
# Build the vendored grok TUI (Apache-2.0) with its binary renamed to `deepseek`.
# The harness side is TypeScript; the TUI is built once from the vendored Rust
# tree and cached. NUMA note: this host pins non-SORT work to node 1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/third_party/grok-build"
OUT="$ROOT/bin/deepseek"

cd "$VENDOR"
exec numactl --cpunodebind=1 --membind=1 cargo build --release -p xai-grok-pager-bin
