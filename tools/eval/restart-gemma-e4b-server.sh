#!/usr/bin/env bash
# Restart gemma-4-E4B llama-server on mac-mini :8090 with the best -ub
# config based on the eval leaderboard. Penumbra uses this server as
# the `local` agent on mac-mini for memory refinement offloading.
set -uo pipefail
cd /Volumes/WorkSSD/repos/personal/llamactl
eval "$(bun packages/cli/src/bin.ts env --eval 2>/dev/null)"

PROGRESS=~/.llamactl/logs/restart-gemma-e4b-progress.log
echo "==> restart-gemma-e4b started $(date -u)" > "$PROGRESS"

REMOTE_BIN=/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server
REMOTE_MODELS=/Volumes/AI-MODELS/llama.cpp/models
REL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf"

# Pick the winning -ub from leaderboard rows for this model on mac-mini.
WIN_UB=$(sqlite3 /Users/acordeiro/DevStorage/eval/leaderboard.sqlite \
  "SELECT ub FROM leaderboard WHERE model='$REL' AND node='mac-mini' ORDER BY composite DESC LIMIT 1;")
if [[ -z "$WIN_UB" ]]; then
  echo "    no leaderboard row for $REL on mac-mini; defaulting to -ub 512" | tee -a "$PROGRESS"
  WIN_UB=512
fi
echo "==> winning -ub for gemma-4-E4B on mac-mini: $WIN_UB" | tee -a "$PROGRESS"

# Kill any tuning-test server still on :18182 just in case.
ssh macmini.ai "pkill -f 'llama-server.*--port 18182' 2>/dev/null; sleep 1" 2>&1 | head -3

# Stop the existing :8090 server, restart with the chosen -ub.
echo "==> killing existing :8090 server" | tee -a "$PROGRESS"
ssh macmini.ai "pkill -f 'llama-server.*--port 8090' 2>/dev/null; sleep 2" 2>&1 | head -3

echo "==> spawning new :8090 server with -ub $WIN_UB (matches penumbra alias 'local')" | tee -a "$PROGRESS"
# DYLD_FALLBACK_LIBRARY_PATH is needed because ssh-spawned processes are
# sandboxed (TCC) and llama-server's @rpath lookup defaults fail; the
# launchd-managed agent doesn't hit this since its sandbox is whitelisted.
ssh macmini.ai "DYLD_FALLBACK_LIBRARY_PATH=/Volumes/AI-DATA/src/llama.cpp/build/bin \
  nohup $REMOTE_BIN \
  -m $REMOTE_MODELS/$REL \
  --alias local --host 127.0.0.1 --port 8090 \
  -ngl 999 -fa on -b 2048 -ub $WIN_UB \
  > /tmp/llama-server-8090.log 2>&1 & echo \$!" > /tmp/macmini-8090-pid 2>>"$PROGRESS"
PID=$(cat /tmp/macmini-8090-pid | tr -d '[:space:]')
echo "    spawned PID=$PID" | tee -a "$PROGRESS"

# Wait for /health (should be quick on already-resident model)
for i in $(seq 1 60); do
  if ssh macmini.ai "curl -fsS http://127.0.0.1:8090/health" > /dev/null 2>&1; then
    echo "==> :8090 up after ${i}s" | tee -a "$PROGRESS"
    break
  fi
  sleep 1
done

ssh macmini.ai "ps aux | grep -E 'llama-server.*--port 8090' | grep -v grep | head -1" | tee -a "$PROGRESS"

echo "==> $(date -u) restart-gemma-e4b complete" | tee -a "$PROGRESS"
