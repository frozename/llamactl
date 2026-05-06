#!/usr/bin/env bash
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
LLAMA_CPP_MODELS="/Users/acordeiro/DevStorage/ai-models/llama.cpp/models"
PROGRESS=~/.llamactl/logs/eval-phase2-download-progress.log
echo "==> Phase 2 download started at $(date -u)" > "$PROGRESS"

declare -a REPOS=(
  "bartowski/openai_gpt-oss-20b-GGUF|openai_gpt-oss-20b-Q4_K_M.gguf|gpt-oss-20b-GGUF"
  "bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF|mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf|Mistral-Small-3.2-24B-GGUF"
  "bartowski/microsoft_Phi-4-reasoning-plus-GGUF|microsoft_Phi-4-reasoning-plus-Q4_K_M.gguf|Phi-4-reasoning-plus-GGUF"
  "unsloth/Qwen3-8B-GGUF|Qwen3-8B-Q4_K_M.gguf|Qwen3-8B-GGUF"
  "unsloth/Llama-3.1-8B-Instruct-GGUF|Llama-3.1-8B-Instruct-Q4_K_M.gguf|Llama-3.1-8B-GGUF"
  "bartowski/microsoft_Phi-4-mini-instruct-GGUF|microsoft_Phi-4-mini-instruct-Q4_K_M.gguf|Phi-4-mini-GGUF"
)

for entry in "${REPOS[@]}"; do
  IFS='|' read -r repo file dir <<< "$entry"
  out="$LLAMA_CPP_MODELS/$dir/$file"
  if [[ -f "$out" ]]; then
    echo "==> $(date -u) skipping $dir (already present)" | tee -a "$PROGRESS"
    continue
  fi
  mkdir -p "$LLAMA_CPP_MODELS/$dir"
  echo "==> $(date -u) downloading $repo :: $file" | tee -a "$PROGRESS"
  hf download "$repo" "$file" --local-dir "$LLAMA_CPP_MODELS/$dir" 2>&1 | tail -3 | tee -a "$PROGRESS"
done
echo "==> $(date -u) Phase 2 downloads complete" | tee -a "$PROGRESS"
