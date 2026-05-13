#!/usr/bin/env bash
# Quant sweep for Gemma 4 26B-A4B + MTP — runs three quants and stashes
# bench JSON + server logs under $DEV_STORAGE/bench/maestro-pilot/quant-sweep-2026-05-13/.
#
# Pre: current `gemma4-26b-a4b-mtp-local` (Q4_K_XL) is the running baseline.
# Post: leaves the XL baseline re-enabled and Granite re-enabled.
set -euo pipefail
OUT=$DEV_STORAGE/bench/maestro-pilot/quant-sweep-2026-05-13
mkdir -p "$OUT"
URL=http://127.0.0.1:8181
MODEL=gemma4-26b-a4b-mtp
BENCH=tools/maestro-bench/bench-maestro.py
TEMPLATES=templates/workloads
PENUMBRA_WORKER=$HOME/Library/LaunchAgents/dev.penumbra.worker.plist

stop_penumbra_worker() {
  if launchctl list | grep -q dev.penumbra.worker; then
    echo "==> unload penumbra worker (no new chain dispatches during bench)"
    launchctl unload "$PENUMBRA_WORKER" || true
    sleep 1
  fi
}

restore_penumbra_worker() {
  if launchctl list | grep -q dev.penumbra.worker; then
    echo "==> penumbra worker already loaded; skip reload"
    return 0
  fi
  echo "==> reload penumbra worker"
  launchctl load "$PENUMBRA_WORKER" || true
}

trap restore_penumbra_worker EXIT
stop_penumbra_worker

wait_healthy() {
  local deadline=$((SECONDS + 180))
  while (( SECONDS < deadline )); do
    if curl -sf "$URL/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "health timeout" >&2
  return 1
}

# Cold prefill at ctx 65536 with the maestro system prompt + tool defs
# can take 5–10 min on first hit and overflow the bench's 600s task
# timeout. Pre-warm with the bench's exact prefix (system + tools) so
# the first real task hits a cached KV prefix.
warmup() {
  echo "==> warmup ($URL)"
  python3 tools/maestro-bench/warmup.py --url "$URL" --model "$MODEL" || true
}

swap_to() {
  local manifest=$1 name=$2 prev=$3
  echo "==> disable $prev"
  llamactl disable "$prev" || true
  sleep 3
  echo "==> apply $name"
  # No --evict: we already disabled prev, so the slot is free. --evict
  # in this CLI takes a target name (e.g. --evict <name>), not a bare flag.
  llamactl apply -f "$manifest"
  wait_healthy
  # give MTP draft head a moment to settle after first health hit
  sleep 5
  warmup
}

run_bench() {
  local tag=$1
  local stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  python3 "$BENCH" \
    --url "$URL" \
    --model "$MODEL" \
    --out "$OUT/${stamp}-${tag}.json"
}

echo "### Control: rerun current XL baseline (re-enable + warmup first)"
llamactl enable gemma4-26b-a4b-mtp-local
wait_healthy
warmup
run_bench q4kxl-control

echo "### Q4_K_M (same footprint as XL)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q4km-local.yaml" \
        gemma4-26b-a4b-mtp-q4km-local \
        gemma4-26b-a4b-mtp-local
run_bench q4km

echo "### Q5_K_M (21 GB)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q5km-local.yaml" \
        gemma4-26b-a4b-mtp-q5km-local \
        gemma4-26b-a4b-mtp-q4km-local
run_bench q5km

echo "### Q8_0 (27 GB) — disabling Granite for RAM headroom"
llamactl disable granite41-8b-long-lived-local || true
sleep 3
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q8-local.yaml" \
        gemma4-26b-a4b-mtp-q8-local \
        gemma4-26b-a4b-mtp-q5km-local
run_bench q8

echo "### Restore: XL baseline + Granite"
llamactl disable gemma4-26b-a4b-mtp-q8-local || true
sleep 3
llamactl enable gemma4-26b-a4b-mtp-local
wait_healthy
llamactl enable granite41-8b-long-lived-local || true

echo "### Done. Results in $OUT"
ls -lh "$OUT"
