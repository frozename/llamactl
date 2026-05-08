#!/usr/bin/env bash
# Bench harness for the Gemma 4 MTP pilot using the
# atomic-llama-cpp-turboquant fork. Spawns the fork's llama-server
# (vanilla mode without --mtp-head, MTP mode with it), runs
# bench-client.py against /completion, then kills the server. Emits
# one JSON file per run under $DEV_STORAGE/bench/mtp-gemma4-pilot/.
#
# Both vanilla and MTP runs use the FORK's binary so the only varying
# axis is the speculative-decoding path (matches the spec).
#
# Usage:
#   bench.sh vanilla <base-rel>
#   bench.sh mtp     <base-rel> <head-rel>
#
# Both rels are relative to $LLAMA_CPP_MODELS.
#
# Spec: docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-design.md

set -euo pipefail

MODE="${1:?usage: bench.sh <vanilla|mtp> <base-rel> [<head-rel>]}"
BASE_REL="${2:?missing base-rel}"
HEAD_REL="${3:-}"

: "${DEV_STORAGE:?DEV_STORAGE must be set}"
: "${LLAMA_CPP_MODELS:?LLAMA_CPP_MODELS must be set}"
LLAMA_CPP_SRC_ATOMIC="${LLAMA_CPP_SRC_ATOMIC:-$DEV_STORAGE/src/llama.cpp-atomic}"
LLAMA_CPP_BIN_ATOMIC="${LLAMA_CPP_BIN_ATOMIC:-$LLAMA_CPP_SRC_ATOMIC/build/bin}"
BIN="$LLAMA_CPP_BIN_ATOMIC/llama-server"
[[ -x "$BIN" ]] || { echo "Missing or non-executable: $BIN — run build.sh first" >&2; exit 3; }

case "$MODE" in
  vanilla) ;;
  mtp)
    [[ -n "$HEAD_REL" ]] || { echo "mtp mode requires <head-rel>" >&2; exit 2; }
    ;;
  *) echo "mode must be vanilla|mtp" >&2; exit 2 ;;
esac

BASE="$LLAMA_CPP_MODELS/$BASE_REL"
[[ -f "$BASE" ]] || { echo "Missing base file: $BASE" >&2; exit 4; }
HEAD=""
if [[ "$MODE" == "mtp" ]]; then
  HEAD="$LLAMA_CPP_MODELS/$HEAD_REL"
  [[ -f "$HEAD" ]] || { echo "Missing head file: $HEAD" >&2; exit 4; }
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the prior pilot's bench client — same /completion shape.
CLIENT="$SCRIPT_DIR/../llama-cpp-mtp/bench-client.py"
[[ -f "$CLIENT" ]] || { echo "Missing $CLIENT" >&2; exit 5; }

OUT_DIR="$DEV_STORAGE/bench/mtp-gemma4-pilot"
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE_REL="$(echo "$BASE_REL" | tr '/' '_')"
OUT="$OUT_DIR/${TS}-${MODE}-${SAFE_REL}.json"
LOG="$OUT_DIR/${TS}-${MODE}-${SAFE_REL}.server.log"

# Non-default port to avoid colliding with running llama-servers
# (granite41-8b-local on :8080, mac-mini on :8090, prior pilot on :18181).
PORT=18282
URL="http://127.0.0.1:${PORT}"

# Common server flags — same for vanilla and MTP for apples-to-apples
# comparison on the main-model KV cache.
SERVER_ARGS=(--host 127.0.0.1 --port "$PORT" --model "$BASE"
             --ctx-size 8192 --no-warmup -np 1
             -ngl 99 --flash-attn on -ub 512
             -ctk turbo3 -ctv turbo3)

if [[ "$MODE" == "mtp" ]]; then
  SERVER_ARGS+=(--mtp-head "$HEAD"
                --spec-type mtp
                --draft-block-size 3 --draft-max 8 --draft-min 0
                -ngld 99 -ctkd turbo3 -ctvd turbo3)
fi

echo "==> Spawning $BIN ${SERVER_ARGS[*]}"
"$BIN" "${SERVER_ARGS[@]}" > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

# MTP path loads the head GGUF too, which can extend startup. Keep
# vanilla at 120s, allow up to 180s for MTP.
HEALTH_DEADLINE=120
[[ "$MODE" == "mtp" ]] && HEALTH_DEADLINE=180

echo "==> Waiting for $URL/health (pid=$SERVER_PID, deadline=${HEALTH_DEADLINE}s)"
for i in $(seq 1 "$HEALTH_DEADLINE"); do
  if curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null | grep -q "^200$"; then
    echo "==> server up after ${i}s"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "==> server died during startup. Last log lines:" >&2
    tail -40 "$LOG" >&2
    exit 6
  fi
  sleep 1
done

if ! curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null | grep -q "^200$"; then
  echo "==> server failed health within ${HEALTH_DEADLINE}s. Log:" >&2
  tail -60 "$LOG" >&2
  exit 7
fi

echo "==> Running bench client → $OUT"
python3 "$CLIENT" --url "$URL" --out "$OUT"

echo "==> wrote $OUT (server log: $LOG)"
