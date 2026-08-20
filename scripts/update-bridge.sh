#!/usr/bin/env bash
# Rebuild the grok-leader bridge and install a packed local copy into the
# dscode profile. The profile may come from npx (registry dependency) or the
# source installer (`file:` dependency); this script changes neither manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE="$ROOT/bridge/grok-leader"
PROFILE="$HOME/.dsh/profiles/dscode"
# shellcheck source=platform.sh
source "$ROOT/scripts/platform.sh"

echo "building the grok-leader bridge..."
( cd "$BRIDGE" && dscode_pnpm install --silent && dscode_pnpm run build )

if [[ ! -d "$PROFILE" ]]; then
  echo "error: profile not found at $PROFILE; run scripts/install.sh first" >&2
  exit 1
fi

command -v npm >/dev/null 2>&1 || {
  echo "error: npm is required to refresh the dscode profile" >&2
  exit 1
}

stage="$(mktemp -d "${TMPDIR:-/tmp}/dscode-bridge.XXXXXX")"
cleanup() {
  find "$stage" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

echo "packing the local bridge..."
( cd "$BRIDGE" && npm pack --silent --pack-destination "$stage" >/dev/null )
archive=""
for candidate in "$stage"/*.tgz; do
  if [[ -f "$candidate" ]]; then
    archive="$candidate"
    break
  fi
done
if [[ -z "$archive" ]]; then
  echo "error: npm pack did not produce a bridge archive" >&2
  exit 1
fi

echo "refreshing the profile copy at $PROFILE..."
installed="$PROFILE/node_modules/@hqzhao95/dscode"
if [[ -e "$installed" || -L "$installed" ]]; then
  find "$installed" -depth -delete
fi
npm install --prefix "$PROFILE" "$archive" \
  --no-save --package-lock=false --legacy-peer-deps --no-audit --no-fund --force

for sentinel in lib/types/index.js bin/dscode.mjs cordis.patch.yml; do
  want="$(dscode_file_sha256 "$BRIDGE/$sentinel")"
  got="$(dscode_file_sha256 "$installed/$sentinel")"
  if [[ "$want" != "$got" ]]; then
    echo "error: the profile copy differs at $sentinel ($got != $want)" >&2
    exit 1
  fi
done
echo "profile bridge, launcher, and composition match the fresh package"

# A live leader keeps the code it loaded at spawn; only a new leader picks
# up this refresh. Never kill it here: it may be serving live TUI sessions.
if pgrep -f "profile dscode" >/dev/null 2>&1; then
  echo "note: a dscode is running on the OLD build."
  echo "      exit every dscode session (the leader exits with its last client),"
  echo "      then start dscode again to spawn a leader on the new build."
fi
