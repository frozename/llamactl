# llamactl environment setup
#
# Intended to be sourced from a shell profile or other env module.
# Defines paths, default models, and OpenAI-compatible URLs used by
# llamactl.zsh. Every value is guarded so callers can override any
# individual variable upstream.
#
# Requires $DEV_STORAGE to be set by the caller. If unset, falls back to
# $HOME/.llamactl so the library still works out of the box.

if [ -z "$DEV_STORAGE" ]; then
  export DEV_STORAGE="$HOME/.llamactl"
fi

export HF_HOME="${HF_HOME:-$DEV_STORAGE/cache/huggingface}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-$HF_HOME/hub}"

export OLLAMA_MODELS="${OLLAMA_MODELS:-$DEV_STORAGE/ai-models/ollama}"

export LLAMA_CPP_SRC="${LLAMA_CPP_SRC:-$DEV_STORAGE/src/llama.cpp}"
export LLAMA_CPP_BIN="${LLAMA_CPP_BIN:-$LLAMA_CPP_SRC/build/bin}"

export LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-$DEV_STORAGE/ai-models/llama.cpp}"
export LLAMA_CPP_MODELS="${LLAMA_CPP_MODELS:-$LLAMA_CPP_ROOT/models}"
export LLAMA_CPP_CACHE="${LLAMA_CPP_CACHE:-$LLAMA_CPP_ROOT/.cache}"
export LLAMA_CPP_LOGS="${LLAMA_CPP_LOGS:-$DEV_STORAGE/logs/llama.cpp}"

export LLAMA_CPP_HOST="${LLAMA_CPP_HOST:-127.0.0.1}"
export LLAMA_CPP_PORT="${LLAMA_CPP_PORT:-8080}"

if [ -z "$LLAMA_CPP_MACHINE_PROFILE" ]; then
  _llama_cpp_hw_mem_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"

  case "$_llama_cpp_hw_mem_bytes" in
    ''|*[!0-9]*)
      export LLAMA_CPP_MACHINE_PROFILE="macbook-pro-48g"
      ;;
    *)
      if [ "$_llama_cpp_hw_mem_bytes" -le 17179869184 ]; then
        export LLAMA_CPP_MACHINE_PROFILE="mac-mini-16g"
      elif [ "$_llama_cpp_hw_mem_bytes" -le 34359738368 ]; then
        export LLAMA_CPP_MACHINE_PROFILE="balanced"
      else
        export LLAMA_CPP_MACHINE_PROFILE="macbook-pro-48g"
      fi
      ;;
  esac

  unset _llama_cpp_hw_mem_bytes
fi

if [ -z "$LLAMA_CPP_GEMMA_CTX_SIZE" ]; then
  case "$LLAMA_CPP_MACHINE_PROFILE" in
    mac-mini-16g)
      export LLAMA_CPP_GEMMA_CTX_SIZE="16384"
      ;;
    balanced)
      export LLAMA_CPP_GEMMA_CTX_SIZE="24576"
      ;;
    *)
      export LLAMA_CPP_GEMMA_CTX_SIZE="32768"
      ;;
  esac
fi

if [ -z "$LLAMA_CPP_QWEN_CTX_SIZE" ]; then
  case "$LLAMA_CPP_MACHINE_PROFILE" in
    mac-mini-16g)
      export LLAMA_CPP_QWEN_CTX_SIZE="16384"
      ;;
    balanced)
      export LLAMA_CPP_QWEN_CTX_SIZE="32768"
      ;;
    *)
      export LLAMA_CPP_QWEN_CTX_SIZE="65536"
      ;;
  esac
fi

if [ -z "$LLAMA_CPP_DEFAULT_MODEL" ]; then
  if [ "$LLAMA_CPP_MACHINE_PROFILE" = "mac-mini-16g" ]; then
    if [ -f "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
    elif [ -f "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf"
    elif [ -f "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
    else
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
    fi
  elif [ "$LLAMA_CPP_MACHINE_PROFILE" = "balanced" ]; then
    if [ -f "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
    elif [ -f "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
    elif [ -f "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
    else
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
    fi
  else
    if [ -f "$LLAMA_CPP_MODELS/gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
    elif [ -f "$LLAMA_CPP_MODELS/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf"
    elif [ -f "$LLAMA_CPP_MODELS/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf" ]; then
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf"
    else
      export LLAMA_CPP_DEFAULT_MODEL="gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
    fi
  fi
fi

export LLAMA_CPP_SERVER_ALIAS="${LLAMA_CPP_SERVER_ALIAS:-local}"

export LLAMA_CACHE="${LLAMA_CACHE:-$LLAMA_CPP_CACHE}"

export LOCAL_AI_LMSTUDIO_HOST="${LOCAL_AI_LMSTUDIO_HOST:-127.0.0.1}"
export LOCAL_AI_LMSTUDIO_PORT="${LOCAL_AI_LMSTUDIO_PORT:-1234}"
export LOCAL_AI_LMSTUDIO_BASE_URL="${LOCAL_AI_LMSTUDIO_BASE_URL:-http://$LOCAL_AI_LMSTUDIO_HOST:$LOCAL_AI_LMSTUDIO_PORT/v1}"
export LOCAL_AI_LLAMA_CPP_BASE_URL="${LOCAL_AI_LLAMA_CPP_BASE_URL:-http://$LLAMA_CPP_HOST:$LLAMA_CPP_PORT/v1}"
export LOCAL_AI_RUNTIME_DIR="${LOCAL_AI_RUNTIME_DIR:-$DEV_STORAGE/ai-models/local-ai}"
export LOCAL_AI_ENABLE_THINKING="${LOCAL_AI_ENABLE_THINKING:-false}"
export LOCAL_AI_PRESERVE_THINKING="${LOCAL_AI_PRESERVE_THINKING:-true}"
export LOCAL_AI_RECOMMENDATIONS_SOURCE="${LOCAL_AI_RECOMMENDATIONS_SOURCE:-hf}"
export LOCAL_AI_HF_CACHE_TTL_SECONDS="${LOCAL_AI_HF_CACHE_TTL_SECONDS:-43200}"
export LOCAL_AI_DISCOVERY_AUTHOR="${LOCAL_AI_DISCOVERY_AUTHOR:-unsloth}"
export LOCAL_AI_DISCOVERY_LIMIT="${LOCAL_AI_DISCOVERY_LIMIT:-24}"
export LOCAL_AI_DISCOVERY_SEARCH="${LOCAL_AI_DISCOVERY_SEARCH:-GGUF}"
export LOCAL_AI_CUSTOM_CATALOG_FILE="${LOCAL_AI_CUSTOM_CATALOG_FILE:-$LOCAL_AI_RUNTIME_DIR/curated-models.tsv}"
export LOCAL_AI_PRESET_OVERRIDES_FILE="${LOCAL_AI_PRESET_OVERRIDES_FILE:-$LOCAL_AI_RUNTIME_DIR/preset-overrides.tsv}"
export LLAMA_CPP_KEEP_ALIVE_INTERVAL="${LLAMA_CPP_KEEP_ALIVE_INTERVAL:-5}"
export LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF="${LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF:-30}"
export LLAMA_CPP_AUTO_TUNE_ON_PULL="${LLAMA_CPP_AUTO_TUNE_ON_PULL:-true}"
export LLAMA_CPP_AUTO_BENCH_VISION="${LLAMA_CPP_AUTO_BENCH_VISION:-true}"
export LOCAL_AI_BENCH_IMAGE="${LOCAL_AI_BENCH_IMAGE:-}"

LOCAL_AI_SOURCE_MODEL="${LOCAL_AI_SOURCE_MODEL:-$LLAMA_CPP_DEFAULT_MODEL}"

if [ -z "$LOCAL_AI_PROVIDER" ]; then
  export LOCAL_AI_PROVIDER="llama.cpp"
fi

export LOCAL_AI_CONTEXT_LENGTH="${LOCAL_AI_CONTEXT_LENGTH:-$LLAMA_CPP_GEMMA_CTX_SIZE}"

case "$LOCAL_AI_PROVIDER" in
  lmstudio)
    export LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LMSTUDIO_BASE_URL"
    export LOCAL_AI_API_KEY="${LM_API_TOKEN:-local}"
    export LOCAL_AI_MODEL="${LOCAL_AI_MODEL:-local/${LOCAL_AI_SOURCE_MODEL%%/*}}"
    ;;
  *)
    export LOCAL_AI_PROVIDER="llama.cpp"
    export LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LLAMA_CPP_BASE_URL"
    export LOCAL_AI_API_KEY="local"
    export LOCAL_AI_MODEL="${LOCAL_AI_MODEL:-$LLAMA_CPP_SERVER_ALIAS}"
    ;;
esac

export OPENAI_BASE_URL="$LOCAL_AI_PROVIDER_URL"
export OPENAI_API_KEY="$LOCAL_AI_API_KEY"

if [ -d "$LLAMA_CPP_BIN" ]; then
  if [ -n "$ZSH_VERSION" ]; then
    path=("$LLAMA_CPP_BIN" $path)
    export PATH
  else
    export PATH="$LLAMA_CPP_BIN:$PATH"
  fi
fi

mkdir -p \
  "$HF_HOME" \
  "$HUGGINGFACE_HUB_CACHE" \
  "$OLLAMA_MODELS" \
  "$LLAMA_CPP_MODELS" \
  "$LLAMA_CPP_CACHE" \
  "$LLAMA_CPP_LOGS" \
  "$LOCAL_AI_RUNTIME_DIR" 2>/dev/null || true
