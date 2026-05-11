#!/usr/bin/env bash
# Unload + remove the daily regression-sweep launchd job.
set -euo pipefail

PLIST_NAME="dev.llamactl.maestro-regression-sweep.plist"
DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [[ -f "$DST" ]]; then
  launchctl unload "$DST" 2>/dev/null || true
  rm -f "$DST"
  echo "removed $DST"
else
  echo "no plist at $DST — already gone"
fi
