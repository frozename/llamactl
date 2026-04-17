# llamactl environment setup
#
# Preferred path: delegate to the TypeScript CLI (`llamactl env --eval`),
# which produces POSIX `export` lines plus a `mkdir -p` for managed dirs
# and a PATH tweak for $LLAMA_CPP_BIN. Running through the TS core keeps
# the shell and the Electron app sharing one source of truth for env
# resolution (machine profile, default model, provider URL, etc.).
#
# Fallback path: when `bun` is unavailable or the CLI cannot be located,
# a small block below sets the same variables with static defaults so an
# interactive shell still boots usefully. That block intentionally does
# not do machine-profile detection or default-model resolution — those
# only work properly through the TS core — but it establishes the paths
# that other scripts depend on.
#
# Callers should keep $DEV_STORAGE set before sourcing this file.
# $LLAMACTL_HOME defaults to the working location under DEV_STORAGE.

if [ -z "$DEV_STORAGE" ]; then
  export DEV_STORAGE="$HOME/.llamactl"
fi

: "${LLAMACTL_HOME:=$DEV_STORAGE/repos/personal/llamactl}"

_llamactl_ts_env_eval() {
  local cli="$LLAMACTL_HOME/packages/cli/src/bin.ts"
  [ -f "$cli" ] || return 1
  command -v bun >/dev/null 2>&1 || return 1
  local output
  output="$(bun "$cli" env --eval 2>/dev/null)" || return 1
  [ -n "$output" ] || return 1
  eval "$output"
}

if _llamactl_ts_env_eval; then
  unset -f _llamactl_ts_env_eval
  return 0 2>/dev/null || true
fi

unset -f _llamactl_ts_env_eval

# ---- fallback (Bun or CLI unavailable) ----------------------------------
# Static defaults so a broken Bun install doesn't strand shell integrations.

export HF_HOME="${HF_HOME:-$DEV_STORAGE/cache/huggingface}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-$HF_HOME/hub}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-$DEV_STORAGE/ai-models/ollama}"

export LLAMA_CPP_SRC="${LLAMA_CPP_SRC:-$DEV_STORAGE/src/llama.cpp}"
export LLAMA_CPP_BIN="${LLAMA_CPP_BIN:-$LLAMA_CPP_SRC/build/bin}"
export LLAMA_CPP_ROOT="${LLAMA_CPP_ROOT:-$DEV_STORAGE/ai-models/llama.cpp}"
export LLAMA_CPP_MODELS="${LLAMA_CPP_MODELS:-$LLAMA_CPP_ROOT/models}"
export LLAMA_CPP_CACHE="${LLAMA_CPP_CACHE:-$LLAMA_CPP_ROOT/.cache}"
export LLAMA_CPP_LOGS="${LLAMA_CPP_LOGS:-$DEV_STORAGE/logs/llama.cpp}"
export LLAMA_CACHE="${LLAMA_CACHE:-$LLAMA_CPP_CACHE}"

export LLAMA_CPP_HOST="${LLAMA_CPP_HOST:-127.0.0.1}"
export LLAMA_CPP_PORT="${LLAMA_CPP_PORT:-8080}"
export LLAMA_CPP_SERVER_ALIAS="${LLAMA_CPP_SERVER_ALIAS:-local}"

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

export LOCAL_AI_PROVIDER="${LOCAL_AI_PROVIDER:-llama.cpp}"
case "$LOCAL_AI_PROVIDER" in
  lmstudio)
    export LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LMSTUDIO_BASE_URL"
    export LOCAL_AI_API_KEY="${LM_API_TOKEN:-local}"
    ;;
  *)
    export LOCAL_AI_PROVIDER="llama.cpp"
    export LOCAL_AI_PROVIDER_URL="$LOCAL_AI_LLAMA_CPP_BASE_URL"
    export LOCAL_AI_API_KEY="local"
    ;;
esac

export OPENAI_BASE_URL="$LOCAL_AI_PROVIDER_URL"
export OPENAI_API_KEY="$LOCAL_AI_API_KEY"

if [ -d "$LLAMA_CPP_BIN" ]; then
  case ":$PATH:" in
    *:$LLAMA_CPP_BIN:*) ;;
    *) export PATH="$LLAMA_CPP_BIN:$PATH" ;;
  esac
fi

mkdir -p \
  "$HF_HOME" \
  "$HUGGINGFACE_HUB_CACHE" \
  "$OLLAMA_MODELS" \
  "$LLAMA_CPP_MODELS" \
  "$LLAMA_CPP_CACHE" \
  "$LLAMA_CPP_LOGS" \
  "$LOCAL_AI_RUNTIME_DIR" 2>/dev/null || true
