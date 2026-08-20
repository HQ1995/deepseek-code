#!/usr/bin/env bash
# Fast dual-platform smoke: script syntax, asset names, checksum/uid helpers.
# Runs on Linux x86_64 and macOS arm64 (CI matrix). Does not compile the TUI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=platform.sh
source "$ROOT/scripts/platform.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "host: $(uname -s)-$(uname -m)"

for f in "$ROOT"/scripts/*.sh; do
  bash -n "$f" || fail "bash -n $f"
done
echo "  bash -n ok"

repo_version="$(tr -d '[:space:]' < "$ROOT/VERSION")"
package_version="$(node -p "require('$ROOT/bridge/grok-leader/package.json').version")"
[[ "$repo_version" == "$package_version" ]] \
  || fail "VERSION ($repo_version) != bridge package version ($package_version)"
echo "  version sources agree: $repo_version"

asset="$(dscode_prebuilt_asset)"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64)
    [[ "$asset" == dscode-linux-x86_64 ]] || fail "expected linux x86_64 asset, got '$asset'"
    ;;
  Darwin-arm64|Darwin-aarch64)
    [[ "$asset" == dscode-macos-aarch64 ]] || fail "expected macos aarch64 asset, got '$asset'"
    ;;
  *)
    echo "  no prebuilt for this host (source build); required assets still ${DSCODE_REQUIRED_ASSETS[*]}"
    ;;
esac
[[ ${#DSCODE_REQUIRED_ASSETS[@]} -eq 2 ]] || fail "DSCODE_REQUIRED_ASSETS must list both platforms"
echo "  prebuilt asset: ${asset:-none}"

tmp="$(mktemp)"
printf 'hello\n' >"$tmp"
hash="$(dscode_file_sha256 "$tmp")"
[[ "$hash" =~ ^[0-9a-f]{64}$ ]] || fail "sha256 helper returned '$hash'"
dscode_write_sha256 "$tmp" "$tmp.sha256"
grep -q "$hash" "$tmp.sha256" || fail "checksum file missing hash"
uid="$(dscode_file_uid "$tmp")"
[[ "$uid" == "$(id -u)" ]] || fail "uid helper returned '$uid'"
rm -f "$tmp" "$tmp.sha256"
echo "  sha256/uid helpers ok"

# Bash 3.2 (macOS /bin/bash) + set -u: never expand an empty array with [@].
HOST_FILES=()
gh_files=(licenses plugin.tgz)
if [[ ${#HOST_FILES[@]} -gt 0 ]]; then
  gh_files=("${HOST_FILES[@]}" "${gh_files[@]}")
fi
[[ ${#gh_files[@]} -eq 2 ]] || fail "empty HOST_FILES concat broke on this bash"
echo "  bash array concat ok"

echo "PASS scripts/check.sh"
