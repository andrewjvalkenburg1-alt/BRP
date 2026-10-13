#!/usr/bin/env bash
# Runs every agent-kit test locally. No network, no paid API.
# Needs: local Postgres 15+ (run as root so it can su to postgres), Node 20+, Playwright with Chromium.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
DB="${BRP_TEST_DB:-brptest}"
su postgres -c "bash '$BACKEND/test/run-local.sh' '$DB'"
node "$HERE/mcp-test.mjs"
node "$HERE/reply-checker-test.mjs"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" NODE_PATH="${NODE_PATH:-$(npm root -g)}" node "$HERE/admin-panel-test.mjs" "$@"
bash "$BACKEND/hq/test/run.sh"
echo "ALL AGENT KIT AND COMMAND TESTS PASSED"
