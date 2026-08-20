# Shared platform helpers for install/release. Source only; do not execute.
#
# Prebuilt TUI assets follow xai-grok-update detect_platform:
#   dscode-{os}-{arch}   e.g. dscode-linux-x86_64, dscode-macos-aarch64
# A release is not complete until every name in DSCODE_REQUIRED_ASSETS is
# published. Other hosts (Intel Mac, Linux ARM) build from source.

# Assets `npx @hqzhao95/dscode` and `dscode update` expect on every release.
DSCODE_REQUIRED_ASSETS=(dscode-linux-x86_64 dscode-macos-aarch64)

# Run the repo-pinned pnpm through an installed shim or Corepack.
dscode_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    echo "error: pnpm or corepack is required" >&2
    return 1
  fi
}

# The prebuilt name for THIS machine, or empty if we do not ship one.
dscode_prebuilt_asset() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64) echo dscode-linux-x86_64 ;;
    Darwin-arm64|Darwin-aarch64) echo dscode-macos-aarch64 ;;
    *) echo "" ;;
  esac
}

# Hex digest of $1. Prefer sha256sum (Linux / recent macOS), then shasum.
dscode_file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: sha256sum or shasum is required" >&2
    return 1
  fi
}

# Write "$hash  basename" to $2 for file $1 (sha256sum-compatible).
dscode_write_sha256() {
  local file="$1" dest="$2" hash
  hash="$(dscode_file_sha256 "$file")"
  printf '%s  %s\n' "$hash" "$(basename "$file")" >"$dest"
}

# Numeric uid of $1. GNU stat first, BSD stat on macOS.
dscode_file_uid() {
  if stat -c %u "$1" >/dev/null 2>&1; then
    stat -c %u "$1"
  else
    stat -f %u "$1"
  fi
}
