#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../cloudflare-backup"
npm run test:cloud
