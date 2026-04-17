# =========================================================
# LLM / DEV STORAGE
# =========================================================

devstorage-status() {
  echo "WORKSSD:          $WORKSSD"
  echo "DEV_STORAGE:      $DEV_STORAGE"
  echo "DEV_STORAGE_MODE: $DEV_STORAGE_MODE"
  if [ -n "$DEV_STORAGE_REPAIR_BACKUP" ]; then
    echo "DEV_STORAGE_BACKUP: $DEV_STORAGE_REPAIR_BACKUP"
  fi
}

ollama-refresh-env() {
  launchctl setenv OLLAMA_MODELS "$HOME/DevStorage/ai-models/ollama"
  launchctl setenv OLLAMA_HOST "127.0.0.1:11434"
  echo "OLLAMA_MODELS=$(launchctl getenv OLLAMA_MODELS)"
  echo "OLLAMA_HOST=$(launchctl getenv OLLAMA_HOST)"
}

ollama-restart() {
  osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
  sleep 1

  if typeset -f devstorage_switch >/dev/null 2>&1; then
    devstorage_switch >/dev/null 2>&1
  elif [ -x "$HOME/bin/devstorage-switch" ]; then
    "$HOME/bin/devstorage-switch" >/dev/null 2>&1
  fi

  mkdir -p "$HOME/DevStorage/ai-models/ollama"
  launchctl setenv OLLAMA_MODELS "$HOME/DevStorage/ai-models/ollama"
  launchctl setenv OLLAMA_HOST "127.0.0.1:11434"

  open -a Ollama
}

ollama-status() {
  echo "OLLAMA_MODELS: $(launchctl getenv OLLAMA_MODELS)"
  echo "OLLAMA_HOST:   $(launchctl getenv OLLAMA_HOST)"
  curl -fsS http://127.0.0.1:11434 >/dev/null && echo "Ollama API: up" || echo "Ollama API: down"
}

ollama-models() {
  curl -fsS http://127.0.0.1:11434/api/tags
}

ollama-logs() {
  cat ~/.ollama/logs/server.log
}

ollama-chat() {
  local model="${1:-gemma3}"
  ollama run "$model"
}

ollama-api-test() {
  local model="${1:-gemma3}"
  curl http://127.0.0.1:11434/api/generate -d "{
    \"model\": \"$model\",
    \"prompt\": \"Say hello in one short sentence.\"
  }"
}

ollama-stop() {
  pkill -f ollama >/dev/null 2>&1 || true
  osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
}

ollama-start() {
  open -a Ollama
}

ollama-reload() {
  ollama-stop
  sleep 1
  ollama-restart
}

_llama_endpoint() {
  printf 'http://%s:%s\n' "$LLAMA_CPP_HOST" "$LLAMA_CPP_PORT"
}

_llama_model_path() {
  local model="$1"
  printf '%s/%s\n' "$LLAMA_CPP_MODELS" "$model"
}

_llama_require_model() {
  local model="$1"
  local model_path

  if [ -z "$model" ]; then
    return 1
  fi

  model_path="$(_llama_model_path "$model")"

  if [ ! -f "$model_path" ]; then
    echo "Model file not found: $model_path"
    return 1
  fi

  printf '%s\n' "$model_path"
}

_llama_list_runnable_models() {
  mkdir -p "$LLAMA_CPP_MODELS"

  find "$LLAMA_CPP_MODELS" -type f -iname '*.gguf' \
    ! -iname 'mmproj*.gguf' \
    ! -iname '*mmproj*' \
    ! -iname '*vision*' \
    ! -iname '*proj*' \
    | sort
}

_llama_print_content() {
  local response="$1"

  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$response" | jq -r '.choices[0].message.content // empty'
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$response" | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data.get("choices", [{}])[0].get("message", {}).get("content", ""))'
    return 0
  fi

  printf '%s\n' "$response"
}

_llama_escape_json() {
  local value="$1"

  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"

  printf '%s\n' "$value"
}

llama-src() {
  cd "$LLAMA_CPP_SRC" || return 1
}

llama-models-dir() {
  mkdir -p "$LLAMA_CPP_MODELS"
  echo "$LLAMA_CPP_MODELS"
}

llama-models() {
  _llama_list_runnable_models
}

llama-build() {
  cd "$LLAMA_CPP_SRC" || return 1
  cmake -B build -DCMAKE_BUILD_TYPE=Release
  cmake --build build --config Release -j
}

llama-rebuild() {
  cd "$LLAMA_CPP_SRC" || return 1
  rm -rf build
  cmake -B build -DCMAKE_BUILD_TYPE=Release
  cmake --build build --config Release -j
}

llama-update() {
  cd "$LLAMA_CPP_SRC" || return 1
  git pull --rebase
  llama-build
}

_llama_backup_root() {
  printf '%s\n' "$LLAMA_CPP_ROOT/.backups"
}

_llama_backup_binaries() {
  local backup_root="$(_llama_backup_root)"
  local timestamp
  local backup_dir
  local copied=0
  local bin

  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="$backup_root/$timestamp"

  mkdir -p "$backup_dir" || return 1

  for bin in llama-server llama-cli llama-bench; do
    if [ -x "$LLAMA_CPP_BIN/$bin" ]; then
      cp -p "$LLAMA_CPP_BIN/$bin" "$backup_dir/$bin" || return 1
      copied=1
    fi
  done

  if [ "$copied" -eq 0 ]; then
    rmdir "$backup_dir" >/dev/null 2>&1 || true
    return 0
  fi

  printf '%s\n' "$backup_dir"
}

_llama_restore_binaries() {
  local backup_dir="$1"
  local bin_path

  if [ -z "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
    return 0
  fi

  mkdir -p "$LLAMA_CPP_BIN" || return 1

  for bin_path in "$backup_dir"/*; do
    if [ -f "$bin_path" ]; then
      cp -p "$bin_path" "$LLAMA_CPP_BIN/${bin_path:t}" || return 1
    fi
  done
}

_llama_smoke_test_binaries() {
  local server_bin="$LLAMA_CPP_BIN/llama-server"

  if [ ! -x "$server_bin" ]; then
    echo "llama-server binary not found: $server_bin"
    return 1
  fi

  "$server_bin" --help >/dev/null 2>&1 || {
    echo "llama-server smoke test failed"
    return 1
  }
}

_llama_bench_profile_file() {
  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/llama-bench-profiles.tsv"
}

_llama_bench_history_file() {
  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/llama-bench-history.tsv"
}

_llama_llama_cpp_build_id() {
  if [ -d "$LLAMA_CPP_SRC/.git" ]; then
    git -C "$LLAMA_CPP_SRC" rev-parse --short HEAD 2>/dev/null && return 0
  fi

  if [ -x "$LLAMA_CPP_BIN/llama-server" ]; then
    stat -f 'bin-%m' "$LLAMA_CPP_BIN/llama-server" 2>/dev/null && return 0
  fi

  printf '%s\n' "unknown"
}

_llama_curated_field_for_rel() {
  local rel="$1"
  local field="$2"

  _llama_curated_catalog | awk -F '\t' -v rel="$rel" -v field="$field" '$6 == rel { print $field; exit }'
}

_llama_model_class_for_rel() {
  local rel="$1"
  local class=""
  local repo=""
  local info=""
  local pipeline=""

  class="$(_llama_curated_field_for_rel "$rel" 4)"
  if [ -n "$class" ]; then
    printf '%s\n' "$class"
    return 0
  fi

  repo="$(_llama_hf_repo_for_rel "$rel" 2>/dev/null || true)"
  if [ -z "$repo" ] && [[ "$rel" == */* ]] && [ -n "${LOCAL_AI_DISCOVERY_AUTHOR:-}" ]; then
    repo="${LOCAL_AI_DISCOVERY_AUTHOR}/${rel%%/*}"
  fi
  if [ -n "$repo" ] && command -v jq >/dev/null 2>&1; then
    info="$(_llama_hf_fetch_model_info "$repo" 2>/dev/null || true)"
    if [ -n "$info" ]; then
      pipeline="$(printf '%s' "$info" | jq -r '.pipeline_tag // ""' 2>/dev/null || true)"
      case "$pipeline" in
        image-text-to-text|visual-question-answering|image-to-text)
          printf '%s\n' "multimodal"
          return 0
          ;;
      esac
    fi
  fi

  case "$rel" in
    gemma-4-*|Qwen3.6-35B-A3B-GGUF/*)
      printf '%s\n' "multimodal"
      ;;
    Qwen3.5-*|DeepSeek-*|deepseek-*|*R1*)
      printf '%s\n' "reasoning"
      ;;
    *)
      printf '%s\n' "general"
      ;;
  esac
}

_llama_bench_default_mode_for_rel() {
  local rel="$1"
  local repo=""
  local mmproj_file=""
  local class=""
  local local_mmproj=""

  case "$rel" in
    Qwen3.5-27B-GGUF/*)
      printf '%s\n' "text"
      return 0
      ;;
  esac

  if [ -f "$LLAMA_CPP_MODELS/$rel" ]; then
    local_mmproj="$(_llama_find_mmproj "$LLAMA_CPP_MODELS/${rel%/*}" "$rel" 2>/dev/null || true)"
    if [ -n "$local_mmproj" ]; then
      printf '%s\n' "vision"
      return 0
    fi
  fi

  if repo="$(_llama_hf_repo_for_rel "$rel" 2>/dev/null)"; then
    :
  else
    repo=""
  fi
  if [ -n "$repo" ]; then
    if mmproj_file="$(_llama_hf_mmproj_file_for_repo "$repo" 2>/dev/null)"; then
      :
    else
      mmproj_file=""
    fi
    if [ -n "$mmproj_file" ]; then
      printf '%s\n' "vision"
      return 0
    fi
  fi

  if class="$(_llama_model_class_for_rel "$rel" 2>/dev/null)"; then
    :
  else
    class=""
  fi
  case "$class" in
    multimodal)
      printf '%s\n' "vision"
      ;;
    *)
      printf '%s\n' "text"
      ;;
  esac
}

_llama_bench_mode_for_rel_and_args() {
  local rel="$1"
  shift

  if [ $# -gt 0 ] && _llama_start_has_mmproj "$@"; then
    printf '%s\n' "vision"
    return 0
  fi

  _llama_bench_default_mode_for_rel "$rel"
}

_llama_bench_context_machine() {
  _local_ai_profile_name "$LLAMA_CPP_MACHINE_PROFILE"
}

_llama_bench_context_ctx() {
  _llama_ctx_for_model "$1"
}

_llama_bench_profile_get() {
  local rel="$1"
  local mode="${2:-$(_llama_bench_default_mode_for_rel "$rel")}"
  local ctx="${3:-$(_llama_bench_context_ctx "$rel")}"
  local machine="${4:-$(_llama_bench_context_machine)}"
  local build="${5:-$(_llama_llama_cpp_build_id)}"
  local file="$(_llama_bench_profile_file)"

  if [ ! -f "$file" ]; then
    return 1
  fi

  awk -F '\t' -v machine="$machine" -v rel="$rel" -v mode="$mode" -v ctx="$ctx" -v build="$build" '
    NF >= 9 && $1 == machine && $2 == rel && $3 == mode && $4 == ctx && $5 == build { print $6; found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$file" | tail -n 1 && return 0

  awk -F '\t' -v rel="$rel" 'NF == 5 && $1 == rel { print $2; found = 1 } END { exit(found ? 0 : 1) }' "$file" | tail -n 1
}

_llama_bench_history_append() {
  local rel="$1"
  local mode="$2"
  local ctx="$3"
  local build="$4"
  local profile="$5"
  local gen_ts="$6"
  local prompt_ts="$7"
  local machine="$(_llama_bench_context_machine)"
  local file="$(_llama_bench_history_file)"

  _local_ai_ensure_runtime_dir
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" \
    "$machine" \
    "$rel" \
    "$mode" \
    "$ctx" \
    "$build" \
    "$profile" \
    "$gen_ts" \
    "$prompt_ts" \
    "$(_llama_server_profile_args "$profile")" >> "$file"
}

_llama_bench_profile_set() {
  local rel="$1"
  local mode="$2"
  local ctx="$3"
  local build="$4"
  local profile="$5"
  local gen_ts="$6"
  local prompt_ts="$7"
  local machine="$(_llama_bench_context_machine)"
  local file="$(_llama_bench_profile_file)"
  local tmp

  _local_ai_ensure_runtime_dir
  tmp="$(mktemp "${TMPDIR:-/tmp}/llama-bench-profiles.XXXXXX")" || return 1

  if [ -f "$file" ]; then
    awk -F '\t' -v machine="$machine" -v rel="$rel" -v mode="$mode" -v ctx="$ctx" -v build="$build" '
      !(NF >= 9 && $1 == machine && $2 == rel && $3 == mode && $4 == ctx && $5 == build) { print $0 }
    ' "$file" > "$tmp"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$machine" "$rel" "$mode" "$ctx" "$build" "$profile" "$gen_ts" "$prompt_ts" "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$tmp"
  mv "$tmp" "$file"
  _llama_bench_history_append "$rel" "$mode" "$ctx" "$build" "$profile" "$gen_ts" "$prompt_ts"
}

_llama_bench_vision_file() {
  printf '%s\n' "${LLAMA_CPP_BENCH_VISION_FILE:-$LOCAL_AI_RUNTIME_DIR/bench-vision.tsv}"
}

_llama_bench_reference_image() {
  local override="${LOCAL_AI_BENCH_IMAGE:-}"
  local image_path=""

  if [ -n "$override" ]; then
    if [ ! -f "$override" ]; then
      echo "LOCAL_AI_BENCH_IMAGE=$override: file not found" >&2
      return 1
    fi
    printf '%s\n' "$override"
    return 0
  fi

  image_path="$LOCAL_AI_RUNTIME_DIR/bench-assets/reference-1x1.png"
  if [ ! -f "$image_path" ]; then
    mkdir -p "${image_path:h}"
    printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgGAWDHAAAEAABSsRJZwAAAABJRU5ErkJggg==' \
      | base64 -d > "$image_path" || {
        rm -f "$image_path"
        echo "Unable to decode embedded reference image" >&2
        return 1
      }
  fi
  printf '%s\n' "$image_path"
}

_llama_bench_vision_record() {
  local machine="$1"
  local rel="$2"
  local ctx="$3"
  local build="$4"
  local load_ms="$5"
  local image_encode_ms="$6"
  local prompt_tps="$7"
  local gen_tps="$8"
  local file="$(_llama_bench_vision_file)"
  local tmp

  _local_ai_ensure_runtime_dir
  mkdir -p "${file:h}"
  tmp="$(mktemp "${TMPDIR:-/tmp}/llama-bench-vision.XXXXXX")" || return 1

  if [ -f "$file" ]; then
    awk -F '\t' -v machine="$machine" -v rel="$rel" -v ctx="$ctx" -v build="$build" '
      !($1 == machine && $2 == rel && $3 == ctx && $4 == build) { print $0 }
    ' "$file" > "$tmp"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$machine" "$rel" "$ctx" "$build" \
    "${load_ms:-0}" "${image_encode_ms:-0}" \
    "$prompt_tps" "$gen_tps" \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$tmp"
  mv "$tmp" "$file"
}

_llama_bench_vision_latest() {
  local rel="$1"
  local machine="${2:-$(_llama_bench_context_machine)}"
  local build="${3:-$(_llama_llama_cpp_build_id)}"
  local file="$(_llama_bench_vision_file)"

  [ -f "$file" ] || return 1
  awk -F '\t' -v machine="$machine" -v rel="$rel" -v build="$build" '
    $1 == machine && $2 == rel && $4 == build { print $0; found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$file" | tail -n 1
}

_llama_bench_vision_auto_enabled() {
  case "${LLAMA_CPP_AUTO_BENCH_VISION:-true}" in
    0|false|FALSE|no|NO|off|OFF)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

_llama_server_profile_args() {
  case "$1" in
    throughput)
      printf '%s\n' "-fa on -b 4096 -ub 1024"
      ;;
    conservative)
      printf '%s\n' "-fa off -b 1024 -ub 256"
      ;;
    default|*)
      printf '%s\n' "-fa on -b 2048 -ub 512"
      ;;
  esac
}

_llama_bench_profile_args() {
  case "$1" in
    throughput)
      printf '%s\n' "-fa 1 -b 4096 -ub 1024"
      ;;
    conservative)
      printf '%s\n' "-fa 0 -b 1024 -ub 256"
      ;;
    default|*)
      printf '%s\n' "-fa 1 -b 2048 -ub 512"
      ;;
  esac
}

_llama_tuned_profile_enabled() {
  case "${LLAMA_CPP_USE_TUNED_ARGS:-true}" in
    0|false|FALSE|no|NO|off|OFF)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

_llama_start_has_mmproj() {
  local arg

  for arg in "$@"; do
    case "$arg" in
      --mmproj|-mm|--mmproj-url|--mmproj-auto)
        return 0
        ;;
    esac
  done

  return 1
}

_llama_safe_retry_args() {
  printf '%s\n' "--flash-attn off --no-cache-prompt --parallel 1 --no-cont-batching --no-mmproj-offload --no-warmup"
}

_llama_launch_server_background() {
  local model_path="$1"
  shift

  nohup llama-server \
    -m "$model_path" \
    --alias "$LLAMA_CPP_SERVER_ALIAS" \
    --host "$LLAMA_CPP_HOST" \
    --port "$LLAMA_CPP_PORT" \
    -ngl 999 \
    "$@" > "$LLAMA_CPP_LOGS/server.log" 2>&1 &

  printf '%s\n' "$!"
}

_llama_wait_for_ready() {
  local pid="$1"
  local health_endpoint="$2"
  local timeout_seconds="${3:-60}"
  local attempt=0
  local http_code=""

  while [ "$attempt" -lt "$timeout_seconds" ]; do
    http_code="$(curl -fsS -o /dev/null -w "%{http_code}" "$health_endpoint" 2>/dev/null || true)"

    case "$http_code" in
      200)
        return 0
        ;;
      503)
        ;;
      *)
        if ! kill -0 "$pid" >/dev/null 2>&1; then
          return 1
        fi
        ;;
    esac

    attempt=$((attempt + 1))
    sleep 1
  done

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi

  return 1
}

llama-bench-preset() {
  local target="${1:-current}"
  local mode_arg="${2:-auto}"
  local rel=""
  local model_path=""
  local profile=""
  local output=""
  local gen_ts=""
  local prompt_ts=""
  local best_profile=""
  local best_gen_ts="-1"
  local best_prompt_ts="-1"
  local bench_args_str=""
  local mode=""
  local ctx=""
  local build=""

  command -v jq >/dev/null 2>&1 || {
    echo "jq is required for llama-bench-preset"
    return 1
  }

  if [ ! -x "$LLAMA_CPP_BIN/llama-bench" ]; then
    echo "llama-bench binary not found: $LLAMA_CPP_BIN/llama-bench"
    return 1
  fi

  rel="$(_local_ai_resolve_model_target "$target")" || return 1
  if _local_ai_is_named_preset "$target"; then
    _local_ai_ensure_model_assets "$rel" || return 1
  fi

  model_path="$(_llama_require_model "$rel")" || return 1
  case "$mode_arg" in
    auto|"")
      mode="$(_llama_bench_default_mode_for_rel "$rel")"
      ;;
    text|vision)
      mode="$mode_arg"
      ;;
    *)
      echo "Usage: llama-bench-preset [target] [auto|text|vision]"
      return 1
      ;;
  esac
  ctx="$(_llama_bench_context_ctx "$rel")"
  build="$(_llama_llama_cpp_build_id)"

  for profile in default throughput conservative; do
    bench_args_str="$(_llama_bench_profile_args "$profile")"
    echo "Benchmarking $rel with profile '$profile' (mode=$mode ctx=$ctx build=$build)..."
    output="$("$LLAMA_CPP_BIN/llama-bench" -m "$model_path" -pg 256,64 -r 1 -ngl 999 ${(z)bench_args_str} -o jsonl 2>/dev/null)" || {
      echo "Benchmark failed for profile '$profile'"
      continue
    }

    gen_ts="$(printf '%s\n' "$output" | jq -sr 'map(select(.n_gen > 0)) | first.avg_ts // -1')"
    prompt_ts="$(printf '%s\n' "$output" | jq -sr 'map(select(.n_prompt > 0 and .n_gen == 0)) | first.avg_ts // -1')"

    if [ "$(printf '%.0f\n' "$gen_ts")" -gt "$(printf '%.0f\n' "$best_gen_ts")" ] || {
      [ "$(printf '%.0f\n' "$gen_ts")" -eq "$(printf '%.0f\n' "$best_gen_ts")" ] &&
      [ "$(printf '%.0f\n' "$prompt_ts")" -gt "$(printf '%.0f\n' "$best_prompt_ts")" ]
    }; then
      best_profile="$profile"
      best_gen_ts="$gen_ts"
      best_prompt_ts="$prompt_ts"
    fi
  done

  if [ -z "$best_profile" ]; then
    echo "No successful benchmark profiles for $rel"
    return 1
  fi

  _llama_bench_profile_set "$rel" "$mode" "$ctx" "$build" "$best_profile" "$best_gen_ts" "$best_prompt_ts" || return 1
  echo "Saved tuned launch profile for $rel"
  echo "machine=$(_llama_bench_context_machine) mode=$mode ctx=$ctx build=$build"
  echo "profile=$best_profile gen_tps=$best_gen_ts prompt_tps=$best_prompt_ts"
}

llama-bench-vision() {
  local target="${1:-current}"
  local rel=""
  local model_path=""
  local model_dir=""
  local mmproj=""
  local image=""
  local ctx=""
  local build=""
  local machine=""
  local bin="$LLAMA_CPP_BIN/llama-mtmd-cli"
  local stderr_file=""
  local parsed=""
  local load_ms=""
  local image_encode_ms=""
  local prompt_tps=""
  local gen_tps=""

  if [ ! -x "$bin" ]; then
    echo "llama-mtmd-cli binary not found: $bin"
    return 1
  fi

  rel="$(_local_ai_resolve_model_target "$target")" || return 1
  if _local_ai_is_named_preset "$target"; then
    _local_ai_ensure_model_assets "$rel" || return 1
  fi

  model_path="$(_llama_require_model "$rel")" || return 1
  model_dir="$LLAMA_CPP_MODELS/${rel%/*}"
  mmproj="$(_llama_find_mmproj "$model_dir" "$rel" 2>/dev/null || true)"
  if [ -z "$mmproj" ]; then
    echo "No mmproj sibling found for $rel; vision bench requires a multimodal projector"
    return 1
  fi

  image="$(_llama_bench_reference_image)" || return 1
  ctx="$(_llama_bench_context_ctx "$rel")"
  build="$(_llama_llama_cpp_build_id)"
  machine="$(_llama_bench_context_machine)"

  stderr_file="$(mktemp "${TMPDIR:-/tmp}/llama-bench-vision.XXXXXX")" || return 1

  echo "Vision-benching $rel (image=$image ctx=$ctx build=$build)..."
  "$bin" \
    -m "$model_path" \
    --mmproj "$mmproj" \
    --image "$image" \
    -p "Describe the image in one sentence." \
    -n 32 \
    -ngl 999 \
    --no-warmup \
    >/dev/null 2>"$stderr_file" || {
      echo "llama-mtmd-cli failed; tail of stderr:"
      tail -20 "$stderr_file"
      rm -f "$stderr_file"
      return 1
    }

  parsed="$(awk '
    /load time =/ && load_ms == "" {
      for (i=1; i<=NF; i++) if ($i == "ms") { load_ms = $(i-1); break }
    }
    /image slice encoded in/ && encode_ms == "" {
      for (i=1; i<=NF; i++) if ($i == "ms") { encode_ms = $(i-1); break }
    }
    /prompt eval time =/ && prompt_tps == "" {
      for (i=1; i<=NF; i++) if ($i == "tokens" && $(i+1) == "per" && $(i+2) == "second)") {
        prompt_tps = $(i-1); break
      }
    }
    /eval time =/ && !/prompt/ && gen_tps == "" {
      for (i=1; i<=NF; i++) if ($i == "tokens" && $(i+1) == "per" && $(i+2) == "second)") {
        gen_tps = $(i-1); break
      }
    }
    END {
      printf "%s\t%s\t%s\t%s\n", load_ms, encode_ms, prompt_tps, gen_tps
    }
  ' "$stderr_file")"

  IFS=$'\t' read -r load_ms image_encode_ms prompt_tps gen_tps <<< "$parsed"

  if [ -z "$prompt_tps" ] || [ -z "$gen_tps" ]; then
    echo "Failed to parse timing from llama-mtmd-cli output (saved: $stderr_file)"
    return 1
  fi

  _llama_bench_vision_record "$machine" "$rel" "$ctx" "$build" \
    "$load_ms" "$image_encode_ms" "$prompt_tps" "$gen_tps" || {
      echo "Failed to save vision bench record"
      rm -f "$stderr_file"
      return 1
    }

  rm -f "$stderr_file"

  echo "Saved vision bench record for $rel"
  echo "machine=$machine rel=$rel ctx=$ctx build=$build"
  printf 'load_ms=%s image_encode_ms=%s prompt_tps=%s gen_tps=%s\n' \
    "${load_ms:-0}" "${image_encode_ms:-0}" "$prompt_tps" "$gen_tps"
}

llama-bench-vision-show() {
  local target="${1:-current}"
  local rel=""
  local record=""
  local machine="" ctx="" build="" load_ms="" image_encode_ms="" prompt_tps="" gen_tps="" updated_at=""
  local row_rel=""

  rel="$(_local_ai_resolve_model_target "$target")" || return 1
  record="$(_llama_bench_vision_latest "$rel" 2>/dev/null || true)"
  if [ -z "$record" ]; then
    echo "No vision bench record for $rel on machine=$(_llama_bench_context_machine) build=$(_llama_llama_cpp_build_id)"
    return 1
  fi

  IFS=$'\t' read -r machine row_rel ctx build load_ms image_encode_ms prompt_tps gen_tps updated_at <<< "$record"
  echo "machine=$machine"
  echo "rel=$row_rel"
  echo "ctx=$ctx"
  echo "build=$build"
  echo "load_ms=$load_ms"
  echo "image_encode_ms=$image_encode_ms"
  echo "prompt_tps=$prompt_tps"
  echo "gen_tps=$gen_tps"
  echo "updated_at=$updated_at"
}

llama-bench-show() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" bench show "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

llama-bench-history() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" bench history "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_bench_latest_record() {
  local rel="$1"
  local mode="${2:-$(_llama_bench_default_mode_for_rel "$rel")}"
  local ctx="${3:-$(_llama_bench_context_ctx "$rel")}"
  local machine="${4:-$(_llama_bench_context_machine)}"
  local build="${5:-$(_llama_llama_cpp_build_id)}"
  local file="$(_llama_bench_profile_file)"

  [ -f "$file" ] || return 1
  awk -F '\t' -v machine="$machine" -v rel="$rel" -v mode="$mode" -v ctx="$ctx" -v build="$build" '
    NF >= 9 && $1 == machine && $2 == rel && $3 == mode && $4 == ctx && $5 == build { print $0; found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$file" | tail -n 1 && return 0

  awk -F '\t' -v rel="$rel" '
    NF == 5 && $1 == rel {
      printf "legacy\t%s\tlegacy\tlegacy\tlegacy\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, $5
      found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$file" | tail -n 1
}

_llama_custom_catalog_file() {
  printf '%s\n' "${LOCAL_AI_CUSTOM_CATALOG_FILE:-$LOCAL_AI_RUNTIME_DIR/curated-models.tsv}"
}

_llama_curated_catalog() {
  cat <<'EOF'
gemma4-e4b-q8	Gemma 4 E4B Q8	gemma4	multimodal	fast	gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf	unsloth/gemma-4-E4B-it-GGUF
gemma4-e4b-q4	Gemma 4 E4B Q4	gemma4	multimodal	compact	gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf	unsloth/gemma-4-E4B-it-GGUF
gemma4-26b-q4	Gemma 4 26B Q4	gemma4	multimodal	balanced	gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf	unsloth/gemma-4-26B-A4B-it-GGUF
gemma4-31b-q4	Gemma 4 31B Q4	gemma4	multimodal	quality	gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf	unsloth/gemma-4-31B-it-GGUF
qwen36-q3s	Qwen 3.6 35B-A3B Q3_K_S	qwen36	reasoning	compact	Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf	unsloth/Qwen3.6-35B-A3B-GGUF
qwen36-q4m	Qwen 3.6 35B-A3B Q4_K_M	qwen36	reasoning	balanced	Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf	unsloth/Qwen3.6-35B-A3B-GGUF
qwen36-q4	Qwen 3.6 35B-A3B Q4_K_XL	qwen36	reasoning	quality	Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf	unsloth/Qwen3.6-35B-A3B-GGUF
qwen27-q5	Qwen 3.5 27B Q5	qwen35	reasoning	legacy-balanced	Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf	unsloth/Qwen3.5-27B-GGUF
EOF

  if [ -f "$(_llama_custom_catalog_file)" ]; then
    awk -F '\t' 'NF >= 7 && $0 !~ /^[[:space:]]*#/ { print $0 }' "$(_llama_custom_catalog_file)"
  fi
}

_llama_curated_meta_for_rel() {
  local rel="$1"

  _llama_curated_catalog | awk -F '\t' -v rel="$rel" '
    $6 == rel { print $0; found = 1; exit }
    END { exit(found ? 0 : 1) }
  '
}

_llama_hf_model_info_cache_file() {
  local repo="$1"
  local safe_repo="${repo//\//__}"

  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/hf-model-info-${safe_repo}.json"
}

_llama_hf_cache_fresh() {
  local file="$1"
  local ttl="${LOCAL_AI_HF_CACHE_TTL_SECONDS:-43200}"
  local now=""
  local mtime=""

  [ -f "$file" ] || return 1
  now="$(date +%s)"
  mtime="$(stat -f %m "$file" 2>/dev/null || printf 0)"
  [ $((now - mtime)) -lt "$ttl" ]
}

_llama_hf_enabled() {
  case "${LOCAL_AI_RECOMMENDATIONS_SOURCE:-hf}" in
    off|none|local|false|FALSE|0)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

_llama_hf_fetch_model_info() {
  local repo="$1"
  local cache_file="$(_llama_hf_model_info_cache_file "$repo")"
  local tmp=""

  _llama_hf_enabled || return 1
  _local_ai_ensure_runtime_dir

  if _llama_hf_cache_fresh "$cache_file"; then
    cat "$cache_file"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  tmp="$(mktemp "${TMPDIR:-/tmp}/hf-model-info.XXXXXX")" || return 1
  if curl -fsSL "https://huggingface.co/api/models/$repo" -o "$tmp" 2>/dev/null; then
    mv "$tmp" "$cache_file"
    cat "$cache_file"
    return 0
  fi

  rm -f "$tmp"
  [ -f "$cache_file" ] && cat "$cache_file"
}

_llama_hf_discovery_cache_file() {
  local author="${1:-${LOCAL_AI_DISCOVERY_AUTHOR:-unsloth}}"
  local limit="${2:-${LOCAL_AI_DISCOVERY_LIMIT:-24}}"
  local search="${3:-${LOCAL_AI_DISCOVERY_SEARCH:-GGUF}}"
  local safe_key="${author//\//__}-${search//[^A-Za-z0-9._-]/_}-${limit}"

  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/hf-discovery-${safe_key}.json"
}

_llama_hf_repo_tree_cache_file() {
  local repo="$1"
  local safe_repo="${repo//\//__}"

  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/hf-tree-${safe_repo}.json"
}

_llama_hf_fetch_discovery_feed() {
  local author="${1:-${LOCAL_AI_DISCOVERY_AUTHOR:-unsloth}}"
  local limit="${2:-${LOCAL_AI_DISCOVERY_LIMIT:-24}}"
  local search="${3:-${LOCAL_AI_DISCOVERY_SEARCH:-GGUF}}"
  local cache_file="$(_llama_hf_discovery_cache_file "$author" "$limit" "$search")"
  local tmp=""

  _llama_hf_enabled || return 1
  _local_ai_ensure_runtime_dir

  if _llama_hf_cache_fresh "$cache_file"; then
    cat "$cache_file"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  tmp="$(mktemp "${TMPDIR:-/tmp}/hf-discovery.XXXXXX")" || return 1
  if curl -fsSL "https://huggingface.co/api/models?author=$author&search=$search&sort=downloads&direction=-1&limit=$limit&full=true" -o "$tmp" 2>/dev/null; then
    mv "$tmp" "$cache_file"
    cat "$cache_file"
    return 0
  fi

  rm -f "$tmp"
  [ -f "$cache_file" ] && cat "$cache_file"
}

_llama_hf_fetch_repo_tree() {
  local repo="$1"
  local cache_file="$(_llama_hf_repo_tree_cache_file "$repo")"
  local tmp=""

  _llama_hf_enabled || return 1
  _local_ai_ensure_runtime_dir

  if _llama_hf_cache_fresh "$cache_file"; then
    cat "$cache_file"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1

  tmp="$(mktemp "${TMPDIR:-/tmp}/hf-tree.XXXXXX")" || return 1
  if curl -fsSL "https://huggingface.co/api/models/$repo/tree/main?recursive=1&expand=1" -o "$tmp" 2>/dev/null; then
    mv "$tmp" "$cache_file"
    cat "$cache_file"
    return 0
  fi

  rm -f "$tmp"
  [ -f "$cache_file" ] && cat "$cache_file"
}

_llama_hf_repo_for_rel() {
  local rel="$1"

  _llama_curated_catalog | awk -F '\t' -v rel="$rel" '$6 == rel { print $7; exit }'
}

_llama_hf_summary_for_rel() {
  local rel="$1"
  local repo=""
  local json=""
  local downloads=""
  local likes=""
  local updated=""
  local pipeline=""
  local file_name="${rel:t}"

  repo="$(_llama_hf_repo_for_rel "$rel")"
  [ -n "$repo" ] || return 1

  json="$(_llama_hf_fetch_model_info "$repo" 2>/dev/null || true)"
  [ -n "$json" ] || return 1

  downloads="$(printf '%s\n' "$json" | jq -r '.downloads // "n/a"' 2>/dev/null)"
  likes="$(printf '%s\n' "$json" | jq -r '.likes // "n/a"' 2>/dev/null)"
  updated="$(printf '%s\n' "$json" | jq -r '.lastModified // "n/a"' 2>/dev/null)"
  pipeline="$(printf '%s\n' "$json" | jq -r '.pipeline_tag // .pipelineTag // "n/a"' 2>/dev/null)"

  printf 'repo=%s downloads=%s likes=%s updated=%s task=%s file=%s\n' \
    "$repo" "$downloads" "$likes" "$updated" "$pipeline" "$file_name"
}

_llama_rel_from_repo_and_file() {
  local repo="$1"
  local file="$2"

  if [[ "$file" == */* ]]; then
    printf '%s\n' "$file"
  else
    printf '%s/%s\n' "${repo##*/}" "$file"
  fi
}

_llama_hf_repo_file_info() {
  local repo="$1"
  local file="$2"
  local json=""
  local query_file="$file"

  json="$(_llama_hf_fetch_model_info "$repo" 2>/dev/null || true)"
  [ -n "$json" ] || return 1

  if [[ "$query_file" != */* ]]; then
    printf '%s\n' "$json" | jq -c --arg file "$query_file" '
      .siblings[]?
      | select(.rfilename == $file or (.rfilename | endswith("/" + $file)))
      | .
    ' 2>/dev/null | head -n 1
  else
    printf '%s\n' "$json" | jq -c --arg file "$query_file" '
      .siblings[]?
      | select(.rfilename == $file)
      | .
    ' 2>/dev/null | head -n 1
  fi
}

_llama_hf_file_size_bytes() {
  local repo="$1"
  local file="$2"
  local json=""
  local query_file="$file"

  json="$(_llama_hf_fetch_repo_tree "$repo" 2>/dev/null || true)"
  [ -n "$json" ] || return 1

  if [[ "$query_file" != */* ]]; then
    printf '%s\n' "$json" | jq -r --arg file "$query_file" '
      [.[] | select(.path == $file or (.path | endswith("/" + $file))) | .size // .lfs.size][0] // empty
    ' 2>/dev/null
  else
    printf '%s\n' "$json" | jq -r --arg file "$query_file" '
      [.[] | select(.path == $file) | .size // .lfs.size][0] // empty
    ' 2>/dev/null
  fi
}

_llama_hf_mmproj_file_for_repo() {
  local repo="$1"
  local json=""

  json="$(_llama_hf_fetch_model_info "$repo" 2>/dev/null || true)"
  [ -n "$json" ] || return 1

  printf '%s\n' "$json" | jq -r '
    [.siblings[]?.rfilename
      | select(test("mmproj.*\\.gguf$"; "i"))
    ][0] // empty
  ' 2>/dev/null
}

_llama_hf_human_size() {
  local bytes="${1:-0}"

  case "$bytes" in
    ''|*[!0-9]*)
      printf '%s\n' "n/a"
      return 0
      ;;
  esac

  awk -v bytes="$bytes" '
    function human(x) {
      split("B KiB MiB GiB TiB", units, " ")
      i = 1
      while (x >= 1024 && i < 5) {
        x /= 1024
        i++
      }
      if (i == 1) {
        printf "%d %s", x, units[i]
      } else {
        printf "%.1f %s", x, units[i]
      }
    }
    BEGIN { human(bytes) }
  '
  printf '\n'
}

_llama_hf_repo_for_rel_or_repo() {
  local rel_or_repo="$1"
  local repo=""

  if [[ "$rel_or_repo" == */* ]] && [[ "$rel_or_repo" != *.gguf ]]; then
    printf '%s\n' "$rel_or_repo"
    return 0
  fi

  repo="$(_llama_hf_repo_for_rel "$rel_or_repo")"
  [ -n "$repo" ] && printf '%s\n' "$repo"
}

_llama_quant_from_rel() {
  local rel="$1"

  case "$rel" in
    *Q8_0.gguf)
      printf '%s\n' "q8"
      ;;
    *UD-Q6_K_XL.gguf)
      printf '%s\n' "q6"
      ;;
    *UD-Q5_K_XL.gguf)
      printf '%s\n' "q5"
      ;;
    *UD-Q4_K_M.gguf)
      printf '%s\n' "q4m"
      ;;
    *UD-Q4_K_XL.gguf)
      printf '%s\n' "q4"
      ;;
    *UD-Q3_K_S.gguf)
      printf '%s\n' "q3s"
      ;;
    *UD-Q3_K_M.gguf)
      printf '%s\n' "q3m"
      ;;
    *UD-Q3_K_XL.gguf)
      printf '%s\n' "q3xl"
      ;;
    *UD-Q2_K_XL.gguf)
      printf '%s\n' "q2"
      ;;
    *MXFP4_MOE.gguf)
      printf '%s\n' "mxfp4"
      ;;
    *Q4_K_M.gguf)
      printf '%s\n' "q4km"
      ;;
    *Q5_K_M.gguf)
      printf '%s\n' "q5km"
      ;;
    *)
      printf '%s\n' "custom"
      ;;
  esac
}

_llama_ctx_for_model() {
  case "$1" in
    Qwen3.6-35B-A3B-GGUF/*|Qwen3.5-27B-GGUF/*)
      printf '%s\n' "$LLAMA_CPP_QWEN_CTX_SIZE"
      ;;
    *)
      printf '%s\n' "$LLAMA_CPP_GEMMA_CTX_SIZE"
      ;;
  esac
}

_llama_curated_repo_known() {
  local repo="$1"

  _llama_curated_catalog | awk -F '\t' -v repo="$repo" '$7 == repo { found = 1 } END { exit(found ? 0 : 1) }'
}

_llama_curated_rel_known() {
  local rel="$1"

  _llama_curated_meta_for_rel "$rel" >/dev/null 2>&1
}

_llama_curated_status_for_repo_file() {
  local repo="$1"
  local file="$2"
  local rel="$(_llama_rel_from_repo_and_file "$repo" "$file")"

  if _llama_curated_rel_known "$rel"; then
    printf '%s\n' "curated"
  elif _llama_curated_repo_known "$repo"; then
    printf '%s\n' "family-known"
  else
    printf '%s\n' "new"
  fi
}

_llama_discovery_profile_name() {
  local filter="$1"
  local profile="${2:-current}"

  case "$filter" in
    fits-16g)
      printf '%s\n' "mac-mini-16g"
      ;;
    fits-32g)
      printf '%s\n' "balanced"
      ;;
    fits-48g)
      printf '%s\n' "macbook-pro-48g"
      ;;
    *)
      if [ "$profile" = "current" ] || [ -z "$profile" ]; then
        printf '%s\n' "$(_local_ai_profile_name "$LLAMA_CPP_MACHINE_PROFILE")"
      else
        printf '%s\n' "$(_local_ai_profile_name "$profile")"
      fi
      ;;
  esac
}

_llama_discovery_classify_repo() {
  local repo="${1:l}"
  local pipeline="${2:l}"
  local tags="${3:l}"

  case "$pipeline" in
    image-text-to-text)
      printf '%s\n' "multimodal"
      return 0
      ;;
  esac

  case "$tags:$repo" in
    *vision*:*|*multimodal*:*|*:*gemma-4-*)
      printf '%s\n' "multimodal"
      return 0
      ;;
  esac

  case "$tags:$repo" in
    *reasoning*:*|*thinking*:*|*:*deepseek*|*:*qwq*|*:*qwen*|*:*r1*)
      printf '%s\n' "reasoning"
      ;;
    *)
      printf '%s\n' "general"
      ;;
  esac
}

_llama_discovery_pick_file() {
  local profile="$(_local_ai_profile_name "$1")"
  local joined_siblings="$2"
  local prefs=()
  local sibling=""
  local all_files=()

  case "$profile" in
    mac-mini-16g)
      prefs=("UD-Q3_K_S.gguf" "UD-Q3_K_M.gguf" "UD-Q4_K_M.gguf" "UD-Q4_K_XL.gguf" "Q4_K_M.gguf" "Q8_0.gguf" "UD-Q5_K_XL.gguf")
      ;;
    balanced)
      prefs=("UD-Q4_K_M.gguf" "UD-Q4_K_XL.gguf" "Q4_K_M.gguf" "UD-Q3_K_M.gguf" "Q8_0.gguf" "UD-Q5_K_XL.gguf")
      ;;
    *)
      prefs=("UD-Q4_K_XL.gguf" "UD-Q5_K_XL.gguf" "UD-Q4_K_M.gguf" "Q4_K_M.gguf" "Q8_0.gguf" "UD-Q6_K_XL.gguf")
      ;;
  esac

  for sibling in ${(s:|:)joined_siblings}; do
    [ -n "$sibling" ] || continue
    all_files+=("$sibling")
  done

  for sibling in "${prefs[@]}"; do
    if printf '%s\n' "${all_files[@]}" | rg -F -m1 -- "$sibling" >/dev/null 2>&1; then
      printf '%s\n' "$(printf '%s\n' "${all_files[@]}" | rg -F -m1 -- "$sibling")"
      return 0
    fi
  done

  [ ${#all_files[@]} -gt 0 ] && printf '%s\n' "${all_files[1]}"
}

_llama_discovery_estimated_bytes() {
  local repo="$1"
  local file="$2"
  local class="$3"
  local model_bytes=""
  local mmproj_file=""
  local mmproj_bytes=""
  local total=0

  model_bytes="$(_llama_hf_file_size_bytes "$repo" "$file" 2>/dev/null || true)"
  case "$model_bytes" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac
  total="$model_bytes"

  if [ "$class" = "multimodal" ]; then
    mmproj_file="$(_llama_hf_mmproj_file_for_repo "$repo" 2>/dev/null || true)"
    if [ -n "$mmproj_file" ]; then
      mmproj_bytes="$(_llama_hf_file_size_bytes "$repo" "$mmproj_file" 2>/dev/null || true)"
      case "$mmproj_bytes" in
        ''|*[!0-9]*) ;;
        *)
          total=$((total + mmproj_bytes))
          ;;
      esac
    fi
  fi

  printf '%s\n' "$total"
}

_llama_discovery_fit() {
  local profile="$(_local_ai_profile_name "$1")"
  local repo="$2"
  local repo_l="${2:l}"
  local class="$3"
  local file="$4"
  local fit=""
  local estimated_bytes=""
  local size_gib=""

  [ -n "$file" ] || {
    printf '%s\n' "unknown"
    return 0
  }

  estimated_bytes="$(_llama_discovery_estimated_bytes "$repo" "$file" "$class" 2>/dev/null || true)"
  case "$estimated_bytes" in
    ''|*[!0-9]*)
      ;;
    *)
      size_gib="$(awk -v bytes="$estimated_bytes" 'BEGIN { printf "%.2f", bytes / (1024 * 1024 * 1024) }')"
      case "$profile" in
        mac-mini-16g)
          if awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 8.5)) }'; then
            fit="excellent"
          elif awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 12.5)) }'; then
            fit="good"
          elif awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 16.5)) }'; then
            fit="fair"
          else
            fit="poor"
          fi
          ;;
        balanced)
          if awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 20.0)) }'; then
            fit="excellent"
          elif awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 28.0)) }'; then
            fit="good"
          elif awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 36.0)) }'; then
            fit="fair"
          else
            fit="poor"
          fi
          ;;
        *)
          if awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 30.0)) }'; then
            fit="excellent"
          elif awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 42.0)) }'; then
            fit="good"
          elif awk -v gib="$size_gib" 'BEGIN { exit(!(gib <= 52.0)) }'; then
            fit="fair"
          else
            fit="poor"
          fi
          ;;
      esac
      ;;
  esac

  if [ -z "$fit" ]; then
    case "$file" in
      *Q2*|*Q3_K_S*|*Q3_K_M*)
        fit="good"
        ;;
      *Q4_K_M*|*UD-Q4_K_M*|*UD-Q4_K_XL*)
        fit="excellent"
        ;;
      *Q5*|*Q6*)
        fit="good"
        ;;
      *Q8_0*)
        fit="fair"
        ;;
      *)
        fit="fair"
        ;;
    esac
  fi

  case "$profile:$repo_l:$file" in
    mac-mini-16g:*:*)
      case "$file" in
        *Q2*|*Q3_K_S*|*Q3_K_M*)
          fit="excellent"
          ;;
        *Q4_K_M*|*UD-Q4_K_M*|*UD-Q4_K_XL*)
          fit="good"
          ;;
        *Q8_0*)
          fit="fair"
          ;;
      esac
      case "$repo_l" in
        *35b-a3b*|*31b*|*27b*|*26b*)
          case "$file" in
            *Q2*|*Q3_K_S*|*Q3_K_M*)
              fit="good"
              ;;
            *)
              fit="poor"
              ;;
          esac
          ;;
        *671b*|*405b*|*123b*|*120b*|*72b*|*70b*|*v3*|*v4*)
          fit="poor"
          ;;
      esac
      ;;
    balanced:*:*)
      case "$file" in
        *Q2*)
          fit="fair"
          ;;
        *Q3_K_S*|*Q3_K_M*)
          fit="good"
          ;;
        *Q4_K_M*|*UD-Q4_K_M*|*UD-Q4_K_XL*)
          fit="excellent"
          ;;
      esac
      case "$repo_l" in
        *671b*|*405b*|*123b*|*120b*|*72b*|*70b*)
          fit="poor"
          ;;
      esac
      ;;
    *)
      case "$repo_l" in
        *671b*|*405b*|*123b*|*120b*)
          fit="poor"
          ;;
      esac
      ;;
  esac

  case "$class:$repo_l:$file" in
    reasoning:*deepseek-v3*:*|reasoning:*deepseek-v4*:*|multimodal:*72b*:*|multimodal:*70b*:*)
      fit="poor"
      ;;
  esac

  printf '%s\n' "$fit"
}

_llama_discovery_fit_score() {
  case "$1" in
    excellent) printf '%s\n' "5" ;;
    good) printf '%s\n' "4" ;;
    fair) printf '%s\n' "3" ;;
    poor) printf '%s\n' "2" ;;
    *) printf '%s\n' "1" ;;
  esac
}

_llama_discovery_filter_matches() {
  local filter="$1"
  local class="$2"
  local repo="$3"
  local fit="$4"

  case "$filter" in
    all|"")
      return 0
      ;;
    other|new)
      ! _llama_curated_repo_known "$repo"
      ;;
    curated|known)
      _llama_curated_repo_known "$repo"
      ;;
    reasoning|multimodal|general)
      [ "$class" = "$filter" ]
      ;;
    fits-16g|fits-32g|fits-48g)
      case "$fit" in
        excellent|good)
          return 0
          ;;
        *)
          return 1
          ;;
      esac
      ;;
    *)
      case "$class:$repo" in
        "$filter":*|*:"$filter"*)
          return 0
          ;;
      esac
      return 1
      ;;
  esac
}

llama-discover-models() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" discover "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_discover_models_legacy() {
  local filter="${1:-other}"
  local requested_profile="${2:-current}"
  local limit="${3:-${LOCAL_AI_DISCOVERY_LIMIT:-24}}"
  local author="${LOCAL_AI_DISCOVERY_AUTHOR:-unsloth}"
  local search="${LOCAL_AI_DISCOVERY_SEARCH:-GGUF}"
  local profile=""
  local json=""
  local tmp=""
  local id=""
  local downloads=""
  local likes=""
  local updated=""
  local pipeline=""
  local tags=""
  local siblings=""
  local class=""
  local file=""
  local fit=""
  local fit_score=""
  local quant=""
  local catalog_status=""
  local rel=""
  local estimated_bytes=""
  local estimated_size=""
  local mmproj_file=""
  local vision_status=""

  profile="$(_llama_discovery_profile_name "$filter" "$requested_profile")"
  json="$(_llama_hf_fetch_discovery_feed "$author" "$limit" "$search" 2>/dev/null || true)"
  [ -n "$json" ] || {
    echo "Unable to fetch Hugging Face discovery feed"
    return 1
  }

  tmp="$(mktemp "${TMPDIR:-/tmp}/llama-discover.XXXXXX")" || return 1

  while IFS=$'\t' read -r id downloads likes updated pipeline tags siblings; do
    [ -n "$id" ] || continue
    [ -n "$siblings" ] || continue

    class="$(_llama_discovery_classify_repo "$id" "$pipeline" "$tags")"
    file="$(_llama_discovery_pick_file "$profile" "$siblings")"
    rel="$(_llama_rel_from_repo_and_file "$id" "$file")"
    fit="$(_llama_discovery_fit "$profile" "$id" "$class" "$file")"
    _llama_discovery_filter_matches "$filter" "$class" "$id" "$fit" || continue

    fit_score="$(_llama_discovery_fit_score "$fit")"
    quant="$(_llama_quant_from_rel "$rel")"
    catalog_status="$(_llama_curated_status_for_repo_file "$id" "$file")"
    estimated_bytes="$(_llama_discovery_estimated_bytes "$id" "$file" "$class" 2>/dev/null || true)"
    estimated_size="$(_llama_hf_human_size "$estimated_bytes")"
    mmproj_file="$(_llama_hf_mmproj_file_for_repo "$id" 2>/dev/null || true)"
    if [ "$class" = "multimodal" ]; then
      if [ -n "$mmproj_file" ]; then
        vision_status="ready"
      else
        vision_status="needs-mmproj"
      fi
    else
      vision_status="text"
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$fit_score" "${downloads:-0}" "$class" "$fit" "$catalog_status" "$id" "$file" "$quant" "${likes:-0}" "$updated" "${pipeline:-n/a}" "$estimated_size" "$vision_status" "$rel" >> "$tmp"
  done < <(
    printf '%s\n' "$json" | jq -r '
      .[]
      | [
          (.id // ""),
          ((.downloads // 0) | tostring),
          ((.likes // 0) | tostring),
          (.lastModified // ""),
          (.pipeline_tag // .pipelineTag // ""),
          ([.tags[]?] | join("|")),
          ([.siblings[]?.rfilename
            | select(test("\\.gguf$"; "i"))
            | select((ascii_downcase | contains("mmproj")) | not)
            | select(test("(^|/)(bf16|fp16|f16)/"; "i") | not)
            | select(test("-[0-9]{5}-of-[0-9]{5}\\.gguf$"; "i") | not)
          ] | join("|"))
        ]
      | @tsv
    '
  )

  printf 'filter=%s profile=%s author=%s limit=%s\n' "$filter" "$profile" "$author" "$limit"
  if [ ! -s "$tmp" ]; then
    printf '  no-discovery-results\n'
    rm -f "$tmp"
    return 0
  fi

  sort -t $'\t' -k1,1nr -k2,2nr -k6,6 "$tmp" | awk -F '\t' '
    {
      printf "  %-11s %-10s status=%-11s quant=%-6s size=%-10s vision=%-11s repo=%s\n", $3, $4, $5, $8, $12, $13, $6
      printf "             file=%s downloads=%s likes=%s updated=%s task=%s rel=%s\n", $7, $2, $9, $10, $11, $14
      if ($5 == "new") {
        printf "             try: llama-candidate-test %s\n", $6
      }
    }
  '

  rm -f "$tmp"
}

llama-curated-list() {
  # Delegates to the TypeScript CLI. The heredoc-backed shell catalog in
  # `_llama_curated_catalog` is still used by other shell helpers during
  # Phase 1 migration; it mirrors the TS `BUILTIN_CATALOG` row-for-row
  # and both sides read the same custom TSV file.
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" catalog list "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

llama-curated-add() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" catalog add "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_curated_add_legacy() {
  local repo="$1"
  local file_or_rel="$2"
  local label="${3:-}"
  local family="${4:-}"
  local class="${5:-}"
  local scope="${6:-candidate}"
  local rel=""
  local model_dir=""
  local entry_id=""
  local custom_file="$(_llama_custom_catalog_file)"
  local quant=""

  if [ -z "$repo" ] || [ -z "$file_or_rel" ]; then
    echo "Usage: llama-curated-add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope]"
    return 1
  fi

  model_dir="${repo##*/}"
  if [[ "$file_or_rel" == */* ]]; then
    rel="$file_or_rel"
  else
    rel="$model_dir/$file_or_rel"
  fi

  if _llama_curated_meta_for_rel "$rel" >/dev/null 2>&1; then
    echo "Catalog already contains $rel"
    return 1
  fi

  quant="$(_llama_quant_from_rel "$rel")"
  entry_id="${model_dir:l}-${quant}"
  entry_id="${entry_id//[^a-z0-9._-]/-}"

  [ -n "$label" ] || label="${rel:t:r}"
  if [ -z "$family" ]; then
    case "${repo:l}" in
      *gemma-4*)
        family="gemma4"
        ;;
      *qwen3.6*)
        family="qwen36"
        ;;
      *qwen3.5*)
        family="qwen35"
        ;;
      *deepseek*)
        family="deepseek"
        ;;
      *)
        family="custom"
        ;;
    esac
  fi
  if [ -z "$class" ]; then
    local hf_info="" hf_pipeline="" hf_tags=""
    hf_info="$(_llama_hf_fetch_model_info "$repo" 2>/dev/null || true)"
    if [ -n "$hf_info" ] && command -v jq >/dev/null 2>&1; then
      hf_pipeline="$(printf '%s' "$hf_info" | jq -r '.pipeline_tag // ""' 2>/dev/null || true)"
      hf_tags="$(printf '%s' "$hf_info" | jq -r 'if (.tags // []) | type == "array" then (.tags | join(" ")) else "" end' 2>/dev/null || true)"
    fi
    class="$(_llama_discovery_classify_repo "$repo" "$hf_pipeline" "$hf_tags")"
  fi

  _local_ai_ensure_runtime_dir
  mkdir -p "${custom_file:h}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$entry_id" "$label" "$family" "$class" "$scope" "$rel" "$repo" >> "$custom_file"

  printf 'Added curated entry to %s\n' "$custom_file"
  printf '  id=%s\n' "$entry_id"
  printf '  model=%s\n' "$rel"
}

_llama_candidate_pick_file() {
  local repo="$1"
  local requested_file="${2:-}"
  local profile="${3:-$LLAMA_CPP_MACHINE_PROFILE}"
  local json=""
  local siblings=""

  if [ -n "$requested_file" ]; then
    printf '%s\n' "$requested_file"
    return 0
  fi

  json="$(_llama_hf_fetch_model_info "$repo" 2>/dev/null || true)"
  [ -n "$json" ] || return 1
  siblings="$(printf '%s\n' "$json" | jq -r '
    [.siblings[]?.rfilename
      | select(test("\\.gguf$"; "i"))
      | select((ascii_downcase | contains("mmproj")) | not)
      | select(test("(^|/)(bf16|fp16|f16)/"; "i") | not)
      | select(test("-[0-9]{5}-of-[0-9]{5}\\.gguf$"; "i") | not)
    ] | join("|")
  ' 2>/dev/null)"
  [ -n "$siblings" ] || return 1
  _llama_discovery_pick_file "$profile" "$siblings"
}

llama-pull-candidate() {
  local repo="$1"
  local file="${2:-}"
  local profile="${3:-$LLAMA_CPP_MACHINE_PROFILE}"

  if [ -z "$repo" ]; then
    echo "Usage: llama-pull-candidate <hf-repo> [gguf-file] [profile]"
    return 1
  fi

  file="$(_llama_candidate_pick_file "$repo" "$file" "$profile")" || {
    echo "Unable to resolve a candidate file for $repo"
    return 1
  }

  _llama_pull_repo_model "$repo" "$file"
}

llama-candidate-test() {
  local repo="$1"
  local file="${2:-}"
  local profile="${3:-$LLAMA_CPP_MACHINE_PROFILE}"
  local rel=""
  local class=""
  local label=""

  if [ -z "$repo" ]; then
    echo "Usage: llama-candidate-test <hf-repo> [gguf-file] [profile]"
    return 1
  fi

  file="$(_llama_candidate_pick_file "$repo" "$file" "$profile")" || {
    echo "Unable to resolve a candidate file for $repo"
    return 1
  }
  rel="$(_llama_rel_from_repo_and_file "$repo" "$file")"

  if ! _llama_curated_rel_known "$rel"; then
    label="${rel:t:r}"
    llama-curated-add "$repo" "$file" "$label" "" "" "candidate" >/dev/null || return 1
  fi

  llama-pull-candidate "$repo" "$file" "$profile" || return 1

  if [ -x "$LLAMA_CPP_BIN/llama-bench" ]; then
    local bench_mode bench_ctx bench_build bench_machine existing_profile
    bench_mode="$(_llama_bench_default_mode_for_rel "$rel")"
    bench_ctx="$(_llama_bench_context_ctx "$rel")"
    bench_build="$(_llama_llama_cpp_build_id)"
    bench_machine="$(_llama_bench_context_machine)"
    existing_profile="$(_llama_bench_profile_get "$rel" "$bench_mode" "$bench_ctx" "$bench_machine" "$bench_build")"
    if [ -z "$existing_profile" ]; then
      llama-bench-preset "$rel" auto || return 1
    else
      echo "Reusing tuned profile for $rel (mode=$bench_mode ctx=$bench_ctx build=$bench_build)"
    fi
    llama-bench-show "$rel" || true
  else
    echo "Skipping benchmark: llama-bench binary not found"
  fi

  class="$(_llama_model_class_for_rel "$rel")"

  if [ "$class" = "multimodal" ] && [ -x "$LLAMA_CPP_BIN/llama-mtmd-cli" ] && _llama_bench_vision_auto_enabled; then
    local vision_existing
    vision_existing="$(_llama_bench_vision_latest "$rel" 2>/dev/null || true)"
    if [ -z "$vision_existing" ]; then
      echo
      llama-bench-vision "$rel" || echo "Vision bench failed for $rel (continuing)"
    else
      echo "Reusing vision bench record for $rel"
    fi
  fi

  echo
  llama-bench-compare "$class"
}

llama-recommendations() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" recommendations "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_recommendations_legacy() {
  local requested_profile="${1:-current}"
  local profile=""
  local profiles=()
  local target=""
  local rel=""
  local meta=""
  local id=""
  local label=""
  local family=""
  local class=""
  local scope=""
  local catalog_rel=""
  local quant=""
  local ctx=""
  local hf_summary=""
  local env_override=""
  local file_override=""
  local promoted_note=""
  local profile_key=""
  local preset_key=""
  local env_var_name=""

  case "$requested_profile" in
    all)
      profiles=("mac-mini-16g" "balanced" "macbook-pro-48g")
      ;;
    current|"")
      profiles=("$(_local_ai_profile_name "$LLAMA_CPP_MACHINE_PROFILE")")
      ;;
    *)
      profiles=("$(_local_ai_profile_name "$requested_profile")")
      ;;
  esac

  for profile in "${profiles[@]}"; do
    printf 'profile=%s\n' "$profile"
    for target in best vision balanced fast qwen qwen27; do
      promoted_note=""
      case "$target" in
        qwen27)
          rel="Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf"
          ;;
        qwen)
          rel="$(_llama_recommended_qwen36_model_for_profile "$profile")"
          ;;
        *)
          rel="$(_local_ai_profile_preset_model "$profile" "$target")" || continue
          profile_key="${(U)${profile//-/_}}"
          preset_key="${(U)target}"
          env_var_name="LOCAL_AI_PRESET_${profile_key}_${preset_key}_MODEL"
          env_override="${(P)env_var_name}"
          file_override="$(_local_ai_profile_preset_file_override "$profile" "$target" 2>/dev/null || true)"
          if [ -n "$env_override" ]; then
            promoted_note=" promoted=env"
          elif [ -n "$file_override" ]; then
            promoted_note=" promoted=file"
          fi
          ;;
      esac

      meta="$(_llama_curated_meta_for_rel "$rel")"
      if [ -n "$meta" ]; then
        IFS=$'\t' read -r id label family class scope catalog_rel <<< "$meta"
      else
        label="${rel:t}"
        family="custom"
        class="custom"
        scope="$target"
      fi

      quant="$(_llama_quant_from_rel "$rel")"
      case "$rel" in
        Qwen3.6-35B-A3B-GGUF/*|Qwen3.5-27B-GGUF/*)
          case "$profile" in
            mac-mini-16g) ctx="16384" ;;
            balanced) ctx="32768" ;;
            *) ctx="65536" ;;
          esac
          ;;
        *)
          case "$profile" in
            mac-mini-16g) ctx="16384" ;;
            balanced) ctx="24576" ;;
            *) ctx="32768" ;;
          esac
          ;;
      esac

      printf '  %-9s %-24s class=%-11s scope=%-16s quant=%-6s ctx=%-6s model=%s%s\n' \
        "$target" "$label" "$class" "$scope" "$quant" "$ctx" "$rel" "$promoted_note"
      hf_summary="$(_llama_hf_summary_for_rel "$rel" 2>/dev/null || true)"
      if [ -n "$hf_summary" ]; then
        printf '             hf=%s\n' "$hf_summary"
      fi
    done
    printf '\n'
  done
}

llama-bench-compare() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" bench compare "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_bench_compare_legacy() {
  local class_filter="${1:-all}"
  local scope_filter="${2:-all}"
  local file="$(_llama_bench_profile_file)"
  local tmp=""
  local id=""
  local label=""
  local family=""
  local class=""
  local scope=""
  local rel=""
  local record=""
  local profile=""
  local gen=""
  local prompt=""
  local updated=""
  local installed=""
  local mode=""
  local ctx=""
  local build=""
  local machine=""
  local vision_record=""
  local v_load_ms="" v_encode_ms="" v_prompt_tps="" v_gen_tps="" v_updated=""

  [ -f "$file" ] || {
    echo "No tuned launch profiles recorded yet"
    return 1
  }

  tmp="$(mktemp "${TMPDIR:-/tmp}/llama-bench-compare.XXXXXX")" || return 1

  while IFS=$'\t' read -r id label family class scope rel repo; do
    case "$class_filter" in
      all|"")
        ;;
      *)
        [ "$class" = "$class_filter" ] || continue
        ;;
    esac

    case "$scope_filter" in
      all|"")
        ;;
      *)
        [ "$scope" = "$scope_filter" ] || continue
        ;;
    esac

    installed="no"
    [ -f "$LLAMA_CPP_MODELS/$rel" ] && installed="yes"
    mode="$(_llama_bench_default_mode_for_rel "$rel")"
    ctx="$(_llama_bench_context_ctx "$rel")"
    build="$(_llama_llama_cpp_build_id)"
    machine="$(_llama_bench_context_machine)"
    record="$(_llama_bench_latest_record "$rel" "$mode" "$ctx" "$machine" "$build" 2>/dev/null || true)"

    v_load_ms="-"
    v_encode_ms="-"
    v_prompt_tps="-"
    v_gen_tps="-"
    v_updated="-"
    vision_record="$(_llama_bench_vision_latest "$rel" "$machine" "$build" 2>/dev/null || true)"
    if [ -n "$vision_record" ]; then
      IFS=$'\t' read -r _vm _vr _vctx _vbuild v_load_ms v_encode_ms v_prompt_tps v_gen_tps v_updated <<< "$vision_record"
    fi

    if [ -n "$record" ]; then
      IFS=$'\t' read -r _record_machine _record_rel _record_mode _record_ctx _record_build profile gen prompt updated <<< "$record"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$gen" "$prompt" "$label" "$class" "$scope" "$profile" "$installed" "$updated" "$rel" "$_record_mode" "$_record_ctx" "$_record_build" \
        "$v_load_ms" "$v_encode_ms" "$v_prompt_tps" "$v_gen_tps" "$v_updated" >> "$tmp"
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "-1" "-1" "$label" "$class" "$scope" "n/a" "$installed" "n/a" "$rel" "$mode" "$ctx" "$build" \
        "$v_load_ms" "$v_encode_ms" "$v_prompt_tps" "$v_gen_tps" "$v_updated" >> "$tmp"
    fi
  done < <(_llama_curated_catalog)

  printf 'class=%s scope=%s\n' "$class_filter" "$scope_filter"
  awk -F '\t' '$1 != "-1"' "$tmp" | sort -t $'\t' -k1,1nr -k2,2nr | awk -F '\t' '{
    printf "%-24s class=%-11s scope=%-16s gen=%-10s prompt=%-10s tuned=%-12s mode=%-6s ctx=%-6s installed=%-3s model=%s\n", $3, $4, $5, $1, $2, $6, $10, $11, $7, $9
    if ($15 != "-" && $15 != "") {
      printf "%-24s vision=         load_ms=%-7s encode_ms=%-5s prompt_tps=%-9s gen_tps=%-9s updated=%s\n", "", $13, $14, $15, $16, $17
    }
  }'

  if awk -F '\t' '$1 == "-1" { found=1 } END { exit(found ? 0 : 1) }' "$tmp"; then
    printf '\nmissing_benchmarks:\n'
    awk -F '\t' '$1 == "-1" { printf "%-24s class=%-11s scope=%-16s mode=%-6s ctx=%-6s installed=%-3s model=%s\n", $3, $4, $5, $10, $11, $7, $9 }' "$tmp"
  fi

  rm -f "$tmp"
}

alias llama-compare='llama-bench-compare'
alias llama-discover='llama-discover-models'
alias llama-candidate='llama-candidate-test'
alias llama-promote='llama-curated-promote'

llama-update-safe() {
  local backup_dir=""
  local previous_commit=""
  local current_commit=""

  cd "$LLAMA_CPP_SRC" || return 1

  previous_commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
  backup_dir="$(_llama_backup_binaries)" || return 1

  if git pull --rebase && llama-build && _llama_smoke_test_binaries; then
    current_commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
    echo "llama.cpp update succeeded: ${previous_commit:-unknown} -> ${current_commit:-unknown}"
    if [ -n "$backup_dir" ]; then
      echo "Binary backup saved at: $backup_dir"
    fi
    return 0
  fi

  echo "llama.cpp update failed; restoring previous binaries..."

  if [ -n "$backup_dir" ]; then
    _llama_restore_binaries "$backup_dir" || {
      echo "Failed to restore binaries from $backup_dir"
      return 1
    }
  fi

  if _llama_smoke_test_binaries; then
    echo "Previous llama.cpp binaries restored successfully."
  else
    echo "Restored llama.cpp binaries did not pass smoke test."
    return 1
  fi

  current_commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
  echo "Working source commit is now: ${current_commit:-unknown}"
  echo "Previous known-good binary build came from: ${previous_commit:-unknown}"
  return 1
}

llama-cli-local() {
  local model="$1"
  local model_path
  if [ $# -gt 0 ]; then
    shift
  fi

  if [ -z "$model" ]; then
    echo "Usage: llama-cli-local <relative-model-path> [extra llama-cli args]"
    return 1
  fi

  model_path="$(_llama_require_model "$model")" || return 1

  llama-cli -m "$model_path" "$@"
}

llama-server-local() {
  local model="$1"
  local model_path
  if [ $# -gt 0 ]; then
    shift
  fi

  if [ -z "$model" ]; then
    echo "Usage: llama-server-local <relative-model-path> [extra llama-server args]"
    return 1
  fi

  model_path="$(_llama_require_model "$model")" || return 1

  llama-server \
    -m "$model_path" \
    --host "$LLAMA_CPP_HOST" \
    --port "$LLAMA_CPP_PORT" \
    "$@"
}

llama-bench-local() {
  local model="$1"
  local model_path
  if [ $# -gt 0 ]; then
    shift
  fi

  if [ -z "$model" ]; then
    echo "Usage: llama-bench-local <relative-model-path> [extra llama-bench args]"
    return 1
  fi

  model_path="$(_llama_require_model "$model")" || return 1

  llama-bench -m "$model_path" "$@"
}

llama-start() {
  local model="${1:-$LLAMA_CPP_DEFAULT_MODEL}"
  local health_endpoint="$(_llama_endpoint)/health"
  local model_path
  local pid
  local timeout_seconds=60
  local tuned_profile=""
  local tuned_args_str=""
  local safe_retry_args_str=""
  local launch_args=()
  local retry_args=()
  local tuned_mode=""
  local tuned_ctx=""
  local tuned_build=""
  local tuned_machine=""
  if [ $# -gt 0 ]; then
    shift
  fi

  mkdir -p "$LLAMA_CPP_MODELS" "$LLAMA_CPP_CACHE" "$LLAMA_CPP_LOGS"
  model_path="$(_llama_require_model "$model")" || {
    echo "Available models:"
    llama-models
    return 1
  }

  llama-stop >/dev/null 2>&1 || true

  if _llama_tuned_profile_enabled; then
    tuned_mode="$(_llama_bench_mode_for_rel_and_args "$model" "$@")"
    tuned_ctx="$(_llama_bench_context_ctx "$model")"
    tuned_build="$(_llama_llama_cpp_build_id)"
    tuned_machine="$(_llama_bench_context_machine)"
    tuned_profile="$(_llama_bench_profile_get "$model" "$tuned_mode" "$tuned_ctx" "$tuned_machine" "$tuned_build")"
    if [ -n "$tuned_profile" ]; then
      tuned_args_str="$(_llama_server_profile_args "$tuned_profile")"
      launch_args+=(${(z)tuned_args_str})
      echo "Using tuned launch profile '$tuned_profile' for $model (machine=$tuned_machine mode=$tuned_mode ctx=$tuned_ctx build=$tuned_build)"
    else
      launch_args+=(${(z)$(_llama_server_profile_args default)})
    fi
  else
    launch_args+=(${(z)$(_llama_server_profile_args default)})
  fi

  launch_args+=("$@")
  pid="$(_llama_launch_server_background "$model_path" "${launch_args[@]}")"

  if _llama_wait_for_ready "$pid" "$health_endpoint" "$timeout_seconds"; then
    llama-status
    return 0
  fi

  if _llama_start_has_mmproj "${launch_args[@]}"; then
    echo "Vision model failed to become ready; retrying with safer server flags..."
    safe_retry_args_str="$(_llama_safe_retry_args)"
    retry_args=("${launch_args[@]}" ${(z)safe_retry_args_str})

    llama-stop >/dev/null 2>&1 || true
    pid="$(_llama_launch_server_background "$model_path" "${retry_args[@]}")"

    if _llama_wait_for_ready "$pid" "$health_endpoint" "$timeout_seconds"; then
      echo "llama.cpp recovered with safe vision flags"
      llama-status
      return 0
    fi
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "llama.cpp exited before becoming ready"
  else
    echo "llama.cpp readiness check timed out after ${timeout_seconds}s"
  fi
  tail -n 50 "$LLAMA_CPP_LOGS/server.log" 2>/dev/null
  return 1
}

_llama_keep_alive_pid_file() {
  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/llama-keep-alive.pid"
}

_llama_keep_alive_stop_file() {
  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/llama-keep-alive.stop"
}

_llama_keep_alive_state_file() {
  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/llama-keep-alive.state"
}

_llama_keep_alive_log_file() {
  printf '%s\n' "$LLAMA_CPP_LOGS/keep-alive.log"
}

_llama_keep_alive_write_state() {
  local target="$1"
  local rel="$2"
  local state="$3"
  local restarts="$4"
  local backoff="$5"
  local file="$(_llama_keep_alive_state_file)"

  _local_ai_ensure_runtime_dir
  mkdir -p "$LLAMA_CPP_LOGS"

  printf 'updated_at=%s\ntarget=%s\nmodel=%s\nstate=%s\nrestarts=%s\nbackoff_seconds=%s\nlog=%s\n' \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" \
    "$target" \
    "$rel" \
    "$state" \
    "$restarts" \
    "$backoff" \
    "$(_llama_keep_alive_log_file)" > "$file"
}

_llama_keep_alive_running_pid() {
  local pid_file="$(_llama_keep_alive_pid_file)"
  local pid=""

  [ -f "$pid_file" ] || return 1
  pid="$(cat "$pid_file" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  printf '%s\n' "$pid"
}

_llama_keep_alive_monitor_ready() {
  local interval="${1:-$LLAMA_CPP_KEEP_ALIVE_INTERVAL}"
  local health_endpoint="$(_llama_endpoint)/health"
  local stop_file="$(_llama_keep_alive_stop_file)"
  local http_code=""

  while :; do
    if [ -f "$stop_file" ]; then
      return 1
    fi

    http_code="$(curl -fsS -o /dev/null -w "%{http_code}" "$health_endpoint" 2>/dev/null || true)"
    case "$http_code" in
      200|503)
        sleep "$interval"
        ;;
      *)
        return 1
        ;;
    esac
  done
}

_llama_keep_alive_worker() {
  local target="${1:-current}"
  local interval="${LLAMA_CPP_KEEP_ALIVE_INTERVAL:-5}"
  local max_backoff="${LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF:-30}"
  local stop_file="$(_llama_keep_alive_stop_file)"
  local pid_file="$(_llama_keep_alive_pid_file)"
  local restarts=0
  local backoff=1
  local requested=""
  local rel=""

  trap 'llama-stop >/dev/null 2>&1 || true; rm -f "$pid_file" "$stop_file"; _llama_keep_alive_write_state "$target" "${rel:-unknown}" "stopped" "$restarts" "$backoff"; exit 0' INT TERM EXIT

  while :; do
    [ -f "$stop_file" ] && break

    requested="$(_local_ai_resolve_model_target "$target")" || {
      _llama_keep_alive_write_state "$target" "unresolved" "resolve-failed" "$restarts" "$backoff"
      sleep "$backoff"
      if [ "$backoff" -lt "$max_backoff" ]; then
        backoff=$((backoff * 2))
        [ "$backoff" -gt "$max_backoff" ] && backoff="$max_backoff"
      fi
      continue
    }

    if _local_ai_is_named_preset "$target"; then
      _local_ai_ensure_model_assets "$requested" || {
        _llama_keep_alive_write_state "$target" "$requested" "asset-fetch-failed" "$restarts" "$backoff"
        sleep "$backoff"
        if [ "$backoff" -lt "$max_backoff" ]; then
          backoff=$((backoff * 2))
          [ "$backoff" -gt "$max_backoff" ] && backoff="$max_backoff"
        fi
        continue
      }
    fi

    rel="$(_local_ai_resolve_llama_cpp_target "$target")" || {
      _llama_keep_alive_write_state "$target" "$requested" "not-runnable" "$restarts" "$backoff"
      sleep "$backoff"
      if [ "$backoff" -lt "$max_backoff" ]; then
        backoff=$((backoff * 2))
        [ "$backoff" -gt "$max_backoff" ] && backoff="$max_backoff"
      fi
      continue
    }

    _llama_keep_alive_write_state "$target" "$rel" "starting" "$restarts" "$backoff"
    _llama_switch_default_model "$rel" >/dev/null 2>&1 || true

    if _local_ai_run_llama_cpp_source "$rel"; then
      backoff=1
      _llama_keep_alive_write_state "$target" "$rel" "ready" "$restarts" "$backoff"

      if _llama_keep_alive_monitor_ready "$interval"; then
        continue
      fi

      [ -f "$stop_file" ] && break
      restarts=$((restarts + 1))
      _llama_keep_alive_write_state "$target" "$rel" "restart-pending" "$restarts" "$backoff"
      sleep "$backoff"
      if [ "$backoff" -lt "$max_backoff" ]; then
        backoff=$((backoff * 2))
        [ "$backoff" -gt "$max_backoff" ] && backoff="$max_backoff"
      fi
      continue
    fi

    restarts=$((restarts + 1))
    _llama_keep_alive_write_state "$target" "$rel" "start-failed" "$restarts" "$backoff"
    sleep "$backoff"
    if [ "$backoff" -lt "$max_backoff" ]; then
      backoff=$((backoff * 2))
      [ "$backoff" -gt "$max_backoff" ] && backoff="$max_backoff"
    fi
  done

  return 0
}

llama-keep-alive() {
  local target="${1:-current}"
  local pid=""
  local log_file="$(_llama_keep_alive_log_file)"

  _local_ai_ensure_runtime_dir
  mkdir -p "$LLAMA_CPP_LOGS"

  pid="$(_llama_keep_alive_running_pid 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    echo "llama.cpp keep-alive is already running: pid=$pid"
    return 1
  fi

  rm -f "$(_llama_keep_alive_stop_file)"
  _llama_keep_alive_write_state "$target" "pending" "launching" 0 1
  ( _llama_keep_alive_worker "$target" ) >> "$log_file" 2>&1 &!
  pid="$!"

  if [ -n "$pid" ]; then
    printf '%s\n' "$pid" > "$(_llama_keep_alive_pid_file)"
  fi

  echo "llama.cpp keep-alive started"
  echo "target=$target"
  echo "pid=${pid:-unknown}"
  echo "log=$log_file"
}

llama-keep-alive-stop() {
  local pid=""
  local stop_file="$(_llama_keep_alive_stop_file)"
  local pid_file="$(_llama_keep_alive_pid_file)"
  local state_file="$(_llama_keep_alive_state_file)"
  local waited=0

  pid="$(_llama_keep_alive_running_pid 2>/dev/null || true)"

  if [ -z "$pid" ]; then
    rm -f "$pid_file" "$stop_file"
    echo "llama.cpp keep-alive is not running"
    return 0
  fi

  : > "$stop_file"

  while kill -0 "$pid" >/dev/null 2>&1 && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done

  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi

  llama-stop >/dev/null 2>&1 || true
  rm -f "$pid_file" "$stop_file"
  [ -f "$state_file" ] && sed -n '1,20p' "$state_file"
}

llama-keep-alive-status() {
  local pid=""
  local state_file="$(_llama_keep_alive_state_file)"

  pid="$(_llama_keep_alive_running_pid 2>/dev/null || true)"

  if [ -n "$pid" ]; then
    echo "llama.cpp keep-alive: running (pid=$pid)"
  else
    echo "llama.cpp keep-alive: stopped"
  fi

  if [ -f "$state_file" ]; then
    sed -n '1,20p' "$state_file"
  fi
}

llama-stop() {
  pkill -f "(^|/)llama-server($| )" >/dev/null 2>&1 || true
}

llama-status() {
  local endpoint="$(_llama_endpoint)"
  local health_endpoint="$endpoint/health"
  local http_code=""
  local state="down"

  mkdir -p "$LLAMA_CPP_MODELS" "$LLAMA_CPP_CACHE" "$LLAMA_CPP_LOGS"

  echo "LLAMA_CPP_SRC:           $LLAMA_CPP_SRC"
  echo "LLAMA_CPP_BIN:           $LLAMA_CPP_BIN"
  echo "LLAMA_CPP_ROOT:          $LLAMA_CPP_ROOT"
  echo "LLAMA_CPP_MODELS:        $LLAMA_CPP_MODELS"
  echo "LLAMA_CPP_CACHE:         $LLAMA_CPP_CACHE"
  echo "LLAMA_CACHE:             $LLAMA_CACHE"
  echo "LLAMA_CPP_DEFAULT_MODEL: $LLAMA_CPP_DEFAULT_MODEL"
  echo "LLAMA_CPP_SERVER_ALIAS:  $LLAMA_CPP_SERVER_ALIAS"
  echo "LLAMA_CPP_HOST:          $LLAMA_CPP_HOST"
  echo "LLAMA_CPP_PORT:          $LLAMA_CPP_PORT"
  echo "LLAMA_CPP_LOGS:          $LLAMA_CPP_LOGS"
  echo "LLAMA_CPP_ENDPOINT:      $endpoint"

  http_code="$(curl -fsS -o /dev/null -w "%{http_code}" "$health_endpoint" 2>/dev/null || true)"

  case "$http_code" in
    200)
      state="ready"
      ;;
    503)
      state="loading"
      ;;
  esac

  echo "llama.cpp API:           $state"
}

llama-logs() {
  cat "$LLAMA_CPP_LOGS/server.log"
}

llama-api-test() {
  curl -fsS "$(_llama_endpoint)/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"'"$LLAMA_CPP_SERVER_ALIAS"'","messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
}

hf-login() {
  hf auth login
}

hf-search() {
  if [ -z "$1" ]; then
    echo "Usage: hf-search <query>"
    return 1
  fi

  hf models ls --search "$1"
}

llama-pull() {
  local repo="$1"
  local target="${2:-}"

  if [ -z "$repo" ]; then
    echo "Usage: llama-pull <hf-repo> [target-dir]"
    return 1
  fi

  if [ -z "$target" ]; then
    target="$LLAMA_CPP_MODELS/${repo##*/}"
  fi

  mkdir -p "$target"
  hf download "$repo" --local-dir "$target"
}

llama-pull-file() {
  local repo="$1"
  local file="$2"
  local target

  if [ -z "$repo" ] || [ -z "$file" ]; then
    echo "Usage: llama-pull-file <hf-repo> <filename.gguf>"
    return 1
  fi

  _llama_pull_repo_model "$repo" "$file"
}

_llama_pull_repo_model() {
  local repo="$1"
  local file="$2"
  local rel="$(_llama_rel_from_repo_and_file "$repo" "$file")"
  local target="$LLAMA_CPP_MODELS/${repo##*/}"
  local was_missing=0
  local class=""
  local mmproj_file=""

  if [ -z "$repo" ] || [ -z "$file" ]; then
    echo "Usage: _llama_pull_repo_model <hf-repo> <filename.gguf>"
    return 1
  fi

  [ -f "$LLAMA_CPP_MODELS/$rel" ] || was_missing=1
  mkdir -p "$target"

  class="$(_llama_model_class_for_rel "$rel")"
  case "$class" in
    general|custom|"")
      class="$(_llama_discovery_classify_repo "$repo" "" "")"
      ;;
  esac

  mmproj_file="$(_llama_hf_mmproj_file_for_repo "$repo" 2>/dev/null || true)"
  if [ -n "$mmproj_file" ]; then
    hf download "$repo" \
      "$file" \
      "$mmproj_file" \
      --local-dir "$target"
  else
    hf download "$repo" \
      "$file" \
      --local-dir "$target"
  fi

  _llama_maybe_tune_after_pull "$rel" "$was_missing"
}

_llama_auto_tune_on_pull_enabled() {
  case "${LLAMA_CPP_AUTO_TUNE_ON_PULL:-true}" in
    0|false|FALSE|no|NO|off|OFF)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

_llama_maybe_tune_after_pull() {
  local rel="$1"
  local was_missing="${2:-0}"
  local profile=""
  local mode=""
  local ctx=""
  local build=""

  if [ "$was_missing" -ne 1 ]; then
    return 0
  fi

  _llama_auto_tune_on_pull_enabled || return 0

  if [ ! -x "$LLAMA_CPP_BIN/llama-bench" ]; then
    echo "Skipping auto-tune for $rel: llama-bench binary not found"
    return 0
  fi

  mode="$(_llama_bench_default_mode_for_rel "$rel")"
  ctx="$(_llama_bench_context_ctx "$rel")"
  build="$(_llama_llama_cpp_build_id)"
  profile="$(_llama_bench_profile_get "$rel" "$mode" "$ctx" "$(_llama_bench_context_machine)" "$build")"
  if [ -n "$profile" ]; then
    echo "Tuned launch profile already exists for $rel (mode=$mode ctx=$ctx build=$build)"
    return 0
  fi

  echo "Running auto-tune benchmark for $rel..."
  llama-bench-preset "$rel" "$mode" || {
    echo "Auto-tune benchmark failed for $rel"
    return 0
  }

  _llama_maybe_vision_bench_after_pull "$rel"
}

_llama_maybe_vision_bench_after_pull() {
  local rel="$1"
  local class=""
  local mmproj=""
  local machine=""
  local build=""
  local existing=""

  _llama_bench_vision_auto_enabled || return 0

  if [ ! -x "$LLAMA_CPP_BIN/llama-mtmd-cli" ]; then
    return 0
  fi

  class="$(_llama_model_class_for_rel "$rel")"
  [ "$class" = "multimodal" ] || return 0

  mmproj="$(_llama_find_mmproj "$LLAMA_CPP_MODELS/${rel%/*}" "$rel" 2>/dev/null || true)"
  [ -n "$mmproj" ] || return 0

  machine="$(_llama_bench_context_machine)"
  build="$(_llama_llama_cpp_build_id)"
  existing="$(_llama_bench_vision_latest "$rel" "$machine" "$build" 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    echo "Vision bench record already exists for $rel (machine=$machine build=$build)"
    return 0
  fi

  echo "Running vision bench for $rel (class=multimodal, mmproj present)..."
  llama-bench-vision "$rel" || {
    echo "Vision bench failed for $rel"
    return 0
  }
}

llama-list() {
  _llama_list_runnable_models
}

llama-run() {
  llama-start "$@"
}

llama-pick() {
  local models
  local selected

  if ! command -v fzf >/dev/null 2>&1; then
    echo "fzf is required for llama-pick"
    return 1
  fi

  models="$(llama-list)"
  if [ -z "$models" ]; then
    echo "No runnable GGUF models found under $LLAMA_CPP_MODELS"
    return 1
  fi

  selected="$(printf '%s\n' "$models" | sed "s#^$LLAMA_CPP_MODELS/##" | fzf --height 50% --layout=reverse --border --prompt='llama model > ')" || return 1
  [ -n "$selected" ] || return 1
  llama-start "$selected"
}

llama-chat() {
  local prompt="${*:-Say hello in one short sentence.}"
  local escaped_prompt
  local response

  escaped_prompt="$(_llama_escape_json "$prompt")"
  response="$(
    curl -fsS "$(_llama_endpoint)/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d '{"model":"'"$LLAMA_CPP_SERVER_ALIAS"'","messages":[{"role":"user","content":"'"$escaped_prompt"'"}]}'
  )" || return 1

  _llama_print_content "$response"
}

llama-clean() {
  mkdir -p "$LLAMA_CPP_CACHE"

  if [ -z "$LLAMA_CPP_CACHE" ] || [ "$LLAMA_CPP_CACHE" = "/" ]; then
    echo "Refusing to clean invalid cache path"
    return 1
  fi

  find "$LLAMA_CPP_CACHE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

llama-uninstall() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" uninstall "$@"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_uninstall_legacy() {
  local rel=""
  local force=0
  local arg=""
  local dir=""
  local model_path=""
  local model_dir=""
  local scope=""
  local tmp=""
  local bench_profile_file=""
  local bench_history_file=""
  local custom_file=""
  local overrides_file=""
  local remaining_ggufs=""

  for arg in "$@"; do
    case "$arg" in
      --force|-f)
        force=1
        ;;
      -h|--help)
        echo "Usage: llama-uninstall <rel> [--force]"
        echo "  Removes a pulled model file plus its mmproj sibling when no other GGUF remains,"
        echo "  prunes its bench profile/history rows, and removes custom-catalog candidate entries."
        echo "  Curated scopes (non-candidate) and promotion overrides require --force."
        return 0
        ;;
      -*)
        echo "Unknown flag: $arg"
        return 1
        ;;
      *)
        if [ -z "$rel" ]; then
          rel="$arg"
        else
          echo "Usage: llama-uninstall <rel> [--force]"
          return 1
        fi
        ;;
    esac
  done

  if [ -z "$rel" ]; then
    echo "Usage: llama-uninstall <rel> [--force]"
    return 1
  fi

  dir="${rel%%/*}"
  model_path="$LLAMA_CPP_MODELS/$rel"
  model_dir="$LLAMA_CPP_MODELS/$dir"

  if [ -z "$dir" ] || [ "$dir" = "$rel" ]; then
    echo "Expected rel of form <repo-dir>/<file.gguf>, got: $rel"
    return 1
  fi

  scope="$(_llama_curated_field_for_rel "$rel" 5)"
  if [ -z "$scope" ] && [ ! -f "$model_path" ]; then
    echo "No catalog entry and no file on disk for $rel"
    return 1
  fi

  case "$scope" in
    candidate|"")
      ;;
    *)
      if [ "$force" -ne 1 ]; then
        echo "Refusing to uninstall $rel: scope=$scope (use --force to override)"
        return 1
      fi
      ;;
  esac

  echo "Uninstalling $rel (scope=${scope:-unknown}, force=$force)"

  if [ -f "$model_path" ]; then
    rm -f "$model_path"
    echo "  removed $model_path"
  fi

  if [ -d "$model_dir" ] && [ -n "$LLAMA_CPP_MODELS" ] && [[ "$model_dir" == "$LLAMA_CPP_MODELS"/* ]]; then
    remaining_ggufs="$(find "$model_dir" -maxdepth 2 -type f -iname '*.gguf' ! -iname 'mmproj*' 2>/dev/null | head -1)"
    if [ -z "$remaining_ggufs" ]; then
      rm -rf "$model_dir"
      if [ ! -e "$model_dir" ]; then
        echo "  removed empty dir $model_dir (including mmproj + hf cache)"
      fi
    fi
  fi

  bench_profile_file="$(_llama_bench_profile_file)"
  if [ -f "$bench_profile_file" ]; then
    tmp="$(mktemp)" || return 1
    awk -F '\t' -v rel="$rel" '$1 != rel && $2 != rel' "$bench_profile_file" > "$tmp" && mv "$tmp" "$bench_profile_file"
    [ -s "$bench_profile_file" ] || rm -f "$bench_profile_file"
    echo "  pruned bench profile rows for $rel"
  fi

  bench_history_file="$(_llama_bench_history_file)"
  if [ -f "$bench_history_file" ]; then
    tmp="$(mktemp)" || return 1
    awk -F '\t' -v rel="$rel" '$2 != rel && $3 != rel' "$bench_history_file" > "$tmp" && mv "$tmp" "$bench_history_file"
    [ -s "$bench_history_file" ] || rm -f "$bench_history_file"
    echo "  pruned bench history rows for $rel"
  fi

  local bench_vision_file="$(_llama_bench_vision_file)"
  if [ -f "$bench_vision_file" ]; then
    tmp="$(mktemp)" || return 1
    awk -F '\t' -v rel="$rel" '$2 != rel' "$bench_vision_file" > "$tmp" && mv "$tmp" "$bench_vision_file"
    [ -s "$bench_vision_file" ] || rm -f "$bench_vision_file"
    echo "  pruned vision bench rows for $rel"
  fi

  custom_file="$(_llama_custom_catalog_file)"
  if [ -f "$custom_file" ]; then
    tmp="$(mktemp)" || return 1
    awk -F '\t' -v rel="$rel" '$6 != rel' "$custom_file" > "$tmp" && mv "$tmp" "$custom_file"
    [ -s "$custom_file" ] || rm -f "$custom_file"
    echo "  pruned custom catalog entries for $rel"
  fi

  if [ "$force" -eq 1 ]; then
    overrides_file="$(_local_ai_preset_overrides_file)"
    if [ -f "$overrides_file" ]; then
      tmp="$(mktemp)" || return 1
      awk -F '\t' -v rel="$rel" '$3 != rel' "$overrides_file" > "$tmp" && mv "$tmp" "$overrides_file"
      [ -s "$overrides_file" ] || rm -f "$overrides_file"
      echo "  pruned promotion overrides for $rel"
    fi
  fi
}

_llama_start_gemma4_model() {
  local rel="$1"
  local model_dir="$2"
  local label="$3"
  local mmproj

  _local_ai_ensure_model_assets "$rel" || return 1

  mmproj="$(_llama_find_mmproj "$LLAMA_CPP_MODELS/$model_dir" "$rel")" || {
    echo "No $label mmproj file found under $LLAMA_CPP_MODELS/$model_dir"
    return 1
  }

  llama-start "$rel" \
    --mmproj "$mmproj" \
    --ctx-size "$LLAMA_CPP_GEMMA_CTX_SIZE" \
    --temp 1.0 \
    --top-p 0.95 \
    --top-k 64 \
    --chat-template-kwargs "$(_local_ai_chat_template_kwargs)"
}

_llama_default_e4b_model() {
  local model_dir="$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF"
  local candidate

  for candidate in \
    "gemma-4-E4B-it-Q8_0.gguf" \
    "gemma-4-E4B-it-UD-Q5_K_XL.gguf" \
    "gemma-4-E4B-it-UD-Q4_K_XL.gguf" \
    "gemma-4-E4B-it-UD-Q6_K_XL.gguf" \
    "gemma-4-E4B-it-Q5_K_M.gguf" \
    "gemma-4-E4B-it-Q4_K_M.gguf"
  do
    if [ -f "$model_dir/$candidate" ]; then
      printf '%s\n' "gemma-4-E4B-it-GGUF/$candidate"
      return 0
    fi
  done

  printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
}

_llama_recommended_qwen36_model_for_profile() {
  local profile="$(_local_ai_profile_name "$1")"

  case "$profile" in
    mac-mini-16g)
      printf '%s\n' "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf"
      ;;
    balanced)
      printf '%s\n' "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
      ;;
    *)
      printf '%s\n' "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
      ;;
  esac
}

_llama_default_qwen36_model() {
  local candidate="$(_llama_recommended_qwen36_model_for_profile "$LLAMA_CPP_MACHINE_PROFILE")"
  local rel=""

  if [ -f "$LLAMA_CPP_MODELS/$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  for rel in \
    "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf" \
    "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" \
    "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf" \
    "Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf"
  do
    if [ -f "$LLAMA_CPP_MODELS/$rel" ]; then
      printf '%s\n' "$rel"
      return 0
    fi
  done

  printf '%s\n' "$candidate"
}

run-gemma4-e4b() {
  local model="${1:-$(_llama_default_e4b_model)}"

  _llama_start_gemma4_model "$model" "gemma-4-E4B-it-GGUF" "Gemma 4 E4B"
}

_llama_find_mmproj() {
  local model_dir="$1"
  local model_ref="$2"
  local model_path=""
  local candidate
  local best_candidate=""
  local best_score=-1
  local score=0

  case "$model_ref" in
    "")
      ;;
    /*)
      model_path="$model_ref"
      ;;
    *)
      model_path="$LLAMA_CPP_MODELS/$model_ref"
      ;;
  esac

  for candidate in "$model_dir"/mmproj*.gguf "$model_dir"/*mmproj*.gguf; do
    [ -f "$candidate" ] || continue
    score="$(_llama_mmproj_match_score "$model_path" "$candidate")"
    if [ "$score" -gt "$best_score" ]; then
      best_candidate="$candidate"
      best_score="$score"
    fi
  done

  if [ -n "$best_candidate" ]; then
    printf '%s\n' "$best_candidate"
    return 0
  fi

  return 1
}

_llama_gguf_metadata_value() {
  local gguf="$1"
  local key="$2"

  [ -f "$gguf" ] || return 1
  command -v strings >/dev/null 2>&1 || return 1

  strings "$gguf" 2>/dev/null | awk -v key="$key" '
    {
      gsub(/[[:cntrl:]]/, "", $0)
      if (prev == key && length($0) > 0) {
        print $0
        exit
      }
      prev = $0
    }
  '
}

_llama_mmproj_match_score() {
  local model_path="$1"
  local mmproj_path="$2"
  local score=0
  local model_basename=""
  local mmproj_basename=""
  local model_base_name=""
  local mmproj_base_name=""
  local model_repo=""
  local mmproj_repo=""
  local mmproj_arch=""

  [ -f "$mmproj_path" ] || {
    printf '0\n'
    return 0
  }

  case "${mmproj_path:t}" in
    mmproj-BF16.gguf)
      score=$((score + 2))
      ;;
    mmproj-F16.gguf)
      score=$((score + 1))
      ;;
  esac

  if [ -f "$model_path" ]; then
    model_basename="$(_llama_gguf_metadata_value "$model_path" "general.basename")"
    mmproj_basename="$(_llama_gguf_metadata_value "$mmproj_path" "general.basename")"
    model_base_name="$(_llama_gguf_metadata_value "$model_path" "general.base_model.0.name")"
    mmproj_base_name="$(_llama_gguf_metadata_value "$mmproj_path" "general.base_model.0.name")"
    model_repo="$(_llama_gguf_metadata_value "$model_path" "general.base_model.0.repo_url")"
    mmproj_repo="$(_llama_gguf_metadata_value "$mmproj_path" "general.base_model.0.repo_url")"

    [ -n "$model_basename" ] && [ "$model_basename" = "$mmproj_basename" ] && score=$((score + 8))
    [ -n "$model_base_name" ] && [ "$model_base_name" = "$mmproj_base_name" ] && score=$((score + 8))
    [ -n "$model_repo" ] && [ "$model_repo" = "$mmproj_repo" ] && score=$((score + 6))
  fi

  mmproj_arch="$(_llama_gguf_metadata_value "$mmproj_path" "general.architecture")"
  [ "$mmproj_arch" = "clip" ] && score=$((score + 3))

  printf '%s\n' "$score"
}

_llama_recommended_model_for_profile() {
  local profile="$1"
  local model=""

  case "$profile" in
    mac-mini-16g|mini|16g)
      for model in \
        "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf" \
        "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf" \
        "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      do
        if [ -f "$LLAMA_CPP_MODELS/$model" ]; then
          printf '%s\n' "$model"
          return 0
        fi
      done

      printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
      ;;
    balanced|mid)
      for model in \
        "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf" \
        "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf" \
        "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
      do
        if [ -f "$LLAMA_CPP_MODELS/$model" ]; then
          printf '%s\n' "$model"
          return 0
        fi
      done

      printf '%s\n' "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      ;;
    *)
      for model in \
        "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf" \
        "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf" \
        "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
      do
        if [ -f "$LLAMA_CPP_MODELS/$model" ]; then
          printf '%s\n' "$model"
          return 0
        fi
      done

      printf '%s\n' "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
      ;;
  esac
}

_llama_switch_default_model() {
  local model="$1"
  local model_path

  if [ -z "$model" ]; then
    echo "Usage: _llama_switch_default_model <relative-model-path>"
    return 1
  fi

  model_path="$LLAMA_CPP_MODELS/$model"

  if [ ! -e "$model_path" ]; then
    echo "Model not found: $model_path"
    return 1
  fi

  export LLAMA_CPP_DEFAULT_MODEL="$model"
  LOCAL_AI_SOURCE_MODEL="$model"

  if typeset -f _local_ai_sync_env >/dev/null 2>&1; then
    _local_ai_sync_env >/dev/null 2>&1 || true
  fi

  echo "LLAMA_CPP_DEFAULT_MODEL -> $LLAMA_CPP_DEFAULT_MODEL"
}

llama-profile() {
  local profile="${1:-current}"
  local model=""

  case "$profile" in
    current)
      echo "LLAMA_CPP_MACHINE_PROFILE=$LLAMA_CPP_MACHINE_PROFILE"
      echo "LLAMA_CPP_GEMMA_CTX_SIZE=$LLAMA_CPP_GEMMA_CTX_SIZE"
      echo "LLAMA_CPP_QWEN_CTX_SIZE=$LLAMA_CPP_QWEN_CTX_SIZE"
      echo "LLAMA_CPP_DEFAULT_MODEL=$LLAMA_CPP_DEFAULT_MODEL"
      return 0
      ;;
    mac-mini-16g|mini|16g)
      export LLAMA_CPP_MACHINE_PROFILE="mac-mini-16g"
      export LLAMA_CPP_GEMMA_CTX_SIZE="16384"
      export LLAMA_CPP_QWEN_CTX_SIZE="16384"
      ;;
    balanced|mid)
      export LLAMA_CPP_MACHINE_PROFILE="balanced"
      export LLAMA_CPP_GEMMA_CTX_SIZE="24576"
      export LLAMA_CPP_QWEN_CTX_SIZE="32768"
      ;;
    macbook-pro-48g|macbook-pro|mbp|laptop|desktop-48g|desktop|48g|best)
      export LLAMA_CPP_MACHINE_PROFILE="macbook-pro-48g"
      export LLAMA_CPP_GEMMA_CTX_SIZE="32768"
      export LLAMA_CPP_QWEN_CTX_SIZE="65536"
      ;;
    *)
      echo "Usage: llama-profile {mini|balanced|macbook-pro|current}"
      return 1
      ;;
  esac

  model="$(_llama_recommended_model_for_profile "$LLAMA_CPP_MACHINE_PROFILE")"
  export LLAMA_CPP_DEFAULT_MODEL="$model"
  LOCAL_AI_SOURCE_MODEL="$model"

  if typeset -f _local_ai_sync_env >/dev/null 2>&1; then
    _local_ai_sync_env >/dev/null 2>&1 || true
  fi

  echo "LLAMA_CPP_MACHINE_PROFILE=$LLAMA_CPP_MACHINE_PROFILE"
  echo "LLAMA_CPP_GEMMA_CTX_SIZE=$LLAMA_CPP_GEMMA_CTX_SIZE"
  echo "LLAMA_CPP_QWEN_CTX_SIZE=$LLAMA_CPP_QWEN_CTX_SIZE"
  echo "LLAMA_CPP_DEFAULT_MODEL=$LLAMA_CPP_DEFAULT_MODEL"
}

llama-profile-mini() {
  llama-profile mini
}

llama-profile-macbook-pro() {
  llama-profile macbook-pro
}

llama-profile-desktop() {
  llama-profile macbook-pro
}

llama-switch() {
  local target="${1:-current}"
  local rel=""

  case "$target" in
    current)
      _local_ai_run_llama_cpp_source "$(_local_ai_source_model)"
      ;;
    best|quality|vision|image|balanced|daily|fast|small|31b|gemma4-31b|gemma-4-31b|26b|gemma4-26b|gemma-4-26b|e4b|gemma4-e4b|gemma-4-e4b|qwen|qwen36|qwen3.6|qwen3.6-35b|qwen35b|qwen27|qwen35|qwen3.5-27b|*.gguf|*/*)
      rel="$(_local_ai_resolve_model_target "$target")" || return 1
      if _local_ai_is_named_preset "$target"; then
        _local_ai_ensure_model_assets "$rel" || return 1
      fi
      _llama_switch_default_model "$rel" || return 1
      _local_ai_run_llama_cpp_source "$rel"
      ;;
    *)
      echo "Usage: llama-switch {best|vision|balanced|fast|31b|26b|e4b|qwen|qwen27|current|<relative-model-path>}"
      return 1
      ;;
  esac
}

llama-switch-best() {
  llama-switch best
}

llama-switch-balanced() {
  llama-switch balanced
}

llama-switch-fast() {
  llama-switch fast
}

llama-switch-vision() {
  llama-switch vision
}

llama-use() {
  local target="$1"
  local apply_now="$2"
  local rel=""

  case "$apply_now" in
    now|run|switch)
      llama-switch "$target"
      return $?
      ;;
  esac

  case "$target" in
    best|quality|vision|image|balanced|daily|fast|small|31b|gemma4-31b|gemma-4-31b|26b|gemma4-26b|gemma-4-26b|e4b|gemma4-e4b|gemma-4-e4b|qwen|qwen36|qwen3.6|qwen3.6-35b|qwen35b|qwen27|qwen35|qwen3.5-27b)
      rel="$(_local_ai_resolve_model_target "$target")" || return 1
      _llama_switch_default_model "$rel"
      ;;
    current|"")
      echo "LLAMA_CPP_DEFAULT_MODEL=$LLAMA_CPP_DEFAULT_MODEL"
      ;;
    *)
      echo "Usage: llama-use {best|vision|balanced|fast|31b|26b|e4b|qwen|qwen27|current}"
      return 1
      ;;
  esac
}

llama-use-best() {
  llama-use best
}

llama-use-balanced() {
  llama-use balanced
}

llama-use-fast() {
  llama-use fast
}

llama-use-e4b() {
  llama-use e4b
}

llama-use-26b() {
  llama-use 26b
}

llama-use-31b() {
  llama-use 31b
}

run-gemma4-26b() {
  local model="${1:-gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf}"

  _llama_start_gemma4_model "$model" "gemma-4-26B-A4B-it-GGUF" "Gemma 4 26B"
}

llama-pull-gemma4-26b() {
  local target="$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF"
  local quant="${1:-recommended}"
  local model_file=""
  local rel=""
  local was_missing=0

  if [ "$quant" = "recommended" ] || [ "$quant" = "default" ] || [ "$quant" = "auto" ]; then
    quant="$(_llama_recommended_quant_for_target 26b)"
  fi

  case "$quant" in
    q4|4bit|recommended|default|balanced)
      model_file="gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      ;;
    q5)
      model_file="gemma-4-26B-A4B-it-UD-Q5_K_XL.gguf"
      ;;
    q6)
      model_file="gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf"
      ;;
    q8|8bit)
      model_file="gemma-4-26B-A4B-it-Q8_0.gguf"
      ;;
    *.gguf)
      model_file="$quant"
      ;;
    *)
      echo "Usage: llama-pull-gemma4-26b [q4|q5|q6|q8|<filename.gguf>]"
      return 1
      ;;
  esac

  rel="gemma-4-26B-A4B-it-GGUF/$model_file"
  [ -f "$LLAMA_CPP_MODELS/$rel" ] || was_missing=1
  mkdir -p "$target"
  hf download unsloth/gemma-4-26B-A4B-it-GGUF \
    "$model_file" \
    mmproj-BF16.gguf \
    --local-dir "$target"
  _llama_maybe_tune_after_pull "$rel" "$was_missing"
}

llama-pull-gemma4-26b-mmproj() {
  local target="$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF"

  mkdir -p "$target"
  hf download unsloth/gemma-4-26B-A4B-it-GGUF \
    mmproj-BF16.gguf \
    --local-dir "$target"
}

llama-pull-gemma4-31b-mmproj() {
  local target="$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF"

  mkdir -p "$target"
  hf download unsloth/gemma-4-31B-it-GGUF \
    mmproj-BF16.gguf \
    --local-dir "$target"
}

llama-pull-gemma4-e4b() {
  local target="$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF"
  local quant="${1:-recommended}"
  local model_file=""
  local rel=""
  local was_missing=0

  if [ "$quant" = "recommended" ] || [ "$quant" = "default" ] || [ "$quant" = "auto" ]; then
    quant="$(_llama_recommended_quant_for_target e4b)"
  fi

  case "$quant" in
    q8|8bit|recommended|default)
      model_file="gemma-4-E4B-it-Q8_0.gguf"
      ;;
    q4|4bit|balanced)
      model_file="gemma-4-E4B-it-UD-Q4_K_XL.gguf"
      ;;
    q5)
      model_file="gemma-4-E4B-it-UD-Q5_K_XL.gguf"
      ;;
    q6)
      model_file="gemma-4-E4B-it-UD-Q6_K_XL.gguf"
      ;;
    q4km)
      model_file="gemma-4-E4B-it-Q4_K_M.gguf"
      ;;
    q5km)
      model_file="gemma-4-E4B-it-Q5_K_M.gguf"
      ;;
    *.gguf)
      model_file="$quant"
      ;;
    *)
      echo "Usage: llama-pull-gemma4-e4b [q8|q4|q5|q6|q4km|q5km|<filename.gguf>]"
      return 1
      ;;
  esac

  rel="gemma-4-E4B-it-GGUF/$model_file"
  [ -f "$LLAMA_CPP_MODELS/$rel" ] || was_missing=1
  mkdir -p "$target"
  hf download unsloth/gemma-4-E4B-it-GGUF \
    "$model_file" \
    mmproj-BF16.gguf \
    --local-dir "$target"
  _llama_maybe_tune_after_pull "$rel" "$was_missing"
}

llama-pull-gemma4-31b() {
  local target="$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF"
  local quant="${1:-recommended}"
  local model_file=""
  local rel=""
  local was_missing=0

  if [ "$quant" = "recommended" ] || [ "$quant" = "default" ] || [ "$quant" = "auto" ]; then
    quant="$(_llama_recommended_quant_for_target 31b)"
  fi

  case "$quant" in
    q4|4bit|recommended|default|best)
      model_file="gemma-4-31B-it-UD-Q4_K_XL.gguf"
      ;;
    q5)
      model_file="gemma-4-31B-it-UD-Q5_K_XL.gguf"
      ;;
    q6)
      model_file="gemma-4-31B-it-UD-Q6_K_XL.gguf"
      ;;
    q8|8bit)
      model_file="gemma-4-31B-it-Q8_0.gguf"
      ;;
    *.gguf)
      model_file="$quant"
      ;;
    *)
      echo "Usage: llama-pull-gemma4-31b [q4|q5|q6|q8|<filename.gguf>]"
      return 1
      ;;
  esac

  rel="gemma-4-31B-it-GGUF/$model_file"
  [ -f "$LLAMA_CPP_MODELS/$rel" ] || was_missing=1
  mkdir -p "$target"
  hf download unsloth/gemma-4-31B-it-GGUF \
    "$model_file" \
    mmproj-BF16.gguf \
    --local-dir "$target"
  _llama_maybe_tune_after_pull "$rel" "$was_missing"
}

llama-pull-qwen35-27b-q5() {
  local target="$LLAMA_CPP_MODELS/Qwen3.5-27B-GGUF"
  local rel="Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf"
  local was_missing=0

  [ -f "$LLAMA_CPP_MODELS/$rel" ] || was_missing=1
  mkdir -p "$target"
  hf download unsloth/Qwen3.5-27B-GGUF \
    Qwen3.5-27B-UD-Q5_K_XL.gguf \
    --local-dir "$target"
  _llama_maybe_tune_after_pull "$rel" "$was_missing"
}

llama-pull-qwen36-35b() {
  local target="$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF"
  local quant="${1:-recommended}"
  local model_file=""
  local rel=""
  local was_missing=0

  if [ "$quant" = "recommended" ] || [ "$quant" = "default" ] || [ "$quant" = "auto" ]; then
    quant="$(_llama_recommended_quant_for_target qwen)"
  fi

  case "$quant" in
    q2|q2xl)
      model_file="Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf"
      ;;
    q3s)
      model_file="Qwen3.6-35B-A3B-UD-Q3_K_S.gguf"
      ;;
    q3m)
      model_file="Qwen3.6-35B-A3B-UD-Q3_K_M.gguf"
      ;;
    q3xl)
      model_file="Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf"
      ;;
    q4m)
      model_file="Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
      ;;
    q4|q4xl|4bit|recommended|default)
      model_file="Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
      ;;
    q5)
      model_file="Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf"
      ;;
    q6)
      model_file="Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf"
      ;;
    q8|8bit)
      model_file="Qwen3.6-35B-A3B-Q8_0.gguf"
      ;;
    mxfp4)
      model_file="Qwen3.6-35B-A3B-MXFP4_MOE.gguf"
      ;;
    *.gguf)
      model_file="$quant"
      ;;
    *)
      echo "Usage: llama-pull-qwen36-35b [q2|q3s|q3m|q3xl|q4|q4m|q5|q6|q8|mxfp4|<filename.gguf>]"
      return 1
      ;;
  esac

  rel="Qwen3.6-35B-A3B-GGUF/$model_file"
  [ -f "$LLAMA_CPP_MODELS/$rel" ] || was_missing=1
  mkdir -p "$target"
  hf download unsloth/Qwen3.6-35B-A3B-GGUF \
    "$model_file" \
    mmproj-BF16.gguf \
    --local-dir "$target"
  _llama_maybe_tune_after_pull "$rel" "$was_missing"
}

llama-pull-qwen36-35b-mmproj() {
  local target="$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF"

  mkdir -p "$target"
  hf download unsloth/Qwen3.6-35B-A3B-GGUF \
    mmproj-BF16.gguf \
    --local-dir "$target"
}

run-qwen35-27b() {
  local model="${1:-Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf}"
  local temp="0.7"
  local top_p="0.8"

  _local_ai_ensure_model_assets "$model" || return 1

  if _local_ai_thinking_enabled; then
    temp="1.0"
    top_p="0.95"
  fi

  llama-start "$model" \
    --ctx-size "$LLAMA_CPP_GEMMA_CTX_SIZE" \
    --temp "$temp" \
    --top-p "$top_p" \
    --top-k 20 \
    --presence-penalty 1.5 \
    --chat-template-kwargs "$(_local_ai_chat_template_kwargs)"
}

_local_ai_qwen_chat_template_kwargs() {
  local preserve="false"

  if _local_ai_thinking_enabled; then
    case "${LOCAL_AI_PRESERVE_THINKING:-true}" in
      0|false|FALSE|no|NO|off|OFF)
        preserve="false"
        ;;
      *)
        preserve="true"
        ;;
    esac

    printf '%s\n' "{\"enable_thinking\":true,\"preserve_thinking\":${preserve}}"
    return 0
  fi

  printf '%s\n' '{"enable_thinking":false,"preserve_thinking":false}'
}

run-qwen36-35b() {
  local model="${1:-$(_llama_default_qwen36_model)}"
  local mmproj=""
  local temp="0.7"
  local top_p="0.8"
  local presence_penalty="1.5"

  _local_ai_ensure_model_assets "$model" || return 1

  mmproj="$(_llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$model")" || {
    echo "No Qwen 3.6 35B-A3B mmproj file found under $LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF"
    return 1
  }

  if _local_ai_thinking_enabled; then
    temp="0.6"
    top_p="0.95"
    presence_penalty="0.0"
  fi

  llama-start "$model" \
    --mmproj "$mmproj" \
    --ctx-size "$LLAMA_CPP_QWEN_CTX_SIZE" \
    --temp "$temp" \
    --top-p "$top_p" \
    --top-k 20 \
    --min-p 0.0 \
    --presence-penalty "$presence_penalty" \
    --repeat-penalty 1.0 \
    --chat-template-kwargs "$(_local_ai_qwen_chat_template_kwargs)"
}

run-gemma4-31b() {
  local model="${1:-gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf}"

  _llama_start_gemma4_model "$model" "gemma-4-31B-it-GGUF" "Gemma 4 31B"
}

_local_ai_ensure_runtime_dir() {
  mkdir -p "$LOCAL_AI_RUNTIME_DIR"
}

_local_ai_validation_file() {
  printf '%s\n' "$LOCAL_AI_RUNTIME_DIR/lmstudio-validation.tsv"
}

_local_ai_source_model() {
  printf '%s\n' "${LOCAL_AI_SOURCE_MODEL:-$LLAMA_CPP_DEFAULT_MODEL}"
}

_local_ai_thinking_enabled() {
  case "${LOCAL_AI_ENABLE_THINKING:-false}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

_local_ai_chat_template_kwargs() {
  if _local_ai_thinking_enabled; then
    printf '%s\n' '{"enable_thinking":true}'
  else
    printf '%s\n' '{"enable_thinking":false}'
  fi
}

llama-thinking() {
  local mode="${1:-current}"

  case "$mode" in
    on|enable|enabled|true|thinking)
      export LOCAL_AI_ENABLE_THINKING="true"
      ;;
    off|disable|disabled|false|instruct|non-thinking|nonthinking)
      export LOCAL_AI_ENABLE_THINKING="false"
      ;;
    preserve-on|preserve|retain|keep)
      export LOCAL_AI_PRESERVE_THINKING="true"
      ;;
    preserve-off|drop|discard)
      export LOCAL_AI_PRESERVE_THINKING="false"
      ;;
    current|"")
      ;;
    *)
      echo "Usage: llama-thinking {on|off|preserve-on|preserve-off|current}"
      return 1
      ;;
  esac

  echo "LOCAL_AI_ENABLE_THINKING=$LOCAL_AI_ENABLE_THINKING"
  echo "LOCAL_AI_PRESERVE_THINKING=$LOCAL_AI_PRESERVE_THINKING"
  echo "LLAMA_CHAT_TEMPLATE_KWARGS=$(_local_ai_chat_template_kwargs)"
  echo "QWEN_CHAT_TEMPLATE_KWARGS=$(_local_ai_qwen_chat_template_kwargs)"
}

_local_ai_profile_name() {
  local profile="${1:-$LLAMA_CPP_MACHINE_PROFILE}"

  case "$profile" in
    mac-mini-16g|mini|16g)
      printf '%s\n' "mac-mini-16g"
      ;;
    balanced|mid)
      printf '%s\n' "balanced"
      ;;
    macbook-pro-48g|macbook-pro|mbp|laptop|desktop-48g|desktop|48g|best)
      printf '%s\n' "macbook-pro-48g"
      ;;
    *)
      printf '%s\n' "$profile"
      ;;
  esac
}

_local_ai_preset_overrides_file() {
  printf '%s\n' "${LOCAL_AI_PRESET_OVERRIDES_FILE:-$LOCAL_AI_RUNTIME_DIR/preset-overrides.tsv}"
}

_local_ai_profile_preset_file_override() {
  local profile="$(_local_ai_profile_name "$1")"
  local preset="$2"
  local file="$(_local_ai_preset_overrides_file)"

  [ -f "$file" ] || return 1
  awk -F '\t' -v profile="$profile" -v preset="$preset" '$1 == profile && $2 == preset { print $3; found = 1 } END { exit(found ? 0 : 1) }' "$file" | tail -n 1
}

_local_ai_profile_preset_override() {
  local profile="$(_local_ai_profile_name "$1")"
  local preset="$2"
  local profile_key="${profile//-/_}"
  local preset_key="$preset"
  local var_name="LOCAL_AI_PRESET_${profile_key}_${preset_key}_MODEL"
  local env_override=""
  local file_override=""

  profile_key="${(U)profile_key}"
  preset_key="${(U)preset_key}"
  var_name="LOCAL_AI_PRESET_${profile_key}_${preset_key}_MODEL"

  env_override="${(P)var_name}"
  if [ -n "$env_override" ]; then
    printf '%s\n' "$env_override"
    return 0
  fi

  file_override="$(_local_ai_profile_preset_file_override "$profile" "$preset" 2>/dev/null || true)"
  [ -n "$file_override" ] && printf '%s\n' "$file_override"
}

_local_ai_profile_preset_model() {
  local profile="$(_local_ai_profile_name "$1")"
  local preset="$2"
  local override="$(_local_ai_profile_preset_override "$profile" "$preset")"

  if [ -n "$override" ]; then
    printf '%s\n' "$override"
    return 0
  fi

  case "$profile:$preset" in
    mac-mini-16g:best)
      printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
      ;;
    mac-mini-16g:vision)
      printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
      ;;
    mac-mini-16g:balanced|mac-mini-16g:fast)
      printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf"
      ;;
    *:best)
      printf '%s\n' "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
      ;;
    *:balanced)
      printf '%s\n' "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      ;;
    *:vision)
      printf '%s\n' "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      ;;
    *:fast)
      printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
      ;;
    *)
      echo "Unknown preset mapping for profile '$profile': $preset"
      return 1
      ;;
  esac
}

_local_ai_profile_preset_set() {
  local profile="$(_local_ai_profile_name "$1")"
  local preset="$2"
  local rel="$3"
  local file="$(_local_ai_preset_overrides_file)"
  local tmp=""

  _local_ai_ensure_runtime_dir
  mkdir -p "${file:h}"
  tmp="$(mktemp "${TMPDIR:-/tmp}/preset-overrides.XXXXXX")" || return 1

  if [ -f "$file" ]; then
    awk -F '\t' -v profile="$profile" -v preset="$preset" '!( $1 == profile && $2 == preset ) { print $0 }' "$file" > "$tmp"
  fi

  printf '%s\t%s\t%s\t%s\n' "$profile" "$preset" "$rel" "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$tmp"
  mv "$tmp" "$file"
}

llama-curated-promotions() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    bun "$cli" catalog promotions
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

llama-curated-promote() {
  local cli="${LLAMACTL_HOME:-$DEV_STORAGE/repos/personal/llamactl}/packages/cli/src/bin.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$cli" ]; then
    local profile="${1:-$LLAMA_CPP_MACHINE_PROFILE}"
    bun "$cli" catalog promote "$profile" "$2" "$3"
    return $?
  fi
  echo "llamactl CLI not available (bun missing or LLAMACTL_HOME unset)" >&2
  return 1
}

_llama_curated_promote_legacy() {
  local profile="${1:-$LLAMA_CPP_MACHINE_PROFILE}"
  local preset="$2"
  local target="$3"
  local rel=""

  case "$preset" in
    best|vision|balanced|fast)
      ;;
    *)
      echo "Usage: llama-curated-promote <profile> <best|vision|balanced|fast> <model-target>"
      return 1
      ;;
  esac

  if [ -z "$target" ]; then
    echo "Usage: llama-curated-promote <profile> <best|vision|balanced|fast> <model-target>"
    return 1
  fi

  if [[ "$target" == *.gguf ]] || [[ "$target" == */* ]]; then
    rel="$target"
  else
    rel="$(_local_ai_resolve_model_target "$target")" || return 1
  fi

  _local_ai_profile_preset_set "$profile" "$preset" "$rel" || return 1
  echo "Promoted $rel"
  echo "profile=$(_local_ai_profile_name "$profile") preset=$preset"
}

_local_ai_is_named_preset() {
  case "$1" in
    best|quality|vision|image|31b|gemma4-31b|gemma-4-31b|balanced|daily|26b|gemma4-26b|gemma-4-26b|fast|small|e4b|gemma4-e4b|gemma-4-e4b|qwen|qwen36|qwen3.6|qwen3.6-35b|qwen35b|qwen27|qwen35|qwen3.5-27b)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

_local_ai_list_importable_models() {
  mkdir -p "$LLAMA_CPP_MODELS"

  find "$LLAMA_CPP_MODELS" -type f -iname '*.gguf' \
    ! -iname 'mmproj*.gguf' \
    ! -iname '*mmproj*' \
    ! -iname '*proj*' \
    | sort
}

_local_ai_model_has_mmproj() {
  local rel="$1"
  local model_dir="$LLAMA_CPP_MODELS/${rel%/*}"

  _llama_find_mmproj "$model_dir" "$rel" >/dev/null 2>&1
}

_local_ai_lmstudio_model_key() {
  local rel="$1"
  local repo="${rel%%/*}"

  printf 'local/%s\n' "$repo"
}

_local_ai_get_validation_status() {
  local rel="$1"
  local file="$(_local_ai_validation_file)"

  if [ ! -f "$file" ]; then
    return 1
  fi

  awk -F '\t' -v rel="$rel" '$1 == rel { print $2 }' "$file" | tail -n 1
}

_local_ai_set_validation_status() {
  local rel="$1"
  local status="$2"
  local note="$3"
  local file="$(_local_ai_validation_file)"
  local tmp

  _local_ai_ensure_runtime_dir
  note="${note//$'\t'/ }"
  note="${note//$'\n'/ }"
  tmp="$(mktemp "${TMPDIR:-/tmp}/local-ai-validation.XXXXXX")" || return 1

  if [ -f "$file" ]; then
    awk -F '\t' -v rel="$rel" '$1 != rel { print $0 }' "$file" > "$tmp"
  fi

  printf '%s\t%s\t%s\n' "$rel" "$status" "$note" >> "$tmp"
  mv "$tmp" "$file"
}

_local_ai_resolve_model_target() {
  local target="${1:-current}"

  case "$target" in
    current|"")
      _local_ai_source_model
      ;;
    best|quality)
      _local_ai_profile_preset_model "$LLAMA_CPP_MACHINE_PROFILE" "best"
      ;;
    vision|image)
      _local_ai_profile_preset_model "$LLAMA_CPP_MACHINE_PROFILE" "vision"
      ;;
    balanced|daily)
      _local_ai_profile_preset_model "$LLAMA_CPP_MACHINE_PROFILE" "balanced"
      ;;
    fast|small)
      _local_ai_profile_preset_model "$LLAMA_CPP_MACHINE_PROFILE" "fast"
      ;;
    31b|gemma4-31b|gemma-4-31b)
      printf '%s\n' "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
      ;;
    26b|gemma4-26b|gemma-4-26b)
      printf '%s\n' "gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      ;;
    e4b|gemma4-e4b|gemma-4-e4b)
      printf '%s\n' "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
      ;;
    qwen|qwen36|qwen3.6|qwen3.6-35b|qwen35b)
      _llama_recommended_qwen36_model_for_profile "$LLAMA_CPP_MACHINE_PROFILE"
      ;;
    qwen27|qwen35|qwen3.5-27b)
      printf '%s\n' "Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf"
      ;;
    *.gguf|*/*)
      printf '%s\n' "$target"
      ;;
    *)
      echo "Unknown model target: $target"
      return 1
      ;;
  esac
}

_llama_recommended_quant_for_target() {
  local target="${1:-current}"
  local rel=""
  local profile="$(_local_ai_profile_name "$LLAMA_CPP_MACHINE_PROFILE")"

  case "$target" in
    31b|gemma4-31b|gemma-4-31b)
      rel="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
      ;;
    26b|gemma4-26b|gemma-4-26b)
      rel="gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
      ;;
    e4b|gemma4-e4b|gemma-4-e4b)
      if [ "$profile" = "mac-mini-16g" ]; then
        printf '%s\n' "q4"
      else
        printf '%s\n' "q8"
      fi
      return 0
      ;;
    qwen|qwen36|qwen3.6|qwen3.6-35b|qwen35b)
      case "$profile" in
        mac-mini-16g)
          printf '%s\n' "q3s"
          ;;
        balanced)
          printf '%s\n' "q4m"
          ;;
        *)
          printf '%s\n' "q4"
          ;;
      esac
      return 0
      ;;
    qwen27|qwen35|qwen3.5-27b)
      printf '%s\n' "q5"
      return 0
      ;;
    *)
      rel="$(_local_ai_resolve_model_target "$target")" || return 1
      ;;
  esac

  case "$rel" in
    gemma-4-31B-it-GGUF/*Q8_0.gguf)
      printf '%s\n' "q8"
      ;;
    gemma-4-31B-it-GGUF/*Q6*.gguf)
      printf '%s\n' "q6"
      ;;
    gemma-4-31B-it-GGUF/*Q5*.gguf)
      printf '%s\n' "q5"
      ;;
    gemma-4-31B-it-GGUF/*)
      printf '%s\n' "q4"
      ;;
    gemma-4-26B-A4B-it-GGUF/*Q8_0.gguf)
      printf '%s\n' "q8"
      ;;
    gemma-4-26B-A4B-it-GGUF/*Q6*.gguf)
      printf '%s\n' "q6"
      ;;
    gemma-4-26B-A4B-it-GGUF/*Q5*.gguf)
      printf '%s\n' "q5"
      ;;
    gemma-4-26B-A4B-it-GGUF/*)
      printf '%s\n' "q4"
      ;;
    gemma-4-E4B-it-GGUF/*Q8_0.gguf)
      printf '%s\n' "q8"
      ;;
    gemma-4-E4B-it-GGUF/*Q6*.gguf)
      printf '%s\n' "q6"
      ;;
    gemma-4-E4B-it-GGUF/*Q5_K_M.gguf)
      printf '%s\n' "q5km"
      ;;
    gemma-4-E4B-it-GGUF/*Q5*.gguf)
      printf '%s\n' "q5"
      ;;
    gemma-4-E4B-it-GGUF/*Q4_K_M.gguf)
      printf '%s\n' "q4km"
      ;;
    gemma-4-E4B-it-GGUF/*)
      printf '%s\n' "q4"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q8_0.gguf)
      printf '%s\n' "q8"
      ;;
    Qwen3.6-35B-A3B-GGUF/*MXFP4_MOE.gguf)
      printf '%s\n' "mxfp4"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q6*.gguf)
      printf '%s\n' "q6"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q5*.gguf)
      printf '%s\n' "q5"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q4_K_M.gguf)
      printf '%s\n' "q4m"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q4*.gguf)
      printf '%s\n' "q4"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q3_K_S.gguf)
      printf '%s\n' "q3s"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q3_K_M.gguf)
      printf '%s\n' "q3m"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q3*.gguf)
      printf '%s\n' "q3xl"
      ;;
    Qwen3.6-35B-A3B-GGUF/*Q2*.gguf)
      printf '%s\n' "q2"
      ;;
    Qwen3.5-27B-GGUF/*)
      printf '%s\n' "q5"
      ;;
    *)
      echo "No recommended quant mapping for $target"
      return 1
      ;;
  esac
}

llama-recommend-quant() {
  local target="${1:-current}"
  local quant=""
  local rel=""

  quant="$(_llama_recommended_quant_for_target "$target")" || return 1
  rel="$(_local_ai_resolve_model_target "$target")" 2>/dev/null || true

  if [ -n "$rel" ]; then
    echo "target=$target"
    echo "model=$rel"
  fi
  echo "recommended_quant=$quant"
}

llama-pull-recommended() {
  local target="${1:-current}"
  local quant=""
  local rel=""

  rel="$(_local_ai_resolve_model_target "$target")" || return 1
  quant="$(_llama_recommended_quant_for_target "$target")" || return 1

  case "$rel" in
    gemma-4-31B-it-GGUF/*)
      llama-pull-gemma4-31b "$quant"
      ;;
    gemma-4-26B-A4B-it-GGUF/*)
      llama-pull-gemma4-26b "$quant"
      ;;
    gemma-4-E4B-it-GGUF/*)
      llama-pull-gemma4-e4b "$quant"
      ;;
    Qwen3.6-35B-A3B-GGUF/*)
      llama-pull-qwen36-35b "$quant"
      ;;
    Qwen3.5-27B-GGUF/*)
      llama-pull-qwen35-27b-q5
      ;;
    *)
      echo "No recommended pull mapping for $target"
      return 1
      ;;
  esac
}

_local_ai_ensure_model_assets() {
  local rel="$1"

  case "$rel" in
    gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 31B Q4 model..."
        llama-pull-gemma4-31b q4 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 31B mmproj..."
        llama-pull-gemma4-31b-mmproj || return 1
      fi
      ;;
    gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q5_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 31B Q5 model..."
        llama-pull-gemma4-31b q5 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 31B mmproj..."
        llama-pull-gemma4-31b-mmproj || return 1
      fi
      ;;
    gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q6_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 31B Q6 model..."
        llama-pull-gemma4-31b q6 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 31B mmproj..."
        llama-pull-gemma4-31b-mmproj || return 1
      fi
      ;;
    gemma-4-31B-it-GGUF/gemma-4-31B-it-Q8_0.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 31B Q8 model..."
        llama-pull-gemma4-31b q8 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 31B mmproj..."
        llama-pull-gemma4-31b-mmproj || return 1
      fi
      ;;
    gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 26B Q4 model..."
        llama-pull-gemma4-26b q4 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 26B mmproj..."
        llama-pull-gemma4-26b-mmproj || return 1
      fi
      ;;
    gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q5_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 26B Q5 model..."
        llama-pull-gemma4-26b q5 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 26B mmproj..."
        llama-pull-gemma4-26b-mmproj || return 1
      fi
      ;;
    gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 26B Q6 model..."
        llama-pull-gemma4-26b q6 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 26B mmproj..."
        llama-pull-gemma4-26b-mmproj || return 1
      fi
      ;;
    gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-Q8_0.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 26B Q8 model..."
        llama-pull-gemma4-26b q8 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 26B mmproj..."
        llama-pull-gemma4-26b-mmproj || return 1
      fi
      ;;
    gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 E4B Q8 model..."
        llama-pull-gemma4-e4b q8 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 E4B mmproj..."
        llama-pull-gemma4-e4b q8 || return 1
      fi
      ;;
    gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 E4B Q4 model..."
        llama-pull-gemma4-e4b q4 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 E4B mmproj..."
        llama-pull-gemma4-e4b q4 || return 1
      fi
      ;;
    gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q5_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 E4B Q5 model..."
        llama-pull-gemma4-e4b q5 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 E4B mmproj..."
        llama-pull-gemma4-e4b q5 || return 1
      fi
      ;;
    gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q6_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 E4B Q6 model..."
        llama-pull-gemma4-e4b q6 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 E4B mmproj..."
        llama-pull-gemma4-e4b q6 || return 1
      fi
      ;;
    gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 E4B Q4_K_M model..."
        llama-pull-gemma4-e4b q4km || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 E4B mmproj..."
        llama-pull-gemma4-e4b q4km || return 1
      fi
      ;;
    gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q5_K_M.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Gemma 4 E4B Q5_K_M model..."
        llama-pull-gemma4-e4b q5km || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1; then
        echo "Pulling missing Gemma 4 E4B mmproj..."
        llama-pull-gemma4-e4b q5km || return 1
      fi
      ;;
    Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.5 27B model..."
        llama-pull-qwen35-27b-q5 || return 1
      fi
      ;;
    Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.6 35B-A3B Q3_K_S model..."
        llama-pull-qwen36-35b q3s || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1; then
        echo "Pulling missing Qwen 3.6 35B-A3B mmproj..."
        llama-pull-qwen36-35b-mmproj || return 1
      fi
      ;;
    Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.6 35B-A3B Q4_K_M model..."
        llama-pull-qwen36-35b q4m || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1; then
        echo "Pulling missing Qwen 3.6 35B-A3B mmproj..."
        llama-pull-qwen36-35b-mmproj || return 1
      fi
      ;;
    Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.6 35B-A3B Q4_K_XL model..."
        llama-pull-qwen36-35b q4 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1; then
        echo "Pulling missing Qwen 3.6 35B-A3B mmproj..."
        llama-pull-qwen36-35b-mmproj || return 1
      fi
      ;;
    Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.6 35B-A3B Q5_K_XL model..."
        llama-pull-qwen36-35b q5 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1; then
        echo "Pulling missing Qwen 3.6 35B-A3B mmproj..."
        llama-pull-qwen36-35b-mmproj || return 1
      fi
      ;;
    Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.6 35B-A3B Q6_K_XL model..."
        llama-pull-qwen36-35b q6 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1; then
        echo "Pulling missing Qwen 3.6 35B-A3B mmproj..."
        llama-pull-qwen36-35b-mmproj || return 1
      fi
      ;;
    Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-Q8_0.gguf)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        echo "Pulling missing Qwen 3.6 35B-A3B Q8_0 model..."
        llama-pull-qwen36-35b q8 || return 1
      fi

      if ! _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1; then
        echo "Pulling missing Qwen 3.6 35B-A3B mmproj..."
        llama-pull-qwen36-35b-mmproj || return 1
      fi
      ;;
    *)
      if [ ! -f "$LLAMA_CPP_MODELS/$rel" ]; then
        local repo=""
        local file=""

        repo="$(_llama_hf_repo_for_rel "$rel" 2>/dev/null || true)"
        if [ -n "$repo" ]; then
          file="${rel#*/}"
          echo "Pulling missing catalog model from $repo..."
          _llama_pull_repo_model "$repo" "$file" || return 1
        else
          echo "Model not found: $LLAMA_CPP_MODELS/$rel"
          return 1
        fi
      fi
      ;;
  esac
}

_local_ai_llama_cpp_model_runnable() {
  local rel="$1"
  local class=""

  case "$rel" in
    gemma-4-31B-it-GGUF/*)
      [ -f "$LLAMA_CPP_MODELS/$rel" ] || return 1
      _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF" >/dev/null 2>&1
      ;;
    gemma-4-26B-A4B-it-GGUF/*)
      [ -f "$LLAMA_CPP_MODELS/$rel" ] || return 1
      _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF" >/dev/null 2>&1
      ;;
    gemma-4-E4B-it-GGUF/*)
      [ -f "$LLAMA_CPP_MODELS/$rel" ] || return 1
      _llama_find_mmproj "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF" >/dev/null 2>&1
      ;;
    Qwen3.6-35B-A3B-GGUF/*)
      [ -f "$LLAMA_CPP_MODELS/$rel" ] || return 1
      _llama_find_mmproj "$LLAMA_CPP_MODELS/Qwen3.6-35B-A3B-GGUF" "$rel" >/dev/null 2>&1
      ;;
    *)
      [ -f "$LLAMA_CPP_MODELS/$rel" ] || return 1
      class="$(_llama_model_class_for_rel "$rel")"
      if [ "$class" = "multimodal" ]; then
        _llama_find_mmproj "$LLAMA_CPP_MODELS/${rel%/*}" "$rel" >/dev/null 2>&1
      else
        return 0
      fi
      ;;
  esac
}

_local_ai_resolve_llama_cpp_target() {
  local target="${1:-current}"
  local requested=""
  local primary=""
  local candidates=""
  local candidate=""

  case "$target" in
    current|"")
      requested="$(_local_ai_source_model)"
      if _local_ai_llama_cpp_model_runnable "$requested"; then
        printf '%s\n' "$requested"
        return 0
      fi
      echo "Current llama.cpp model is not runnable: $requested"
      return 1
      ;;
    best|quality|vision|image|balanced|daily|fast|small)
      primary="$(_local_ai_resolve_model_target "$target")" || return 1

      case "$(_local_ai_profile_name "$LLAMA_CPP_MACHINE_PROFILE"):$target" in
        mac-mini-16g:best|mac-mini-16g:quality)
          candidates=$'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf\ngemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\nQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf\nQwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf'
          ;;
        mac-mini-16g:vision|mac-mini-16g:image)
          candidates=$'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf\ngemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'
          ;;
        mac-mini-16g:balanced|mac-mini-16g:daily)
          candidates=$'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\ngemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\nQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf\nQwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf'
          ;;
        mac-mini-16g:fast|mac-mini-16g:small)
          candidates=$'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf'
          ;;
        *:best|*:quality)
          candidates=$'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf\nQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf\ngemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\nQwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf'
          ;;
        *:vision|*:image)
          candidates=$'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\ngemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf'
          ;;
        *:balanced|*:daily)
          candidates=$'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\nQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf\ngemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\nQwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf\ngemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf'
          ;;
        *)
          candidates=$'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf\nQwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf\nQwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf\ngemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf\ngemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf'
          ;;
      esac

      for candidate in ${(f)candidates}; do
        if _local_ai_llama_cpp_model_runnable "$candidate"; then
          if [ "$candidate" != "$primary" ]; then
            echo "Requested $target, but $primary is not runnable locally. Using $candidate instead." >&2
          fi
          printf '%s\n' "$candidate"
          return 0
        fi
      done
      ;;
    qwen|qwen36|qwen3.6|qwen3.6-35b|qwen35b|qwen27|qwen35|qwen3.5-27b|*.gguf|*/*)
      requested="$(_local_ai_resolve_model_target "$target")" || return 1
      if _local_ai_llama_cpp_model_runnable "$requested"; then
        printf '%s\n' "$requested"
        return 0
      fi
      echo "Requested llama.cpp model is not runnable: $requested"
      return 1
      ;;
    *)
      echo "Unknown model target: $target"
      return 1
      ;;
  esac

  echo "No runnable llama.cpp model found for target: $target"
  return 1
}

_local_ai_run_llama_cpp_source() {
  local rel="$1"

  case "$rel" in
    gemma-4-31B-it-GGUF/*)
      run-gemma4-31b "$rel"
      ;;
    gemma-4-26B-A4B-it-GGUF/*)
      run-gemma4-26b "$rel"
      ;;
    gemma-4-E4B-it-GGUF/*)
      run-gemma4-e4b "$rel"
      ;;
    Qwen3.6-35B-A3B-GGUF/*)
      run-qwen36-35b "$rel"
      ;;
    Qwen3.5-27B-GGUF/*)
      run-qwen35-27b "$rel"
      ;;
    *)
      llama-start "$rel"
      ;;
  esac
}

_local_ai_sync_env() {
  local source_model="$(_local_ai_source_model)"

  case "$source_model" in
    Qwen3.6-35B-A3B-GGUF/*|Qwen3.5-27B-GGUF/*)
      export LOCAL_AI_CONTEXT_LENGTH="$LLAMA_CPP_QWEN_CTX_SIZE"
      ;;
    *)
      export LOCAL_AI_CONTEXT_LENGTH="$LLAMA_CPP_GEMMA_CTX_SIZE"
      ;;
  esac

  case "$LOCAL_AI_PROVIDER" in
    lmstudio)
      export LOCAL_AI_PROVIDER="lmstudio"
      export LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LMSTUDIO_BASE_URL"
      export LOCAL_AI_API_KEY="${LM_API_TOKEN:-local}"
      export LOCAL_AI_MODEL="$(_local_ai_lmstudio_model_key "$source_model")"
      ;;
    *)
      export LOCAL_AI_PROVIDER="llama.cpp"
      export LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LLAMA_CPP_BASE_URL"
      export LOCAL_AI_API_KEY="local"
      export LOCAL_AI_MODEL="$LLAMA_CPP_SERVER_ALIAS"
      ;;
  esac

  export OPENAI_BASE_URL="$LOCAL_AI_PROVIDER_URL"
  export OPENAI_API_KEY="$LOCAL_AI_API_KEY"
}

_local_ai_lmstudio_model_exists() {
  local key="$1"

  command -v lms >/dev/null 2>&1 || return 1
  lms ls "$key" --json >/dev/null 2>&1
}

_local_ai_lmstudio_start_server() {
  command -v lms >/dev/null 2>&1 || {
    echo "LM Studio CLI not found"
    return 1
  }

  lms server start --bind "$LOCAL_AI_LMSTUDIO_HOST" --port "$LOCAL_AI_LMSTUDIO_PORT" >/dev/null 2>&1 || true
}

_local_ai_lmstudio_validate_model() {
  local rel="$1"
  local key="$2"
  local base="${rel##*/}"
  local identifier=""

  if ! _local_ai_model_has_mmproj "$rel"; then
    _local_ai_set_validation_status "$rel" "text" "text-only import"
    return 0
  fi

  base="${base%.gguf}"
  identifier="local-ai-validate-${base}-$$"

  _local_ai_lmstudio_start_server || return 1

  if lms load "$key" --context-length "$LOCAL_AI_CONTEXT_LENGTH" --identifier "$identifier" -y >/dev/null 2>&1; then
    lms unload "$identifier" >/dev/null 2>&1 || true
    _local_ai_set_validation_status "$rel" "lmstudio-capable" "multimodal import validated"
    echo "LM Studio multimodal validation passed for $rel"
    return 0
  fi

  _local_ai_set_validation_status "$rel" "llama.cpp-preferred" "LM Studio load failed for multimodal import"
  echo "LM Studio could not validate multimodal support for $rel; keep using llama.cpp for this model"
  return 0
}

lmstudio-import-llama-model() {
  local dry_run=0
  local rel=""
  local abs=""
  local key=""
  local cmd=()

  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
  esac

  rel="$1"

  if [ -z "$rel" ]; then
    echo "Usage: lmstudio-import-llama-model [--dry-run] <relative-gguf-path>"
    return 1
  fi

  case "$rel" in
    *mmproj*.gguf|mmproj*.gguf)
      echo "Skipping sidecar file: $rel"
      return 0
      ;;
  esac

  abs="$(_llama_require_model "$rel")" || return 1
  key="$(_local_ai_lmstudio_model_key "$rel")"
  cmd=(lms import "$abs" --yes --user-repo "$key" --symbolic-link)

  if [ "$dry_run" -eq 1 ]; then
    cmd+=(--dry-run)
  fi

  "${cmd[@]}" || return 1

  if [ "$dry_run" -eq 1 ]; then
    return 0
  fi

  _local_ai_lmstudio_validate_model "$rel" "$key" || return 1
  _local_ai_sync_env >/dev/null 2>&1 || true
}

lmstudio-import-llama-all() {
  local dry_run=0
  local rel=""
  local total=0
  local failures=0

  case "$1" in
    --dry-run)
      dry_run=1
      ;;
  esac

  while IFS= read -r rel; do
    total=$((total + 1))

    if [ "$dry_run" -eq 1 ]; then
      lmstudio-import-llama-model --dry-run "$rel" || failures=$((failures + 1))
    else
      lmstudio-import-llama-model "$rel" || failures=$((failures + 1))
    fi
  done < <(_local_ai_list_importable_models | sed "s#^$LLAMA_CPP_MODELS/##")

  echo "LM Studio import summary: total=$total failures=$failures"

  if [ "$failures" -gt 0 ]; then
    return 1
  fi
}

lmstudio-list-imported() {
  local rel=""
  local key=""
  local imported=""
  local validation=""

  command -v lms >/dev/null 2>&1 || {
    echo "LM Studio CLI not found"
    return 1
  }

  while IFS= read -r rel; do
    key="$(_local_ai_lmstudio_model_key "$rel")"
    imported="no"
    validation="text"

    if _local_ai_lmstudio_model_exists "$key"; then
      imported="yes"
    fi

    if _local_ai_model_has_mmproj "$rel"; then
      validation="$(_local_ai_get_validation_status "$rel")"
      if [ -z "$validation" ]; then
        validation="unvalidated"
      fi
    fi

    printf '%s | imported=%s | validation=%s | source=%s\n' "$key" "$imported" "$validation" "$rel"
  done < <(_local_ai_list_importable_models | sed "s#^$LLAMA_CPP_MODELS/##")
}

local-ai-use() {
  local provider="${1:-}"

  case "$provider" in
    lmstudio|lm)
      export LOCAL_AI_PROVIDER="lmstudio"
      ;;
    llama.cpp|llama|llamacpp)
      export LOCAL_AI_PROVIDER="llama.cpp"
      ;;
    current|"")
      ;;
    *)
      echo "Usage: local-ai-use {lmstudio|llama.cpp|current}"
      return 1
      ;;
  esac

  _local_ai_sync_env
  echo "LOCAL_AI_PROVIDER -> $LOCAL_AI_PROVIDER"
  echo "LOCAL_AI_PROVIDER_URL -> $LOCAL_AI_PROVIDER_URL"
  echo "LOCAL_AI_MODEL -> $LOCAL_AI_MODEL"
}

local-ai-env() {
  _local_ai_sync_env

  echo "export LOCAL_AI_PROVIDER=$LOCAL_AI_PROVIDER"
  echo "export LOCAL_AI_PROVIDER_URL=$LOCAL_AI_PROVIDER_URL"
  echo "export LOCAL_AI_API_KEY=$LOCAL_AI_API_KEY"
  echo "export LOCAL_AI_MODEL=$LOCAL_AI_MODEL"
  echo "export LOCAL_AI_CONTEXT_LENGTH=$LOCAL_AI_CONTEXT_LENGTH"
  echo "export OPENAI_BASE_URL=$OPENAI_BASE_URL"
  echo "export OPENAI_API_KEY=$OPENAI_API_KEY"
}

local-ai-status() {
  local reachability="down"
  local api_key_mode="local"
  local imported="n/a"
  local source_model="$(_local_ai_source_model)"

  _local_ai_sync_env

  if [ "$LOCAL_AI_API_KEY" != "local" ]; then
    api_key_mode="token"
  fi

  case "$LOCAL_AI_PROVIDER" in
    lmstudio)
      if _local_ai_lmstudio_model_exists "$LOCAL_AI_MODEL"; then
        imported="yes"
      else
        imported="no"
      fi

      if [ "$api_key_mode" = "token" ]; then
        curl -fsS -H "Authorization: Bearer $LOCAL_AI_API_KEY" "$LOCAL_AI_PROVIDER_URL/models" >/dev/null 2>&1 && reachability="up"
      else
        curl -fsS "$LOCAL_AI_PROVIDER_URL/models" >/dev/null 2>&1 && reachability="up"
      fi
      ;;
    *)
      curl -fsS "$(_llama_endpoint)/health" >/dev/null 2>&1 && reachability="up"
      ;;
  esac

  echo "LOCAL_AI_PROVIDER:       $LOCAL_AI_PROVIDER"
  echo "LOCAL_AI_PROVIDER_URL:   $LOCAL_AI_PROVIDER_URL"
  echo "LOCAL_AI_API_KEY_MODE:   $api_key_mode"
  echo "LOCAL_AI_MODEL:          $LOCAL_AI_MODEL"
  echo "LOCAL_AI_SOURCE_MODEL:   $source_model"
  echo "LOCAL_AI_CONTEXT_LENGTH: $LOCAL_AI_CONTEXT_LENGTH"
  echo "Local AI server:         $reachability"

  local overrides_file="$(_local_ai_preset_overrides_file)"
  local override_count=0
  if [ -f "$overrides_file" ]; then
    override_count="$(awk 'NF' "$overrides_file" | wc -l | tr -d ' ')"
  fi
  echo "Preset promotions:       $override_count (file=$overrides_file)"

  if [ "$LOCAL_AI_PROVIDER" = "lmstudio" ]; then
    echo "LM Studio imported:      $imported"
  fi
}

local-ai-load() {
  local target="${1:-current}"
  local rel=""
  local key=""
  local validation=""

  case "$LOCAL_AI_PROVIDER" in
    lmstudio)
      rel="$(_local_ai_resolve_model_target "$target")" || return 1
      if _local_ai_is_named_preset "$target"; then
        _local_ai_ensure_model_assets "$rel" || return 1
      fi
      _llama_switch_default_model "$rel" || return 1
      key="$(_local_ai_lmstudio_model_key "$rel")"

      if ! _local_ai_lmstudio_model_exists "$key"; then
        echo "Importing $rel into LM Studio..."
        lmstudio-import-llama-model "$rel" || return 1
      fi

      if _local_ai_model_has_mmproj "$rel"; then
        validation="$(_local_ai_get_validation_status "$rel")"

        if [ "$validation" != "lmstudio-capable" ]; then
          _local_ai_lmstudio_validate_model "$rel" "$key" || return 1
          validation="$(_local_ai_get_validation_status "$rel")"
        fi

        if [ "$validation" = "llama.cpp-preferred" ]; then
          echo "LM Studio is not validated for multimodal use with $rel"
          echo "Use: local-ai-use llama.cpp && local-ai-load $target"
          return 1
        fi
      fi

      _local_ai_lmstudio_start_server || return 1
      lms load "$key" --context-length "$LOCAL_AI_CONTEXT_LENGTH" -y || return 1
      _local_ai_sync_env
      echo "LM Studio model loaded: $key"
      ;;
    *)
      rel="$(_local_ai_resolve_model_target "$target")" || return 1
      if _local_ai_is_named_preset "$target"; then
        _local_ai_ensure_model_assets "$rel" || return 1
      fi
      rel="$(_local_ai_resolve_llama_cpp_target "$target")" || return 1
      _llama_switch_default_model "$rel" || return 1
      _local_ai_run_llama_cpp_source "$rel" || return 1
      _local_ai_sync_env
      ;;
  esac
}

alias qwen27='run-qwen35-27b'
alias gemma4-best='llama-switch best'
alias gemma4-vision='llama-switch vision'
alias gemma4-balanced='llama-switch balanced'
alias gemma4-fast='llama-switch fast'
alias gemma4-mini='run-gemma4-e4b'
alias gemma4-profile-mini='llama-profile mini'
alias gemma4-profile-macbook-pro='llama-profile macbook-pro'
alias gemma4-profile-desktop='llama-profile macbook-pro'
alias gemma4-switch-best='llama-switch best'
alias gemma4-switch-vision='llama-switch vision'
alias gemma4-switch-balanced='llama-switch balanced'
alias gemma4-switch-fast='llama-switch fast'
alias gemma4-best-pull='llama-pull-recommended best'
alias gemma4-balanced-pull='llama-pull-recommended balanced'
alias gemma4-fast-pull='llama-pull-recommended fast'
alias gemma4-mini-pull='llama-pull-gemma4-e4b q8'
alias gemma4-31b-pull='llama-pull-gemma4-31b'
alias gemma4-31b-mmproj-pull='llama-pull-gemma4-31b-mmproj'
alias gemma4-26b-pull='llama-pull-gemma4-26b'
alias gemma4-26b-mmproj-pull='llama-pull-gemma4-26b-mmproj'
alias gemma4-e4b-pull='llama-pull-gemma4-e4b'
alias qwen='llama-switch qwen'
alias qwen36='llama-switch qwen'
alias qwen-pull='llama-pull-recommended qwen'
alias qwen36-pull='llama-pull-qwen36-35b'
alias qwen36-mmproj-pull='llama-pull-qwen36-35b-mmproj'
alias qwen27-pull='llama-pull-qwen35-27b-q5'
alias llama-thinking-on='llama-thinking on'
alias llama-thinking-off='llama-thinking off'

alias claude-mem='bun "$HOME/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs"'

autoload -Uz add-zsh-hook

devstorage-autoheal() {
  if ! builtin pwd >/dev/null 2>&1; then
    cd "$DEV_STORAGE" 2>/dev/null || cd "$HOME"
  fi
}

add-zsh-hook precmd devstorage-autoheal

if [[ -o interactive ]]; then
  if [[ -n "$DEV_STORAGE_REPAIR_BACKUP" ]]; then
    echo "ℹ️ Archived legacy DevStorage to $DEV_STORAGE_REPAIR_BACKUP and switched back to WorkSSD"
  fi

  if [[ "$DEV_STORAGE_MODE" = "local" ]]; then
    if [[ -d "$WORKSSD" ]]; then
      echo "⚠️ WorkSSD is mounted, but DevStorage is still using local storage"
    else
      echo "⚠️ WorkSSD not mounted — using local fallback"
    fi
  fi
fi
