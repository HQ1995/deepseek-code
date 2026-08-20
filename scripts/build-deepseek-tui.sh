#!/usr/bin/env bash
# Build the vendored grok TUI (Apache-2.0); the crate [[bin]] is dscode and lands
# at third_party/grok-build/target/release/dscode. The harness side is
# TypeScript; the TUI is built once and cached. NUMA note: this host pins
# non-SORT work to node 1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/third_party/grok-build"
BIN="$VENDOR/target/release/dscode"

if [[ -n "${CARGO:-}" ]]; then
  CARGO_BIN="$CARGO"
elif command -v cargo >/dev/null 2>&1; then
  CARGO_BIN="$(command -v cargo)"
elif [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
else
  echo "error: cargo is required to build the dscode TUI" >&2
  exit 1
fi

# Single version source: the repo VERSION file. GROK_VERSION feeds both the
# compiled xai_grok_version::VERSION (hero screen, updater comparisons) and
# the --version banner (VERSION_WITH_COMMIT). Dev builds carry a -dev
# prerelease suffix so the updater offers the real release when it lands;
# scripts/release.sh overrides with the exact tag version.
export GROK_VERSION="${GROK_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")-dev}"

cd "$VENDOR"
# NUMA pinning is a this-host policy; CI runners and other machines build plain.
if command -v numactl >/dev/null 2>&1; then
  numactl --cpunodebind=1 --membind=1 "$CARGO_BIN" build --release -p xai-grok-pager-bin
else
  "$CARGO_BIN" build --release -p xai-grok-pager-bin
fi
echo "built: $BIN ($GROK_VERSION)"
