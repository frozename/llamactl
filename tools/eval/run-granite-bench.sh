#!/usr/bin/env bash
# Bench Granite 4.1 8b + 3b on both M4 Pro (local) and mac-mini.
# Both quants (Q4_K_M from unsloth) run with the standard --ub 512
# Apple Silicon flags via the existing eval CLI.
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"
export LLAMA_CPP_BIN=/Users/acordeiro/DevStorage/src/llama.cpp/build/bin

PROGRESS=~/.llamactl/logs/eval-granite-progress.log
echo "==> granite bench started $(date -u)" > "$PROGRESS"

REMOTE_BIN=/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server
REMOTE_MODELS=/Volumes/AI-MODELS/llama.cpp/models
REMOTE_PORT=18182
URL="http://192.168.68.76:${REMOTE_PORT}"

MODELS=(
  "granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf"
  "granite-4.1-3b-GGUF/granite-4.1-3b-Q4_K_M.gguf"
)

for rel in "${MODELS[@]}"; do
  safe=$(echo "$rel" | tr '/' '_')

  # M4 Pro local
  llog=~/.llamactl/logs/eval-granite-local-${safe}.log
  echo "==> $(date -u) [local] starting $rel" | tee -a "$PROGRESS"
  pkill -f llama-server 2>/dev/null
  sleep 3
  start=$(date +%s)
  bun packages/cli/src/bin.ts eval run "$rel" --node local --ub 512 > "$llog" 2>&1
  status=$?
  end=$(date +%s)
  echo "==> $(date -u) [local] done $rel (exit=$status, $((end-start))s wall)" | tee -a "$PROGRESS"

  # mac-mini remote (SSH-spawn server, drive bench from here via --url)
  rlog=~/.llamactl/logs/eval-granite-mac-mini-${safe}.log
  if ! ssh macmini.ai "test -f $REMOTE_MODELS/$rel"; then
    echo "    [mac-mini] missing $rel — skipping" | tee -a "$PROGRESS"
    continue
  fi
  echo "==> $(date -u) [mac-mini] starting $rel" | tee -a "$PROGRESS"
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
    echo "    ERR: server failed health within 120s" | tee -a "$PROGRESS"
    ssh macmini.ai "tail -30 /tmp/eval-server-${REMOTE_PORT}.log" | tee -a "$PROGRESS"
    ssh macmini.ai "kill $PID 2>/dev/null"
    continue
  fi
  start=$(date +%s)
  bun packages/cli/src/bin.ts eval run "$rel" --node mac-mini --ub 512 --url "$URL" > "$rlog" 2>&1
  status=$?
  end=$(date +%s)
  echo "==> $(date -u) [mac-mini] done $rel (exit=$status, $((end-start))s wall)" | tee -a "$PROGRESS"
  ssh macmini.ai "kill $PID 2>/dev/null; sleep 1; pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null"
done

pkill -f llama-server 2>/dev/null
echo "==> $(date -u) granite bench complete" | tee -a "$PROGRESS"
