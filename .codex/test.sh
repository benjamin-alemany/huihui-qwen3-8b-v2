#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${NODE_OPTIONS:-}" || -n "${NODE_PATH:-}" ]]; then
  printf '%s\n' 'Refusing inherited Node preload settings. Use a clean environment.' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
node .codex/run-tests.mjs
