#!/usr/bin/env bash
# Publish the dscode dsh plugin to npm, pinned to an EXISTING GitHub release
# (the launcher downloads that release's TUI binary on first run).
#
# Usage:
#   scripts/publish-npm.sh --otp 123456          # pin = repo VERSION file
#   scripts/publish-npm.sh --otp 123456 --pin 0.0.5
#
# The npm account requires 2FA, so --otp (or a granular automation token in
# the npm config) is needed. scripts/release.sh calls this after publishing
# the GitHub release; NPM_OTP env works there.
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
if ! curl -fsIL "https://github.com/HQ1995/deepseek-code/releases/download/v$PIN/dscode-linux-x86_64" >/dev/null; then
  echo "error: release v$PIN has no dscode-linux-x86_64 asset; the launcher pin would 404" >&2
  exit 1
fi

( cd "$ROOT/bridge/grok-leader" && pnpm install --silent && pnpm run --silent build )
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
( cd "$stage" && npm publish --access public ${OTP:+--otp="$OTP"} )
echo "published: npm view dscode version -> $(npm view dscode version)"
