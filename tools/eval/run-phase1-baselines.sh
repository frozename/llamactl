#!/usr/bin/env bash
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"
export LLAMA_CPP_BIN=/Users/acordeiro/DevStorage/src/llama.cpp/build/bin

PROGRESS=~/.llamactl/logs/eval-phase1-progress.log
echo "==> Phase 1 baseline run started at $(date -u)" > "$PROGRESS"

MODELS=(
  "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
  "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
  "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
  "Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf"
  "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf"
  "Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf"
)

for rel in "${MODELS[@]}"; do
  safe=$(echo "$rel" | tr '/' '_')
  log=~/.llamactl/logs/eval-phase1-${safe}.log
  echo "==> $(date -u) starting $rel" | tee -a "$PROGRESS"
  pkill -f llama-server 2>/dev/null
  sleep 3
  start=$(date +%s)
  bun packages/cli/src/bin.ts eval run "$rel" --node local --ub 512 > "$log" 2>&1
  status=$?
  end=$(date +%s)
  echo "==> $(date -u) done $rel (exit=$status, ${duration}s wall)" | tee -a "$PROGRESS"
  duration=$((end - start))
  echo "    log: $log" | tee -a "$PROGRESS"
done

pkill -f llama-server 2>/dev/null
echo "==> $(date -u) Phase 1 baseline complete" | tee -a "$PROGRESS"
