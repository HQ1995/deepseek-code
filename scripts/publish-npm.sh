#!/usr/bin/env bash
# Publish the dscode dsh plugin to npm, pinned to an EXISTING GitHub release
# (the launcher downloads that release's TUI binary on first run).
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
NPM_TAG="latest"
[[ "$PIN" == *-* ]] && NPM_TAG="beta"
# shellcheck source=platform.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform.sh"
missing=()
for asset in "${DSCODE_REQUIRED_ASSETS[@]}"; do
  for required in "$asset" "$asset.sha256" "$asset.gz"; do
    if ! curl -fsIL "https://github.com/HQ1995/deepseek-code/releases/download/v$PIN/$required" >/dev/null; then
      missing+=("$required")
    fi
  done
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: release v$PIN is missing required assets: ${missing[*]}" >&2
  echo "  both raw and compressed platform binaries plus SHA-256 files must exist before npm" >&2
  exit 1
fi

( cd "$ROOT/bridge/grok-leader" && dscode_pnpm install --silent && dscode_pnpm run --silent build )
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r "$ROOT/bridge/grok-leader/lib" "$ROOT/bridge/grok-leader/src" \
      "$ROOT/bridge/grok-leader/bin" "$stage/"
cp "$ROOT/bridge/grok-leader/cordis.patch.yml" "$ROOT/bridge/grok-leader/README.md" "$stage/"
python3 - "$ROOT/bridge/grok-leader/package.json" "$stage/package.json" "$PIN" <<'PY'
import json, sys
pkg = json.load(open(sys.argv[1]))
pkg["version"] = sys.argv[3]
pkg["dscode"] = {"release": sys.argv[3]}
f = open(sys.argv[2], "w"); json.dump(pkg, f, indent=2, ensure_ascii=False); f.write("\n")
PY
( cd "$stage" && npm publish --access public --tag "$NPM_TAG" ${OTP:+--otp="$OTP"} \
    ${NPM_TOKEN:+--//registry.npmjs.org/:_authToken="$NPM_TOKEN"} )
echo "published: npm view @hqzhao95/dscode@$NPM_TAG version -> $(npm view "@hqzhao95/dscode@$NPM_TAG" version)"
