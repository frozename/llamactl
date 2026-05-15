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
PORT=18099

# --- Pinned upstream versions ---
# Bump these intentionally; the spike report records what actually ran.
LLAMA_CPP_SHA="49d1701bd24e4cedf6dfec9e50e185111203946b"
# Model fallback chain. Each entry is "<repo>@<revision-sha>". The revision is
# the HF commit SHA captured at pin time; pinning protects against silent
# upstream changes to the weights or tokenizer.
MODEL_CHAIN=(
  "Qwen/Qwen2.5-0.5B-Instruct@7ae557604adf67be50417f59c2c2f167def9a775"
  "Qwen/Qwen2.5-0.5B@060db6499f32faf8b98477b0a26969ef7d8b9987"
  "Qwen/Qwen3-0.6B-Base@da87bfb608c14b7cf20ba1ce41287e8de496c0cd"
)
# Python deps pinned to versions verified working on Python 3.14 / macOS arm64.
# llama.cpp's requirements file pins torch~=2.6 / transformers==5.5.1, which
# don't satisfy on Python 3.14 — these are the next-best known-good versions.
PIP_PINS=(
  "mlx-lm==0.31.3"
  "safetensors==0.7.0"
  "numpy==2.4.5"
  "huggingface_hub==1.15.0"
  "torch==2.12.0"
  "transformers==5.8.1"
  "sentencepiece==0.2.1"
  "gguf==0.19.0"
  "protobuf==7.34.1"
  "pytest==8.3.4"
)

mkdir -p "$WORK_DIR" "$GGUF_DIR"

verdict="PARTIAL"
verdict_reason=""
step_train="SKIP"; step_bridge="SKIP"; step_convert="SKIP"; step_serve="SKIP"
train_duration_sec=0; bridge_duration_sec=0; convert_duration_sec=0; serve_duration_sec=0
picked_model=""; picked_revision=""; picked_fallback_index=0
mlx_version=""; llama_commit=""; py_version=""; os_uname=""
llama_server_source=""
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
"$PIP" install --quiet "${PIP_PINS[@]}"

py_version="$("$PYTHON" --version 2>&1)"
mlx_version="$("$PIP" show mlx-lm 2>/dev/null | awk '/^Version:/ {print $2}')"
os_uname="$(uname -sm)"

# --- Step 0.5: vendor llama.cpp at pinned SHA ---
log "step 0.5: vendor llama.cpp @ $LLAMA_CPP_SHA"
if [ ! -d "$VENDOR_DIR/.git" ]; then
  git clone https://github.com/ggml-org/llama.cpp.git "$VENDOR_DIR"
fi
git -C "$VENDOR_DIR" fetch --quiet origin "$LLAMA_CPP_SHA" || true
git -C "$VENDOR_DIR" checkout --quiet "$LLAMA_CPP_SHA"
llama_commit="$(git -C "$VENDOR_DIR" rev-parse HEAD)"

# llama-server discovery: prefer LLAMA_SERVER env override, then PATH lookup,
# then the vendored build (build it if missing). Keep the full cmake log.
if [ -n "${LLAMA_SERVER:-}" ] && [ -x "${LLAMA_SERVER}" ]; then
  llama_server_source="env override"
else
  candidate="$(command -v llama-server 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    LLAMA_SERVER="$candidate"
    llama_server_source="PATH ($candidate)"
  else
    LLAMA_SERVER="$VENDOR_DIR/build/bin/llama-server"
    if [ ! -x "$LLAMA_SERVER" ]; then
      log "building llama-server (may take a while)"
      cmake -S "$VENDOR_DIR" -B "$VENDOR_DIR/build" -DGGML_METAL=ON -DLLAMA_BUILD_TESTS=OFF \
        > "$WORK_DIR/cmake-configure.log" 2>&1
      cmake --build "$VENDOR_DIR/build" --target llama-server -j \
        > "$WORK_DIR/cmake-build.log" 2>&1
    fi
    llama_server_source="vendor build"
  fi
fi

# --- Step 0.75: pick & fetch model with revision pin ---
log "step 0.75: pick model"
for i in "${!MODEL_CHAIN[@]}"; do
  entry="${MODEL_CHAIN[$i]}"
  candidate_repo="${entry%@*}"
  candidate_rev="${entry##*@}"
  candidate_dir="$WORK_DIR/hf-base/$candidate_rev"
  log "trying $candidate_repo @ $candidate_rev"
  rm -rf "$candidate_dir"
  if "$VENV_DIR/bin/hf" download "$candidate_repo" --revision "$candidate_rev" \
       --local-dir "$candidate_dir" >"$WORK_DIR/hf-download.log" 2>&1; then
    picked_model="$candidate_repo"
    picked_revision="$candidate_rev"
    picked_fallback_index=$((i + 1))
    HF_BASE_DIR="$candidate_dir"
    break
  fi
done
if [ -z "$picked_model" ]; then
  verdict="PARTIAL"; verdict_reason="no model in fallback chain fetchable"
  steps_ran=0
else
  steps_ran=1
fi

# --- Step 1: train ---
if [ "$steps_ran" = "1" ]; then
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
  train_duration_sec=$(( $(date +%s) - t0 ))
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
  bridge_duration_sec=$(( $(date +%s) - t0 ))
fi

# --- Step 3: convert PEFT → GGUF (also base → GGUF if missing) ---
if [ "$step_bridge" = "PASS" ]; then
  log "step 3: convert"
  t0=$(date +%s)
  base_gguf="$GGUF_DIR/base.gguf"
  adapter_gguf="$GGUF_DIR/adapter.gguf"
  convert_ok=1
  if [ ! -f "$base_gguf" ]; then
    "$PYTHON" "$VENDOR_DIR/convert_hf_to_gguf.py" "$HF_BASE_DIR" \
       --outfile "$base_gguf" --outtype f16 > "$WORK_DIR/base-convert.log" 2>&1 || convert_ok=0
  fi
  if [ "$convert_ok" = "1" ]; then
    "$PYTHON" "$VENDOR_DIR/convert_lora_to_gguf.py" --base "$HF_BASE_DIR" \
       --outfile "$adapter_gguf" --outtype f16 "$PEFT_DIR" \
       > "$WORK_DIR/lora-convert.log" 2>&1 || convert_ok=0
  fi
  if [ "$convert_ok" = "1" ] && [ -f "$adapter_gguf" ]; then
    step_convert="PASS"
  else
    step_convert="FAIL"
    verdict="FAIL"; verdict_reason="step 3 (convert) failed"
  fi
  convert_duration_sec=$(( $(date +%s) - t0 ))
fi

# --- Step 4: serve + request (fail-closed: HTTP error or empty content => FAIL) ---
if [ "$step_convert" = "PASS" ]; then
  log "step 4: serve"
  t0=$(date +%s)
  "$LLAMA_SERVER" --model "$GGUF_DIR/base.gguf" --lora "$GGUF_DIR/adapter.gguf" \
      --port "$PORT" --no-webui > "$WORK_DIR/server.log" 2>&1 &
  server_pid=$!
  # Wait up to 30s for the server to come up.
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q "ok"; then
      break
    fi
    sleep 1
  done
  # -fsS: fail on HTTP error, silent except errors. Then schema-check the body
  # has a non-empty `content` field; mere HTTP 200 is not enough.
  if curl -fsS "http://127.0.0.1:$PORT/completion" \
       -H "Content-Type: application/json" \
       -d '{"prompt":"Reverse: hello\n","n_predict":16,"temperature":0.0}' \
       > "$WORK_DIR/serve-resp.json" 2>"$WORK_DIR/serve-err.log" \
     && "$PYTHON" -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get('content') else 1)" \
          "$WORK_DIR/serve-resp.json" ; then
    serve_response="$(head -c 240 "$WORK_DIR/serve-resp.json")"
    step_serve="PASS"
    verdict="PASS"; verdict_reason="all four steps green"
  else
    step_serve="FAIL"
    verdict="FAIL"; verdict_reason="step 4 (serve) failed (HTTP error or empty content)"
  fi
  serve_duration_sec=$(( $(date +%s) - t0 ))
fi

# --- write the report ---
{
  echo "# Spike report — MLX-LM → llama.cpp LoRA adapter"
  echo
  echo "## Bottom line"
  echo "$verdict: $verdict_reason"
  echo
  echo "## Environment"
  echo "- mlx-lm: $mlx_version"
  echo "- llama.cpp commit: $llama_commit"
  echo "- llama-server source: $llama_server_source"
  echo "- Python: $py_version"
  echo "- OS: $os_uname"
  echo "- Model (rank $picked_fallback_index of ${#MODEL_CHAIN[@]}): ${picked_model:-(none)} @ ${picked_revision:-(none)}"
  echo
  echo "## Step results"
  echo "| # | Step | Result | Wall |"
  echo "|---|------|--------|------|"
  echo "| 1 | Train   | $step_train   | ${train_duration_sec}s |"
  echo "| 2 | Bridge  | $step_bridge  | ${bridge_duration_sec}s |"
  echo "| 3 | Convert | $step_convert | ${convert_duration_sec}s |"
  echo "| 4 | Serve   | $step_serve   | ${serve_duration_sec}s |"
  echo
  echo "## Bridge key map (sample)"
  echo '```'
  echo "${rename_lines:-no bridge output captured}"
  echo '```'
  echo
  echo "## Serve response (first 240 bytes)"
  echo '```'
  echo "${serve_response:-no response captured}"
  echo '```'
} > "$REPORT_FILE"

echo "SPIKE: $verdict"
case "$verdict" in
  PASS) exit 0 ;;
  PARTIAL) exit 0 ;;
  *) exit 1 ;;
esac
