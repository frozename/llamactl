#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$ROOT_DIR/packages/eval/results"
MODELS_DIR="/Volumes/AI-MODELS/llama.cpp/models"
MAC_MINI_HOST="${MAC_MINI_HOST:-mac-mini}"

usage() {
  cat <<USAGE
usage: ./tools/stress-fleet.sh <A|B|C|D> <concurrency>

example:
  ./tools/stress-fleet.sh A 4
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

FLEET="${1:-}"
CONCURRENCY="${2:-}"

if [[ ! "$FLEET" =~ ^[ABCD]$ ]]; then
  echo "[stress] fleet must be one of A|B|C|D" >&2
  usage
  exit 1
fi

if [[ ! "$CONCURRENCY" =~ ^[0-9]+$ ]] || (( CONCURRENCY < 1 || CONCURRENCY > 8 )); then
  echo "[stress] concurrency must be an integer in [1,8]" >&2
  usage
  exit 1
fi

declare -a MODELHOSTS=()
declare -a PORTS=()

get_fleet_shape() {
  case "$FLEET" in
    A)
      MODELHOSTS=("stress-fleet-a-granite-8b-mac-mini")
      PORTS=(8201)
      ;;
    B)
      MODELHOSTS=("stress-fleet-b-granite-3b-mac-mini" "stress-fleet-b-granite-8b-mac-mini")
      PORTS=(8202 8203)
      ;;
    C)
      MODELHOSTS=("stress-fleet-c-granite-8b-mac-mini" "stress-fleet-c-qwen3-8b-mac-mini")
      PORTS=(8204 8205)
      ;;
    D)
      MODELHOSTS=("stress-fleet-d-granite-3b-mac-mini" "stress-fleet-d-granite-8b-mac-mini" "stress-fleet-d-qwen3-8b-mac-mini")
      PORTS=(8206 8207 8208)
      ;;
  esac
}

cleanup_disable() {
  if [[ "${#MODELHOSTS[@]}" -eq 0 ]]; then
    return
  fi
  echo "[stress] disabling fleet $FLEET ModelHosts"
  for name in "${MODELHOSTS[@]}"; do
    llamactl --node mac-mini disable "$name" || true
  done
}

get_fleet_shape
trap cleanup_disable EXIT

wait_endpoint() {
  local host="$1"
  local port="$2"
  local deadline=$(( $(date +%s) + 120 ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS "http://${host}:${port}/v1/models" >/dev/null; then
      echo "[stress] endpoint up: ${host}:${port}"
      return 0
    fi
    sleep 2
  done
  echo "[stress] endpoint timeout: ${host}:${port}" >&2
  return 1
}

model_key_for_workload() {
  local workload="$1"
  case "$FLEET:$workload" in
    A:*)
      echo "granite8"
      ;;
    B:memory-efficacy-4way)
      echo "granite3"
      ;;
    B:*)
      echo "granite8"
      ;;
    C:tool-call-grammar)
      echo "qwen8"
      ;;
    C:*)
      echo "granite8"
      ;;
    D:memory-efficacy-4way)
      echo "granite3"
      ;;
    D:tool-call-grammar)
      echo "qwen8"
      ;;
    D:*)
      echo "granite8"
      ;;
  esac
}

model_json_for_key() {
  local model_key="$1"
  local out_file="$2"
  local name family quant size request_model_id port rel disable_thinking
  disable_thinking="false"

  case "$FLEET:$model_key" in
    A:granite8)
      name="granite-4.1-8b-mlx-nvfp4"
      family="granite-4.1"
      quant="MLX-nvfp4"
      size="8B"
      request_model_id="granite-4.1-8b-nvfp4"
      port=8201
      rel="mlx-community/granite-4.1-8b-nvfp4"
      ;;
    B:granite3)
      name="granite-4.1-3b-mlx-4bit"
      family="granite-4.1"
      quant="MLX-4bit"
      size="3B"
      request_model_id="granite-4.1-3b-4bit"
      port=8202
      rel="mlx-community/granite-4.1-3b-4bit"
      ;;
    B:granite8)
      name="granite-4.1-8b-mlx-nvfp4"
      family="granite-4.1"
      quant="MLX-nvfp4"
      size="8B"
      request_model_id="granite-4.1-8b-nvfp4"
      port=8203
      rel="mlx-community/granite-4.1-8b-nvfp4"
      ;;
    C:granite8)
      name="granite-4.1-8b-mlx-nvfp4"
      family="granite-4.1"
      quant="MLX-nvfp4"
      size="8B"
      request_model_id="granite-4.1-8b-nvfp4"
      port=8204
      rel="mlx-community/granite-4.1-8b-nvfp4"
      ;;
    C:qwen8)
      name="qwen3-8b-mlx-4bit"
      family="qwen-3"
      quant="MLX-4bit"
      size="8B"
      request_model_id="Qwen3-8B-MLX-4bit"
      port=8205
      rel="Qwen3-8B-MLX-4bit"
      disable_thinking="true"
      ;;
    D:granite3)
      name="granite-4.1-3b-mlx-4bit"
      family="granite-4.1"
      quant="MLX-4bit"
      size="3B"
      request_model_id="granite-4.1-3b-4bit"
      port=8206
      rel="mlx-community/granite-4.1-3b-4bit"
      ;;
    D:granite8)
      name="granite-4.1-8b-mlx-nvfp4"
      family="granite-4.1"
      quant="MLX-nvfp4"
      size="8B"
      request_model_id="granite-4.1-8b-nvfp4"
      port=8207
      rel="mlx-community/granite-4.1-8b-nvfp4"
      ;;
    D:qwen8)
      name="qwen3-8b-mlx-4bit"
      family="qwen-3"
      quant="MLX-4bit"
      size="8B"
      request_model_id="Qwen3-8B-MLX-4bit"
      port=8208
      rel="Qwen3-8B-MLX-4bit"
      disable_thinking="true"
      ;;
    *)
      echo "[stress] unsupported model key: ${FLEET}:${model_key}" >&2
      exit 1
      ;;
  esac

  cat > "$out_file" <<JSON
[
  {
    "name": "${name}",
    "engine": "omlx",
    "family": "${family}",
    "quant": "${quant}",
    "size_params": "${size}",
    "host": "${MAC_MINI_HOST}",
    "port": ${port},
    "binary": "/Volumes/AI-DATA/src/omlx/.venv/bin/omlx",
    "mlx_model_dir": "${MODELS_DIR}",
    "request_model_id": "${request_model_id}",
    "disable_thinking": ${disable_thinking},
    "extra_args": ["--max-concurrent-requests", "4"],
    "start_args": [],
    "gguf_path": "${rel}",
    "managed": false
  }
]
JSON
}

mkdir -p "$RESULTS_DIR"
OUT_DB="$RESULTS_DIR/stress-${FLEET}.db"
OUT_MD="$RESULTS_DIR/stress-${FLEET}.md"
RUN_ID="stress-${FLEET}-$(date +%Y%m%d-%H%M%S)"

if compgen -G "$ROOT_DIR/templates/workloads/stress-fleet-${FLEET}-*.yaml" >/dev/null; then
  for manifest in "$ROOT_DIR"/templates/workloads/stress-fleet-"$FLEET"-*.yaml; do
    echo "[stress] applying ${manifest#$ROOT_DIR/}"
    llamactl --node mac-mini apply -f "$manifest"
  done
else
  echo "[stress] no manifests match templates/workloads/stress-fleet-${FLEET}-*.yaml" >&2
  exit 1
fi

for port in "${PORTS[@]}"; do
  wait_endpoint "$MAC_MINI_HOST" "$port"
done

workloads=(
  "memory-efficacy-4way"
  "memory-recall"
  "tool-call-grammar"
  "task-refiner-rubric"
)

declare -A PIDS=()
declare -A MODEL_FILES=()
TMP_DIR="$(mktemp -d -t stress-fleet-${FLEET}-XXXXXX)"

start_epoch="$(date +%s)"

echo "[stress] starting 4 parallel matrix runs (per-workload dbs, run_id=${RUN_ID})"
declare -A WORKLOAD_DBS=()
for workload in "${workloads[@]}"; do
  model_key="$(model_key_for_workload "$workload")"
  model_file="$TMP_DIR/${workload}.json"
  model_json_for_key "$model_key" "$model_file"
  MODEL_FILES["$workload"]="$model_file"

  workload_db="${OUT_DB%.db}-${workload}.db"
  rm -f "$workload_db"
  WORKLOAD_DBS["$workload"]="$workload_db"

  (
    cd "$ROOT_DIR"
    bun packages/eval/src/matrix/cli.ts \
      --models "$model_file" \
      --workloads "$workload" \
      --out-db "$workload_db" \
      --run-id "$RUN_ID" \
      --concurrency "$CONCURRENCY"
  ) &
  PIDS["$workload"]=$!
done

failures=0
for workload in "${workloads[@]}"; do
  pid="${PIDS[$workload]}"
  if wait "$pid"; then
    echo "[stress] workload succeeded: $workload"
  else
    rc=$?
    echo "[stress] workload failed: $workload (exit=$rc)" >&2
    failures=$((failures + 1))
  fi
done

end_epoch="$(date +%s)"
wall_seconds=$((end_epoch - start_epoch))

if (( failures > 0 )); then
  echo "[stress] ${failures} workload runs failed" >&2
  rm -rf "$TMP_DIR"
  exit 1
fi

summary_rows="$TMP_DIR/summary.tsv"
# Build a colon-joined list of per-workload dbs for the aggregator
WORKLOAD_DB_LIST=""
for workload in "${workloads[@]}"; do
  wdb="${WORKLOAD_DBS[$workload]}"
  if [[ -f "$wdb" ]]; then
    WORKLOAD_DB_LIST="${WORKLOAD_DB_LIST}${wdb}:"
  fi
done
RUN_ID="$RUN_ID" WORKLOAD_DB_LIST="$WORKLOAD_DB_LIST" bun -e '
  import { Database } from "bun:sqlite";
  const dbs = process.env.WORKLOAD_DB_LIST!.split(":").filter(Boolean);
  const runId = process.env.RUN_ID!;
  type Row = Record<string, string | number>;
  const all: Row[] = [];
  for (const path of dbs) {
    const db = new Database(path);
    try {
      const rows = db.query(`
        SELECT workload_name, model_name, primary_metric_name, primary_metric_value, throughput_tps, latency_p50_ms, latency_p95_ms, errors
        FROM matrix_runs
        WHERE run_id = ?
      `).all(runId) as Row[];
      all.push(...rows);
    } finally {
      db.close();
    }
  }
  all.sort((a, b) => String(a.workload_name).localeCompare(String(b.workload_name)));
  for (const row of all) {
    console.log([
      row.workload_name,
      row.model_name,
      row.primary_metric_name,
      row.primary_metric_value,
      row.throughput_tps,
      row.latency_p50_ms,
      row.latency_p95_ms,
      row.errors,
    ].join("\t"));
  }
' > "$summary_rows"

{
  echo "# Stress fleet ${FLEET}"
  echo
  echo "Run ID: \`${RUN_ID}\`"
  echo
  echo "| workload | model | metric | score | throughput_tps | p50_ms | p95_ms | errors |"
  echo "| -- | -- | -- | --: | --: | --: | --: | --: |"
  while IFS=$'\t' read -r workload model metric score tps p50 p95 errors; do
    [[ -z "$workload" ]] && continue
    printf '| %s | %s | %s | %.4f | %.2f | %.0f | %.0f | %s |\n' \
      "$workload" "$model" "$metric" "$score" "$tps" "$p50" "$p95" "$errors"
  done < "$summary_rows"
  echo "| aggregate-wall-time | all | elapsed_seconds | ${wall_seconds} | - | - | - | - |"
  echo
} > "$OUT_MD"

echo "[stress] wrote report: ${OUT_MD#$ROOT_DIR/}"

echo "[stress] headline:"
while IFS=$'\t' read -r workload model _metric score _tps _p50 _p95 _errors; do
  [[ -z "$workload" ]] && continue
  printf '%s -> %s -> %.4f\n' "$model" "$workload" "$score"
done < "$summary_rows"

rm -rf "$TMP_DIR"
