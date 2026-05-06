#!/usr/bin/env bash
# Run agentic-eval bench across the Phase 2 new candidate models on the
# `local` (M4 Pro) node. Mac-mini-tier models are also benched on `local`
# since they fit comfortably; cross-node mac-mini coverage is a separate
# pass. -ub 512 only (single-config first pass).
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"
export LLAMA_CPP_BIN=/Users/acordeiro/DevStorage/src/llama.cpp/build/bin

PROGRESS=~/.llamactl/logs/eval-phase2-bench-progress.log
echo "==> Phase 2 bench started at $(date -u)" > "$PROGRESS"

MODELS=(
  "gpt-oss-20b-GGUF/openai_gpt-oss-20b-Q4_K_M.gguf"
  "Mistral-Small-3.2-24B-GGUF/mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf"
  "Phi-4-reasoning-plus-GGUF/microsoft_Phi-4-reasoning-plus-Q4_K_M.gguf"
  "Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"
  "Llama-3.1-8B-GGUF/Llama-3.1-8B-Instruct-Q4_K_M.gguf"
  "Phi-4-mini-GGUF/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf"
)

for rel in "${MODELS[@]}"; do
  safe=$(echo "$rel" | tr '/' '_')
  log=~/.llamactl/logs/eval-phase2-bench-${safe}.log
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
echo "==> $(date -u) Phase 2 bench complete" | tee -a "$PROGRESS"
