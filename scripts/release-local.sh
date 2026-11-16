#!/usr/bin/env bash
# A usable local build of jin, separate from the checkout you develop in:
#   ~/.jin/release/app     this repo at its current commit, with a production web build
#   ~/Applications/jin.app the desktop window; it starts the daemon (7317) and web (3917)
#                          from the release when they are not running
# Rerun it to update: it rebuilds, restarts jin's services and reopens the app.
# Needs Bun, Node and the hutch toolchain (HUTCH_HOME, default ~/.jin/toolchain/hutch).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
JIN_HOME=${JIN_HOME:-$HOME/.jin}
DEST=$JIN_HOME/release/app
export HUTCH_HOME=${HUTCH_HOME:-$JIN_HOME/toolchain/hutch}
HUTCH=$HUTCH_HOME/bin/hutch
SHA=$(git -C "$REPO" rev-parse HEAD)
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

[ -x "$HUTCH" ] || { echo "hutch not found at $HUTCH (set HUTCH_HOME)"; exit 1; }
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes are not included; building $(git -C "$REPO" rev-parse --short HEAD)"
fi

say "jin $(git -C "$REPO" rev-parse --short HEAD) → $DEST"
mkdir -p "$(dirname "$DEST")"
[ -d "$DEST/.git" ] || git clone -q --no-local "$REPO" "$DEST"
git -C "$DEST" fetch -q "$REPO" "$SHA"
git -C "$DEST" checkout -q --detach "$SHA"

say "dependencies"
(cd "$DEST" && bun install --silent)

say "web app (production build)"
(cd "$DEST/apps/web" && bun run build >/dev/null)

say "desktop app"
(cd "$DEST/apps/desktop" && "$HUTCH" electrobun build --env=stable >/dev/null)
APP=$(find "$DEST/apps/desktop/build" -maxdepth 2 -name "*.app" -type d | grep -i stable | head -1)
[ -n "$APP" ] || { echo "the desktop build produced no .app"; exit 1; }

say "restarting jin's services"
osascript -e 'quit app "jin"' >/dev/null 2>&1 || true
if [ -f "$JIN_HOME/daemon.json" ]; then kill "$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$JIN_HOME/daemon.json")" 2>/dev/null || true; fi
for pid in $(lsof -tiTCP:3917 -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 40); do lsof -tiTCP:7317 -sTCP:LISTEN >/dev/null 2>&1 || lsof -tiTCP:3917 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.25; done

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/jin.app"
cp -R "$APP" "$HOME/Applications/jin.app"
echo "$SHA" > "$JIN_HOME/release/VERSION"
say "installed ~/Applications/jin.app; opening it"
open "$HOME/Applications/jin.app"
