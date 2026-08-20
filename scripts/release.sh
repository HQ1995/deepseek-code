#!/usr/bin/env bash
# Cut a deepseek-code release from the repo VERSION file (the single version
# source): build the TUI with the exact tag version compiled in, checksum it,
# tag, and publish to GitHub Releases.
#
# Channels are encoded in the version itself:
#   0.0.5         -> stable release (marked latest; /releases/latest serves it)
#   0.0.6-beta.1  -> beta prerelease (only the beta channel resolves it)
#
# Usage:
#   scripts/release.sh            # release $(cat VERSION)
#   scripts/release.sh --dry-run  # build + checksum only, no tag/publish
#
# Consumers of the published artifacts:
#   - scripts/install.sh / npx launcher (dscode-linux-x86_64 + dscode-macos-aarch64)
#   - dscode update (xai-grok-update install_dscode_release)
#
# This script can run on Linux or macOS. It attaches the *native* TUI
# binary when cargo is available, creates the GitHub release, and waits for
# CI (.github/workflows/release.yml) to upload the other platform before
# publishing npm. Do not hardcode one OS as the asset name: a Darwin binary
# shipped as dscode-linux-x86_64 would break Linux installs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=platform.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform.sh"
RELEASE_REPO="HQ1995/deepseek-code"
HOST_ASSET="$(dscode_prebuilt_asset)"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
TAG="v$VERSION"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "error: VERSION file is not semver: '$VERSION'" >&2
  exit 1
fi
PRERELEASE_FLAGS=(--latest)
[[ "$VERSION" == *-* ]] && PRERELEASE_FLAGS=(--prerelease)

if [[ "$DRY_RUN" == 0 ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "error: the gh CLI is required to publish releases" >&2
    exit 1
  fi
  if git -C "$ROOT" rev-parse "$TAG" >/dev/null 2>&1; then
    echo "error: tag $TAG already exists; bump VERSION first" >&2
    exit 1
  fi
  if gh release view "$TAG" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
    echo "error: release $TAG already exists on $RELEASE_REPO" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "error: the working tree is dirty; commit or stash before releasing" >&2
    exit 1
  fi
fi

echo "releasing deepseek-code $TAG"
DIST="$ROOT/dist"
mkdir -p "$DIST"
HOST_FILES=()

if [[ -n "$HOST_ASSET" ]] && command -v cargo >/dev/null 2>&1; then
  echo "  building native TUI ($HOST_ASSET) with GROK_VERSION=$VERSION..."
  GROK_VERSION="$VERSION" bash "$ROOT/scripts/build-deepseek-tui.sh"
  BIN="$ROOT/third_party/grok-build/target/release/dscode"
  banner="$("$BIN" --version)"
  if [[ "$banner" != *"$VERSION"* ]]; then
    echo "error: built binary reports '$banner', expected it to carry $VERSION" >&2
    exit 1
  fi
  echo "  binary: $banner"
  cp "$BIN" "$DIST/$HOST_ASSET"
  dscode_write_sha256 "$DIST/$HOST_ASSET" "$DIST/$HOST_ASSET.sha256"
  echo "  $(cat "$DIST/$HOST_ASSET.sha256")"
  HOST_FILES=("$DIST/$HOST_ASSET" "$DIST/$HOST_ASSET.sha256")
elif [[ -n "$HOST_ASSET" ]]; then
  echo "  no cargo on PATH; CI will publish $HOST_ASSET"
else
  echo "  no prebuilt TUI for $(uname -s)-$(uname -m); CI publishes Linux x86_64 and macOS arm64"
fi

# Apache-2.0 §4: a binary distribution must carry the license and NOTICE.
# Bundle the repo notices plus the vendored grok-build license and its
# §4(b) modification ledger so every release asset set is self-contained.
LICENSES="$DIST/dscode-licenses.tar.gz"
stage="$(mktemp -d)"
mkdir -p "$stage/dscode-licenses/third_party/grok-build"
cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/THIRD_PARTY_NOTICES.md" "$stage/dscode-licenses/"
cp "$ROOT/third_party/grok-build/LICENSE" \
   "$ROOT/third_party/grok-build/TUI-DIVERGENCE.md" \
   "$stage/dscode-licenses/third_party/grok-build/"
tar -czf "$LICENSES" -C "$stage" dscode-licenses
rm -rf "$stage"
echo "  bundled $(basename "$LICENSES")"

# dscode-plugin.tgz: the repo's dsh plugin (grok-leader bridge + dscode
# launcher), release-pinned via package.json dscode.release so the launcher
# materializes exactly this release's binary. Plugin-native install:
#   dsh plugin --profile dscode add \
#     https://github.com/HQ1995/deepseek-code/releases/latest/download/dscode-plugin.tgz
echo "  building the plugin tarball..."
( cd "$ROOT/bridge/grok-leader" && pnpm install --silent && pnpm run --silent build )
plugin_stage="$(mktemp -d)"
cp -r "$ROOT/bridge/grok-leader/lib" "$ROOT/bridge/grok-leader/src" \
      "$ROOT/bridge/grok-leader/bin" "$plugin_stage/"
cp "$ROOT/bridge/grok-leader/cordis.patch.yml" "$plugin_stage/"
python3 - "$ROOT/bridge/grok-leader/package.json" "$plugin_stage/package.json" "$VERSION" <<'PY'
import json, sys
pkg = json.load(open(sys.argv[1]))
pkg["dscode"] = {"release": sys.argv[3]}
json.dump(pkg, open(sys.argv[2], "w"), indent=2)
PY
( cd "$plugin_stage" && npm pack --silent --pack-destination "$DIST" >/dev/null )
mv "$DIST"/hqzhao95-dscode-*.tgz "$DIST/dscode-plugin.tgz"
rm -rf "$plugin_stage"
echo "  bundled dscode-plugin.tgz (pinned to $VERSION)"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "dry run: artifacts staged in $DIST; no tag or release created"
  exit 0
fi

git -C "$ROOT" tag -a "$TAG" -m "deepseek-code $TAG"
git -C "$ROOT" push origin "$TAG"
# Bash 3.2 (macOS /bin/bash) treats "${empty[@]}" as unbound under set -u.
gh_files=("$LICENSES" "$DIST/dscode-plugin.tgz")
if [[ ${#HOST_FILES[@]} -gt 0 ]]; then
  gh_files=("${HOST_FILES[@]}" "${gh_files[@]}")
fi
gh release create "$TAG" \
  --repo "$RELEASE_REPO" \
  --title "deepseek-code $TAG" \
  --notes "deepseek-code $TAG (channel: $([[ "$VERSION" == *-* ]] && echo beta || echo stable))

Prebuilt TUI: Linux x86_64 (\`dscode-linux-x86_64\`) and macOS Apple Silicon (\`dscode-macos-aarch64\`).

License and attribution for this binary: dscode-licenses.tar.gz (Apache-2.0; includes the vendored grok-build license and modification ledger)." \
  "${PRERELEASE_FLAGS[@]}" \
  "${gh_files[@]}"
echo "published $TAG"

echo "  waiting for CI to attach ${DSCODE_REQUIRED_ASSETS[*]}..."
deadline=$((SECONDS + 2400))
for asset in "${DSCODE_REQUIRED_ASSETS[@]}"; do
  while ! curl -fsIL "https://github.com/$RELEASE_REPO/releases/download/$TAG/$asset" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "error: timed out waiting for $asset on $TAG" >&2
      echo "  inspect: gh run list --repo $RELEASE_REPO --branch $TAG" >&2
      echo "  then: scripts/publish-npm.sh --pin $VERSION" >&2
      exit 1
    fi
    echo "    still waiting for $asset..."
    sleep 20
  done
  echo "    $asset ready"
done

# npm: dscode@$VERSION pinned to this release. The npm account requires 2FA;
# pass NPM_OTP or run scripts/publish-npm.sh manually afterwards.
if bash "$ROOT/scripts/publish-npm.sh" --pin "$VERSION"; then
  echo "published dscode@$VERSION to npm"
else
  echo "warning: npm publish failed (2FA?); run: scripts/publish-npm.sh --otp <code> --pin $VERSION" >&2
fi
