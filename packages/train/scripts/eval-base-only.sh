#!/usr/bin/env bash
#
# Evaluate a single model (no adapter) on a chat-formatted test set,
# extracting `classification` from each assistant reply and computing
# per-class precision/recall/F1 + macro-F1.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
Usage:
  bash packages/train/scripts/eval-base-only.sh <MODEL_GGUF> <TEST_JSONL> <PORT> <OUT_DIR>

Environment:
  LLAMA_SERVER (path to llama-server binary)
  N_PREDICT (default 250)
  CTX_SIZE  (default 8192)
EOF
}

[[ $# -eq 4 ]] || { usage; die "expected 4 arguments"; }

MODEL_GGUF=$1
TEST_JSONL=$2
PORT=$3
OUT_DIR=$4

for path in "$MODEL_GGUF" "$TEST_JSONL"; do
  [[ -f "$path" ]] || die "input file not found: $path"
done
mkdir -p "$OUT_DIR"

if [[ -n "${LLAMA_SERVER:-}" ]]; then
  BIN="$LLAMA_SERVER"
elif command -v llama-server >/dev/null 2>&1; then
  BIN="$(command -v llama-server)"
else
  die "llama-server binary not found (set LLAMA_SERVER)"
fi

N_PREDICT=${N_PREDICT:-250}
CTX_SIZE=${CTX_SIZE:-8192}

PREDICTIONS="$OUT_DIR/predictions.jsonl"
REPORT="$OUT_DIR/report.md"
SERVER_LOG="$OUT_DIR/server.log"

kill_port "$PORT"

"$BIN" \
  --model "$MODEL_GGUF" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --ctx-size "$CTX_SIZE" \
  --jinja \
  --reasoning off \
  --no-warmup \
  --temp 0.0 \
  -n "$N_PREDICT" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

trap 'kill -9 $SERVER_PID 2>/dev/null || true' EXIT

wait_for_health "$PORT" 180

: > "$PREDICTIONS"
i=0
while IFS= read -r row; do
  i=$((i+1))
  user_content=$(jq -r '.messages[0].content' <<<"$row")
  gold=$(jq -r '.messages[-1].content | fromjson | .classification' <<<"$row")
  body=$(jq -n --arg c "$user_content" --argjson n "$N_PREDICT" '{
    messages: [{role:"user", content:$c}],
    temperature: 0.0,
    max_tokens: $n
  }')
  resp=$(curl -fsS --max-time 90 \
    -H 'Content-Type: application/json' \
    -d "$body" \
    "http://127.0.0.1:${PORT}/v1/chat/completions" || true)
  content=$(jq -r '.choices[0].message.content // ""' <<<"$resp")
  # Extract first {...} from content, parse classification
  pred=$(python3 -c '
import json, re, sys
text = sys.argv[1]
m = re.search(r"\{(?:[^{}\"]|\"(?:\\\\.|[^\"])*\")*\}", text, re.S)
if not m:
    print("__noparse__"); sys.exit(0)
try:
    obj = json.loads(m.group(0))
    print(obj.get("classification", "__nokey__"))
except Exception:
    print("__nojson__")
' "$content")
  jq -nc --arg gold "$gold" --arg pred "$pred" --arg raw "$content" \
    '{gold:$gold, pred:$pred, raw:$raw}' >> "$PREDICTIONS"
  printf "  [%2d] gold=%s pred=%s\n" "$i" "$gold" "$pred"
done < "$TEST_JSONL"

# Compute macro-F1
python3 - "$PREDICTIONS" "$REPORT" "$MODEL_GGUF" <<'PY'
import json, sys
from collections import defaultdict

preds_path, report_path, model_path = sys.argv[1], sys.argv[2], sys.argv[3]
rows = [json.loads(l) for l in open(preds_path)]
classes = sorted({r["gold"] for r in rows} | {r["pred"] for r in rows if not r["pred"].startswith("__")})

tp = defaultdict(int); fp = defaultdict(int); fn = defaultdict(int)
n_parse_fail = 0
for r in rows:
    g, p = r["gold"], r["pred"]
    if p.startswith("__"):
        n_parse_fail += 1
        fn[g] += 1
        continue
    if p == g:
        tp[g] += 1
    else:
        fp[p] += 1
        fn[g] += 1

def prf(c):
    p = tp[c] / (tp[c] + fp[c]) if (tp[c]+fp[c]) else 0.0
    r = tp[c] / (tp[c] + fn[c]) if (tp[c]+fn[c]) else 0.0
    f = 2*p*r/(p+r) if (p+r) else 0.0
    return p, r, f

# Score only against gold classes (the 4 target labels)
gold_classes = sorted({r["gold"] for r in rows})
macro_f = sum(prf(c)[2] for c in gold_classes) / len(gold_classes)
acc = sum(1 for r in rows if r["pred"] == r["gold"]) / len(rows)

with open(report_path, "w") as f:
    f.write(f"# Eval report\n\n")
    f.write(f"model: `{model_path}`\n\n")
    f.write(f"n_rows: {len(rows)} | parse_failures: {n_parse_fail} | accuracy: {acc:.4f} | macro-F1: {macro_f:.4f}\n\n")
    f.write("| class | tp | fp | fn | precision | recall | F1 |\n")
    f.write("|---|---|---|---|---|---|---|\n")
    for c in gold_classes:
        p,r,fv = prf(c)
        f.write(f"| {c} | {tp[c]} | {fp[c]} | {fn[c]} | {p:.4f} | {r:.4f} | {fv:.4f} |\n")

print(f"\nmacro-F1 = {macro_f:.4f} | acc = {acc:.4f} | parse_fail = {n_parse_fail}")
PY

echo "predictions: $PREDICTIONS"
echo "report:      $REPORT"
