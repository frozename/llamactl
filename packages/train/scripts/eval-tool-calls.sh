#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage:
  bash packages/train/scripts/eval-tool-calls.sh
EOF
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
gold_turn = (row.get("messages") or [{}])[-1]
gold_calls = gold_turn.get("tool_calls") or []
gold_content = gold_turn.get("content") or ""
message = resp.get("choices", [{}])[0].get("message", {})
tool_calls = message.get("tool_calls") or []
content = message.get("content") or ""

positive = bool(gold_calls)
if positive:
    def canonicalize(args: str) -> str:
        try:
            return json.dumps(json.loads(args), sort_keys=True, separators=(",", ":"))
        except Exception:
            return args.strip()

    args_ok = len(tool_calls) == len(gold_calls)
    success = len(tool_calls) == len(gold_calls)
    if success:
        for predicted_call, gold_call in zip(tool_calls, gold_calls):
            predicted_function = predicted_call.get("function", {})
            gold_function = gold_call.get("function", {})
            if predicted_function.get("name") != gold_function.get("name"):
                success = False
                args_ok = False
                break
            if canonicalize(predicted_function.get("arguments", "")) != canonicalize(gold_function.get("arguments", "")):
                success = False
                args_ok = False
                break
else:
    success = not tool_calls and bool(content.strip())
    args_ok = False

predicted_name = tool_calls[0].get("function", {}).get("name") if tool_calls else ""
predicted_args = tool_calls[0].get("function", {}).get("arguments", "") if tool_calls else ""
gold_name = gold_calls[0].get("function", {}).get("name") if gold_calls else ""
gold_args = gold_calls[0].get("function", {}).get("arguments", "") if gold_calls else ""

print(json.dumps({
    "positive": positive,
    "success": success,
    "args_ok": args_ok,
    "predicted_name": predicted_name,
    "predicted_args": predicted_args,
    "predicted_content": content,
    "gold_name": gold_name,
    "gold_args": gold_args,
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

  wait_for_health "$PORT" 60
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
  echo "See base.jsonl / adapter.jsonl for raw responses."
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
  echo "### Row Debug Table"
  echo
  python3 - "$OUT_DIR/base.jsonl" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
for line in path.read_text().splitlines():
    if not line.strip():
        continue
    row = json.loads(line)
    score = row["score"]
    if score["positive"]:
        print(f"- {score['gold_name']} | {score['predicted_name']} | {'Y' if score['args_ok'] else 'N'}")
    else:
        print(f"- - | - | {'Y' if score['success'] else 'N'}")
PY
  echo
  echo "## Wall Time"
  echo
  echo "- base and adapter runs completed sequentially in this shell."
} >> "$REPORT_FILE"
