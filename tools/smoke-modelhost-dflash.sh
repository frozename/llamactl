#!/usr/bin/env bash
# End-to-end smoke for dflash D2: apply the dflash pilot, verify the
# sidecar model_settings.json was written by llamactl, wait for /v1/models,
# send /v1/chat/completions with a longish prompt to exercise the draft
# path, capture wall time + tokens, tear down.
#
# Manual: run on M4 Pro after install + pull + draft download.

set -euo pipefail

YAML="$(cd "$(dirname "$0")/.." && pwd)/templates/workloads/mlx-host-dflash.yaml"
PORT=8095
MODEL_REL="lmstudio-community/Qwen3-8B-MLX-4bit"
MODEL_BASENAME="Qwen3-8B-MLX-4bit"
WORKLOAD_NAME="dflash-host-local"
RUNTIME_DIR="${LLAMACTL_RUNTIME_DIR:-$HOME/.llamactl/runtime}"
SETTINGS_FILE="${RUNTIME_DIR}/workloads/${WORKLOAD_NAME}/.omlx/model_settings.json"

if [[ ! -f "$YAML" ]]; then
  echo "[smoke] manifest not found: $YAML" >&2
  exit 1
fi

cleanup() {
  echo "[smoke] cleanup: disable ${WORKLOAD_NAME}"
  llamactl disable "${WORKLOAD_NAME}" || true
}
trap cleanup EXIT

echo "[smoke] applying $YAML"
llamactl apply -f "$YAML"

echo "[smoke] verifying llamactl wrote the dflash sidecar at $SETTINGS_FILE"
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "[smoke] FAIL — model_settings.json was not written. Check that engine.prepareLaunch ran." >&2
  exit 1
fi
echo "[smoke] sidecar contents:"
python3 -m json.tool < "$SETTINGS_FILE"

# Confirm the dflash fields are present and the model_id key is the basename.
if ! python3 -c "
import json, sys
data = json.load(open('${SETTINGS_FILE}'))
models = data.get('models', {})
key = '${MODEL_BASENAME}'
if key not in models:
    print(f'[smoke] FAIL — model_id ${MODEL_BASENAME} not present in model_settings.json (keys: {list(models.keys())})', file=sys.stderr)
    sys.exit(1)
entry = models[key]
if not entry.get('dflash_enabled'):
    print('[smoke] FAIL — dflash_enabled is not true in sidecar', file=sys.stderr)
    sys.exit(1)
if not entry.get('dflash_draft_model'):
    print('[smoke] FAIL — dflash_draft_model is missing in sidecar', file=sys.stderr)
    sys.exit(1)
print(f'[smoke] dflash_enabled=true, draft={entry[\"dflash_draft_model\"]}')
"; then
  exit 1
fi

echo "[smoke] waiting for /v1/models on :$PORT (up to 120s — draft model load is slow)"
found=0
deadline=$(($(date +%s) + 120))
while [[ $(date +%s) -lt $deadline ]]; do
  if curl -fs "http://127.0.0.1:$PORT/v1/models" | grep -q "$MODEL_BASENAME"; then
    echo "[smoke] /v1/models exposes $MODEL_BASENAME"
    found=1
    break
  fi
  sleep 2
done

if [[ "$found" -ne 1 ]]; then
  echo "[smoke] FAIL — $MODEL_BASENAME never appeared on /v1/models within 120s" >&2
  exit 1
fi

echo "[smoke] POST /v1/chat/completions (longer prompt to engage the draft path)"
PROMPT='Write a one-paragraph explanation of speculative decoding in transformer inference, mentioning draft models and acceptance rates. Be concise.'
START_NS=$(python3 -c "import time; print(int(time.time_ns()))")
REPLY=$(curl -fs -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "$(python3 -c "
import json, sys
print(json.dumps({
    'model': '${MODEL_BASENAME}',
    'messages': [{'role': 'user', 'content': '''${PROMPT}'''}],
    'max_tokens': 200,
    'temperature': 0.0,
}))
")")
END_NS=$(python3 -c "import time; print(int(time.time_ns()))")

WALL_MS=$(( (END_NS - START_NS) / 1000000 ))
CONTENT=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(d['choices'][0]['message']['content'])
" "$REPLY")
TOKENS=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
usage = d.get('usage', {})
print(usage.get('completion_tokens', 0))
" "$REPLY")

if [[ -z "$CONTENT" ]]; then
  echo "[smoke] FAIL — empty completion content. Raw: $REPLY" >&2
  exit 1
fi

TPS=$(python3 -c "print(f'{${TOKENS} / (${WALL_MS} / 1000):.2f}')")
echo "[smoke] PASS — completion content length=$(printf '%s' "$CONTENT" | wc -c), tokens=$TOKENS, wall=${WALL_MS}ms, tps=$TPS"
echo "[smoke] reply: $(printf '%s' "$CONTENT" | head -c 200)..."

# Optional: tail the oMLX log to confirm dflash was actually engaged.
# Look for "dflash" or "accepted" or "draft" markers — exact strings
# depend on the oMLX version. Print the last 50 lines for manual review.
LOG_FILE="${RUNTIME_DIR}/workloads/${WORKLOAD_NAME}/omlx.log"
if [[ -f "$LOG_FILE" ]]; then
  echo "[smoke] tail of $LOG_FILE (look for dflash acceptance markers):"
  tail -50 "$LOG_FILE" | grep -i -E 'dflash|draft|accept|spec' || echo "[smoke] (no dflash markers found in log tail — check the full log if throughput looks vanilla)"
fi

echo "[smoke] done"
