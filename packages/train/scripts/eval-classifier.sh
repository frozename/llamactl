#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash packages/train/scripts/eval-classifier.sh <BASE_GGUF> <ADAPTER_GGUF> <TEST_JSONL> <OUT_DIR>
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ "$#" -ne 4 ]]; then
  usage
  die "expected 4 arguments"
fi

BASE_GGUF=$1
ADAPTER_GGUF=$2
TEST_JSONL=$3
OUT_DIR=$4

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

PREDICTIONS_BASE="$OUT_DIR/predictions-base.jsonl"
PREDICTIONS_ADAPTER="$OUT_DIR/predictions-adapter.jsonl"
EVAL_REPORT="$OUT_DIR/EVAL_REPORT.md"
SERVER_LOG_BASE="$OUT_DIR/server-base.log"
SERVER_LOG_ADAPTER="$OUT_DIR/server-adapter.log"
SERVER_PORT=18099
N_PREDICT=${N_PREDICT:-250}
TEMPERATURE=0.0
WRAP_CHAT_TEMPLATE=${WRAP_CHAT_TEMPLATE:-0}
FRAMING=${FRAMING:-binary}
MAX_WAIT_SECONDS=180

SERVER_PID=
SERVER_LOG_FILE=
CURRENT_LABEL=

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
    fi
    SERVER_PID=
  fi
}

trap cleanup EXIT INT TERM

canonical_or_fallback() {
  local target=$1
  if command -v realpath >/dev/null 2>&1; then
    realpath "$target" 2>/dev/null || echo "$target"
  else
    echo "$target"
  fi
}

kill_port() {
  local pids
  pids="$(lsof -ti ":$SERVER_PORT" || true)"
  if [[ -n "$pids" ]]; then
    printf '%s\n' "$pids" | xargs -r kill -TERM
    for _ in $(seq 1 20); do
      if ! lsof -ti ":$SERVER_PORT" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    if lsof -ti ":$SERVER_PORT" >/dev/null 2>&1; then
      pids="$(lsof -ti ":$SERVER_PORT" || true)"
      if [[ -n "$pids" ]]; then
        printf '%s\n' "$pids" | xargs -r kill -9
      fi
    fi
  fi

  wait_port_bindable
}

wait_port_bindable() {
  local tries=0
  local max_tries=60

  until python3 -c "
import socket
import sys

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(('127.0.0.1', $SERVER_PORT))
    s.close()
except OSError:
    sys.exit(1)
" 2>/dev/null; do
    tries=$((tries + 1))
    if [[ "$tries" -ge "$max_tries" ]]; then
      die "port ${SERVER_PORT} did not become bindable after ${max_tries}s"
    fi
    sleep 1
  done
}

wait_for_health() {
  local tries=0
  local max_tries=$((MAX_WAIT_SECONDS))

  until curl -fsS "http://127.0.0.1:${SERVER_PORT}/health" >/dev/null; do
    tries=$((tries + 1))
    if [[ "$tries" -ge "$max_tries" ]]; then
      die "llama-server did not become healthy for ${CURRENT_LABEL} run"
    fi
    sleep 1
  done
}

verify_server_model() {
  local expected=$1
  local log_file=$2

  if ! props=$(curl -fsS "http://127.0.0.1:${SERVER_PORT}/props"); then
    die "failed to fetch /props for ${CURRENT_LABEL} run"
  fi

  local expected_resolved
  local props_model
  local props_resolved
  local expected_base

  expected_resolved="$(canonical_or_fallback "$expected")"
  expected_base="$(basename "$expected")"

  props_model="$(printf '%s' "$props" | jq -r '.model // .model_path // .default_model // empty')"
  if [[ -n "$props_model" && "$props_model" != "null" ]]; then
    props_resolved="$(canonical_or_fallback "$props_model")"
    if [[ "$props_model" != "$expected" && "$props_resolved" != "$expected_resolved" && "$(basename "$props_model")" != "$expected_base" ]]; then
      die "model verification failed for ${CURRENT_LABEL} run: /props=$props_model expected=$expected"
    fi
  elif ! grep -qF "$expected_base" "$log_file"; then
    die "cannot verify loaded model path for ${CURRENT_LABEL} run"
  fi

  if ! grep -qF "$expected" "$log_file" && ! grep -qF "$expected_base" "$log_file"; then
    die "server log does not contain expected model path for ${CURRENT_LABEL} run"
  fi
}

verify_port_owner() {
  local expected_pid=$1
  local log_file=$2

  local pids
  pids="$(lsof -ti ":$SERVER_PORT" || true)"
  if [[ -z "$pids" ]]; then
    die "port ${SERVER_PORT} is not bound for ${CURRENT_LABEL} run"
  fi

  local bound_pid
  bound_pid="$(printf '%s\n' "$pids" | head -n1)"
  if [[ "$bound_pid" != "$expected_pid" ]]; then
    die "port ${SERVER_PORT} bound by unexpected pid ${bound_pid} for ${CURRENT_LABEL} run"
  fi

  local proc_state
  proc_state="$(ps -o stat= -p "$bound_pid" 2>/dev/null | tr -d ' ' || true)"
  if [[ -n "$proc_state" && "${proc_state:0:1}" == "Z" ]]; then
    die "port ${SERVER_PORT} bound by zombie process ${bound_pid} for ${CURRENT_LABEL} run"
  fi

  if ! grep -qF "$expected_pid" "$log_file"; then
    :
  fi
}

extract_first_json_object() {
  printf '%s' "$1" | python3 -c '
import sys

text = sys.stdin.read()
start = None
depth = 0
in_string = False
escape = False

for i, ch in enumerate(text):
    if start is None:
        if ch == "{":
            start = i
            depth = 1
        continue

    if in_string:
        if escape:
            escape = False
        elif ch == "\\":
            escape = True
        elif ch == "\"":
            in_string = False
        continue

    if ch == "\"":
        in_string = True
    elif ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            print(text[start : i + 1])
            raise SystemExit(0)
'
}

normalize_bool() {
  case "${1:-}" in
    true|TRUE|True|1) echo "true" ;;
    false|FALSE|False|0) echo "false" ;;
    *) echo "" ;;
  esac
}

wrap_chat_template() {
  local prompt=$1
  python3 - "$prompt" <<'PY'
import sys

prompt = sys.argv[1]
sys.stdout.write(
    "<|im_start|>user\n"
    f"{prompt}<|im_end|>\n"
    "<|im_start|>assistant\n"
    "<think>\n\n"
    "</think>\n\n"
)
PY
}

extract_gold() {
  printf '%s\n' "$1" | jq -r '
    if has("memory_related") then .memory_related
    elif has("gold") then .gold
    elif has("label") then .label
    elif (.completion | type) == "string" then (try (.completion | fromjson | if has("memory_related") then .memory_related else empty end) catch empty)
    else empty
    end
  '
}

extract_gold_4way() {
  printf '%s\n' "$1" | jq -r '
    if has("classification") then .classification
    elif has("gold") then .gold
    elif has("label") then .label
    elif (.completion | type) == "string" then (try (.completion | fromjson | if has("classification") then .classification else empty end) catch empty)
    elif (.messages | type) == "array" then (try (.messages | map(select(.role == "assistant")) | .[0].content | fromjson | if has("classification") then .classification else empty end) catch empty)
    else empty
    end
  '
}

extract_pred_from_response_obj() {
  local response_obj=$1

  local pred_raw=""
  local outer=""
  local content=""
  local inner=""

  outer="$(printf '%s' "$response_obj" | jq -c . 2>/dev/null || true)"
  if [[ -n "$outer" ]]; then
    pred_raw="$(printf '%s' "$outer" | jq -r '
      (if has("memory_related") then .memory_related else empty end) //
      (try (.completion | fromjson | if has("memory_related") then .memory_related else empty end) catch empty) //
      empty
    ' 2>/dev/null || true)"
    if [[ -n "$pred_raw" ]]; then
      printf '%s' "$pred_raw"
      return 0
    fi

    content="$(printf '%s' "$outer" | jq -r '.content // ""' 2>/dev/null || true)"
    if [[ -n "$content" ]]; then
      inner="$(printf '%s' "$content" | python3 -c '
import re
import sys

text = sys.stdin.read()
match = re.search(r"\{(?:[^{}\"]|\"(?:\\.|[^\"])*\")*\}", text, re.S)
print(match.group(0) if match else "")
')"
      if [[ -n "$inner" ]]; then
        pred_raw="$(printf '%s' "$inner" | jq -r 'if has("memory_related") then .memory_related else empty end' 2>/dev/null || true)"
        if [[ -n "$pred_raw" ]]; then
          printf '%s' "$pred_raw"
          return 0
        fi
      fi
    fi
  fi

  pred_raw="$(printf '%s' "$response_obj" | jq -r '
    (if has("memory_related") then .memory_related else empty end) //
    (try (.completion | fromjson | if has("memory_related") then .memory_related else empty end) catch empty) //
    (try (.content | fromjson | if has("memory_related") then .memory_related else empty end) catch empty) //
    (try (fromjson | if has("memory_related") then .memory_related else empty end) catch empty) //
    empty
  ' 2>/dev/null || true)"

  printf '%s' "$pred_raw"
}

extract_pred_4way_from_response_obj() {
  local response_obj=$1

  local pred_raw=""
  local outer=""
  local content=""
  local inner=""

  outer="$(printf '%s' "$response_obj" | jq -c . 2>/dev/null || true)"
  if [[ -n "$outer" ]]; then
    pred_raw="$(printf '%s' "$outer" | jq -r '
      (if has("classification") then .classification else empty end) //
      (try (.completion | fromjson | if has("classification") then .classification else empty end) catch empty) //
      empty
    ' 2>/dev/null || true)"
    if [[ -n "$pred_raw" ]]; then
      printf '%s' "$pred_raw"
      return 0
    fi

    content="$(printf '%s' "$outer" | jq -r '.content // ""' 2>/dev/null || true)"
    if [[ -n "$content" ]]; then
      inner="$(printf '%s' "$content" | python3 -c '
import re
import sys

text = sys.stdin.read()
match = re.search(r"\{(?:[^{}\"]|\"(?:\\.|[^\"])*\")*\}", text, re.S)
print(match.group(0) if match else "")
')"
      if [[ -n "$inner" ]]; then
        pred_raw="$(printf '%s' "$inner" | jq -r 'if has("classification") then .classification else empty end' 2>/dev/null || true)"
        if [[ -n "$pred_raw" ]]; then
          printf '%s' "$pred_raw"
          return 0
        fi
      fi
    fi
  fi

  pred_raw="$(printf '%s' "$response_obj" | jq -r '
    (if has("classification") then .classification else empty end) //
    (try (.completion | fromjson | if has("classification") then .classification else empty end) catch empty) //
    (try (.content | fromjson | if has("classification") then .classification else empty end) catch empty) //
    (try (fromjson | if has("classification") then .classification else empty end) catch empty) //
    empty
  ' 2>/dev/null || true)"

  printf '%s' "$pred_raw"
}

normalize_classification() {
  case "${1:-}" in
    missed_registration|recall_miss|memory_ignored|not_memory_related) echo "$1" ;;
    *) echo "" ;;
  esac
}

run_completion_eval() {
  local model=$1
  local lora=$2
  local out_file=$3
  local label=$4

  CURRENT_LABEL=$label
  local log_file="$OUT_DIR/server-${label}.log"
  local class_metrics_file="$OUT_DIR/${label}-class-metrics.tsv"
  SERVER_LOG_FILE=$log_file

  rm -f "$out_file"
  rm -f "$class_metrics_file"

  kill_port
  rm -f "$log_file"

  local lora_args=()
  if [[ -n "$lora" ]]; then
    lora_args+=("--lora" "$lora")
  fi

  local cmd=("$LLAMA_SERVER_BIN" --port "$SERVER_PORT" --host 127.0.0.1 --model "$model" "${lora_args[@]}")
  "${cmd[@]}" >"$log_file" 2>&1 &
  SERVER_PID=$!

  sleep 1
  wait_for_health
  verify_port_owner "$SERVER_PID" "$log_file"
  verify_server_model "$model" "$log_file"

  if [[ -n "$lora" ]]; then
    if ! grep -q "llama_adapter_lora_init_impl: loading lora adapter" "$log_file"; then
      die "missing adapter init marker in adapter run server log"
    fi
  fi

  local idx=0
  local total=0
  local parsed_count=0
  local correct=0
  local tp=0
  local fp=0
  local fn=0
  local tn=0
  local classes=(missed_registration recall_miss memory_ignored not_memory_related)
  local -A class_tp=()
  local -A class_fp=()
  local -A class_fn=()
  local rows
  local row
  local row_index=0

  mapfile -t rows < "$TEST_JSONL"

  for row in "${rows[@]}"; do
    row_index=$((row_index + 1))
    idx=$((idx + 1))
    total=$((total + 1))

    local prompt
    local gold
    local pred_raw=""
    local parsed=false
    local pred=""
    local pred_norm=""
    local gold_norm=""
    local response
    local response_file
    local http_code
    local model_text=""
    local raw_response=""
    local payload
    local response_obj

    prompt="$(printf '%s\n' "$row" | jq -r '.prompt // .input // empty')"
    if [[ -z "$prompt" ]]; then
      prompt="$(printf '%s\n' "$row" | jq -r '.text // empty')"
    fi
    if [[ -z "$prompt" ]]; then
      prompt="$(printf '%s\n' "$row" | jq -r '.messages // [] | map(select(.role == "user")) | .[0].content // empty')"
    fi
    if [[ "$WRAP_CHAT_TEMPLATE" == "1" ]]; then
      prompt="$(wrap_chat_template "$prompt")"
    fi

    if [[ "$FRAMING" == "4way" ]]; then
      gold="$(extract_gold_4way "$row")"
      gold_norm="$(normalize_classification "$gold")"
    else
      gold="$(extract_gold "$row")"
      gold_norm="$(normalize_bool "$gold")"
    fi

    payload="$(jq -n --arg p "$prompt" --argjson n "$N_PREDICT" --argjson t "$TEMPERATURE" '{prompt: $p, n_predict: $n, temperature: $t, cache_prompt: true}')"

    response=""
    http_code=""
    delay=1
    for _ in $(seq 1 6); do
      response_file="$(mktemp)"
      http_code="$(curl -sS -w '%{http_code}' -o "$response_file" -H 'Content-Type: application/json' -d "$payload" "http://127.0.0.1:${SERVER_PORT}/completion")"
      response="$(cat "$response_file")"
      rm -f "$response_file"
      if [[ "$http_code" == "200" ]]; then
        break
      fi
      if [[ "$http_code" == "503" ]]; then
        sleep "$delay"
        if [[ "$delay" -lt 8 ]]; then
          delay=$(( delay * 2 ))
          if [[ "$delay" -gt 8 ]]; then
            delay=8
          fi
        fi
        continue
      fi
      break
    done
    if [[ "$http_code" != "200" ]]; then
      response=""
    fi

    raw_response="$response"

    response_obj="$(extract_first_json_object "$response")"
    if [[ -n "$response_obj" ]]; then
      if [[ "$FRAMING" == "4way" ]]; then
        pred_raw="$(extract_pred_4way_from_response_obj "$response_obj")"
      else
        pred_raw="$(extract_pred_from_response_obj "$response_obj")"
      fi
      model_text="$(printf '%s' "$response_obj" | jq -r '
        .content // .completion // empty
      ' 2>/dev/null || true)"
    fi
    if [[ "$FRAMING" == "4way" ]]; then
      pred_norm="$(normalize_classification "$pred_raw")"
    else
      pred_norm="$(normalize_bool "$pred_raw")"
    fi

    if [[ -n "$pred_norm" ]]; then
      parsed=true
      parsed_count=$((parsed_count + 1))
    fi

    if [[ "$parsed" == "true" && -n "$gold_norm" ]]; then
      if [[ "$pred_norm" == "$gold_norm" ]]; then
        correct=$((correct + 1))
      fi

      if [[ "$FRAMING" == "4way" ]]; then
        for class in "${classes[@]}"; do
          if [[ "$pred_norm" == "$class" && "$gold_norm" == "$class" ]]; then
            class_tp["$class"]=$(( ${class_tp["$class"]:-0} + 1 ))
          elif [[ "$pred_norm" == "$class" && "$gold_norm" != "$class" ]]; then
            class_fp["$class"]=$(( ${class_fp["$class"]:-0} + 1 ))
          elif [[ "$pred_norm" != "$class" && "$gold_norm" == "$class" ]]; then
            class_fn["$class"]=$(( ${class_fn["$class"]:-0} + 1 ))
          fi
        done
      else
        if [[ "$pred_norm" == "true" && "$gold_norm" == "true" ]]; then
          tp=$((tp + 1))
        elif [[ "$pred_norm" == "true" && "$gold_norm" == "false" ]]; then
          fp=$((fp + 1))
        elif [[ "$pred_norm" == "false" && "$gold_norm" == "true" ]]; then
          fn=$((fn + 1))
        else
          tn=$((tn + 1))
        fi
      fi
    fi

    local pred_json
    if [[ "$FRAMING" == "4way" ]]; then
      pred_json="$(jq -nc \
        --argjson i "$idx" \
        --arg gold "$gold_norm" \
        --arg parsed "$parsed" \
        --arg pred "$pred_norm" \
        --arg http_code "$http_code" \
        --arg model_text "$model_text" \
        --arg raw_response "$raw_response" \
        '{idx: $i, gold: $gold, parsed: ($parsed == "true"), pred: $pred, http_code: $http_code, model_text: $model_text, raw_response: $raw_response}')"
    else
      pred_json="$(jq -nc \
        --argjson i "$idx" \
        --arg gold "$gold_norm" \
        --arg parsed "$parsed" \
        --arg pred "$pred_norm" \
        --arg http_code "$http_code" \
        --arg model_text "$model_text" \
        --arg raw_response "$raw_response" \
        '{idx: $i, gold: (if $gold == "true" then true elif $gold == "false" then false else null end), parsed: ($parsed == "true"), pred: (if $pred == "true" then true elif $pred == "false" then false else null end), http_code: $http_code, model_text: $model_text, raw_response: $raw_response}')"
    fi
    printf '%s\n' "$pred_json" >>"$out_file"
  done

  if [[ "$total" -eq 0 ]]; then
    die "empty test file: $TEST_JSONL"
  fi

  kill -9 "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID=

  local accuracy precision recall f1 parse_rate macro_f1
  local pos_count
  local pos_in_gold
  if [[ "$FRAMING" == "4way" ]]; then
    accuracy="$(awk -v c="$correct" -v t="$total" 'BEGIN { printf "%.4f", c / t }')"
    macro_f1="0.0000"
    local class_lines=()
    local class
    for class in "${classes[@]}"; do
      local ctp cfp cfn cprec crec cf1
      ctp=${class_tp["$class"]:-0}
      cfp=${class_fp["$class"]:-0}
      cfn=${class_fn["$class"]:-0}
      if [[ "$ctp" -eq 0 && "$cfp" -eq 0 ]]; then
        cprec="0.0000"
      else
        cprec="$(awk -v tp="$ctp" -v fp="$cfp" 'BEGIN { printf "%.4f", tp / (tp + fp) }')"
      fi
      if [[ "$ctp" -eq 0 && "$cfn" -eq 0 ]]; then
        crec="0.0000"
      else
        crec="$(awk -v tp="$ctp" -v fn="$cfn" 'BEGIN { printf "%.4f", tp / (tp + fn) }')"
      fi
      if [[ "$(awk -v p="$cprec" -v r="$crec" 'BEGIN { if ((p + r) == 0) print "1"; else print "0" }')" == "1" ]]; then
        cf1="0.0000"
      else
        cf1="$(awk -v p="$cprec" -v r="$crec" 'BEGIN { printf "%.4f", (2 * p * r) / (p + r) }')"
      fi
      macro_f1="$(awk -v a="$macro_f1" -v b="$cf1" 'BEGIN { printf "%.4f", a + b }')"
      class_lines+=("$class|$ctp|$cfp|$cfn|$cprec|$crec|$cf1")
    done
    macro_f1="$(awk -v s="$macro_f1" 'BEGIN { printf "%.4f", s / 4 }')"
    printf '%s\n' "${class_lines[@]}" >"$class_metrics_file"
    precision="$macro_f1"
    recall="$macro_f1"
    f1="$macro_f1"
    pos_count=0
  else
    pos_count=$((tp + fn))
    if [[ "$total" -eq 0 ]]; then
      accuracy="0.0000"
    else
      accuracy="$(awk -v c="$correct" -v t="$total" 'BEGIN { printf "%.4f", c / t }')"
    fi
    if [[ "$tp" -eq 0 && "$fp" -eq 0 ]]; then
      precision="0.0000"
    else
      precision="$(awk -v tp="$tp" -v fp="$fp" 'BEGIN { printf "%.4f", tp / (tp + fp) }')"
    fi
    if [[ "$tp" -eq 0 && "$fn" -eq 0 ]]; then
      recall="0.0000"
    else
      recall="$(awk -v tp="$tp" -v fn="$fn" 'BEGIN { printf "%.4f", tp / (tp + fn) }')"
    fi
    if [[ "$(awk -v p="$precision" -v r="$recall" 'BEGIN { if ((p + r) == 0) print "1"; else print "0" }')" == "1" ]]; then
      f1="0.0000"
    else
      f1="$(awk -v p="$precision" -v r="$recall" 'BEGIN { printf "%.4f", (2 * p * r) / (p + r) }')"
    fi
    macro_f1="$f1"
  fi
  parse_rate="$(awk -v p="$parsed_count" -v t="$total" 'BEGIN { printf "%.4f", p / t }')"

  if [[ "$FRAMING" == "4way" ]]; then
    printf '%s\n' "$parsed_count|$correct|$accuracy|$macro_f1|$parse_rate|$total|$idx|${class_lines[*]}"
  else
    printf '%s\n' "$parsed_count|$correct|$tp|$fp|$fn|$accuracy|$precision|$recall|$f1|$parse_rate|$total|$idx|$pos_count"
  fi
}

collect_disagreements() {
  local base_file=$1
  local adapter_file=$2
  local max_items=5
  local count=0

  while IFS=$'\t' read -r base_line adapter_line; do
    local idx
    local gold
    local base_pred
    local adapter_pred
    local base_model_text
    local adapter_model_text
    local base_model_text_json
    local adapter_model_text_json
    idx="$(printf '%s' "$base_line" | jq -r '.idx')"
    gold="$(printf '%s' "$base_line" | jq -r '.gold // null')"
    base_pred="$(printf '%s' "$base_line" | jq -r '.pred // null')"
    adapter_pred="$(printf '%s' "$adapter_line" | jq -r '.pred // null')"
    base_model_text="$(printf '%s' "$base_line" | jq -r '.model_text // ""')"
    adapter_model_text="$(printf '%s' "$adapter_line" | jq -r '.model_text // ""')"
    base_model_text_json="$(printf '%s' "$base_model_text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()[:300]))')"
    adapter_model_text_json="$(printf '%s' "$adapter_model_text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()[:300]))')"

    if [[ "$base_pred" != "$adapter_pred" ]]; then
      printf '%s\n' "[$idx, $gold, $base_pred, $adapter_pred, $base_model_text_json, $adapter_model_text_json]"
      count=$((count + 1))
      if [[ "$count" -ge "$max_items" ]]; then
        break
      fi
    fi
  done < <(paste "$base_file" "$adapter_file")
}

echo "running adapter eval..."
read -r ADAPTER_METRICS <<<"$(run_completion_eval "$BASE_GGUF" "$ADAPTER_GGUF" "$PREDICTIONS_ADAPTER" adapter)"

read -r BASE_METRICS <<<"$(run_completion_eval "$BASE_GGUF" "" "$PREDICTIONS_BASE" base)"

if [[ "$FRAMING" == "4way" ]]; then
  IFS='|' read -r ADP_PARSED ADP_CORRECT ADP_ACC ADP_F1 ADP_PARSE_RATE ADP_TOTAL ADP_IDX ADP_CLASSES <<<"$ADAPTER_METRICS"
  IFS='|' read -r BASE_PARSED BASE_CORRECT BASE_ACC BASE_F1 BASE_PARSE_RATE BASE_TOTAL BASE_IDX BASE_CLASSES <<<"$BASE_METRICS"
else
  IFS='|' read -r ADP_PARSED ADP_CORRECT ADP_TP ADP_FP ADP_FN ADP_ACC ADP_PREC ADP_RECALL ADP_F1 ADP_PARSE_RATE ADP_TOTAL ADP_IDX ADP_POS <<<"$ADAPTER_METRICS"
  IFS='|' read -r BASE_PARSED BASE_CORRECT BASE_TP BASE_FP BASE_FN BASE_ACC BASE_PREC BASE_RECALL BASE_F1 BASE_PARSE_RATE BASE_TOTAL BASE_IDX BASE_POS <<<"$BASE_METRICS"
fi

if [[ "$ADP_TOTAL" -ne "$BASE_TOTAL" ]]; then
  die "row count mismatch between runs: adapter=$ADP_TOTAL base=$BASE_TOTAL"
fi

DELTA_ACC="$(awk -v a="$ADP_ACC" -v b="$BASE_ACC" 'BEGIN { printf "%.4f", a - b }')"
DELTA_F1="$(awk -v a="$ADP_F1" -v b="$BASE_F1" 'BEGIN { printf "%.4f", a - b }')"
DELTA_PARSE="$(awk -v a="$ADP_PARSE_RATE" -v b="$BASE_PARSE_RATE" 'BEGIN { printf "%.4f", a - b }')"
if [[ "$FRAMING" != "4way" ]]; then
  DELTA_PREC="$(awk -v a="$ADP_PREC" -v b="$BASE_PREC" 'BEGIN { printf "%.4f", a - b }')"
  DELTA_RECALL="$(awk -v a="$ADP_RECALL" -v b="$BASE_RECALL" 'BEGIN { printf "%.4f", a - b }')"
fi

if [[ "$FRAMING" == "4way" ]]; then
  POSITIVE_COUNT="$(jq -r 'if has("classification") then .classification elif has("gold") then .gold elif has("label") then .label elif (.completion | type) == "string" then (try (.completion | fromjson | if has("classification") then .classification else empty end) catch empty) else empty end' "$TEST_JSONL" | awk 'NF{p++} END {print p+0}')"
  NEGATIVE_COUNT="0"
else
  POSITIVE_COUNT="$(jq -r 'if has("memory_related") then .memory_related elif has("gold") then .gold elif has("label") then .label elif (.completion | type) == "string" then (try (.completion | fromjson | if has("memory_related") then .memory_related else empty end) catch empty) else empty end' "$TEST_JSONL" | awk 'tolower($0)=="true"{p++} END {print p+0}')"
  NEGATIVE_COUNT="$(jq -r 'if has("memory_related") then .memory_related elif has("gold") then .gold elif has("label") then .label elif (.completion | type) == "string" then (try (.completion | fromjson | if has("memory_related") then .memory_related else empty end) catch empty) else empty end' "$TEST_JSONL" | awk 'tolower($0)=="false"{n++} END {print n+0}')"
fi

BASE_SIZE=$(stat -f %z "$BASE_GGUF")
BASE_MTIME=$(stat -f '%Sm' "$BASE_GGUF")
ADAPTER_SIZE=$(stat -f %z "$ADAPTER_GGUF")
ADAPTER_MTIME=$(stat -f '%Sm' "$ADAPTER_GGUF")

cat >"$EVAL_REPORT" <<EOF
# Memory-efficacy ${FRAMING} classifier eval

## Setup
- Base GGUF: $BASE_GGUF
- Adapter GGUF: $ADAPTER_GGUF (size=$ADAPTER_SIZE, mtime=$ADAPTER_MTIME)
- Test rows: $BASE_TOTAL (${POSITIVE_COUNT:-0} positive / ${NEGATIVE_COUNT:-0} negative)
- llama-server: $LLAMA_SERVER_BIN
- n_predict: $N_PREDICT, temperature: $TEMPERATURE
- WRAP_CHAT_TEMPLATE: $WRAP_CHAT_TEMPLATE

## Results
EOF
if [[ "$FRAMING" == "4way" ]]; then
cat >>"$EVAL_REPORT" <<EOF
|        | accuracy | macro-F1 | parse rate |
|--------|----------|----------|------------|
| base   | $BASE_ACC | $BASE_F1 | $BASE_PARSE_RATE |
| adapter| $ADP_ACC | $ADP_F1 | $ADP_PARSE_RATE |
| delta  | $DELTA_ACC | $DELTA_F1 | $DELTA_PARSE |

## Per-class metrics
EOF
  {
    echo "| class | base P | base R | base F1 | adapter P | adapter R | adapter F1 |"
    echo "|-------|--------|--------|---------|-----------|-----------|------------|"
    paste "$OUT_DIR/base-class-metrics.tsv" "$OUT_DIR/adapter-class-metrics.tsv" | while IFS=$'\t' read -r base_line adapter_line; do
      # Emit shape (line 625): class|tp|fp|fn|prec|rec|f1 → fields 5/6/7 are P/R/F1.
      base_class="$(printf '%s' "$base_line" | cut -d'|' -f1)"
      base_prec="$(printf '%s' "$base_line" | cut -d'|' -f5)"
      base_rec="$(printf '%s' "$base_line" | cut -d'|' -f6)"
      base_f1="$(printf '%s' "$base_line" | cut -d'|' -f7)"
      adapter_prec="$(printf '%s' "$adapter_line" | cut -d'|' -f5)"
      adapter_rec="$(printf '%s' "$adapter_line" | cut -d'|' -f6)"
      adapter_f1="$(printf '%s' "$adapter_line" | cut -d'|' -f7)"
      echo "| $base_class | $base_prec | $base_rec | $base_f1 | $adapter_prec | $adapter_rec | $adapter_f1 |"
    done
  } >>"$EVAL_REPORT"
else
cat >>"$EVAL_REPORT" <<EOF
|        | accuracy | precision (T) | recall (T) | F1 (T) | parse rate |
|--------|----------|---------------|------------|--------|------------|
| base   | $BASE_ACC | $BASE_PREC | $BASE_RECALL | $BASE_F1 | $BASE_PARSE_RATE |
| adapter| $ADP_ACC | $ADP_PREC | $ADP_RECALL | $ADP_F1 | $ADP_PARSE_RATE |
| delta  | $DELTA_ACC | $DELTA_PREC | $DELTA_RECALL | $DELTA_F1 | $DELTA_PARSE |
EOF
fi

{
  echo
  echo "## Sample disagreements (first 5 rows where adapter ≠ base)"
  echo '```'
  collect_disagreements "$PREDICTIONS_BASE" "$PREDICTIONS_ADAPTER" | sed -n '1,5p'
  echo '```'
} >>"$EVAL_REPORT"

echo "Wrote $EVAL_REPORT"
cat "$EVAL_REPORT"
echo "Adapter run log: $SERVER_LOG_ADAPTER"
echo "Base run log: $SERVER_LOG_BASE"
