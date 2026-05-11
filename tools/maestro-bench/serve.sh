#!/usr/bin/env bash
# Persistent serve harness for the local penumbra maestro candidate:
# Gemma 4 26B-A4B UD-Q4_K_XL + MTP via AtomicBot-ai/atomic-llama-cpp-turboquant.
#
# Spawns the atomic-fork llama-server in the foreground (so a supervisor
# — launchd, systemd, or a terminal session — owns the lifecycle and
# can restart on exit).
#
# Override the defaults with env vars before invocation. Path defaults
# assume the layout this pilot was set up under:
#   ATOMIC_BIN=/Volumes/WorkSSD/src/llama.cpp-atomic/build/bin/llama-server
#   LLAMA_CPP_MODELS=/Volumes/WorkSSD/ai-models/llama.cpp/models
#   MAESTRO_PORT=8181
#
# Spec: docs/superpowers/specs/2026-05-11-maestro-pilot-wiring.md
# Bench: tools/maestro-bench/bench-maestro.py

set -euo pipefail

ATOMIC_BIN="${ATOMIC_BIN:-/Volumes/WorkSSD/src/llama.cpp-atomic/build/bin/llama-server}"
LLAMA_CPP_MODELS="${LLAMA_CPP_MODELS:-/Volumes/WorkSSD/ai-models/llama.cpp/models}"
MAESTRO_PORT="${MAESTRO_PORT:-8181}"
MAESTRO_HOST="${MAESTRO_HOST:-127.0.0.1}"
MAESTRO_ALIAS="${MAESTRO_ALIAS:-gemma4-26b-a4b-mtp}"
MAESTRO_CTX="${MAESTRO_CTX:-32768}"

BASE_REL="${MAESTRO_BASE_REL:-gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf}"
HEAD_REL="${MAESTRO_HEAD_REL:-gemma-4-26B-A4B-it-assistant-GGUF/gemma-4-26B-A4B-it-assistant.Q4_K_M.gguf}"

[[ -x "$ATOMIC_BIN" ]] || { echo "Missing atomic-fork binary: $ATOMIC_BIN" >&2; exit 3; }
[[ -f "$LLAMA_CPP_MODELS/$BASE_REL" ]] || { echo "Missing base: $LLAMA_CPP_MODELS/$BASE_REL" >&2; exit 4; }
[[ -f "$LLAMA_CPP_MODELS/$HEAD_REL" ]] || { echo "Missing head: $LLAMA_CPP_MODELS/$HEAD_REL" >&2; exit 4; }

echo "==> serving $MAESTRO_ALIAS on $MAESTRO_HOST:$MAESTRO_PORT (ctx=$MAESTRO_CTX)"
echo "    base = $BASE_REL"
echo "    head = $HEAD_REL"

exec "$ATOMIC_BIN" \
  --host "$MAESTRO_HOST" --port "$MAESTRO_PORT" \
  --alias "$MAESTRO_ALIAS" \
  --model "$LLAMA_CPP_MODELS/$BASE_REL" \
  --mtp-head "$LLAMA_CPP_MODELS/$HEAD_REL" \
  --spec-type mtp --draft-block-size 3 --draft-max 8 --draft-min 0 \
  -ngl 99 -ngld 99 \
  -ctk turbo3 -ctv turbo3 -ctkd turbo3 -ctvd turbo3 \
  --flash-attn on -c "$MAESTRO_CTX" --no-warmup -np 1 \
  --jinja
