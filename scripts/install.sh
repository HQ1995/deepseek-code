#!/usr/bin/env bash
# Install one validated product/runtime/plugin tuple. With no release selection,
# build this checkout; an unpublished VERSION is never looked up on GitHub.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/platform.sh"
PROFILE="${DSCODE_HOME:-${DSH_HOME:-$HOME/.dsh}/profiles/dscode}"
VERSION="$(cat "$ROOT/VERSION")"
release_args=()
local_install=1
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      echo "Usage: scripts/install.sh [--version VERSION] [--stable|--beta|--alpha|--enterprise]"
      echo "No selection builds checkout VERSION. DSCODE_HOME/DSH_HOME select the profile."
      echo "DSCODE_RELEASE_DIR supplies prebuilt checkout payloads; DSCODE_SOURCE_DIR and"
      echo "DSCODE_RUNTIME_CONSUMER select the pinned source and source-built SDK consumer."
      exit 0 ;;
  esac
done
if [[ $# -gt 0 ]]; then release_args=("$@"); local_install=0; fi
if [[ -n "${DSC_CHANNEL:-}" ]]; then
  release_args+=("--$DSC_CHANNEL"); local_install=0
fi
if [[ -n "${DEEPSEEK_CODE_TUI_RELEASE:-}" ]]; then
  echo "note: DEEPSEEK_CODE_TUI_RELEASE now selects the entire exact release tuple, not only the TUI" >&2
  release_args+=(--version "$DEEPSEEK_CODE_TUI_RELEASE"); local_install=0
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'const a=process.versions.node.split(".").map(Number); process.exit(a[0]>22 || (a[0]===22 && (a[1]>19 || (a[1]===19 && a[2]>=0))) ? 0 : 1)'; then
  echo "error: node >=22.19.0 is required; install it first" >&2; exit 1
fi
ASSET="$(dscode_prebuilt_asset)"
[[ -n "$ASSET" ]] || { echo "error: source-built runtime payloads support Linux x86_64 and macOS arm64 only" >&2; exit 1; }
# Keep local file URLs alive after installation. Never overwrite an artifact
# directory referenced by an already installed profile manifest.
stage="$(mktemp -d "${TMPDIR:-/tmp}/dscode-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
payload="${DSCODE_RELEASE_DIR:-}"
if [[ -z "$payload" ]]; then
  if [[ "$local_install" == 1 ]]; then
    cache="${XDG_CACHE_HOME:-$HOME/.cache}/dscode/releases"
    mkdir -p "$cache"
    payload="$(mktemp -d "$cache/checkout.XXXXXX")"
  else
    payload="$stage/payload"
  fi
  build_args=(--version "$VERSION" --out "$payload")
  [[ -z "${DSCODE_SOURCE_DIR:-}" ]] || build_args+=(--source "$DSCODE_SOURCE_DIR")
  [[ -z "${DSCODE_RUNTIME_CONSUMER:-}" ]] || build_args+=(--consumer "$DSCODE_RUNTIME_CONSUMER")
  [[ "$local_install" == 1 ]] || build_args+=(--plugin-only)
  node "$ROOT/scripts/build-release-payload.mjs" "${build_args[@]}"
  if [[ "$local_install" == 1 ]]; then
    build_target="${CARGO_TARGET_DIR:-$ROOT/third_party/grok-build/target}"
    [[ "$build_target" = /* ]] || build_target="$ROOT/third_party/grok-build/$build_target"
    CARGO_TARGET_DIR="$build_target" GROK_VERSION="$VERSION" bash "$ROOT/scripts/build-deepseek-tui.sh"
    cp "$build_target/release/dscode" "$payload/$ASSET"
    dscode_write_sha256 "$payload/$ASSET" "$payload/$ASSET.sha256"
  fi
fi
# The packed helper carries its ordinary dependency closure. Importing it does
# not require installing this checkout's unpublished SDK versions from npm.
node --input-type=module - "$payload/dscode-plugin.tgz" <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const archive = process.argv[2];
const expected = readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected) throw new Error('bootstrap plugin checksum mismatch');
NODE
mkdir -p "$stage/helper"
tar -xzf "$payload/dscode-plugin.tgz" -C "$stage/helper"
node --input-type=module - "$ROOT" "$PROFILE" "$VERSION" "$ASSET" "$payload" "$stage/helper/package" "$local_install" "${release_args[@]}" <<'NODE'
import { readFileSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [root, profileArg, checkoutVersion, asset, payload, helper, local, ...args] = process.argv.slice(2);
const profile = resolve(profileArg);
const { installRelease, resolveRelease, updateOptions } = await import(pathToFileURL(join(helper, 'bin/update.mjs')));
const { releaseChannel } = await import(pathToFileURL(join(root, 'scripts/build-release-payload.mjs')));
const packageName = JSON.parse(readFileSync(join(root, 'bridge/grok-leader/package.json'), 'utf8')).name;
// Only installation selections are meaningful here, not update/check modes.
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version') { i++; continue; }
  if (!/^--(?:stable|beta|alpha|enterprise)$/.test(args[i]) && !args[i].startsWith('--version=')) throw new Error(`unsupported install argument: ${args[i]}; use --version and/or a release lane`);
}
const options = local === '1' ? { version: checkoutVersion, channel: releaseChannel(checkoutVersion) } : updateOptions(args, profile, checkoutVersion);
const version = local === '1' ? checkoutVersion : await resolveRelease(options);
const localOptions = local === '1' ? {
  base: pathToFileURL(resolve(payload)).href.replace(/\/$/, ''),
  fetcher: async url => {
    try { return new Response(readFileSync(fileURLToPath(url))); }
    catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
  },
} : {};
await installRelease({ profile, packageName, version, channel: options.channel, asset, ...localOptions });
const launcher = join(profile, 'node_modules', ...packageName.split('/'), 'bin/dscode.mjs');
const link = join(process.env.HOME, '.local/bin/dscode');
try {
let existing;
try { existing = lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const owned = !existing || (existing.isSymbolicLink() && [launcher, join(profile, 'bin/dscode'), join(root, 'bin/dscode'), join(root, 'third_party/grok-build/target/release/dscode')].includes(resolve(join(link, '..'), readlinkSync(link))));
if (owned) {
  mkdirSync(join(process.env.HOME, '.local/bin'), { recursive: true });
  const temporary = `${link}.install-${process.pid}`;
  try { symlinkSync(launcher, temporary); renameSync(temporary, link); }
  finally { rmSync(temporary, { force: true }); }
} else console.error(`warning: ${link} is not owned by this installation; leaving it alone`);
} catch (error) {
  console.error(`warning: installed tuple is ready, but could not repair ${link}: ${error.message}`);
}
console.log(`Installed ${version} (${options.channel}) at ${profile}.`);
console.log(`Run with the same profile environment: ${launcher}`);
NODE
