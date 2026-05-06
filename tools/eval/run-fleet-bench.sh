#!/usr/bin/env bash
# Run agentic-eval bench across the local fleet on the `local` (M4 Pro)
# node. Trimmed to MoE + small models only after observing dense large
# models (gemma 31B, qwen 27B, qwen 35B-A3B Q5) take 20+ min wall and
# Gemma 4 26B-A4B already sets the 0.95+ composite ceiling.
# Single -ub 512 pass.
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"
export LLAMA_CPP_BIN=/Users/acordeiro/DevStorage/src/llama.cpp/build/bin

PROGRESS=~/.llamactl/logs/eval-fleet-progress.log
echo "==> Fleet bench (trimmed) restarted at $(date -u)" >> "$PROGRESS"

MODELS=(
  # MoE — fast, candidates for ceiling
  "Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf"
  "gpt-oss-20b-GGUF/openai_gpt-oss-20b-Q4_K_M.gguf"
  # Small dense — mac-mini-class candidates (also worth measuring on M4 Pro)
  "Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"
  "Llama-3.1-8B-GGUF/Llama-3.1-8B-Instruct-Q4_K_M.gguf"
  "Phi-4-mini-GGUF/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf"
)

for rel in "${MODELS[@]}"; do
  safe=$(echo "$rel" | tr '/' '_')
  log=~/.llamactl/logs/eval-fleet-${safe}.log
  echo "==> $(date -u) starting $rel" | tee -a "$PROGRESS"
  pkill -f llama-server 2>/dev/null
  sleep 3
  start=$(date +%s)
  bun packages/cli/src/bin.ts eval run "$rel" --node local --ub 512 > "$log" 2>&1
  status=$?
  end=$(date +%s)
  duration=$((end - start))
  echo "==> $(date -u) done $rel (exit=$status, ${duration}s wall)" | tee -a "$PROGRESS"
  echo "    log: $log" | tee -a "$PROGRESS"
done

pkill -f llama-server 2>/dev/null
echo "==> $(date -u) Fleet bench (trimmed) complete" | tee -a "$PROGRESS"
