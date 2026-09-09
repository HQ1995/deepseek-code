#!/usr/bin/env bash
# Test a temporary bridge copy against the pinned release SDK.
# Usage: scripts/dev-bridge-tests.sh [--reuse]
# DSCODE_E2E_RELEASE_DIR selects an existing payload; --reuse selects dist/.
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
if [[ "$#" == 1 && "$1" == "--reuse" ]]; then
  REUSE=1
elif [[ "$#" != 0 ]]; then
  echo "usage: scripts/dev-bridge-tests.sh [--reuse]" >&2
  exit 1
fi

# Writable staging even when $TMPDIR points at a read-only tree (sandboxed
# shells, some containers): vitest and dsh write temp files under TMPDIR.
BASE="${DSCODE_DEV_TMPDIR:-${TMPDIR:-/tmp}}"
if ! STAGE="$(mktemp -d "$BASE/dscode-bridge-dev.XXXXXX" 2>/dev/null)"; then
  STAGE="$(mktemp -d /tmp/dscode-bridge-dev.XXXXXX)"
fi
export TMPDIR="$STAGE"
trap 'rm -rf "$STAGE"' EXIT

PAYLOAD="${DSCODE_E2E_RELEASE_DIR:-}"
if [[ -z "$PAYLOAD" && "$REUSE" == 1 && -d "$ROOT/dist" ]]; then
  PAYLOAD="$ROOT/dist"
fi
build_args=(--out "${PAYLOAD:-$STAGE/payload}")
[[ -z "${DSCODE_SOURCE_DIR:-}" ]] || build_args+=(--source "$DSCODE_SOURCE_DIR")
[[ -z "${DSCODE_RUNTIME_CONSUMER:-}" ]] || build_args+=(--consumer "$DSCODE_RUNTIME_CONSUMER")
if [[ -z "$PAYLOAD" ]]; then
  echo "[dev-bridge-tests] building release payload..."
  "$NODE_BIN" "$ROOT/scripts/build-release-payload.mjs" "${build_args[@]}"
  PAYLOAD="$STAGE/payload"
fi
PAYLOAD="$(cd "$PAYLOAD" && pwd)"

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
source "$ROOT/scripts/platform.sh"
ASSET="$(dscode_prebuilt_asset)"
[[ -n "$ASSET" ]] || { echo "error: unsupported runtime platform" >&2; exit 1; }
TGZ="$PAYLOAD/${ASSET/dscode-/dscode-runtime-}.tar.gz"
if [[ ! -f "$TGZ" ]]; then
  echo "no source runtime in $PAYLOAD; building one" >&2
  "$NODE_BIN" "$ROOT/scripts/build-release-payload.mjs" --runtime-only "${build_args[@]}"
fi
tar --no-same-owner -xzf "$TGZ" -C "$RUNTIME"
[[ -f "$RUNTIME/bin/dsh" ]] || { echo "error: runtime tarball has no bin/dsh" >&2; exit 1; }

# Read the extracted descriptor instead of listing and extracting the archive again.
"$NODE_BIN" --input-type=module - "$BRIDGE/package.json" "$RUNTIME/dscode-runtime.json" <<'JS'
import { readFileSync } from 'node:fs';
const [pkg, runtime] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')));
if (runtime.schema !== 1 || runtime.dshVersion !== pkg.dsh.testedVersion || runtime.sourceCommit !== pkg.dsh.sourceCommit
  || runtime.platform !== process.platform || runtime.arch !== process.arch) {
  throw new Error('Runtime payload does not match the checkout SDK pin and host');
}
JS

# The product E2E uses the same layout; never replace the checkout's node_modules.
mkdir -p "$STAGE/bridge/grok-leader"
for entry in src bin tests presets package.json tsconfig.json cordis.patch.yml; do
  cp -R "$BRIDGE/$entry" "$STAGE/bridge/grok-leader/$entry"
done
cp "$ROOT/VERSION" "$STAGE/VERSION"
BRIDGE="$STAGE/bridge/grok-leader"
ln -s "$RUNTIME/node_modules" "$BRIDGE/node_modules"

export DSCODE_E2E_DSH_BIN="$RUNTIME/bin/dsh"
export DSCODE_E2E_PLUGIN_TGZ="$PLUGIN_TGZ"

cd "$BRIDGE"
echo "[dev-bridge-tests] tsc against source-built SDK..."
"$NODE_BIN" "$RUNTIME/node_modules/typescript/bin/tsc" -p tsconfig.json --tsBuildInfoFile "$STAGE/bridge.tsbuildinfo"
echo "[dev-bridge-tests] vitest..."
"$NODE_BIN" "$RUNTIME/node_modules/vitest/vitest.mjs" run --maxWorkers 2
