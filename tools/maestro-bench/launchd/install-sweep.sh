#!/usr/bin/env bash
# Install the daily regression-sweep as a per-user launchd job.
# Same FDA caveat as install.sh — /bin/bash (and here /usr/bin/python3)
# must have Full Disk Access to read /Volumes/WorkSSD or the job will
# fail to load.
#
# Bootstrap (idempotent):
#   bash tools/maestro-bench/launchd/install-sweep.sh
#
# Trigger one-shot for testing:
#   launchctl kickstart -k gui/$(id -u)/dev.llamactl.maestro-regression-sweep
#
# Uninstall:
#   bash tools/maestro-bench/launchd/uninstall-sweep.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_NAME="dev.llamactl.maestro-regression-sweep.plist"
SRC="$SCRIPT_DIR/$PLIST_NAME"
DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LABEL="${PLIST_NAME%.plist}"

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 2; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/llamactl"
cp "$SRC" "$DST"
echo "wrote $DST"

if launchctl list | grep -q "$LABEL"; then
  launchctl unload "$DST" 2>/dev/null || true
  sleep 1
fi
launchctl load -w "$DST"
echo "loaded $LABEL — will fire at 03:17 local"
