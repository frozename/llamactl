# Maestro continuation — 2026-05-16 pm-vvlate

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state. Keep commits/PR descriptions neutral. Delegate substantive code via `chain_start`; hand-code only when the worker won't boot, when a dispatch has structurally failed twice, or when the fix is a single small inline edit.

## What this session shipped (continues from 2026-05-16-pm-vlate note)

User asked for "all in recommended order" twice. First leg shipped K + M.1 + N. Second leg shipped M.3 + M.2 + K.2.

### Second-leg commits (today, 1 new)

- `4561b06` `corpus(memory-efficacy): expand minority pool to ~35/class (+46 synthetic rows)` — bundles M.3 relabels (syn-mi-008/010/012/015 → recall_miss) with M.2 expansion (+46 synthetic rows). Final minority counts: recall_miss=35, memory_ignored=35, missed_registration=35. All synthetic batch-2 rows labeled `codex-acp-fast-synth-2026-05-16` / `sourceReview=synthetic-2026-05-16-batch2`.

### K.2 — no commits (eval-only re-run)

Ran train+eval on Qwen3-1.7B base in `packages/train/.spike-work/tool-call-grammar-qwen3-1_7b/` (gitignored). Result: base 100% (3/3), adapter 100% (3/3). Even 1.7B saturates the 3-row test set when `--jinja` carries the chat template. **Same outcome as the 4B pilot — test set is the binding constraint, not the base model.**

## Thread M.2 + M.3 outcome

Post-expansion split counts (per `packages/train/corpora/memory-efficacy/README.md`):

- 4-way `train 26/26/28/371 · valid 5/5/3/37 · test 4/4/4/48` for `missed_registration / recall_miss / memory_ignored / not_memory_related`. **Test split has ≥3 of each minority class** (was 2/3/2 post-M.1 hash-mod; 1/2/1 pre-fix).
- binary `train 80/371 · valid 13/37 · test 12/48`.

Macro-F1 should now actually be able to move when adapters help minority recall. The adversarial-review's "majority dominance / minority test count too small" critique is at least *measurement-feasible* now — still 88% not_memory_related dominant, but minority is no longer at floor.

Audit relabels applied: in gold-labels.json, the 4 syn-mi rows the audit flagged are now `classification: recall_miss` with updated `reason` fields. The findingId prefixes stay `syn-mi-*` (audit didn't propose ID renames — only classification changes).

## Thread K.2 outcome

Strategic reframing confirmed for the third time this session: **Qwen3 + `--jinja` saturates the 3-row test set across all variants tested (1.7B, 4B-Instruct-2507)**. The chat template carries the tool-call emission load; the LoRA can't help where the base is already at 100%.

To actually measure tool-call LoRA value would need:
1. **Adversarial test mining**: 20-30 prompts where Qwen3+jinja fails or hesitates — multi-tool dispatch, near-name collisions, ambiguous intent, missing schema fields. This is a substantive corpus-mining task.
2. **Or eval-without-jinja**: see if the adapter recovers tool-calling when the chat template doesn't render the tool schemas. This would test a different deployment pattern (the model emits structured output without --jinja's help).
3. **Or accept**: tool-call LoRA is defense-in-depth for when grammar parsing soft-fails, not a primary fix. See `reference_qwen3_jinja_tool_call_gold_standard`.

Decision: defer further K work. The other two threads in this session moved real numbers; K is currently exploring a saturated metric.

## Memories updated today (2 update commits, 0 new files this leg)

- `project_memory_efficacy_v0_1_2026-05-16` — appended M.2+M.3 outcome with new per-class counts and split numbers.
- `project_tool_call_lora_pilot_2026-05-16` — appended K.2 result confirming the saturation pattern.

MEMORY.md index unchanged this leg (entries already linked).

## Live state at session end

- **penumbra daemon**: pid 38905 (unchanged)
- **penumbra worker**: pid 41726 (unchanged)
- mac-mini at 192.168.68.76: still off-LAN
- **llamactl HEAD**: `4561b06`. Working tree has untracked `docs/notes/maestro-continuation-2026-05-16-*.md` and `ops-triage-*.md` from this and prior sessions; can be committed when convenient.
- **penumbra HEAD**: `0c6452b` (unchanged).
- **home-mgmt**: still `status: active`. Ticks still completing `success` end-to-end through this session.
- HF model caches under `packages/train/.spike-work/` (gitignored): `tool-call-grammar-qwen3-4b/` and now `tool-call-grammar-qwen3-1_7b/` both have their GGUFs + eval artifacts.

## Open threads (concrete first moves)

### Thread M.4 — Run memory-efficacy classifier eval on the expanded corpus

The expansion landed but no model has been re-evaluated against the new splits yet. Next move: re-run `packages/train/scripts/eval-classifier.sh` on the existing Qwen3-8B 4-way LoRA adapter (or train fresh) against the new `4way-chat/test.jsonl` (n=61 with 4 of each minority). Expect macro-F1 to *move* this time — the prior n=49 with 1-2 minority each made the metric statistically dead.

### Thread K.3 — Adversarial tool-call test set mining

If returning to tool-call LoRA: mine 20-30 prompts where Qwen3+jinja fails or hesitates. Categories: (a) multi-tool dispatch where the right answer requires 2+ sequential calls, (b) prompts that mention multiple tools by similar names, (c) prompts with ambiguous intent (call X or reply Y?), (d) schema edge cases (datetime formats per the `project_qwen_tool_grammar_2026-05-15` known bug). Then re-run eval — that's where LoRA might actually help.

### Thread N.2 — Penumbra-side ops fixes

Still pending in penumbra (not this repo). See `docs/notes/ops-triage-2026-05-16-pm-late.md` — gh-task-sync 100% errored + task-refiner federation race.

### Thread M.5 — Backfill canonical minority labels

The 88% not_memory_related dominance is now the binding constraint on macro-F1 (test split has 48 not_memory_related vs 4 per minority). Either label more canonical findings as minority (a sourcing problem — most findings genuinely aren't memory-related) or downsample not_memory_related to e.g. 100-150 rows. The latter is mechanical and would balance the corpus much further.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__long_lived_get home-mgmt` → confirm `working_memory.updated_at` is recent.
4. Pick a thread with the user. **M.4 is the highest-leverage next move** — actually measure whether the corpus expansion moved macro-F1, which is the whole point of M.1+M.2+M.3. K.3 is the next move on the tool-call track but requires substantive corpus mining first.
