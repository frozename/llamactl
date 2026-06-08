#!/bin/zsh
# MTP draft-spec throughput bench: baseline (main alone) vs MTP (main + assistant
# draft via --spec-type draft-mtp) for one or more Gemma 4 QAT sizes. Serial —
# one llama-server at a time on $PORT (single-GPU). Records tok/s + draft accept.
#
# Reproduces the r/LocalLLaMA "Gemma4 QAT + MTP" config. On M4 Pro/Metal the
# speedups do NOT transfer (see docs/notes/2026-06-08-gemma4-qat-family-eval-and-mtp-metal.md).
#
# Env (override as needed):
#   BIN        llama-server binary (needs Gemma4 MTP #23398 + --spec-type draft-mtp)
#   MODELS     models root containing gemma-4-<sz>-it-qat-GGUF/ and
#              gemma-4-<sz>-it-qat-assistant-MTP-Q8_0-GGUF/
#   SIZES      space-separated sizes (default "12B 26B-A4B 31B")
#   PORT       bench port (default 8200)
#   OUT        results TSV (default /tmp/mtp-bench-results.tsv)
# Run with the harness sandbox disabled (llama-server exec).
set -u
export PATH=/opt/homebrew/bin:/usr/bin:/bin:$PATH
BIN=${BIN:-/Volumes/WorkSSD/src/llama.cpp/build/bin/llama-server}
MODELS=${MODELS:-/Volumes/WorkSSD/ai-models/llama.cpp/models}
SIZES=${SIZES:-"12B 26B-A4B 31B"}
PORT=${PORT:-8200}
OUT=${OUT:-/tmp/mtp-bench-results.tsv}
echo -e "model\tmode\ttok_s\tdraft_n\tdraft_acc\taccept_rate" > "$OUT"

python3 - <<'PY'
import json
json.dump({"prompt":"Explain in thorough detail, step by step, how a modern CPU pipeline fetches, decodes, executes, and retires a single instruction, including pipeline hazards and how they are resolved.",
"n_predict":192,"temperature":1.0,"top_p":0.95,"top_k":64,"cache_prompt":False}, open("/tmp/mtp-req.json","w"))
json.dump({"prompt":"hi","n_predict":16}, open("/tmp/mtp-warm.json","w"))
PY

wait_health(){ for i in $(seq 1 90); do curl -s --max-time 3 localhost:$PORT/health 2>/dev/null | grep -q '"ok"' && return 0; sleep 2; done; return 1; }
kill_server(){ lsof -ti :$PORT 2>/dev/null | xargs -r kill 2>/dev/null; for i in $(seq 1 30); do lsof -ti :$PORT >/dev/null 2>&1 || break; sleep 1; done; }

run_one(){
  local model=$1 mode=$2; shift 2
  echo "=========== $model / $mode ==========="
  kill_server
  $BIN "$@" --host 127.0.0.1 --port $PORT -ngl 999 --flash-attn on \
    --ctx-size 40960 -ctk q8_0 -ctv q8_0 --parallel 1 > /tmp/mtp-srv-$model-$mode.log 2>&1 &
  if ! wait_health; then echo "$model $mode: SERVER FAILED"; tail -6 /tmp/mtp-srv-$model-$mode.log; echo -e "$model\t$mode\tFAIL\t-\t-\t-" >>"$OUT"; kill_server; return; fi
  curl -s --max-time 120 localhost:$PORT/completion -H 'content-type: application/json' -d @/tmp/mtp-warm.json >/dev/null 2>&1
  local best=0 dn=0 da=0
  for r in 1 2; do
    curl -s --max-time 300 localhost:$PORT/completion -H 'content-type: application/json' -d @/tmp/mtp-req.json > /tmp/mtp-resp.json 2>/dev/null
    read tps rdn rda <<< "$(python3 -c "
import json
t=json.load(open('/tmp/mtp-resp.json')).get('timings',{})
print(round(t.get('predicted_per_second',0),2), t.get('draft_n',0), t.get('draft_n_accepted',0))" 2>/dev/null)"
    echo "  run$r tps=$tps draft_n=$rdn draft_acc=$rda"
    best=$(python3 -c "print(max($best, $tps if '$tps' else 0))" 2>/dev/null)
    dn=$rdn; da=$rda
  done
  local acc="-"; [ -n "$dn" ] && [ "$dn" != "0" ] && acc=$(python3 -c "print(round($da/$dn,4))" 2>/dev/null)
  echo -e "$model\t$mode\t$best\t$dn\t$da\t$acc" >>"$OUT"
  kill_server
}

for sz in ${=SIZES}; do
  MAIN=$MODELS/gemma-4-${sz}-it-qat-GGUF/gemma-4-${sz}-it-qat-UD-Q4_K_XL.gguf
  DRAFT=$MODELS/gemma-4-${sz}-it-qat-assistant-MTP-Q8_0-GGUF/gemma-4-${sz}-it-qat-assistant-MTP-Q8_0.gguf
  run_one "$sz" baseline -m "$MAIN"
  run_one "$sz" mtp -m "$MAIN" --model-draft "$DRAFT" --spec-type draft-mtp \
    --spec-draft-n-max 4 --spec-draft-ngl all --spec-draft-type-k q8_0 --spec-draft-type-v q8_0
done
echo ALL_MTP_BENCH_DONE
cat "$OUT"
