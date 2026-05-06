#!/usr/bin/env bash
# Quick gemma-4-E4B tuning sweep on mac-mini.
# Existing data point (asof 05:23:50 UTC, post-relabel): -ub 512 → 27.7 tps, composite 0.757.
# This driver adds -ub 256 (and optionally -b 4096) for comparison, then
# leaves the server STOPPED so the caller can restart with the winning config.
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"

PROGRESS=~/.llamactl/logs/eval-tune-gemma-e4b-progress.log
echo "==> gemma-4-E4B tune sweep started $(date -u)" > "$PROGRESS"

REMOTE_BIN=/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server
REMOTE_MODELS=/Volumes/AI-MODELS/llama.cpp/models
REMOTE_PORT=18182
URL="http://192.168.68.76:${REMOTE_PORT}"
REL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf"

# Mark the existing -ub 512 row as a tuning baseline (we'll add -ub 256 and compare).
# Configs to try: ub=256 standard; ub=512 already done (skip).
for ub in 256; do
  echo "==> $(date -u) launching server with --ub $ub" | tee -a "$PROGRESS"
  ssh macmini.ai "pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null; sleep 1; \
    nohup $REMOTE_BIN \
      --host 0.0.0.0 --port $REMOTE_PORT \
      --model $REMOTE_MODELS/$REL \
      --ctx-size 20480 --no-warmup -np 1 \
      -ngl 999 --flash-attn on -ub $ub -b 2048 \
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
  log=~/.llamactl/logs/eval-tune-gemma-e4b-ub${ub}.log
  start=$(date +%s)
  bun packages/cli/src/bin.ts --node mac-mini eval run "$REL" --ub $ub --url "$URL" > "$log" 2>&1
  status=$?
  end=$(date +%s)
  echo "==> $(date -u) done --ub $ub (exit=$status, $((end-start))s wall)" | tee -a "$PROGRESS"
  ssh macmini.ai "kill $PID 2>/dev/null; sleep 1; pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null"
done

echo "==> $(date -u) gemma-4-E4B tune sweep complete" | tee -a "$PROGRESS"
