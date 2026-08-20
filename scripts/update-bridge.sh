#!/usr/bin/env bash
# Rebuild the grok-leader bridge and force-refresh its copy inside the
# dscode profile.
#
# Why the force-refresh: the profile depends on the bridge as a pnpm `file:`
# dependency, which pnpm materializes as HARD LINKS through its store. tsc
# replaces output files by inode, so after a rebuild the profile keeps
# serving the OLD build, and `pnpm install --force` over an existing
# node_modules does not re-link. Deleting node_modules and reinstalling is
# the sequence that propagates a rebuild; the SHA-256 gate below proves it did.
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

echo "refreshing the profile copy at $PROFILE..."
rm -rf "$PROFILE/node_modules"
( cd "$PROFILE" && dscode_pnpm install --force --silent )

sentinel="lib/types/index.js"
want="$(dscode_file_sha256 "$BRIDGE/$sentinel")"
got="$(dscode_file_sha256 "$PROFILE/node_modules/@hqzhao95/dscode/$sentinel")"
if [[ "$want" != "$got" ]]; then
  echo "error: the profile copy still differs from the fresh build ($got != $want)" >&2
  exit 1
fi
echo "profile copy matches the fresh build"

# A live leader keeps the code it loaded at spawn; only a new leader picks
# up this refresh. Never kill it here: it may be serving live TUI sessions.
if pgrep -f "profile dscode" >/dev/null 2>&1; then
  echo "note: a dscode is running on the OLD build."
  echo "      exit every dscode session (the leader exits with its last client),"
  echo "      then start dscode again to spawn a leader on the new build."
fi
