#!/usr/bin/env bash
# Local bridge test loop that reproduces the CI "Bridge tests" job exactly
# (.github/workflows/ci.yml): build the pinned source payload (SDK + runtime +
# plugin) — or reuse one via DSCODE_E2E_RELEASE_DIR — extract the source
# runtime, link its node_modules into bridge/grok-leader, then compile with
# `tsc -b` and run vitest against that same source-built SDK.
#
# The 0.1.3-alpha.1 SDK family is not published on npm, so plain `pnpm install
# && pnpm run build && pnpm exec vitest run` cannot satisfy the pin from a
# clone. This script is the local equivalent of the CI job.
#
#   scripts/dev-bridge-tests.sh            payload build (clones upstream if
#                                          no DSCODE_SOURCE_DIR is given)
#   scripts/dev-bridge-tests.sh --reuse    reuse ./dist when it matches VERSION
#   DSCODE_E2E_RELEASE_DIR=... scripts/dev-bridge-tests.sh
#
# Extra payload build controls (same env vars as scripts/e2e-product.sh):
# DSCODE_SOURCE_DIR, DSCODE_RUNTIME_CONSUMER, DSCODE_E2E_NODE_BIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE="$ROOT/bridge/grok-leader"
NODE_BIN="${DSCODE_E2E_NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node >=22.19.0 is required" >&2
  exit 1
fi
"$NODE_BIN" -e 'const a=process.versions.node.split(".").map(Number), b=[22,19,0]; process.exit(a[0]>b[0] || (a[0]===b[0] && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2]))) ? 0 : 1)' \
  || { echo "error: pinned dsh requires Node >=22.19.0 (got $($NODE_BIN --version))" >&2; exit 1; }

REUSE=0
if [[ "${1:-}" == "--reuse" ]]; then REUSE=1; fi

# Writable staging even when $TMPDIR points at a read-only tree (sandboxed
# shells, some containers): vitest and dsh write temp files under TMPDIR.
BASE="${DSCODE_DEV_TMPDIR:-${TMPDIR:-/tmp}}"
if ! STAGE="$(mktemp -d "$BASE/dscode-bridge-dev.XXXXXX" 2>/dev/null)"; then
  STAGE="$(mktemp -d /tmp/dscode-bridge-dev.XXXXXX)"
fi
export TMPDIR="$STAGE"
SAVED_NODE_MODULES=""
RESTORE_LINK=0
restore() {
  if [[ -n "$SAVED_NODE_MODULES" ]]; then
    rm -rf "$BRIDGE/node_modules"
    mv "$SAVED_NODE_MODULES" "$BRIDGE/node_modules"
  elif [[ "$RESTORE_LINK" == 1 ]]; then
    rm -f "$BRIDGE/node_modules"
  fi
  rm -rf "$STAGE"
}
trap restore EXIT

PAYLOAD="${DSCODE_E2E_RELEASE_DIR:-}"
if [[ -z "$PAYLOAD" && "$REUSE" == 1 && -d "$ROOT/dist" ]]; then
  PAYLOAD="$ROOT/dist"
fi
if [[ -z "$PAYLOAD" ]]; then
  echo "[dev-bridge-tests] building release payload..."
  build_args=(--out "$STAGE/payload")
  [[ -z "${DSCODE_SOURCE_DIR:-}" ]] || build_args+=(--source "$DSCODE_SOURCE_DIR")
  [[ -z "${DSCODE_RUNTIME_CONSUMER:-}" ]] || build_args+=(--consumer "$DSCODE_RUNTIME_CONSUMER")
  "$NODE_BIN" "$ROOT/scripts/build-release-payload.mjs" "${build_args[@]}"
  PAYLOAD="$STAGE/payload"
fi

# Validate the plugin payload matches the checkout before consuming it.
PLUGIN_TGZ="$PAYLOAD/dscode-plugin.tgz"
EXPECTED="$(tr -d '[:space:]' < "$ROOT/VERSION")"
ACTUAL="$(tar xOzf "$PLUGIN_TGZ" package/package.json | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  echo "error: payload plugin $ACTUAL != checkout VERSION $EXPECTED; rebuild the payload or point DSCODE_E2E_RELEASE_DIR at a matching one" >&2
  exit 1
fi

RUNTIME="$STAGE/runtime"
mkdir -p "$RUNTIME"
TGZ="$(find "$PAYLOAD" -maxdepth 1 -name 'dscode-runtime-*.tar.gz' | head -1)"
if [[ -z "$TGZ" ]]; then
  echo "no source runtime in $PAYLOAD; building one" >&2
  "$NODE_BIN" "$ROOT/scripts/build-release-payload.mjs" --runtime-only --out "$PAYLOAD"
  TGZ="$(find "$PAYLOAD" -maxdepth 1 -name 'dscode-runtime-*.tar.gz' | head -1)"
fi
tar -xzf "$TGZ" -C "$RUNTIME"
[[ -f "$RUNTIME/bin/dsh" ]] || { echo "error: runtime tarball has no bin/dsh" >&2; exit 1; }

# Runtime tarballs name their members with a ./ prefix ("dscode-runtime.json"
# lives at "./dscode-runtime.json"); locate the real member name so extraction
# works whether or not the prefix exists.
runtime_member() {
  local member="$1"
  tar tzf "$TGZ" | grep -E "(^|/)$member$" | head -1 || true
}
RT_JSON="$(runtime_member dscode-runtime.json)"
if [[ -n "$RT_JSON" ]]; then
  RUNTIME_DSH="$(tar -xOzf "$TGZ" "$RT_JSON" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dshVersion))')"
  TESTED="$(tar -xOzf "$PLUGIN_TGZ" package/package.json 2>/dev/null | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).dsh?.testedVersion||"")}catch{console.log("")}})' || true)"
  if [[ -n "$RUNTIME_DSH" && -n "$TESTED" && "$RUNTIME_DSH" != "$TESTED" ]]; then
    echo "error: runtime dsh $RUNTIME_DSH != plugin dsh.testedVersion $TESTED; payload mismatch" >&2
    exit 1
  fi
fi

# CI links the runtime's node_modules into the bridge before compiling.
# Never clobber a pre-existing real install: move it aside and restore on exit
# (only a fresh git clone has an empty or missing node_modules, in which case
# the runtime link stays in place until the script removes it on exit).
if [[ -e "$BRIDGE/node_modules" && ! -L "$BRIDGE/node_modules" ]]; then
  SAVED_NODE_MODULES="$STAGE/saved-node_modules"
  mv "$BRIDGE/node_modules" "$SAVED_NODE_MODULES"
elif [[ -L "$BRIDGE/node_modules" ]]; then
  rm -f "$BRIDGE/node_modules"
  RESTORE_LINK=1
fi
ln -s "$RUNTIME/node_modules" "$BRIDGE/node_modules"

export DSCODE_E2E_DSH_BIN="$RUNTIME/bin/dsh"
export DSCODE_E2E_PLUGIN_TGZ="$PLUGIN_TGZ"

# CI runs both steps with working-directory: bridge/grok-leader. Doing the same
# here keeps vitest's project root at the bridge (so top-level scripts/ test
# files aren't swept in) instead of scanning the whole checkout.
cd "$BRIDGE"
echo "[dev-bridge-tests] tsc -b against source-built SDK..."
"$NODE_BIN" "$RUNTIME/node_modules/typescript/bin/tsc" -b tsconfig.json
echo "[dev-bridge-tests] vitest..."
"$NODE_BIN" "$RUNTIME/node_modules/vitest/vitest.mjs" run
