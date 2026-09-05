#!/usr/bin/env bash
# Refresh only the local plugin copy; preserve the profile manifest, runtime,
# channel, and live leader. Use install.sh when changing the installed tuple.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSCODE_HOME:-${DSH_HOME:-$HOME/.dsh}/profiles/dscode}"
if [[ $# -ne 0 ]]; then
  echo "Usage: scripts/update-bridge.sh (DSCODE_HOME/DSH_HOME select the profile)" >&2
  exit 1
fi
if [[ ! -d "$PROFILE" ]]; then
  echo "error: profile not found at $PROFILE; run scripts/install.sh first" >&2
  exit 1
fi
# Same filesystem as the active package so the final replacement is a rename.
profile_parent="$(dirname "$PROFILE")"
stage="$(mktemp -d "$profile_parent/.dscode-bridge.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
VERSION="$(cat "$ROOT/VERSION")"
payload="${DSCODE_RELEASE_DIR:-$stage/payload}"
if [[ -z "${DSCODE_RELEASE_DIR:-}" ]]; then
  build_args=(--plugin-only --version "$VERSION" --out "$payload")
  [[ -z "${DSCODE_SOURCE_DIR:-}" ]] || build_args+=(--source "$DSCODE_SOURCE_DIR")
  [[ -z "${DSCODE_RUNTIME_CONSUMER:-}" ]] || build_args+=(--consumer "$DSCODE_RUNTIME_CONSUMER")
  node "$ROOT/scripts/build-release-payload.mjs" "${build_args[@]}"
fi
mkdir -p "$stage/archive"
node --input-type=module - "$PROFILE" "$stage" "$payload" "$VERSION" <<'NODE'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [profileArg, stageArg, payload, version] = process.argv.slice(2);
const profile = resolve(profileArg), stage = resolve(stageArg);
const unpacked = join(stage, 'archive/package');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const archive = join(payload, 'dscode-plugin.tgz');
const expected = readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(expected) || digest(archive) !== expected) throw new Error('local plugin checksum mismatch');
execFileSync('tar', ['-xzf', archive, '-C', join(stage, 'archive')], { stdio: 'inherit' });
const metadata = json(join(unpacked, 'package.json'));
if (metadata.name !== '@hqzhao95/dscode' || metadata.version !== version || metadata.dscode?.release !== version) throw new Error('local plugin must match checkout VERSION');
const { commitInstallation, validateRuntime } = await import(pathToFileURL(join(unpacked, 'bin/update.mjs')));
const entry = join('node_modules', ...metadata.name.split('/'));
const installed = join(profile, entry);
if (!existsSync(join(installed, 'package.json'))) throw new Error('installed plugin not found; run scripts/install.sh first');
const current = json(join(installed, 'package.json'));
if (current.version !== version || current.dscode?.release !== version) throw new Error('checkout VERSION differs from the installed tuple; run scripts/install.sh to install the complete checkout tuple');
try { validateRuntime(join(profile, 'runtime'), metadata); }
catch (error) { throw new Error(`installed runtime is incompatible with this checkout; run scripts/install.sh first: ${error.message}`); }
for (const dependency of Object.keys(metadata.dependencies ?? {})) {
  if (!existsSync(join(unpacked, 'node_modules', ...dependency.split('/'), 'package.json'))) throw new Error(`missing bundled dependency ${dependency}`);
}
const prepared = join(stage, 'profile', entry);
mkdirSync(dirname(prepared), { recursive: true });
cpSync(unpacked, prepared, { recursive: true, verbatimSymlinks: true });
// Compare the prepared installation to the freshly compiled packed output,
// not stale checkout lib/ files (the builder compiles in an isolated tree).
for (const sentinel of ['lib/types/index.js', 'bin/dscode.mjs', 'cordis.patch.yml']) {
  if (digest(join(unpacked, sentinel)) !== digest(join(prepared, sentinel))) throw new Error(`prepared profile copy differs at ${sentinel}`);
}
commitInstallation(profile, stage, [entry]);
console.log('profile bridge, launcher, and composition match the fresh package');
NODE
# A live leader retains its loaded build; never interrupt live sessions.
if pgrep -f 'profile dscode' >/dev/null 2>&1; then
  echo "note: a dscode may be running on the OLD build."
  echo "      exit every dscode session, then restart with the same profile environment."
fi
