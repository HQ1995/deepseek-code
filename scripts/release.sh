#!/usr/bin/env bash
# Cut a deepseek-code release from the repo VERSION file (the single version
# source): verify the host TUI, tag, create the GitHub release, and publish npm.
#
# Channels are encoded in the version itself:
#   0.0.5         -> stable release (marked latest; /releases/latest serves it)
#   0.0.6-beta.1  -> beta prerelease (only the beta channel resolves it)
#   0.0.6-alpha.1 -> independent alpha prerelease (npm alpha)
#
# Usage:
#   scripts/release.sh            # release $(cat VERSION)
#   scripts/release.sh --dry-run  # build + checksum only, no tag/publish
#
# Consumers of the published artifacts:
#   - scripts/install.sh / npx launcher (dscode-linux-x86_64 + dscode-macos-aarch64)
#   - managed dscode update (one exact plugin/TUI/runtime tuple)
#
# This script can run on Linux or macOS. It builds the native TUI as a local
# preflight, creates the draft release with metadata assets, and waits for CI
# (.github/workflows/release.yml) to upload both platforms' required payloads
# before publishing npm. CI is the sole platform-asset uploader so users never see
# mixed files while duplicate uploads are being clobbered.
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
PACKAGE_VERSION="$(node -p "require('$ROOT/bridge/grok-leader/package.json').version")"
if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
  echo "error: VERSION ($VERSION) and bridge package version ($PACKAGE_VERSION) differ" >&2
  exit 1
fi
CHANNEL="$(node "$ROOT/scripts/build-release-payload.mjs" --channel --version "$VERSION")"
PUBLISH_FLAGS=(--latest)
[[ "$CHANNEL" != stable ]] && PUBLISH_FLAGS=(--prerelease)

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
  gzip -9 -c "$DIST/$HOST_ASSET" > "$DIST/$HOST_ASSET.gz"
  echo "  $(cat "$DIST/$HOST_ASSET.sha256")"
  echo "  compressed: $(du -h "$DIST/$HOST_ASSET.gz" | awk '{print $1}')"
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
echo "  building release payloads from the pinned SDK..."
payload_args=(--version "$VERSION" --out "$DIST")
[[ -n "${DSCODE_SOURCE_DIR:-}" ]] && payload_args+=(--source "$DSCODE_SOURCE_DIR")
[[ -n "${DSCODE_RUNTIME_CONSUMER:-}" ]] && payload_args+=(--consumer "$DSCODE_RUNTIME_CONSUMER")
node "$ROOT/scripts/build-release-payload.mjs" "${payload_args[@]}"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "dry run: artifacts staged in $DIST; no tag or release created"
  exit 0
fi

git -C "$ROOT" tag -a "$TAG" -m "deepseek-code $TAG"
git -C "$ROOT" push origin "$TAG"
# CI is the sole owner of platform assets. Concurrent host + CI uploads replace
# the raw, checksum, and gzip files separately and can expose a mixed asset set.
gh_files=("$LICENSES" "$DIST/dscode-plugin.tgz" "$DIST/dscode-plugin.tgz.sha256")
release_args=(
  --repo "$RELEASE_REPO"
  --title "deepseek-code $TAG"
  --draft
  --notes "deepseek-code $TAG (channel: $CHANNEL)

Prebuilt TUI: Linux x86_64 (\`dscode-linux-x86_64\`) and macOS Apple Silicon (\`dscode-macos-aarch64\`).

License and attribution for this binary: dscode-licenses.tar.gz (Apache-2.0; includes the vendored grok-build license and modification ledger)."
)
if [[ "$VERSION" == *-* ]]; then
  release_args+=(--prerelease)
fi
gh release create "$TAG" "${release_args[@]}" "${gh_files[@]}"
echo "created draft release $TAG"

echo "  waiting for CI to attach both platforms' complete release payloads..."
deadline=$((SECONDS + 2400))
while IFS= read -r required; do
    while ! gh release view "$TAG" --repo "$RELEASE_REPO" --json assets --jq '.assets[].name' \
      | grep -Fxq "$required"; do
      if (( SECONDS >= deadline )); then
        echo "error: timed out waiting for $required on draft $TAG" >&2
        echo "  inspect: gh run list --repo $RELEASE_REPO --branch $TAG" >&2
        exit 1
      fi
      echo "    still waiting for $required..."
      sleep 20
    done
    echo "    $required ready"
done < <(node "$ROOT/scripts/build-release-payload.mjs" --assets --version "$VERSION")

gh release edit "$TAG" --repo "$RELEASE_REPO" --draft=false "${PUBLISH_FLAGS[@]}"
echo "published $TAG with complete platform assets"

# npm: dscode@$VERSION pinned to this release. The npm account requires 2FA;
# pass NPM_OTP or run scripts/publish-npm.sh manually afterwards.
if ! bash "$ROOT/scripts/publish-npm.sh" --pin "$VERSION"; then
  echo "error: GitHub release is live but npm publish failed; recover with:" >&2
  echo "  scripts/publish-npm.sh --otp <code> --pin $VERSION" >&2
  exit 1
fi
echo "published dscode@$VERSION to npm"
