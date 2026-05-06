#!/usr/bin/env bash
# Idempotent download of a pre-built MTP-aware GGUF (or its vanilla
# baseline) from HF into $LLAMA_CPP_MODELS. Use this in place of
# conversion when upstream (or community) ships a usable GGUF.
set -euo pipefail
MODEL_ID="${1:?usage: download.sh <catalog-model-id>}"
: "${LLAMA_CPP_MODELS:?LLAMA_CPP_MODELS must be set}"

case "$MODEL_ID" in
  qwen36-27b-q4m)
    HF_REPO="unsloth/Qwen3.6-27B-GGUF"
    HF_FILE="Qwen3.6-27B-Q4_K_M.gguf"
    REL_DIR="Qwen3.6-27B-GGUF"
    ;;
  qwen36-27b-mtp)
    HF_REPO="RDson/Qwen3.6-27B-MTP-Q4_K_M-GGUF"
    HF_FILE="Qwen3.6-27B-MTP-Q4_K_M.gguf"
    REL_DIR="Qwen3.6-27B-MTP-GGUF"
    ;;
  *)
    echo "Unknown model id: $MODEL_ID" >&2
    exit 2
    ;;
esac

OUT_DIR="$LLAMA_CPP_MODELS/$REL_DIR"
OUT_FILE="$OUT_DIR/$HF_FILE"
if [[ -f "$OUT_FILE" ]]; then
  echo "Already present: $OUT_FILE"
  exit 0
fi
mkdir -p "$OUT_DIR"
echo "==> Downloading $HF_REPO :: $HF_FILE"
hf download "$HF_REPO" "$HF_FILE" --local-dir "$OUT_DIR"
echo "==> Wrote $OUT_FILE"
ls -lh "$OUT_FILE"
