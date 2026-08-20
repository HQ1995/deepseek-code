#!/usr/bin/env bash
# deepseek-code uninstaller: remove the launcher links, the dscode
# profile (bridge plugin), and optionally the official dsh CLI. Everything it
# deletes is guarded by an identity check so a same-named foreign file or
# directory is never touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=platform.sh
source "$(cd "$(dirname "$0")" && pwd)/platform.sh"
PROFILE="$HOME/.dsh/profiles/dscode"
FLAG="${1:-}"

note() { echo "  $1"; }

# 1. Launcher symlinks that point into this repo. dscode links straight to the
# prebuilt TUI binary; the $ROOT/bin/dscode target is accepted too so setups
# installed by the pre-selfcontained installer still clean up.
dscode_link="$HOME/.local/bin/dscode"
if [[ -L "$dscode_link" ]]; then
  target="$(readlink "$dscode_link" 2>/dev/null || true)"
  if [[ "$target" == "$ROOT/third_party/grok-build/target/release/dscode" \
      || "$target" == "$ROOT/bin/dscode" \
      || "$target" == *"/.dsh/profiles/dscode/node_modules/"*"/bin/dscode.mjs" ]]; then
    unlink "$dscode_link"
    echo "  removed $dscode_link"
  else
    note "kept $dscode_link (points elsewhere: $target)"
  fi
elif [[ -e "$dscode_link" ]]; then
  note "kept $dscode_link (not our symlink)"
fi
for name in dsh; do
  link="$HOME/.local/bin/$name"
  if [[ -L "$link" ]]; then
    target="$(readlink "$link" 2>/dev/null || true)"
    if [[ "$target" == "$ROOT/bin/$name" ]]; then
      unlink "$link"
      echo "  removed $link"
    else
      note "kept $link (points elsewhere: $target)"
    fi
  elif [[ -e "$link" ]]; then
    note "kept $link (not our symlink)"
  fi
done

# 2. The dscode profile — only when it is actually ours (its package.json
#    must declare the grok-leader bridge).
if [[ -d "$PROFILE" ]]; then
  if grep -qE '"(@hqzhao95/dscode|dscode|@deepseek-ai/dsh-grok-leader)"' "$PROFILE/package.json" 2>/dev/null; then
    rm -rf "$PROFILE"
    echo "  removed $PROFILE"
  else
    note "kept $PROFILE (no grok-leader bridge declared; not ours)"
  fi
else
  note "no profile at $PROFILE"
fi

# 3. Leftover TUI home from before it lived inside the profile
#    (~/.dsh/profiles/dscode, removed with the profile above).
legacy_tui="$HOME/.dsh/dsc-tui"
custom_home="${DSCODE_HOME:-${DSC_HOME:-}}"
if [[ -n "$custom_home" && -d "$custom_home" && "$(dscode_file_uid "$custom_home" 2>/dev/null || true)" == "$UID" ]]; then
  rm -rf "$custom_home"
  echo "  removed $custom_home"
elif [[ -d "$legacy_tui" && ! -L "$legacy_tui" && "$(dscode_file_uid "$legacy_tui" 2>/dev/null || true)" == "$UID" ]]; then
  rm -rf "$legacy_tui"
  echo "  removed $legacy_tui"
fi

# 4. The official dsh CLI, only with --remove-dsh (it is the upstream
#    package, not deepseek-code's own artifact).
if [[ "$FLAG" == "--remove-dsh" ]] && command -v npm >/dev/null 2>&1; then
  npm uninstall -g @deepseek-ai/dsh >/dev/null 2>&1 || note "npm uninstall -g @deepseek-ai/dsh failed"
  note "removed the official @deepseek-ai/dsh global package"
fi

echo
echo "kept on purpose:"
echo "  this repository itself ($ROOT) - delete it if you no longer want the source"
echo "  ~/.dsh/sessions and ~/.dsh/storages (owned by dsh, shared with other dsh use)"
echo "  ~/.grok (never touched by dscode: GROK_HOME is overridden to the profile tui/ dir)"
echo "  the official @deepseek-ai/dsh npm package (rerun with --remove-dsh to drop it)"
