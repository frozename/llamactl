#!/usr/bin/env bash
# Idempotent download of a pre-built MTP-aware GGUF from HF into
# $LLAMA_CPP_MODELS. Use this in place of conversion when upstream
# (or community) ships an MTP GGUF directly.
set -euo pipefail
MODEL_ID="${1:?usage: download.sh <catalog-model-id>}"
: "${LLAMA_CPP_MODELS:?LLAMA_CPP_MODELS must be set}"

case "$MODEL_ID" in
  qwen36-mtp)
    HF_REPO="am17an/Qwen3.6-35BA3B-MTP-GGUF"
    REL_DIR="Qwen3.6-35B-A3B-MTP-GGUF"
    ;;
  *)
    echo "Unknown model id: $MODEL_ID" >&2
    exit 2
    ;;
esac

echo "==> Inspecting $HF_REPO"
FILES_JSON="$(curl -fsSL "https://huggingface.co/api/models/$HF_REPO/tree/main?recursive=1&expand=1")"
PREFERRED=("Q4_K_M" "Q4_K_S" "Q5_K_M" "Q4_0" "Q8_0")
PICK=""
for q in "${PREFERRED[@]}"; do
  PICK="$(echo "$FILES_JSON" | python3 -c "import sys, json; files=json.load(sys.stdin); [print(f.get('path','')) for f in files if f.get('type')=='file' and f.get('path','').lower().endswith('.gguf') and '$q'.lower() in f.get('path','').lower()]" | head -1)"
  [[ -n "$PICK" ]] && break
done

if [[ -z "$PICK" ]]; then
  PICK="$(echo "$FILES_JSON" | python3 -c "import sys, json; files=json.load(sys.stdin); rows=[(f.get('size') or 0, f.get('path','')) for f in files if f.get('type')=='file' and f.get('path','').lower().endswith('.gguf') and f.get('path','')]; rows.sort(); print(rows[0][1] if rows else '')")"
fi

if [[ -z "$PICK" ]]; then
  echo "No .gguf files found in $HF_REPO" >&2
  exit 3
fi

OUT_DIR="$LLAMA_CPP_MODELS/$REL_DIR"
OUT_FILE="$OUT_DIR/$PICK"
if [[ -f "$OUT_FILE" ]]; then
  echo "Already present: $OUT_FILE"
  exit 0
fi

mkdir -p "$OUT_DIR"
echo "==> Downloading $HF_REPO :: $PICK"
hf download "$HF_REPO" "$PICK" --local-dir "$OUT_DIR"

echo "==> Wrote $OUT_FILE"
ls -lh "$OUT_FILE"
