#!/usr/bin/env bash
# Build the vendored grok TUI (Apache-2.0); the crate [[bin]] is dscode and lands
# at third_party/grok-build/target/release/dscode. The harness side is
# TypeScript; the TUI is built once and cached. NUMA note: this host pins
# non-SORT work to node 1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/third_party/grok-build"
BIN="$VENDOR/target/release/dscode"

# Single version source: the repo VERSION file. GROK_VERSION feeds both the
# compiled xai_grok_version::VERSION (hero screen, updater comparisons) and
# the --version banner (VERSION_WITH_COMMIT). Dev builds carry a -dev
# prerelease suffix so the updater offers the real release when it lands;
# scripts/release.sh overrides with the exact tag version.
export GROK_VERSION="${GROK_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")-dev}"

cd "$VENDOR"
# NUMA pinning is a this-host policy; CI runners and other machines build plain.
if command -v numactl >/dev/null 2>&1; then
  numactl --cpunodebind=1 --membind=1 cargo build --release -p xai-grok-pager-bin
else
  cargo build --release -p xai-grok-pager-bin
fi
echo "built: $BIN ($GROK_VERSION)"
