#!/usr/bin/env bash
# Drive an agentic-eval bench against mac-mini from the M4 Pro control
# plane. For each target model, SSH-spawn llama-server on mac-mini at a
# non-default port (18182, distinct from the live :8090 service), wait
# for /health, run the four sub-benches via the eval CLI's --url path,
# then SSH-kill the spawned server.
#
# Requires: ssh macmini.ai works, target GGUFs exist on mac-mini under
# /Volumes/AI-MODELS/llama.cpp/models/, llama-server at
# /Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server.
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"

PROGRESS=~/.llamactl/logs/eval-mac-mini-progress.log
echo "==> mac-mini bench started at $(date -u)" > "$PROGRESS"

REMOTE_BIN=/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server
REMOTE_MODELS=/Volumes/AI-MODELS/llama.cpp/models
REMOTE_PORT=18182
URL="http://192.168.68.76:${REMOTE_PORT}"

MODELS=(
  "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf"
  "Phi-4-mini-GGUF/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf"
  "Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"
  "Llama-3.1-8B-GGUF/Llama-3.1-8B-Instruct-Q4_K_M.gguf"
)

for rel in "${MODELS[@]}"; do
  safe=$(echo "$rel" | tr '/' '_')
  log=~/.llamactl/logs/eval-mac-mini-${safe}.log
  echo "==> $(date -u) starting $rel" | tee -a "$PROGRESS"

  # Sanity: confirm GGUF exists on mac-mini
  if ! ssh macmini.ai "test -f $REMOTE_MODELS/$rel"; then
    echo "    ERR: $rel missing on mac-mini" | tee -a "$PROGRESS"
    continue
  fi

  # Spawn llama-server on mac-mini in the background, capture the PID.
  ssh macmini.ai "pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null; sleep 1; \
    nohup $REMOTE_BIN \
      --host 0.0.0.0 --port $REMOTE_PORT \
      --model $REMOTE_MODELS/$rel \
      --ctx-size 20480 --no-warmup -np 1 \
      -ngl 999 --flash-attn on -ub 512 \
      > /tmp/eval-server-${REMOTE_PORT}.log 2>&1 & echo \$!" > /tmp/macmini-pid 2>>"$PROGRESS"
  PID=$(cat /tmp/macmini-pid | tr -d '[:space:]')
  echo "    spawned PID=$PID" | tee -a "$PROGRESS"

  # Wait for /health
  ready=0
  for i in $(seq 1 120); do
    if curl -fsS "$URL/health" > /dev/null 2>&1; then
      ready=1
      echo "    server up after ${i}s" | tee -a "$PROGRESS"
      break
    fi
    sleep 1
  done
  if [[ $ready -eq 0 ]]; then
    echo "    ERR: server failed health within 120s" | tee -a "$PROGRESS"
    ssh macmini.ai "tail -30 /tmp/eval-server-${REMOTE_PORT}.log" | tee -a "$PROGRESS"
    ssh macmini.ai "kill $PID 2>/dev/null"
    continue
  fi

  # Run the bench via --url
  start=$(date +%s)
  echo "    CMD: bun packages/cli/src/bin.ts eval run $rel --node mac-mini --ub 512 --url $URL" | tee -a "$PROGRESS"
  bun packages/cli/src/bin.ts eval run "$rel" --node mac-mini --ub 512 --url "$URL" > "$log" 2>&1
  status=$?
  end=$(date +%s)
  duration=$((end - start))
  echo "==> $(date -u) done $rel (exit=$status, ${duration}s wall)" | tee -a "$PROGRESS"
  echo "    log: $log" | tee -a "$PROGRESS"

  # Kill remote server
  ssh macmini.ai "kill $PID 2>/dev/null; sleep 1; pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null"
done

echo "==> $(date -u) mac-mini bench complete" | tee -a "$PROGRESS"
