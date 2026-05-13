#!/usr/bin/env bash
# Per-quant + TURBO_SPARSE_V A/B llama-bench sweep on Gemma 4 26B-A4B.
#
# Why: maestro-bench mixes prefill / decode / MTP accept / SWA cache hits.
# llama-bench isolates pp+tg per quant, so we can see (a) which quants
# are kernel-bound vs memory-bound, (b) whether turbo3 sparse V dequant
# is a free win or a regression on Gemma 4 specifically.
#
# Pre: no llama-server running on :8181. The sweep will load each model
# directly into llama-bench.
# Post: nothing left running. We restart gemma4-26b-a4b-mtp-local at the end.
set -euo pipefail
BIN=/Volumes/WorkSSD/src/llama.cpp-atomic/build/bin/llama-bench
MODELS_DIR=/Volumes/WorkSSD/ai-models/llama.cpp/models/gemma-4-26B-A4B-it-GGUF
OUT=$DEV_STORAGE/bench/maestro-pilot/llama-bench-2026-05-13
mkdir -p "$OUT"

# llamactl daemon side: stop everything so llama-bench has the GPU.
llamactl disable gemma4-26b-a4b-mtp-local 2>/dev/null || true
llamactl disable granite41-8b-long-lived-local 2>/dev/null || true
sleep 3

run_one() {
  local quant=$1 file=$2 sparse_v=$3
  local tag="$quant-sparseV${sparse_v}"
  local stamp; stamp=$(date -u +%Y%m%dT%H%M%SZ)
  echo "==> $tag ($file)"
  TURBO_SPARSE_V="$sparse_v" "$BIN" \
    -m "$MODELS_DIR/$file" \
    -ngl 99 \
    -fa 1 \
    -ctk f16 -ctv f16 \
    -p 512 -n 128 \
    -r 3 \
    -o jsonl \
    > "$OUT/${stamp}-${tag}.jsonl" 2> "$OUT/${stamp}-${tag}.stderr"
  tail -3 "$OUT/${stamp}-${tag}.jsonl"
}

# Three representative quants: Q4_K_M (current baseline), Q6_K_XL (quality
# tier), Q8_0 (turbo3 native). MXFP4 is novel and worth a separate run.
QUANTS=(
  "q4km gemma-4-26B-A4B-it-UD-Q4_K_M.gguf"
  "q6kxl gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
  "q8_0 gemma-4-26B-A4B-it-Q8_0.gguf"
  "mxfp4 gemma-4-26B-A4B-it-MXFP4_MOE.gguf"
)

for entry in "${QUANTS[@]}"; do
  read -r tag file <<<"$entry"
  # A/B sparse V on the same quant — sparse_v=1 (default) vs 0 (opt-out).
  run_one "$tag" "$file" 1
  run_one "$tag" "$file" 0
done

# Restore live workloads
llamactl enable gemma4-26b-a4b-mtp-local
llamactl enable granite41-8b-long-lived-local

echo "### Done. Results in $OUT"
/bin/ls -lh "$OUT"
