#!/usr/bin/env bash
# Deploy this checkout's committed daemon to a machine jin set up (default: d-jin.exe.xyz) and
# restart it there, without rebuilding the app. For working on the daemon against the hub.
#   scripts/deploy-machine.sh [ssh-host]
set -euo pipefail

HOST=${1:-d-jin.exe.xyz}
REPO=$(cd "$(dirname "$0")/.." && pwd)
# JIN_REF: deploy another commit than HEAD (a snapshot of uncommitted work, to try it).
REF=${JIN_REF:-HEAD}
SHA=$(git -C "$REPO" rev-parse --short "$REF")
if [ -z "${JIN_REF:-}" ] && [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no -- apps/daemon package.json bun.lock)" ]; then
  echo "note: uncommitted daemon changes are not deployed; deploying $SHA"
fi
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

echo "==> jin $SHA → $HOST"
git -C "$REPO" archive --format=tar "$REF" -- package.json bun.lock tsconfig.base.json apps/daemon |
  "${SSH[@]}" "set -e; export PATH=\"\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH\"
    rm -rf ~/.jin/app.new && mkdir -p ~/.jin/app.new && tar -x -C ~/.jin/app.new
    echo $SHA > ~/.jin/app.new/VERSION
    cd ~/.jin/app.new && bun install --production 2>&1 | tail -1
    rm -rf ~/.jin/app && mv ~/.jin/app.new ~/.jin/app"

echo "==> restarting jin there"
"${SSH[@]}" 'export PATH="$HOME/.bun/bin:$PATH"; [ -n "${XDG_RUNTIME_DIR:-}" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  if systemctl --user show-environment >/dev/null 2>&1; then systemctl --user restart jin-daemon; else
    pkill -f "$HOME/.jin/app/apps/daemon/src/main.ts" || true; sleep 1
    nohup "$(command -v bun)" "$HOME/.jin/app/apps/daemon/src/main.ts" > ~/.jin/daemon.log 2>&1 < /dev/null &
  fi
  for i in $(seq 1 40); do curl -sf http://127.0.0.1:7317/health >/dev/null && break; sleep 0.5; done
  curl -sf http://127.0.0.1:7317/health >/dev/null && echo "jin answering on $(hostname)" || { echo "jin did not come back; journalctl --user -u jin-daemon"; exit 1; }'
