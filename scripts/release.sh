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
#   - scripts/install.sh (channel resolution + dscode-linux-x86_64.sha256)
#   - dscode update (xai-grok-update install_dscode_release)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_REPO="HQ1995/deepseek-code"
ASSET="dscode-linux-x86_64"
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
echo "  building with GROK_VERSION=$VERSION..."
GROK_VERSION="$VERSION" bash "$ROOT/scripts/build-deepseek-tui.sh"

BIN="$ROOT/third_party/grok-build/target/release/dscode"
banner="$("$BIN" --version)"
if [[ "$banner" != *"$VERSION"* ]]; then
  echo "error: built binary reports '$banner', expected it to carry $VERSION" >&2
  exit 1
fi
echo "  binary: $banner"

DIST="$ROOT/dist"
mkdir -p "$DIST"
cp "$BIN" "$DIST/$ASSET"
( cd "$DIST" && sha256sum "$ASSET" > "$ASSET.sha256" )
echo "  $(cat "$DIST/$ASSET.sha256")"

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
#   dsh plugin --profile deepseek-leader add \
#     https://github.com/HQ1995/deepseek-code/releases/latest/download/dscode-plugin.tgz
echo "  building the plugin tarball..."
( cd "$ROOT/bridge/grok-leader" && DSCODE_SKIP_DOWNLOAD=1 pnpm install --silent && pnpm run --silent build )
plugin_stage="$(mktemp -d)"
cp -r "$ROOT/bridge/grok-leader/lib" "$ROOT/bridge/grok-leader/src" \
      "$ROOT/bridge/grok-leader/bin" "$plugin_stage/"
mkdir -p "$plugin_stage/scripts"
cp "$ROOT/bridge/grok-leader/scripts/postinstall.mjs" "$plugin_stage/scripts/"
cp "$ROOT/bridge/grok-leader/cordis.patch.yml" "$plugin_stage/"
python3 - "$ROOT/bridge/grok-leader/package.json" "$plugin_stage/package.json" "$VERSION" <<'PY'
import json, sys
pkg = json.load(open(sys.argv[1]))
pkg["dscode"] = {"release": sys.argv[3]}
json.dump(pkg, open(sys.argv[2], "w"), indent=2)
PY
( cd "$plugin_stage" && npm pack --silent --pack-destination "$DIST" >/dev/null )
mv "$DIST"/deepseek-ai-dsh-grok-leader-*.tgz "$DIST/dscode-plugin.tgz"
rm -rf "$plugin_stage"
echo "  bundled dscode-plugin.tgz (pinned to $VERSION)"

if [[ "$DRY_RUN" == 1 ]]; then
  echo "dry run: artifacts staged in $DIST; no tag or release created"
  exit 0
fi

git -C "$ROOT" tag -a "$TAG" -m "deepseek-code $TAG"
git -C "$ROOT" push origin "$TAG"
gh release create "$TAG" \
  --repo "$RELEASE_REPO" \
  --title "deepseek-code $TAG" \
  --notes "deepseek-code $TAG (channel: $([[ "$VERSION" == *-* ]] && echo beta || echo stable))

License and attribution for this binary: dscode-licenses.tar.gz (Apache-2.0; includes the vendored grok-build license and modification ledger)." \
  "${PRERELEASE_FLAGS[@]}" \
  "$DIST/$ASSET" "$DIST/$ASSET.sha256" "$LICENSES" "$DIST/dscode-plugin.tgz"
echo "published $TAG"
