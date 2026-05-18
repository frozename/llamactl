# Fleet eval extension plan — 2026-05-17

**Status:** planning
**Source specs:**
- `docs/notes/fleet-eval-scoping-2026-05-16-night.md` — inventory + per-workload shapes
- `docs/notes/attention-thesis-cross-family-eval-2026-05-16-night.md` — methodology

## Dependency map

```
Phase 0 (verify swap) ─────────────────────────────► Phase 1, 2 (anchor confirmed)
Phase 4 ops triage ────────────────────────────────► Phase 4 eval (5-7 days later)
Phase 1 (home-mgmt classify) ──────────────────────► independent of 2/3
Phase 2 corpus build ──────────────────────────────► Phase 3
Phase 5 (memory recall) ───────────────────────────► closed (embeddings, not LLM)
```

---

## Phase 0 — Production-state verification

**Open from:** `docs/notes/attention-thesis-cross-family-eval-2026-05-16-night.md` pre-conditions 2 and 3.

**Precondition (i): daemon-path eval**

`resolveJudgeConfig` in `penumbra/packages/daemon/src/serve.ts:822` (efficacy runner) and
`:367` (dispatch-refine) both resolve via `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:8085`
(set in `~/Library/LaunchAgents/dev.penumbra.daemon.plist`), model alias `local`.
`PENUMBRA_JUDGE_MODEL` is not set; the default `local` model string passes through unchanged.
The live daemon is already routing to granite-3b-Q8.

To confirm the chat-template + classification chain matches the offline Q8_0 result (0.9235),
POST the test corpus directly to the live port — no new server launch needed:

```bash
# Inference against live :8085 using the same chat format as eval-base-only.sh.
# Skips llama-server launch; tests chat-template handling on the production binary.
python3 - << 'PYEOF'
import json, subprocess, sys, urllib.request, collections

PORT = 8085
corpus = [json.loads(l) for l in open(
    "packages/train/corpora/memory-efficacy/4way-chat-fewshot/test.jsonl")]

classes = ["memory_ignored","missed_registration","recall_miss","not_memory_related"]
tp = collections.defaultdict(int); fp = collections.defaultdict(int)
fn = collections.defaultdict(int)

for row in corpus:
    gold = json.loads(row["messages"][-1]["content"])["classification"]
    payload = json.dumps({
        "model": "local",
        "messages": row["messages"][:-1],
        "max_tokens": 250,
        "temperature": 0.0,
    }).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/v1/chat/completions",
        data=payload, headers={"Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
    try:
        pred = json.loads(resp["choices"][0]["message"]["content"])["classification"]
    except Exception:
        pred = "__parse_fail__"
    for c in classes:
        if pred == c == gold: tp[c] += 1
        elif pred == c != gold: fp[c] += 1
        elif gold == c != pred: fn[c] += 1

f1s = []
for c in classes:
    p = tp[c]/(tp[c]+fp[c]) if tp[c]+fp[c] else 0
    r = tp[c]/(tp[c]+fn[c]) if tp[c]+fn[c] else 0
    f = 2*p*r/(p+r) if p+r else 0
    f1s.append(f)
    print(f"{c}: P={p:.3f} R={r:.3f} F1={f:.3f}")
print(f"macro-F1: {sum(f1s)/len(f1s):.4f}")
PYEOF
```

Expected: macro-F1 ≥ 0.9235. Drop > 2 pp → investigate chat-template path before continuing.

**Precondition (ii): throughput bench**

Probe at `/tmp/throughput-probe.sh` already running. Compares granite-3b-Q8 at `:8085` (local)
and `:7843` (mac-mini via gateway). Baseline comparator: Qwen3-8B Q4_K_M was the prior model.

```bash
bash /tmp/throughput-probe.sh 2>&1 | tee /tmp/phase0-throughput.txt
```

Pass criterion: local AVG tok/s ≥ prior Qwen3-8B tok/s at `:8085`.

**Inputs:** `packages/train/corpora/memory-efficacy/4way-chat-fewshot/test.jsonl`, live `:8085`
**New artifacts:** `/tmp/phase0-daemon-path/`, `/tmp/phase0-throughput.txt`
**Cost:** 60 completions × ~250 tok ≈ 15K tok; < 5 min wall at 47 tps
**Gates:** none; run immediately

---

## Phase 1 — home-mgmt classify (Path B synthesis + initial sweep)

**Per spec:** `fleet-eval-scoping-2026-05-16-night.md:54-71`

**Task:** 4-way: `short_circuit_no_change` / `note_to_thread` / `escalate_for_diagnosis` / `act_with_approval`
**Anchor:** Qwen3-8B mac-mini `:8090` (separate from `:8085` judge pool; still live)
**Candidates:** Granite-4.1-3B Q8_0, Gemma 4 E4B UD-Q4_K_XL, Granite-4.1-8B Q4_K_M

### Corpus build (Path B — synthesis)

Layout mirrors `packages/train/corpora/memory-efficacy/`:

```
packages/train/corpora/home-mgmt-classify/
  README.md
  prep_chat.py          # adapt from memory-efficacy/prep_chat.py
  4way-chat-fewshot/
    train.jsonl         # mod-10 ∈ {0-6}
    valid.jsonl         # mod-10 ∈ {7-8}
    test.jsonl          # mod-10 ∈ {9}
```

Row schema (`messages` key, same as `memory-efficacy/4way-chat-fewshot/test.jsonl`):

```json
{
  "messages": [
    {"role": "system", "content": "<home-mgmt classify system prompt + 3 exemplars>"},
    {"role": "user", "content": "<ha_pulse JSON>\n\nopen_threads:\n<working_memory.open_threads>"},
    {"role": "assistant", "content": "{\"classification\":\"note_to_thread\",\"reason\":\"...\"}"}
  ]
}
```

**Synthesis procedure:**

1. Pull ≥ 5 real `ha:ha_pulse` payloads as variation seeds:
   ```sql
   SELECT metadata_json FROM long_lived_ticks
   WHERE agent_name = 'home-mgmt' AND outcome = 'success'
   ORDER BY ts DESC LIMIT 20;
   ```
2. Pull home-mgmt `standing_brief` via `mcp__penumbra__long_lived_state_get`.
3. Dispatch to Qwen3-8B + jinja at `:8090` (codex-acp-spark pattern): generate N=120 synthetic
   (pulse_payload, thread_state) → gold_classification pairs.
   Target class balance: `short_circuit_no_change` 50%, `note_to_thread` 30%,
   `escalate_for_diagnosis` 15%, `act_with_approval` 5%.
4. Apply `hash(row_index) % 10` split. Verify: ≥ 6 rows per minority class in combined
   train+valid+test before split. If `act_with_approval` < 10 total, oversample first
   (same trap as `project_memory_efficacy_corpus_llm_labeled` — 4-way valid/test had
   zero minority rows with the original mod-10 split).

**Harness:** `packages/train/scripts/eval-base-only.sh` as-is — chat format +
`{"classification": "..."}` extraction already handles this shape.

**First measurable signal:** Qwen3-8B anchor macro-F1 on n_test ≥ 12 rows. If < 0.80,
synthetic labels don't reflect the real task; inspect failure rows before running candidates.

**Inputs:** home-mgmt standing_brief, ≥5 real pulse payloads, Qwen3-8B `:8090`
**New artifacts:** `packages/train/corpora/home-mgmt-classify/4way-chat-fewshot/{train,valid,test}.jsonl`
**Cost:** 120 synthesis calls × ~400 tok = ~48K tok + 60 eval calls/model × 3 models ≈ 3-4 hr wall
**Gates:** Phase 0 pass is advisory (confirms harness methodology); not a hard blocker

---

## Phase 2 — task-refiner generation eval

**Per spec:** `fleet-eval-scoping-2026-05-16-night.md:83-99`

**Current model:** dispatch-refine resolves via `serve.ts:367` to `local` at `:8085`
(granite-3b-Q8). `PENUMBRA_REFINER_MODEL` env is not set in the daemon plist.
Task-refiner long-lived role is not present in the production `agentchat.yaml`; the
refiner is the standalone `dispatch-prompt-refiner.ts` invoked on every chain_start.

**System prompt source:** `penumbra/packages/core/src/services/dispatch-prompt-refiner.ts:4-18`
(the `REFINER_SYSTEM_PROMPT` constant). Use verbatim as the inference system prompt.

### New harness: `packages/train/scripts/eval-generation-rubric.sh`

```
eval-generation-rubric.sh <MODEL_GGUF> <TEST_JSONL> <JUDGE_URL> <JUDGE_MODEL> <PORT> <OUT_DIR>
```

`TEST_JSONL` row schema:
```json
{"input": "<raw chain_start prompt>", "gold": "<strong-model refined version>"}
```

Scoring loop per row:
1. Inference: POST `[{role:system, content:REFINER_SYSTEM_PROMPT}, {role:user, content:input}]`
   to candidate model at `PORT`.
2. Judge: POST `(input, gold, candidate_output)` to `JUDGE_URL`/`JUDGE_MODEL` with rubric prompt.
   Rubric dimensions, each 0-3:
   - `intent_preservation`: refined keeps the original task intent
   - `contract_clarity`: deliverable + scope are sharper in output than input
   - `noise_removal`: preamble / meta-narration / approval-seeking removed
3. Parse judge response with `if has("k") then .k else empty end` pattern
   (not `//` — `reference_jq_false_coalesce_trap`).
4. Report: mean per dimension + composite (sum / 9). Flag rows < 0.67 composite.

### Corpus build

Source: `dispatch_events` table, rows where `kind = 'chain_start.refined'` or
`event_type = 'chain_start'`, recent 7 days. Extract raw `prompt` field. Sample 30-50 rows.

Gold generation: Qwen3-8B + jinja at `:8090` applies `REFINER_SYSTEM_PROMPT`, human review
of borderline cases (rows where output contains a `#` header or "Here is" prefix).

Corpus path: `packages/train/corpora/dispatch-refine/eval.jsonl` (shared by Phase 3).

**First measurable signal:** granite-3b-Q8 anchor composite ≥ 0.67 on n=30 inputs.
If < 0.67, consider pointing `PENUMBRA_REFINER_MODEL` to a separate capable endpoint.

**Inputs:** 30-50 raw dispatch prompts from `dispatch_events`; `dispatch-prompt-refiner.ts:4-18`
**New artifacts:** `packages/train/scripts/eval-generation-rubric.sh`,
`packages/train/corpora/dispatch-refine/eval.jsonl`
**Cost:** 30-50 inference + 30-50 judge runs per model; ~3-4 hr wall including corpus prep
**Gates:** Phase 0 pass (anchor on production wire). Phase 1 not required.

---

## Phase 3 — dispatch-refine generation eval

Same harness and corpus as Phase 2. Distinction: Phase 2 may filter to
task-shaped inputs; Phase 3 runs the full `packages/train/corpora/dispatch-refine/eval.jsonl`
without filter. If Phase 2 used all n=30-50 rows unfiltered, Phase 3 is a no-op.

**First measurable signal:** composite ≥ 0.67 on ≥ 80% of rows → current granite-3b-Q8
acceptable for dispatch-refine; model swap warranted only below this threshold.

**Inputs:** same as Phase 2 (corpus already built)
**New artifacts:** `/tmp/phase3-dispatch-refine/report.md` (separate OUT_DIR)
**Cost:** ≤ 1 hr (corpus reuse)
**Gates:** Phase 2 corpus build complete.

---

## Phase 4 — t2-promotion judge pool eval

**Per spec:** `fleet-eval-scoping-2026-05-16-night.md:107-114`

### Step 4a — ops triage (run in parallel with Phase 0)

Both judge agents (`granite-mini-8b` mac-mini `:7843`, `local-granite-8b` `:8080`) were
100% unhealthy since 2026-05-06 (13,355 errors in daemon log). RAM context: granite-3b
was OOM-killed mid-tensor-load when co-located (`feedback_mac_mini_ram_admission_underestimate_2026-05-17`).

```bash
curl -sk http://127.0.0.1:8080/health | jq .status
ssh macmini.ai "curl -sk http://127.0.0.1:7843/health | jq .status"
```

If either returns non-`"ok"`: check workload YAML RAM estimates, verify launchd plist env,
confirm granite-3b-Q8 is not co-resident on the same slot.

### Step 4b — corpus mining (after 4a passes)

```bash
sqlite3 ~/.penumbra/penumbra.sqlite \
  ".tables" | grep -q rollup_judge && echo "table exists" || echo "absent"
```

If `rollup_judge_decisions` table exists: extract `(rollup_json, decision, rationale)` rows.
If absent: mine `~/Library/Logs/penumbra/launchd.daemon.out.log` for
`"t2 promotion: promoted session count=N"` events + adjacent rollup JSON.

Target: n=50 rows (promote / not). Gold = historical decision.

Corpus path: `packages/train/corpora/t2-promotion/2way-chat-fewshot/test.jsonl`

**Harness:** `packages/train/scripts/eval-base-only.sh` — 2-class classification,
same `{"classification": "..."}` extraction; scores binary F1 instead of macro-4way.

**First measurable signal:** check row count after corpus mining. If 0:
judge pool was never healthy enough to produce decisions; re-entry condition =
pool health confirmed + 5-7 days of accumulated decisions before re-opening this phase.

**Inputs:** `~/.penumbra/penumbra.sqlite`, daemon logs
**New artifacts:** `packages/train/corpora/t2-promotion/2way-chat-fewshot/test.jsonl`
**Cost:** ~30 min ops triage + ~1 hr corpus mining + ~30 min eval
**Gates:** Step 4a health check; corpus row count ≥ 20 before running eval models.

---

## Phase 5 — memory recall scoring

**Per spec:** `fleet-eval-scoping-2026-05-16-night.md:116-124`

**Finding:** `autoRecallForDispatch` (`penumbra/packages/daemon/src/dispatch/auto-recall.ts:27`)
is **not LLM-driven**. It delegates to `deps.memoryRecall` which calls the hybrid reader
(`penumbra/packages/core/src/readers/hybrid.ts:57`): SQL filter → vector rerank using
embedding cosine similarity — no language model call anywhere in the path.

**Conclusion:** NDCG@K or MRR eval would assess the embedding model + RRF weights, not
judge model quality. Out of scope for the fleet-eval-extension plan.

**Action:** close as infrastructure eval (embedding model bench). File a separate task
if retrieval quality becomes a measurable concern.

---

## Phase 6 — Deferred / frozen

| Track | Freeze reason | Re-entry condition |
|---|---|---|
| K-track tool-call LoRA | Model-vs-labeler stylistic mismatch; adapter-layer blocker | Different labeler OR adapter wire-format fix |
| Path A instrumentation | `penumbra@b2ba0d1` spec unimplemented | Implementation lands; ≥100 production ticks accumulated |
| home-mgmt HA actions | Adapter blocker `reference_claude_agent_acp_tool_call_wire_shape` | ACP tool_name=null fix upstream |

---

## Execution schedule

| Phase | Hard blocker | Can start | Est. wall time |
|---|---|---|---|
| 0 | none | now | < 30 min |
| 4a (ops triage) | none | now (parallel with 0) | ~30 min |
| 1 | Phase 0 advisory | after 0 | 3-4 hr |
| 2 | Phase 0 pass | after 0 (parallel with 1) | 3-4 hr |
| 3 | Phase 2 corpus | after 2 | ~1 hr |
| 4b (eval) | 4a pass + decisions accumulated | 5-7 days | ~2 hr |
| 5 | N/A — closed | — | — |

Phases 1 and 2 run in parallel once Phase 0 confirms the anchor.
