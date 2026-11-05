#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12)){throw Error("Use Node 22.12+ for the pinned Workers test tools")}'
npm --prefix cloudflare-backup ci --no-audit --no-fund
bash .codex/test.sh
