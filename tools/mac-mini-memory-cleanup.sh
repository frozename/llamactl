#!/bin/bash
# Threshold-driven cleanup of macOS background daemons that pile up RAM
# on a 16 GB mac mini running multi-model GPU workloads. Run periodically
# via the matching LaunchAgent (com.llamactl.memory-cleanup.plist).
#
# Below the threshold, we kill the daemon list and log. Daemons respawn
# on demand when actually needed (Photos opening, Spotlight query, Siri
# invocation, etc.), so the kill is operationally safe.
#
# Above the threshold, we log a no-op so the running cadence is visible.

set -euo pipefail

# 130000 pages * 16384 bytes/page ≈ 2.0 GB free.
# Below this, run the kill list.
THRESHOLD_PAGES=${LLAMACTL_MEM_THRESHOLD_PAGES:-130000}

LOG_DIR="${HOME}/.llamactl-launchd-logs"
LOG="${LOG_DIR}/memory-cleanup.log"
mkdir -p "$LOG_DIR"

# Daemons that consistently accumulate RAM on the mac mini and are safe
# to kill (macOS respawns them on demand). Order matters only for log
# readability.
DAEMONS=(
  mediaanalysisd
  photoanalysisd
  photolibraryd
  siriknowledged
  assistantd
  suggestd
  duetexpertd
  routined
  siriactionsd
  corespotlightd
  managedcorespotlightd
  sirittsd
  TextThumbnailExtension
  iconservicesagent
)

get_free_pages() {
  vm_stat | awk '/Pages free/ {gsub(/\./, "", $3); print $3}'
}

ts() { date '+%Y-%m-%d %H:%M:%S'; }

free_before=$(get_free_pages)

if [[ "$free_before" -lt "$THRESHOLD_PAGES" ]]; then
  echo "[$(ts)] free=${free_before} < threshold=${THRESHOLD_PAGES} — running cleanup" >> "$LOG"
  killed=0
  for d in "${DAEMONS[@]}"; do
    if killall -0 "$d" 2>/dev/null; then
      killall "$d" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done
  sleep 1
  free_after=$(get_free_pages)
  gain=$((free_after - free_before))
  echo "[$(ts)] killed=${killed} daemons; pages_free: ${free_before} -> ${free_after} (Δ=${gain})" >> "$LOG"
else
  echo "[$(ts)] free=${free_before} >= threshold=${THRESHOLD_PAGES} — skip" >> "$LOG"
fi
