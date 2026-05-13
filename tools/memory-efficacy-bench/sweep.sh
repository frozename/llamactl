#!/usr/bin/env bash
# Sweep Granite mac-mini config variations against the memory-efficacy bench.
#
# Spins a temp llama-server on mac-mini :18190 (--host 0.0.0.0 so M4 Pro can
# reach it directly), benches via run-bench.ts, tears down the temp server,
# and moves on. Production :8090 stays alive throughout (16 GB mac-mini —
# watch RAM on f16 KV configs).
#
# Usage: bash tools/memory-efficacy-bench/sweep.sh

set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl

REMOTE_BIN=/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server
REMOTE_MODEL=/Volumes/AI-MODELS/llama.cpp/models/granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf
REMOTE_PORT=18190
URL="http://192.168.68.76:${REMOTE_PORT}"
RESULTS_DIR=./bench-results
PROGRESS=~/.llamactl/logs/memory-efficacy-sweep.log

mkdir -p "$RESULTS_DIR"
echo "==> $(date -u) sweep starting" > "$PROGRESS"

# Config grid. Each entry is "id:llama-server-args".
# Common args are appended: -m, --host, --port, --no-warmup, -ngl, --flash-attn.
declare -a CONFIGS=(
  "baseline:--ctx-size 32768 -b 2048 -ub 512 -ctk q8_0 -ctv q8_0 -np 2"
  "ub256:--ctx-size 32768 -b 2048 -ub 256 -ctk q8_0 -ctv q8_0 -np 2"
  "ub1024:--ctx-size 32768 -b 2048 -ub 1024 -ctk q8_0 -ctv q8_0 -np 2"
  "batch4096:--ctx-size 32768 -b 4096 -ub 1024 -ctk q8_0 -ctv q8_0 -np 2"
  "kvf16:--ctx-size 32768 -b 2048 -ub 512 -ctk f16 -ctv f16 -np 1"
  "np1:--ctx-size 32768 -b 2048 -ub 512 -ctk q8_0 -ctv q8_0 -np 1"
  "jinja:--ctx-size 32768 -b 2048 -ub 512 -ctk q8_0 -ctv q8_0 -np 2 --jinja"
  "aggressive:--ctx-size 32768 -b 4096 -ub 1024 -ctk q8_0 -ctv q8_0 -np 2 --jinja"
)

# Ensure no leftover test instance on :18190.
ssh macmini.ai "pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null; sleep 1" >>"$PROGRESS" 2>&1

for entry in "${CONFIGS[@]}"; do
  id="${entry%%:*}"
  args="${entry#*:}"
  out="${RESULTS_DIR}/sweep-${id}.json"

  if [[ -s "$out" ]]; then
    echo "==> $(date -u) skip ${id} (exists)" | tee -a "$PROGRESS"
    continue
  fi

  echo "==> $(date -u) launching ${id}: ${args}" | tee -a "$PROGRESS"

  ssh macmini.ai "pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null; sleep 1; \
    nohup $REMOTE_BIN \
      --host 0.0.0.0 --port ${REMOTE_PORT} \
      --model $REMOTE_MODEL \
      --no-warmup -ngl 999 --flash-attn on \
      ${args} \
      > /tmp/granite-efficacy-sweep-${id}.log 2>&1 & echo \$!" > /tmp/macmini-pid 2>>"$PROGRESS"
  PID=$(cat /tmp/macmini-pid | tr -d '[:space:]')
  echo "    PID=$PID" | tee -a "$PROGRESS"

  # Wait up to 120s for /health.
  ready=0
  for i in $(seq 1 120); do
    if curl -fsS "$URL/health" > /dev/null 2>&1; then
      ready=1
      echo "    /health ok after ${i}s" | tee -a "$PROGRESS"
      break
    fi
    sleep 1
  done
  if [[ $ready -eq 0 ]]; then
    echo "    ERR: ${id} health never reached, dumping last 30 log lines:" | tee -a "$PROGRESS"
    ssh macmini.ai "tail -30 /tmp/granite-efficacy-sweep-${id}.log" 2>&1 | tee -a "$PROGRESS"
    ssh macmini.ai "kill $PID 2>/dev/null" >>"$PROGRESS" 2>&1
    continue
  fi

  echo "==> $(date -u) benching ${id}" | tee -a "$PROGRESS"
  bun tools/memory-efficacy-bench/run-bench.ts \
    --url "$URL" --model local \
    --out "$out" 2>&1 | tee -a "$PROGRESS"

  ssh macmini.ai "kill $PID 2>/dev/null; sleep 1; pkill -f 'llama-server.*--port ${REMOTE_PORT}' 2>/dev/null" >>"$PROGRESS" 2>&1
done

echo "==> $(date -u) sweep complete" | tee -a "$PROGRESS"
