#!/usr/bin/env bash
# Re-bench all 7 Gemma 4 26B-A4B quants with the rebuilt atomic fork
# (turboquant-kv-cache b9013) and --cache-reuse 256. The fork commit
# "Gemma 4 time-to-first-token drops from 8-12s to <1s by unblocking
# cache reuse" should restore the prompt-prefix cache that was failing
# silently before, slashing wall time.
#
# Pre: gemma4-26b-a4b-mtp-local (XL) is Running as the current baseline;
# granite41-8b-long-lived-local is Running. Both will be cycled.
# Post: XL baseline + Granite re-enabled, results in $OUT.
set -euo pipefail
OUT=$DEV_STORAGE/bench/maestro-pilot/rebench-2026-05-13
mkdir -p "$OUT"
URL=http://127.0.0.1:8181
MODEL=gemma4-26b-a4b-mtp
BENCH=tools/maestro-bench/bench-maestro.py
TEMPLATES=templates/workloads
PENUMBRA_WORKER=$HOME/Library/LaunchAgents/dev.penumbra.worker.plist

stop_penumbra_worker() {
  if launchctl list | grep -q dev.penumbra.worker; then
    echo "==> unload penumbra worker"
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
  local deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    if curl -sf "$URL/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "health timeout" >&2
  return 1
}

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
  llamactl apply -f "$manifest"
  wait_healthy
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

# Order: cheap → expensive. The Q8 family (27 GB) goes last and needs
# Granite stopped for RAM headroom.
echo "### Baseline rerun: Q4_K_XL with new binary + --cache-reuse"
# XL is currently Running with the OLD args. Disable + re-apply via the
# patched template so it picks up --cache-reuse.
llamactl disable gemma4-26b-a4b-mtp-local || true
sleep 3
llamactl apply -f "$TEMPLATES/gemma4-26b-a4b-mtp-local.yaml"
wait_healthy
sleep 5
warmup
run_bench q4kxl

echo "### MXFP4_MOE (16 GB, novel format)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-mxfp4-local.yaml" \
        gemma4-26b-a4b-mtp-mxfp4-local \
        gemma4-26b-a4b-mtp-local
run_bench mxfp4

echo "### Q4_K_M (17 GB)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q4km-local.yaml" \
        gemma4-26b-a4b-mtp-q4km-local \
        gemma4-26b-a4b-mtp-mxfp4-local
run_bench q4km

echo "### Q5_K_M (21 GB)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q5km-local.yaml" \
        gemma4-26b-a4b-mtp-q5km-local \
        gemma4-26b-a4b-mtp-q4km-local
run_bench q5km

echo "### UD-Q6_K_XL (23 GB) — disabling Granite for RAM headroom"
llamactl disable granite41-8b-long-lived-local || true
sleep 3
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q6kxl-local.yaml" \
        gemma4-26b-a4b-mtp-q6kxl-local \
        gemma4-26b-a4b-mtp-q5km-local
run_bench q6kxl

echo "### Q8_0 (27 GB)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q8-local.yaml" \
        gemma4-26b-a4b-mtp-q8-local \
        gemma4-26b-a4b-mtp-q6kxl-local
run_bench q8

echo "### UD-Q8_K_XL (28 GB)"
swap_to "$TEMPLATES/gemma4-26b-a4b-mtp-q8kxl-local.yaml" \
        gemma4-26b-a4b-mtp-q8kxl-local \
        gemma4-26b-a4b-mtp-q8-local
run_bench q8kxl

echo "### Restore: XL baseline + Granite"
llamactl disable gemma4-26b-a4b-mtp-q8kxl-local || true
sleep 3
llamactl enable gemma4-26b-a4b-mtp-local
wait_healthy
llamactl enable granite41-8b-long-lived-local || true

echo "### Done. Results in $OUT"
/bin/ls -lh "$OUT"
