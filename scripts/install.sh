#!/usr/bin/env bash
# deepseek-code installer: the official @deepseek-ai/dsh CLI from npm, the
# grok-leader bridge as an out-of-tree plugin in the dscode profile,
# the prebuilt grok TUI into this repo tree, and launchers into ~/.local/bin.
#
# Known gap: the pinned npm dsh may still lack the EMFILE/ENOSPC watch-capacity
# and persistent-bash-prompt fixes; watch-driven hot reload can degrade under
# heavy watch pressure and persistent bash sessions may fall back to
# idle-silence timeouts until they land upstream.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=platform.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform.sh"
# The prebuilt TUI is unchanged by harness migrations, so it keeps its own
# release tag rather than tracking the repo release.
TUI_RELEASE="${DEEPSEEK_CODE_TUI_RELEASE:-v0.0.4}"

echo "deepseek-code installer"
echo "  repo: $ROOT"

# Toolchain gates: node ^22.19.0 || >=24.0.0, npm beside it, and pnpm (the
# official dsh plugin command forwards to pnpm). Fail with a clear message
# instead of an opaque pnpm failure deep in the plugin step.
node_version="$(node -p 'process.version.slice(1)' 2>/dev/null || true)"
if [[ -z "$node_version" ]]; then
  echo "error: node is required (^22.19.0 || >=24.0.0); install it first" >&2
  exit 1
fi
node_major="$(echo "$node_version" | cut -d. -f1)"
node_minor="$(echo "$node_version" | cut -d. -f2)"
if ! { [[ "$node_major" == 22 && "$node_minor" -ge 19 ]] || [[ "$node_major" -ge 24 ]]; }; then
  echo "error: node ^22.19.0 || >=24.0.0 required, found $node_version" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required alongside node" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required by 'dsh plugin'; enable it with: corepack enable" >&2
  exit 1
fi

# dsh is pinned to the exact version this dscode release was tested against.
# Bump it deliberately in bridge/grok-leader/package.json (dsh.testedVersion)
# and re-run the full bridge/e2e suite before releasing.
DSH_VERSION="$(node -p "require('$ROOT/bridge/grok-leader/package.json').dsh.testedVersion")"
if [[ -z "$DSH_VERSION" ]]; then
  echo "error: dsh.testedVersion is missing in bridge/grok-leader/package.json" >&2
  exit 1
fi

# Source installs never mutate the user's global npm prefix. Use an existing
# tested dsh or the exact npx pin for the one-time profile operation.
if command -v dsh >/dev/null 2>&1; then
  installed_dsh_version="$(dsh --version 2>/dev/null | head -1 || true)"
  if [[ "$installed_dsh_version" == "$DSH_VERSION" ]]; then
    DSH_RUN=(dsh)
  else
    DSH_RUN=(npx --yes "@deepseek-ai/dsh@$DSH_VERSION")
  fi
else
  DSH_RUN=(npx --yes "@deepseek-ai/dsh@$DSH_VERSION")
fi

# The dsh profile used by the TUI leader.
PROFILE_NAME="dscode"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE_NAME"

# Build the bridge against its pinned npm peers, then install it as a plugin
# into the dscode profile. The official CLI initializes the profile
# with the dsh-base bundle and reconciles the bridge's cordis.patch.yml layer.
echo "  building the grok-leader bridge..."
( cd "$ROOT/bridge/grok-leader" && dscode_pnpm install && dscode_pnpm run build )
echo "  installing the bridge into the $PROFILE_NAME profile..."
"${DSH_RUN[@]}" plugin --profile "$PROFILE_NAME" add "file:$ROOT/bridge/grok-leader"
# pnpm materializes the file: dependency as hard links through its store, so
# on a RE-install over an existing profile the copy keeps serving the build
# that was current when it was first linked (tsc replaces inodes). Rebuild
# the copy from scratch so re-running this installer picks up the current
# bridge; scripts/update-bridge.sh is the standalone form of this step.
profile_dir="$PROFILE_DIR"
if [[ -d "$profile_dir/node_modules" ]]; then
  rm -rf "$profile_dir/node_modules"
  ( cd "$profile_dir" && dscode_pnpm install --force )
fi

# Prebuilt TUI binary into the repo tree. The release channel picks which
# GitHub release serves it: stable resolves /releases/latest (never a
# prerelease); beta resolves the newest tag by semver INCLUDING prereleases.
# DEEPSEEK_CODE_TUI_RELEASE pins an exact tag and skips channel resolution;
# the baked-in pin is the offline fallback when the release API is
# unreachable.
mkdir -p "$ROOT/third_party/grok-build/target/release"
DSC_CHANNEL="${DSC_CHANNEL:-stable}"
RELEASE_REPO="HQ1995/deepseek-code"
RELEASE_API="https://api.github.com/repos/$RELEASE_REPO/releases"
BIN_PATH="$ROOT/third_party/grok-build/target/release/dscode"
ASSET="$(dscode_prebuilt_asset)"

resolve_release_tag() {
  case "$DSC_CHANNEL" in
    stable)
      curl -fsSL "$RELEASE_API/latest" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null || true
      ;;
    beta)
      curl -fsSL "$RELEASE_API?per_page=100" 2>/dev/null | python3 -c '
import json, re, sys
def key(tag):
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", tag)
    if not m:
        return None
    # A plain release outranks a prerelease of the same x.y.z (semver).
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4) is None, m.group(4) or "")
tags = [r["tag_name"] for r in json.load(sys.stdin) if not r.get("draft")]
keyed = sorted((key(t), t) for t in tags if key(t))
print(keyed[-1][1] if keyed else "")' 2>/dev/null || true
      ;;
    *)
      echo "error: DSC_CHANNEL must be stable or beta (got $DSC_CHANNEL)" >&2
      exit 1
      ;;
  esac
}

if [[ -z "${DEEPSEEK_CODE_TUI_RELEASE:-}" ]]; then
  resolved_tag="$(resolve_release_tag)"
  if [[ -n "$resolved_tag" ]]; then
    TUI_RELEASE="$resolved_tag"
    echo "  channel $DSC_CHANNEL resolved to $TUI_RELEASE"
  else
    echo "  release API unreachable; falling back to pinned $TUI_RELEASE"
  fi
fi

# The expected SHA-256 for the release binary: the .sha256 release asset
# (published by scripts/release.sh from v0.0.5 on), else the baked-in pin
# for older releases. Empty means no digest is available.
expected_dscode_sha256() {
  local from_asset
  from_asset="$(curl -fsSL "https://github.com/$RELEASE_REPO/releases/download/$TUI_RELEASE/$ASSET.sha256" 2>/dev/null | cut -d' ' -f1 || true)"
  if [[ "$from_asset" =~ ^[0-9a-f]{64}$ ]]; then
    echo "$from_asset"
    return
  fi
  case "$TUI_RELEASE" in
    v0.0.4) echo '70e2541281b1f4afdab7d0d18cc2ceaf192d822370004cfee5b2fc4120a1f11f' ;;
    *) echo '' ;;
  esac
}

verify_or_fail() { # $1 = expected sha (may be empty), exits on mismatch
  if [[ -z "$1" ]]; then
    echo "  warning: no checksum published for $TUI_RELEASE; skipping verification" >&2
    return 0
  fi
  local actual
  actual="$(dscode_file_sha256 "$BIN_PATH")"
  if [[ "$actual" != "$1" ]]; then
    rm -f "$BIN_PATH"
    echo "error: dscode failed its SHA-256 check for $TUI_RELEASE (got $actual, want $1)" >&2
    exit 1
  fi
}

download_dscode() {
  echo "  downloading prebuilt dscode ($TUI_RELEASE)..."
  curl -fL -o "$BIN_PATH" \
    "https://github.com/$RELEASE_REPO/releases/download/$TUI_RELEASE/$ASSET"
}

if [[ -n "$ASSET" ]]; then
  expected_sha="$(expected_dscode_sha256)"
  if [[ -x "$BIN_PATH" && -n "$expected_sha" ]]; then
    echo "  prebuilt dscode already present; verifying its SHA-256 before use"
    actual_sha="$(dscode_file_sha256 "$BIN_PATH")"
    if [[ "$actual_sha" == "$expected_sha" ]]; then
      echo "  prebuilt dscode verified"
    else
      echo "  prebuilt dscode differs from $TUI_RELEASE (got $actual_sha); re-downloading"
      rm -f "$BIN_PATH"
      download_dscode
      verify_or_fail "$expected_sha"
    fi
  elif [[ ! -x "$BIN_PATH" ]]; then
    download_dscode
    verify_or_fail "$expected_sha"
  fi
  chmod +x "$BIN_PATH"
else
  echo "  no prebuilt binary for this platform; building TUI with cargo (takes minutes)..."
  ( cd "$ROOT/third_party/grok-build" && cargo build --release -p xai-grok-pager-bin )
fi

# Launchers. dscode links DIRECTLY to the prebuilt TUI binary - it bootstraps
# the dsh leader itself (no shell wrapper). dsh is linked only when no working
# dsh is reachable on PATH (the official CLI usually owns that name); a foreign
# regular file is left alone.
mkdir -p "$HOME/.local/bin"
dscode_link="$HOME/.local/bin/dscode"
if [[ -e "$dscode_link" && ! -L "$dscode_link" ]]; then
  echo "  warning: $dscode_link exists and is not a symlink; leaving it alone" >&2
elif [[ -L "$dscode_link" ]]; then
  target="$(readlink "$dscode_link" 2>/dev/null || true)"
  if [[ "$target" == "$ROOT/third_party/grok-build/target/release/dscode" ]]; then
    ln -sf "$ROOT/third_party/grok-build/target/release/dscode" "$dscode_link"
    echo "  linked dscode"
  else
    echo "  warning: $dscode_link points elsewhere ($target); leaving it alone" >&2
  fi
else
  ln -sf "$ROOT/third_party/grok-build/target/release/dscode" "$dscode_link"
  echo "  linked dscode"
fi
if dsh --version >/dev/null 2>&1; then
  echo "  dsh already reachable on PATH; leaving it in place"
elif [[ -e "$HOME/.local/bin/dsh" && ! -L "$HOME/.local/bin/dsh" ]]; then
  echo "  warning: $HOME/.local/bin/dsh exists and is not a symlink; leaving it alone" >&2
else
  ln -sf "$ROOT/bin/dsh" "$HOME/.local/bin/dsh"
  echo "  linked dsh"
fi

echo
echo "done. run: dscode"
echo "  (make sure $HOME/.local/bin is on PATH)"
echo "  note: the pinned npm dsh may still lack the EMFILE/ENOSPC watch-capacity"
echo "  and persistent-bash-prompt fixes; watch-driven hot reload may degrade"
echo "  under load and persistent bash may use idle timeouts."
