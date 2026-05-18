#!/usr/bin/env bash
# End-to-end smoke for Sub A: apply the MLX pilot, wait for /v1/models,
# send a /v1/chat/completions, assert the response parses.
#
# Manual: run on M4 Pro after install + pull.

set -euo pipefail

YAML="$(cd "$(dirname "$0")/.." && pwd)/templates/workloads/mlx-host-local.yaml"
PORT=8094
MODEL_REL="mlx-community/Qwen3-8B-MLX-4bit"
MODEL_BASENAME="Qwen3-8B-MLX-4bit"

echo "[smoke] applying $YAML"
llamactl apply -f "$YAML"

echo "[smoke] waiting for /v1/models on :$PORT (up to 60s)"
deadline=$(($(date +%s) + 60))
while [[ $(date +%s) -lt $deadline ]]; do
  if curl -fs "http://127.0.0.1:$PORT/v1/models" | grep -q "$MODEL_BASENAME"; then
    echo "[smoke] /v1/models exposes $MODEL_BASENAME"
    break
  fi
  sleep 2
done

echo "[smoke] POST /v1/chat/completions"
REPLY=$(curl -fs -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL_BASENAME\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with exactly: SMOKE-OK\"}],\"max_tokens\":8,\"temperature\":0}")
echo "[smoke] reply: $REPLY"

if echo "$REPLY" | grep -q SMOKE-OK; then
  echo "[smoke] PASS"
else
  echo "[smoke] FAIL — reply did not contain SMOKE-OK" >&2
  exit 1
fi

echo "[smoke] tearing down"
llamactl disable mlx-host-local
echo "[smoke] done"
