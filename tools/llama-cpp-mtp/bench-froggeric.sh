#!/usr/bin/env bash
# Re-pilot wrapper: bench vanilla vs MTP using the PR #22673 binary
# already built under $LLAMA_CPP_BIN_MTP, with the flag set from the
# 2026-05-10 LocalLLaMA post (froggeric, Qwen 3.6 27B MTP):
#
#   --cache-type-k q8_0 --cache-type-v q8_0  (q8_0 KV)
#   --spec-type mtp --spec-draft-n-max 3      (MTP only)
#
# Same binary for both vanilla and MTP runs — only the speculative
# flags vary. Output JSON under $DEV_STORAGE/bench/mtp-froggeric/.
#
# Usage:
#   bench-froggeric.sh vanilla <rel>
#   bench-froggeric.sh mtp     <rel>
#
# `<rel>` is a path under $LLAMA_CPP_MODELS. The MTP-converted GGUF
# from froggeric works for both modes — without `--spec-type mtp` the
# extra MTP head tensors are loaded but unused.

set -euo pipefail

MODE="${1:?usage: bench-froggeric.sh <vanilla|mtp> <rel>}"
REL="${2:?missing rel}"

: "${DEV_STORAGE:?DEV_STORAGE must be set}"
: "${LLAMA_CPP_MODELS:?LLAMA_CPP_MODELS must be set}"
LLAMA_CPP_SRC_MTP="${LLAMA_CPP_SRC_MTP:-$DEV_STORAGE/src/llama.cpp-mtp}"
LLAMA_CPP_BIN_MTP="${LLAMA_CPP_BIN_MTP:-$LLAMA_CPP_SRC_MTP/build/bin}"
BIN="$LLAMA_CPP_BIN_MTP/llama-server"
[[ -x "$BIN" ]] || { echo "Missing: $BIN — run tools/llama-cpp-mtp/build.sh first" >&2; exit 3; }

case "$MODE" in
  vanilla|mtp) ;;
  *) echo "mode must be vanilla|mtp" >&2; exit 2 ;;
esac

MODEL="$LLAMA_CPP_MODELS/$REL"
[[ -f "$MODEL" ]] || { echo "Missing: $MODEL" >&2; exit 4; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/bench-client.py"
[[ -f "$CLIENT" ]] || { echo "Missing $CLIENT" >&2; exit 5; }

OUT_DIR="$DEV_STORAGE/bench/mtp-froggeric"
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_REL="$(echo "$REL" | tr '/' '_')"
OUT="$OUT_DIR/${TS}-${MODE}-${SAFE_REL}.json"
LOG="$OUT_DIR/${TS}-${MODE}-${SAFE_REL}.server.log"

# Different port from the atomic-fork pilot (18282) and the prior MTP
# pilot (18181), so concurrent runs don't collide.
PORT=18383
URL="http://127.0.0.1:${PORT}"

# OP's flag set verbatim except --ctx-size 8192 (bench doesn't need 256k).
# --flash-attn is intentionally NOT passed — PR #22673's MTP path appears
# to allocate a second full copy of the model when flash-attn is on with
# Apple Metal, OOMing the working set on M4 Pro. The OP omits it too.
SERVER_ARGS=(--host 127.0.0.1 --port "$PORT" --model "$MODEL"
             --ctx-size 8192 --no-warmup -np 1
             -ngl 99
             --cache-type-k q8_0 --cache-type-v q8_0)

if [[ "$MODE" == "mtp" ]]; then
  SERVER_ARGS+=(--spec-type mtp --spec-draft-n-max 3)
fi

echo "==> Spawning $BIN ${SERVER_ARGS[*]}"
"$BIN" "${SERVER_ARGS[@]}" > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

DEADLINE=180
echo "==> Waiting for $URL/health (pid=$SERVER_PID, deadline=${DEADLINE}s)"
for i in $(seq 1 "$DEADLINE"); do
  if curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null | grep -q "^200$"; then
    echo "==> server up after ${i}s"; break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "==> server died:" >&2; tail -40 "$LOG" >&2; exit 6
  fi
  sleep 1
done
if ! curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null | grep -q "^200$"; then
  echo "==> server not healthy:" >&2; tail -60 "$LOG" >&2; exit 7
fi

echo "==> Running bench client → $OUT"
python3 "$CLIENT" --url "$URL" --out "$OUT"
echo "==> wrote $OUT (server log: $LOG)"
