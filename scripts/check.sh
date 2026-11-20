#!/bin/sh
# Everything that must hold before jin is deployed, and what CI runs: type checks, the daemon's
# tests, and the acceptance suite (which builds the web app and runs the browser smoke checks in
# WebKit). Nothing here deploys, calls Claude or needs a secret: agents are a scripted stand-in.
#   scripts/check.sh
# Needs Bun, Node, Chrome (CHROME_PATH when it is not the macOS default) and Playwright's WebKit
# (node node_modules/playwright-core/cli.js install webkit).
set -e
cd "$(dirname "$0")/.."
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "type checks"
bun run typecheck
bunx tsc -p tests --noEmit
# The desktop app's types come from its devkit, which only a machine that builds the app has.
if [ -d apps/desktop/.hutch ]; then (cd apps/desktop && bun run typecheck:local); else echo "desktop app: skipped (no devkit on this machine)"; fi

step "daemon tests"
bun test apps/daemon

step "acceptance tests and browser smoke checks"
bun test tests/acceptance --timeout 300000

printf '\n\033[1m==> all checks pass\033[0m\n'
