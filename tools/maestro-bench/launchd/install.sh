#!/usr/bin/env bash
# Install the maestro server as a per-user launchd agent. Copies the
# plist to ~/Library/LaunchAgents/ and loads it. Survives login but
# not reboots without re-loading on next login (per-user agents auto-load
# at user-session start).
#
# Bootstrap (idempotent):
#   bash tools/maestro-bench/launchd/install.sh
#
# Verify:
#   launchctl list | grep maestro-gemma4
#   curl -s http://127.0.0.1:8181/health
#
# Uninstall:
#   bash tools/maestro-bench/launchd/uninstall.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_NAME="dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist"
SRC="$SCRIPT_DIR/$PLIST_NAME"
DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LABEL="${PLIST_NAME%.plist}"

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 2; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/llamactl"
cp "$SRC" "$DST"
echo "wrote $DST"

# Unload first if already loaded (idempotency).
if launchctl list | grep -q "$LABEL"; then
  launchctl unload "$DST" 2>/dev/null || true
  sleep 1
fi
launchctl load -w "$DST"
echo "loaded $LABEL"

echo "==> waiting for /health"
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8181/health 2>/dev/null | grep -q "^200$"; then
    echo "/health 200 after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "still not healthy after 60s; check logs:" >&2
echo "  tail -50 /Volumes/WorkSSD/logs/maestro-gemma4-26b-a4b-mtp.err.log" >&2
exit 1
