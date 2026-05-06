#!/usr/bin/env bash
# Resume mac-mini bench after parser-bug fix (commit 3229726). The first
# two models (gemma-4-E4B, Phi-4-mini) already have correctly-labeled
# rows in sqlite; this driver finishes Qwen3-8B + Llama-3.1-8B.
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"

PROGRESS=~/.llamactl/logs/eval-mac-mini-resume-progress.log
echo "==> mac-mini resume started $(date -u)" > "$PROGRESS"

REMOTE_BIN=/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server
REMOTE_MODELS=/Volumes/AI-MODELS/llama.cpp/models
REMOTE_PORT=18182
URL="http://192.168.68.76:${REMOTE_PORT}"

MODELS=(
  "Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"
  "Llama-3.1-8B-GGUF/Llama-3.1-8B-Instruct-Q4_K_M.gguf"
)

for rel in "${MODELS[@]}"; do
  echo "==> $(date -u) starting $rel" | tee -a "$PROGRESS"
  if ! ssh macmini.ai "test -f $REMOTE_MODELS/$rel"; then
    echo "    ERR: $rel missing on mac-mini" | tee -a "$PROGRESS"
    continue
  fi
  ssh macmini.ai "pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null; sleep 1; \
    nohup $REMOTE_BIN \
      --host 0.0.0.0 --port $REMOTE_PORT \
      --model $REMOTE_MODELS/$rel \
      --ctx-size 20480 --no-warmup -np 1 \
      -ngl 999 --flash-attn on -ub 512 \
      > /tmp/eval-server-${REMOTE_PORT}.log 2>&1 & echo \$!" > /tmp/macmini-pid 2>>"$PROGRESS"
  PID=$(cat /tmp/macmini-pid | tr -d '[:space:]')
  ready=0
  for i in $(seq 1 120); do
    if curl -fsS "$URL/health" > /dev/null 2>&1; then ready=1; echo "    server up after ${i}s" | tee -a "$PROGRESS"; break; fi
    sleep 1
  done
  if [[ $ready -eq 0 ]]; then
    echo "    ERR: server failed health" | tee -a "$PROGRESS"
    ssh macmini.ai "kill $PID 2>/dev/null"
    continue
  fi

  safe=$(echo "$rel" | tr '/' '_')
  log=~/.llamactl/logs/eval-mac-mini-resume-${safe}.log
  start=$(date +%s)
  bun packages/cli/src/bin.ts --node mac-mini eval run "$rel" --ub 512 --url "$URL" > "$log" 2>&1
  status=$?
  end=$(date +%s)
  echo "==> $(date -u) done $rel (exit=$status, $((end-start))s wall)" | tee -a "$PROGRESS"
  ssh macmini.ai "kill $PID 2>/dev/null; sleep 1; pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null"
done

echo "==> $(date -u) mac-mini resume complete" | tee -a "$PROGRESS"
