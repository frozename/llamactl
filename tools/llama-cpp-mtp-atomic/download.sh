#!/usr/bin/env bash
# Idempotent download of the Gemma 4 26B-A4B AtomicChat assistant head
# (and optionally the unsloth UD-Q4_K_M base) into $LLAMA_CPP_MODELS.
# Skips files that already exist.
#
# Default: head only — the M4 Pro pilot reuses the UD-Q4_K_XL base
# already present on disk (decision recorded in the spec). Pass `--base`
# to also pull the spec-aligned UD-Q4_K_M.
#
# Spec: docs/superpowers/specs/2026-05-08-llamacpp-mtp-gemma4-pilot-design.md

set -euo pipefail

: "${LLAMA_CPP_MODELS:?LLAMA_CPP_MODELS must be set}"

want_base=0
want_head=1
case "${1:-}" in
  "")             ;;
  --base)         want_base=1 ;;
  --head-only)    ;;
  --base-only)    want_base=1; want_head=0 ;;
  *) echo "Unknown arg: $1 (allowed: --base | --head-only | --base-only)" >&2; exit 2 ;;
esac

fetch() {
  local repo="$1" file="$2" dir="$3"
  local out_dir="$LLAMA_CPP_MODELS/$dir"
  local out_file="$out_dir/$file"
  if [[ -f "$out_file" ]]; then
    echo "==> Already present: $out_file"
    return 0
  fi
  mkdir -p "$out_dir"
  echo "==> Downloading $repo :: $file"
  hf download "$repo" "$file" --local-dir "$out_dir"
  echo "==> Wrote $out_file"
  ls -lh "$out_file"
}

if (( want_head )); then
  fetch \
    "AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF" \
    "gemma-4-26B-A4B-it-assistant.Q4_K_M.gguf" \
    "gemma-4-26B-A4B-it-assistant-GGUF"
fi

if (( want_base )); then
  fetch \
    "unsloth/gemma-4-26B-A4B-it-GGUF" \
    "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf" \
    "gemma-4-26B-A4B-it-GGUF"
fi
