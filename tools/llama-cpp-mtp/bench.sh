#!/usr/bin/env bash
# Bench harness for the MTP pilot. Spawns llama-server (vanilla or MTP)
# against a fixed model file, runs bench-client.py against /completion
# with a fixed prompt set, captures aggregate decode tps + draft accept
# rate, then kills the server. Emits one JSON file per run under
# $DEV_STORAGE/bench/mtp-pilot/.
#
# Usage:
#   bench.sh vanilla <rel>
#   bench.sh mtp <rel>
#
# `<rel>` is a path under $LLAMA_CPP_MODELS. For Qwen MTP, MTP heads
# are embedded in the same GGUF so no --model-draft is passed.

set -euo pipefail

MODE="${1:?usage: bench.sh <vanilla|mtp> <rel>}"
REL="${2:?missing rel}"

: "${DEV_STORAGE:?DEV_STORAGE must be set}"
: "${LLAMA_CPP_BIN:?LLAMA_CPP_BIN must be set}"
: "${LLAMA_CPP_MODELS:?LLAMA_CPP_MODELS must be set}"
LLAMA_CPP_SRC_MTP="${LLAMA_CPP_SRC_MTP:-$DEV_STORAGE/src/llama.cpp-mtp}"
LLAMA_CPP_BIN_MTP="${LLAMA_CPP_BIN_MTP:-$LLAMA_CPP_SRC_MTP/build/bin}"

case "$MODE" in
  vanilla) BIN="$LLAMA_CPP_BIN/llama-server" ;;
  mtp)     BIN="$LLAMA_CPP_BIN_MTP/llama-server" ;;
  *) echo "mode must be vanilla|mtp" >&2; exit 2 ;;
esac

[[ -x "$BIN" ]] || { echo "Missing or non-executable: $BIN" >&2; exit 3; }
MODEL="$LLAMA_CPP_MODELS/$REL"
[[ -f "$MODEL" ]] || { echo "Missing model file: $MODEL" >&2; exit 4; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT="$SCRIPT_DIR/bench-client.py"
[[ -f "$CLIENT" ]] || { echo "Missing $CLIENT" >&2; exit 5; }

OUT_DIR="$DEV_STORAGE/bench/mtp-pilot"
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_REL="$(echo "$REL" | tr '/' '_')"
OUT="$OUT_DIR/${TS}-${MODE}-${SAFE_REL}.json"
LOG="$OUT_DIR/${TS}-${MODE}-${SAFE_REL}.server.log"

# Use a non-default port to avoid colliding with any running llama-server.
PORT=18181
URL="http://127.0.0.1:${PORT}"

SERVER_ARGS=(--host 127.0.0.1 --port "$PORT" --model "$MODEL"
             --ctx-size 8192 --no-warmup -np 1)
if [[ "$MODE" == "mtp" ]]; then
  SERVER_ARGS+=(--spec-type mtp --spec-draft-n-max 3)
fi

echo "==> Spawning $BIN ${SERVER_ARGS[*]}"
"$BIN" "${SERVER_ARGS[@]}" > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

echo "==> Waiting for $URL/health (pid=$SERVER_PID)"
for i in $(seq 1 120); do
  if curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null | grep -q "^200$"; then
    echo "==> server up after ${i}s"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "==> server died during startup. Last log lines:" >&2
    tail -30 "$LOG" >&2
    exit 6
  fi
  sleep 1
done

if ! curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null | grep -q "^200$"; then
  echo "==> server failed health within 120s. Log:" >&2
  tail -40 "$LOG" >&2
  exit 7
fi

echo "==> Running bench client → $OUT"
python3 "$CLIENT" --url "$URL" --out "$OUT"

echo "==> wrote $OUT (server log: $LOG)"
