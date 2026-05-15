#!/usr/bin/env bash
# Day-1 spike: MLX-LM → llama.cpp LoRA adapter end-to-end.
# Trains a 20-iter LoRA on dummy data, bridges MLX→PEFT, converts to GGUF,
# loads via llama-server --lora on :18099, observes a response.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
VENDOR_DIR="$ROOT_DIR/vendor/llama.cpp"
REPORT_FILE="$ROOT_DIR/SPIKE_REPORT.md"
DATA_DIR="$ROOT_DIR/data"
WORK_DIR="$ROOT_DIR/.spike-work"
MLX_ADAPTER_DIR="$WORK_DIR/mlx-adapter"
PEFT_DIR="$WORK_DIR/peft-adapter"
GGUF_DIR="$WORK_DIR/gguf"
HF_BASE_DIR="$WORK_DIR/hf-base"
PORT=18099
MODEL_CHAIN=(
  "Qwen/Qwen2.5-0.5B-Instruct"
  "Qwen/Qwen2.5-0.5B"
  "Qwen/Qwen3-0.6B-Base"
)

mkdir -p "$WORK_DIR" "$GGUF_DIR"

verdict="PARTIAL"
verdict_reason=""
step_train="SKIP"; step_bridge="SKIP"; step_convert="SKIP"; step_serve="SKIP"
train_wall=0; bridge_wall=0; convert_wall=0; serve_wall=0
picked_model=""; picked_rank=0
mlx_version=""; llama_commit=""; py_version=""; os_uname=""
server_pid=""
serve_response=""
rename_lines=""

cleanup() {
  if [ -n "${server_pid:-}" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() { printf '\n[spike] %s\n' "$*" >&2; }

# --- Step 0: env ---
log "step 0: venv + deps"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"
"$PIP" install --quiet --upgrade pip
"$PIP" install --quiet "mlx-lm" "safetensors" "numpy" "huggingface_hub"

py_version="$("$PYTHON" --version 2>&1)"
mlx_version="$("$PIP" show mlx-lm 2>/dev/null | awk '/^Version:/ {print $2}')"
os_uname="$(uname -sm)"

# --- Step 0.5: vendor llama.cpp + python deps for conversion ---
log "step 0.5: vendor llama.cpp"
if [ ! -d "$VENDOR_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$VENDOR_DIR"
fi
llama_commit="$(git -C "$VENDOR_DIR" rev-parse --short HEAD)"
# Skip llama.cpp's requirements file — its pins (torch~=2.6, numpy~=1.26, transformers==5.5.1)
# don't satisfy on Python 3.14. Install what convert_{hf,lora}_to_gguf.py actually imports,
# without version pins.
"$PIP" install --quiet torch transformers sentencepiece gguf protobuf

LLAMA_SERVER="/Users/acordeiro/.llamactl/bin/llama-server"
if [ ! -x "$LLAMA_SERVER" ]; then
  LLAMA_SERVER="$VENDOR_DIR/build/bin/llama-server"
  if [ ! -x "$LLAMA_SERVER" ]; then
    log "building llama-server (may take a while)"
    cmake -S "$VENDOR_DIR" -B "$VENDOR_DIR/build" -DGGML_METAL=ON -DLLAMA_BUILD_TESTS=OFF >/dev/null
    cmake --build "$VENDOR_DIR/build" --target llama-server -j 2>&1 | tail -5
  fi
fi

# --- Step 0.75: pick & fetch model ---
log "step 0.75: pick model"
for i in "${!MODEL_CHAIN[@]}"; do
  candidate="${MODEL_CHAIN[$i]}"
  log "trying $candidate"
  if "$VENV_DIR/bin/hf" download "$candidate" \
       --local-dir "$HF_BASE_DIR" >"$WORK_DIR/hf-download.log" 2>&1; then
    picked_model="$candidate"
    picked_rank=$((i + 1))
    break
  fi
done
if [ -z "$picked_model" ]; then
  verdict="PARTIAL"
  verdict_reason="no model in fallback chain fetchable"
  goto_report=1
else
  goto_report=0
fi

# --- Step 1: train ---
if [ "$goto_report" = "0" ]; then
  log "step 1: train"
  rm -rf "$MLX_ADAPTER_DIR"; mkdir -p "$MLX_ADAPTER_DIR"
  t0=$(date +%s)
  if "$PYTHON" -m mlx_lm.lora --model "$HF_BASE_DIR" --train \
       --data "$DATA_DIR" --iters 20 --batch-size 1 --num-layers 4 \
       --adapter-path "$MLX_ADAPTER_DIR" 2>&1 | tail -20 ; then
    step_train="PASS"
  else
    step_train="FAIL"
    verdict="FAIL"; verdict_reason="step 1 (train) failed"
  fi
  train_wall=$(( $(date +%s) - t0 ))
fi

# --- Step 2: bridge MLX → PEFT ---
if [ "$step_train" = "PASS" ]; then
  log "step 2: bridge"
  rm -rf "$PEFT_DIR"
  t0=$(date +%s)
  if "$PYTHON" "$ROOT_DIR/src/bridge/mlx_to_peft.py" "$MLX_ADAPTER_DIR" "$PEFT_DIR" \
       > "$WORK_DIR/bridge.log" 2>&1 ; then
    step_bridge="PASS"
    rename_lines="$(grep '→' "$WORK_DIR/bridge.log" | head -4 || true)"
  else
    step_bridge="FAIL"
    verdict="FAIL"; verdict_reason="step 2 (bridge) failed"
  fi
  bridge_wall=$(( $(date +%s) - t0 ))
fi

# --- Step 3: convert PEFT → GGUF (also base → GGUF if missing) ---
if [ "$step_bridge" = "PASS" ]; then
  log "step 3: convert"
  t0=$(date +%s)
  base_gguf="$GGUF_DIR/base.gguf"
  adapter_gguf="$GGUF_DIR/adapter.gguf"
  ok=1
  if [ ! -f "$base_gguf" ]; then
    "$PYTHON" "$VENDOR_DIR/convert_hf_to_gguf.py" "$HF_BASE_DIR" \
       --outfile "$base_gguf" --outtype f16 > "$WORK_DIR/base-convert.log" 2>&1 || ok=0
  fi
  if [ "$ok" = "1" ]; then
    "$PYTHON" "$VENDOR_DIR/convert_lora_to_gguf.py" --base "$HF_BASE_DIR" \
       --outfile "$adapter_gguf" --outtype f16 "$PEFT_DIR" \
       > "$WORK_DIR/lora-convert.log" 2>&1 || ok=0
  fi
  if [ "$ok" = "1" ] && [ -f "$adapter_gguf" ]; then
    step_convert="PASS"
  else
    step_convert="FAIL"
    verdict="FAIL"; verdict_reason="step 3 (convert) failed"
  fi
  convert_wall=$(( $(date +%s) - t0 ))
fi

# --- Step 4: serve + request ---
if [ "$step_convert" = "PASS" ]; then
  log "step 4: serve"
  t0=$(date +%s)
  "$LLAMA_SERVER" --model "$GGUF_DIR/base.gguf" --lora "$GGUF_DIR/adapter.gguf" \
      --port "$PORT" --no-webui > "$WORK_DIR/server.log" 2>&1 &
  server_pid=$!
  # Wait up to 30s for the server to come up.
  for _ in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q "ok"; then
      break
    fi
    sleep 1
  done
  if curl -s "http://127.0.0.1:$PORT/completion" \
       -H "Content-Type: application/json" \
       -d '{"prompt":"Reverse: hello\n","n_predict":16,"temperature":0.0}' \
       > "$WORK_DIR/serve-resp.json" 2>&1; then
    serve_response="$(head -c 240 "$WORK_DIR/serve-resp.json")"
    step_serve="PASS"
    verdict="PASS"; verdict_reason="all four steps green"
  else
    step_serve="FAIL"
    verdict="FAIL"; verdict_reason="step 4 (serve) failed"
  fi
  serve_wall=$(( $(date +%s) - t0 ))
fi

# --- write the real report ---
{
  echo "# Spike report — MLX-LM → llama.cpp LoRA adapter"
  echo
  echo "## Bottom line"
  echo "$verdict: $verdict_reason"
  echo
  echo "## Environment"
  echo "- mlx-lm: $mlx_version"
  echo "- llama.cpp commit: $llama_commit"
  echo "- Python: $py_version"
  echo "- OS: $os_uname"
  echo "- Model (rank $picked_rank of ${#MODEL_CHAIN[@]}): $picked_model"
  echo
  echo "## Step results"
  echo "| # | Step | Result | Wall |"
  echo "|---|------|--------|------|"
  echo "| 1 | Train   | $step_train   | ${train_wall}s |"
  echo "| 2 | Bridge  | $step_bridge  | ${bridge_wall}s |"
  echo "| 3 | Convert | $step_convert | ${convert_wall}s |"
  echo "| 4 | Serve   | $step_serve   | ${serve_wall}s |"
  echo
  echo "## Bridge key map (sample)"
  echo '```'
  echo "${rename_lines:-no bridge output captured}"
  echo '```'
  echo
  echo "## Serve response (head, truncated)"
  echo '```'
  echo "${serve_response:-no response captured}"
  echo '```'
  echo
  echo "## Blockers / next-session inputs"
  echo "- Scale path: rerun this script with \`Qwen/Qwen3-8B-Base\` (16 GB download) once the toolchain is green here."
  echo "- Q/K-norm LoRA: Qwen3 attention uses Q/K-norm; the bridge's target_modules detection currently uses \`lora_parameters.keys\` from MLX config — verify Qwen3 mlx-lm writes those keys correctly."
  echo "- \`convert_lora_to_gguf.py\` Qwen3.5 reshape bug (issue ggml-org/llama.cpp#21125) — verify against Qwen3 first."
} > "$REPORT_FILE"

echo "SPIKE: $verdict"
case "$verdict" in
  PASS) exit 0 ;;
  PARTIAL) exit 0 ;;
  *) exit 1 ;;
esac
