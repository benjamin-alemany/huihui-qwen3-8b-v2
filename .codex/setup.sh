#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${NODE_OPTIONS:-}" || -n "${NODE_PATH:-}" ]]; then
  printf '%s\n' 'Refusing inherited Node preload settings. Use a clean environment.' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
node .codex/preflight.mjs
# Download locked registry packages without executing their lifecycle hooks.
# Use a disposable environment without credential mounts for installation.
setup_tmp_dir=$(mktemp -d)
trap 'rm -rf "$setup_tmp_dir"' EXIT
touch "$setup_tmp_dir/npmrc"
npm --prefix cloudflare-backup ci --ignore-scripts --no-audit --no-fund --userconfig=/dev/null --globalconfig="$setup_tmp_dir/npmrc" --cache="$setup_tmp_dir/cache"
printf '%s\n' 'Dependencies installed without lifecycle scripts. Run bash .codex/test.sh separately; tests require OS network isolation.'
