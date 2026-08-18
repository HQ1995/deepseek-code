#!/usr/bin/env bash
# Rebuild the grok-leader bridge and force-refresh its copy inside the
# deepseek-leader profile.
#
# Why the force-refresh: the profile depends on the bridge as a pnpm `file:`
# dependency, which pnpm materializes as HARD LINKS through its store. tsc
# replaces output files by inode, so after a rebuild the profile keeps
# serving the OLD build, and `pnpm install --force` over an existing
# node_modules does not re-link. Deleting node_modules and reinstalling is
# the sequence that propagates a rebuild; the md5 gate below proves it did.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE="$ROOT/bridge/grok-leader"
PROFILE="$HOME/.dsh/profiles/deepseek-leader"

echo "building the grok-leader bridge..."
( cd "$BRIDGE" && pnpm install --silent && pnpm run build )

if [[ ! -d "$PROFILE" ]]; then
  echo "error: profile not found at $PROFILE; run scripts/install.sh first" >&2
  exit 1
fi

echo "refreshing the profile copy at $PROFILE..."
rm -rf "$PROFILE/node_modules"
( cd "$PROFILE" && pnpm install --force --silent )

sentinel="lib/types/index.js"
want="$(md5sum "$BRIDGE/$sentinel" | cut -d' ' -f1)"
got="$(md5sum "$PROFILE/node_modules/dscode/$sentinel" | cut -d' ' -f1)"
if [[ "$want" != "$got" ]]; then
  echo "error: the profile copy still differs from the fresh build ($got != $want)" >&2
  exit 1
fi
echo "profile copy matches the fresh build"

# A live leader keeps the code it loaded at spawn; only a new leader picks
# up this refresh. Never kill it here: it may be serving live TUI sessions.
if pgrep -f "profile deepseek-leader" >/dev/null 2>&1; then
  echo "note: a deepseek-leader is running on the OLD build."
  echo "      exit every dscode session (the leader exits with its last client),"
  echo "      then start dscode again to spawn a leader on the new build."
fi
