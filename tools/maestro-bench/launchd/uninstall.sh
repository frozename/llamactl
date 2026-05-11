#!/usr/bin/env bash
# Unload and remove the per-user launchd agent for the maestro server.
set -euo pipefail

PLIST_NAME="dev.llamactl.maestro-gemma4-26b-a4b-mtp.plist"
DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LABEL="${PLIST_NAME%.plist}"

if [[ -f "$DST" ]]; then
  launchctl unload "$DST" 2>/dev/null || true
  rm -f "$DST"
  echo "removed $DST"
else
  echo "no plist at $DST — already gone"
fi

# Belt-and-braces: kill any stray binary still listening on the port.
for pid in $(lsof -nP -iTCP:8181 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u); do
  echo "killing residual pid $pid on :8181"
  kill -TERM "$pid" 2>/dev/null || true
done
