#!/usr/bin/env bash
# Runs the Command (backend/hq) tests locally. No network, no paid API.
# Needs: Node 20+, Playwright with Chromium (PLAYWRIGHT_BROWSERS_PATH, default /opt/pw-browsers).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node "$HERE/chat-core-test.mjs"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" NODE_PATH="${NODE_PATH:-$(npm root -g)}" node "$HERE/hq-ui-test.mjs" "$@"
echo "ALL COMMAND TESTS PASSED"
