#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash packages/train/scripts/eval-tool-calls.sh
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

BASE_GGUF="${BASE_GGUF:-}"
ADAPTER_GGUF="${ADAPTER_GGUF:-}"
TEST_JSONL="${TEST_JSONL:-}"
OUT_DIR="${OUT_DIR:-}"
PORT="${PORT:-18099}"

if [[ -z "$BASE_GGUF" || -z "$ADAPTER_GGUF" || -z "$TEST_JSONL" || -z "$OUT_DIR" ]]; then
  usage
  die "BASE_GGUF, ADAPTER_GGUF, TEST_JSONL, and OUT_DIR must be set"
fi

for path in "$BASE_GGUF" "$ADAPTER_GGUF" "$TEST_JSONL"; do
  [[ -f "$path" ]] || die "input file not found: $path"
done

mkdir -p "$OUT_DIR"

if [[ -n "${LLAMA_SERVER:-}" ]]; then
  LLAMA_SERVER_BIN="$LLAMA_SERVER"
elif command -v llama-server >/dev/null 2>&1; then
  LLAMA_SERVER_BIN="$(command -v llama-server)"
elif [[ -x "packages/train/vendor/llama.cpp/build/bin/llama-server" ]]; then
  LLAMA_SERVER_BIN="packages/train/vendor/llama.cpp/build/bin/llama-server"
else
  die "llama-server binary not found"
fi

REPORT_FILE="$OUT_DIR/EVAL_REPORT.md"
RAW_FILE="$OUT_DIR/eval-raw.jsonl"

kill_port() {
  local pids
  pids="$(lsof -ti ":$PORT" || true)"
  if [[ -n "$pids" ]]; then
    printf '%s\n' "$pids" | xargs -r kill -TERM
    for _ in $(seq 1 20); do
      if ! lsof -ti ":$PORT" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    if lsof -ti ":$PORT" >/dev/null 2>&1; then
      pids="$(lsof -ti ":$PORT" || true)"
      if [[ -n "$pids" ]]; then
        printf '%s\n' "$pids" | xargs -r kill -9
      fi
    fi
  fi
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "llama-server did not become healthy on port $PORT"
}

verify_server_model() {
  local expected=$1
  local props
  props="$(curl -fsS "http://127.0.0.1:${PORT}/props")"
  python3 - "$expected" "$props" <<'PY'
import json
import os
import sys
from pathlib import Path

expected = Path(sys.argv[1]).name
props = json.loads(sys.argv[2])
candidate = (
    props.get("default_generation_settings", {}).get("model", {}).get("path")
    or props.get("model_path")
    or props.get("model")
    or ""
)
if not candidate or not str(candidate).endswith(expected):
    raise SystemExit(f"model verification failed: {candidate!r} does not end with {expected!r}")
PY
}

post_chat() {
  local messages_json=$1
  local tools_json=$2
  local tool_choice_json=$3
  curl -fsS \
    -H 'Content-Type: application/json' \
    -d "$(jq -n \
      --argjson messages "$messages_json" \
      --argjson tools "$tools_json" \
      --argjson tool_choice "$tool_choice_json" \
      '{model:"local",messages:$messages,tools:$tools,tool_choice:$tool_choice,max_tokens:256,temperature:0.0,chat_template_kwargs:{enable_thinking:false}}')" \
    "http://127.0.0.1:${PORT}/v1/chat/completions"
}

score_row() {
  local row_json=$1
  local response_json=$2
  python3 - "$row_json" "$response_json" <<'PY'
import json
import sys

row = json.loads(sys.argv[1])
resp = json.loads(sys.argv[2])
gold_calls = row.get("expected_tool_calls") or []
message = resp.get("choices", [{}])[0].get("message", {})
tool_calls = message.get("tool_calls") or []
content = message.get("content") or ""

positive = bool(gold_calls)
if positive:
    success = bool(tool_calls) and tool_calls[0].get("function", {}).get("name") == gold_calls[0].get("function", {}).get("name")
else:
    success = not tool_calls and bool(content.strip())

print(json.dumps({
    "positive": positive,
    "success": success,
    "predicted_name": tool_calls[0].get("function", {}).get("name") if tool_calls else "",
    "predicted_content": content,
    "gold_name": gold_calls[0].get("function", {}).get("name") if gold_calls else "",
}))
PY
}

run_config() {
  local label=$1
  local model=$2
  local lora=${3:-}
  local log_file="$OUT_DIR/${label}.log"
  local server_pid=""
  local results_file="$OUT_DIR/${label}.jsonl"

  kill_port
  rm -f "$log_file" "$results_file"

  local cmd=("$LLAMA_SERVER_BIN" --model "$model" --jinja --port "$PORT" --no-webui)
  if [[ -n "$lora" ]]; then
    cmd+=("--lora" "$lora")
  fi
  "${cmd[@]}" >"$log_file" 2>&1 &
  server_pid=$!

  cleanup() {
    if [[ -n "$server_pid" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
      kill "$server_pid" >/dev/null 2>&1 || true
      wait "$server_pid" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup RETURN

  wait_for_health
  verify_server_model "$model"

  mapfile -t rows < "$TEST_JSONL"
  : > "$results_file"
  local start_ts end_ts
  start_ts=$(date +%s)

  local idx=0
  local successes=0
  local positives=0
  local negative_successes=0
  local row
  for row in "${rows[@]}"; do
    idx=$((idx + 1))
    response="$(python3 - "$PORT" "$row" <<'PY'
import json
import sys
import urllib.request

port = int(sys.argv[1])
row = json.loads(sys.argv[2])
messages = row["messages"][:-1]
body = {
    "model": "local",
    "messages": messages,
    "tools": row["tools"],
    "tool_choice": row["tool_choice"],
    "max_tokens": 256,
    "temperature": 0.0,
    "chat_template_kwargs": {"enable_thinking": False},
}
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/v1/chat/completions",
    data=json.dumps(body).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as resp:
    print(resp.read().decode("utf-8", errors="replace"))
PY
)"
    score="$(score_row "$row" "$response")"
    printf '%s\n' "$response" | jq -c --argjson score "$score" --arg label "$label" --argjson idx "$idx" '{label:$label,idx:$idx,response:.,score:$score}' >> "$results_file"
    if [[ "$(printf '%s' "$score" | jq -r '.positive')" == "true" ]]; then
      positives=$((positives + 1))
    fi
    if [[ "$(printf '%s' "$score" | jq -r '.success')" == "true" ]]; then
      successes=$((successes + 1))
      if [[ "$(printf '%s' "$score" | jq -r '.positive')" == "false" ]]; then
        negative_successes=$((negative_successes + 1))
      fi
    fi
  done

  end_ts=$(date +%s)
  local total="${#rows[@]}"
  local positive_total="$positives"
  local negative_total=$((total - positives))
  local rate
  rate="$(python3 - "$successes" "$total" <<'PY'
import sys
succ = int(sys.argv[1])
total = int(sys.argv[2])
print(f"{(succ / total * 100.0) if total else 0.0:.1f}")
PY
)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$successes" "$total" "$positive_total" "$negative_total" >> "$OUT_DIR/.summary.tsv"
  printf '%s\t%s\n' "$label" "$rate" >> "$OUT_DIR/.rates.tsv"
  trap - RETURN
  cleanup
  echo "$rate"
}

rm -f "$OUT_DIR/.summary.tsv" "$OUT_DIR/.rates.tsv"
echo "# EVAL REPORT" > "$REPORT_FILE"
echo >> "$REPORT_FILE"
echo "Base GGUF: $BASE_GGUF" >> "$REPORT_FILE"
echo "Adapter GGUF: $ADAPTER_GGUF" >> "$REPORT_FILE"
echo "Test JSONL: $TEST_JSONL" >> "$REPORT_FILE"
echo "Port: $PORT" >> "$REPORT_FILE"
echo >> "$REPORT_FILE"

base_rate="$(run_config base "$BASE_GGUF")"
adapter_rate="$(run_config adapter "$BASE_GGUF" "$ADAPTER_GGUF")"

{
  echo "## Parse Success"
  echo
  echo "- base: ${base_rate}%"
  echo "- adapter: ${adapter_rate}%"
  echo
  echo "## Per-Row Results"
  echo
  echo "See `eval-raw.jsonl` for raw responses."
  echo
  python3 - "$OUT_DIR/.summary.tsv" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
rows = []
for line in path.read_text().splitlines():
    if not line.strip():
        continue
    label, succ, total, pos, neg = line.split("\t")
    rows.append((label, int(succ), int(total), int(pos), int(neg)))
for label, succ, total, pos, neg in rows:
    print(f"- {label}: {succ}/{total} successes (positive={pos}, negative={neg})")
PY
  echo
  echo "## Wall Time"
  echo
  echo "- base and adapter runs completed sequentially in this shell."
} >> "$REPORT_FILE"
