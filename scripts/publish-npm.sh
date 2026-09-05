#!/usr/bin/env bash
# Publish the dscode dsh plugin to npm, pinned to an EXISTING GitHub release
# (the launcher installs that release's exact whole-product payload).
#
# Usage:
#   scripts/publish-npm.sh --otp 123456          # pin = repo VERSION file
#   scripts/publish-npm.sh --otp 123456 --pin 0.0.5
#
# Auth: NPM_TOKEN env (a token with publish rights / 2FA bypass) is used
# when set — the user's shell exports it from ~/.zshrc; otherwise --otp (or
# NPM_OTP) supplies the 2FA code for the npm-config login. scripts/release.sh
# calls this after publishing the GitHub release.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OTP="${NPM_OTP:-}"
PIN="$(tr -d '[:space:]' < "$ROOT/VERSION")"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --otp) OTP="$2"; shift 2 ;;
    --pin) PIN="$2"; shift 2 ;;
    *) echo "error: unknown argument $1" >&2; exit 1 ;;
  esac
done

echo "publishing dscode@$PIN to npm (binary pin: v$PIN)"
CHANNEL="$(node "$ROOT/scripts/build-release-payload.mjs" --channel --version "$PIN")"
NPM_TAG="$CHANNEL"
[[ "$CHANNEL" == stable ]] && NPM_TAG=latest
# shellcheck source=platform.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform.sh"

# Publish the already validated release payload, never a registry SDK rebuild.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
base="https://github.com/HQ1995/deepseek-code/releases/download/v$PIN"
curl -fsSL "$base/dscode-plugin.tgz" -o "$stage/dscode-plugin.tgz"
# Historical releases may predate the sidecar. In that case only GitHub's
# canonical digest for this exact tagged release asset can authenticate bytes.
status="$(curl -sSL -w '%{http_code}' "$base/dscode-plugin.tgz.sha256" -o "$stage/dscode-plugin.tgz.sha256")"
case "$status" in
  200) proof=sidecar ;;
  404)
    proof=github
    curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/HQ1995/deepseek-code/releases/tags/v$PIN" -o "$stage/release.json"
    ;;
  *) echo "error: plugin checksum download returned HTTP $status" >&2; exit 1 ;;
esac
node --input-type=module - "$stage" "$PIN" "$proof" <<'JS'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const [stage, pin, proof] = process.argv.slice(2);
let expected;
if (proof === 'sidecar') {
  const match = /^([a-fA-F0-9]{64})\s+\*?dscode-plugin\.tgz\s*$/.exec(fs.readFileSync(`${stage}/dscode-plugin.tgz.sha256`, 'utf8'));
  if (!match) throw new Error('Invalid plugin checksum sidecar');
  expected = match[1].toLowerCase();
} else {
  const release = JSON.parse(fs.readFileSync(`${stage}/release.json`, 'utf8'));
  if (release.tag_name !== `v${pin}` || release.draft) throw new Error('Release identity mismatch');
  const assets = release.assets?.filter(asset => asset.name === 'dscode-plugin.tgz');
  if (assets?.length !== 1 || assets[0].browser_download_url !== `https://github.com/HQ1995/deepseek-code/releases/download/v${pin}/dscode-plugin.tgz`) throw new Error('Canonical plugin asset missing');
  const match = /^sha256:([a-fA-F0-9]{64})$/.exec(assets[0].digest || '');
  if (!match) throw new Error('Canonical plugin asset has no SHA-256 digest');
  expected = match[1].toLowerCase();
}
const actual = createHash('sha256').update(fs.readFileSync(`${stage}/dscode-plugin.tgz`)).digest('hex');
if (actual !== expected) throw new Error('Plugin checksum mismatch');
JS
# Read only the authenticated target manifest; the checkout may describe a
# different release lane or source-runtime generation entirely.
tar -xOf "$stage/dscode-plugin.tgz" package/package.json > "$stage/plugin.json"
node --input-type=module - "$ROOT/scripts/build-release-payload.mjs" "$stage/plugin.json" "$PIN" "$proof" > "$stage/required-assets" <<'JS'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { releaseAssets } = await import(pathToFileURL(process.argv[2]));
const pkg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
if (pkg.name !== '@hqzhao95/dscode' || pkg.version !== process.argv[4] || pkg.dscode?.release !== process.argv[4]) throw new Error('Plugin identity/release pin mismatch');
const sourceCommit = pkg.dsh?.sourceCommit;
if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid source revision');
const required = releaseAssets(sourceCommit).filter(name => name !== 'dscode-plugin.tgz.sha256' || sourceCommit || process.argv[5] === 'sidecar');
console.log(required.join('\n'));
JS
missing=()
while IFS= read -r required; do
  if ! curl -fsIL "$base/$required" >/dev/null; then missing+=("$required"); fi
done < "$stage/required-assets"
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: release v$PIN is missing required assets: ${missing[*]}" >&2
  exit 1
fi
npm publish "$stage/dscode-plugin.tgz" --access public --tag "$NPM_TAG" ${OTP:+--otp="$OTP"} \
    ${NPM_TOKEN:+--//registry.npmjs.org/:_authToken="$NPM_TOKEN"}
echo "published: npm view @hqzhao95/dscode@$NPM_TAG version -> $(npm view "@hqzhao95/dscode@$NPM_TAG" version)"
