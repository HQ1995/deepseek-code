#!/usr/bin/env bash
# Use the same ownership and data-preservation rules as the managed launcher.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/bridge/grok-leader/bin/dscode.mjs" uninstall "$@"
