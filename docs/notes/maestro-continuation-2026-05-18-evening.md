# Maestro continuation — 2026-05-18 evening

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. Follow `AGENTS.md`. Use Penumbra MCP for chain state. Keep commits and repo-facing text neutral; no AI/tool attribution. Delegate via `chain_start` when possible; hand-code only when worker/daemon won't boot.

## 1. What this session shipped (7 commits, 19 ahead of origin)

All four PM-note carry-forwards from `maestro-continuation-2026-05-18-pm.md` landed, plus 3 follow-ups generated during execution.

PM-note carry-forwards:

- `01c2e46` Qwen-relabel control — corpus validated, no labeler self-bias. gemma4 / qwen3.5 ranking stable under labeler swap (Δ ≤ -3.6 pp), gap +16 pp preserved. Qwen scored *worse* on its own labeler's questions.
- `639c603` Fleet-fill (gemma4-e4b + granite-3b-Q8) — e4b slots #2 on memory-recall strong-gold (0.8927, -1.9 pp vs 26B MTP) at 1/3 RAM. granite-3b-Q8 ties granite-8b-Q4 on strong-gold and beats it +15 pp on n=105.
- `82377ce` Tool-call gold-tier diagnostic — **multi-call tier (n=11) is broken corpus design**: all 4 models score 0/11 because gold expects 2+ calls in one turn but every modern tool-using model emits sequentially. Single-call tier: granite-3b-Q8 0.8485 wins narrowly.
- `038f4ee` Per-row score persistence — `matrix_cell_row_details` table + runner integration + 6 new test assertions. 73/73 tests green.

Session follow-ups:

- `03572b7` Per-row persistence validation — re-bench tool-call full n=50; SQL-derive 3 tier breakdowns from `row_index`; match the explicit tier benches to 4-dp. "Split corpus + re-bench" is now strictly unnecessary for row-decomposable workloads.
- `01c72a1` Granite Q8-small vs Q4-large on weak-gold — direct mined-only bench: granite-3b-Q8 0.5605 vs granite-8b-Q4 0.2437 (+31.7 pp). Q4 destroys token-identity matching on code-symbol vocab. Third workload confirming Q8-small > Q4-large pattern.
- `c2bf9ae` Penumbra ask #4 pilot — `memory_search_explain.py` wraps the [A-Za-z0-9]+ OR-fanout rewriter the existing miners use. Side-by-side vs live `mcp__penumbra__memory_search`: Q1 returns disjoint candidate sets (t1 vs t2); Q2 returns 3 vs 0 hits. Divergence documented in `RUNTIME_DIVERGENCE.md`.

## 2. Production reads carried forward

**Memory-recall production pick: gemma4-26b-a4b-mtp.** 0.9119 strong-gold n=55, validated under labeler swap, +1.9 pp ahead of e4b sibling.

**Budget pick: gemma4-e4b-vanilla.** 0.8927 strong-gold at ~10 GiB and 31 tps. Same E4B that's a maestro disaster *with* MTP is a memory-recall workhorse vanilla — codified workload-shape rule.

**Sub-budget pick: granite-3b-Q8.** 0.6837 strong-gold, dominated by e4b on memory-recall but the right pick when only ~4 GiB is available. Also strongly preferred over granite-8b-Q4 anywhere code-symbol retrieval matters.

**Tool-call read:** granite-3b-Q8, qwen3.5-9b-mtp, gemma4-26b-a4b-mtp are interchangeable within ±3 pp on the single-call tier. Pick on tps × RAM; granite-3b-Q8 wins both. Avoid gemma4-e4b-vanilla on any structured-output workload (3rd bench confirming).

## 3. Decisions / facts that updated this session

- **`matrix_cell_row_details` is now the right place to slice corpora.** Future tier/family/outlier analysis on row-decomposable workloads runs in SQL on a single bench's `run_id`. Pre-`038f4ee` runs have no detail rows; tier analysis on historical benches still needs a re-bench (or an explicit backfill, not scoped).
- **Q8-small > Q4-large is a first-principle rule now.** Confirmed across (1) memory-efficacy classifier, (2) tool-call grammar single-call, (3) memory-recall identifier ranking. Mechanism: Q4 perturbs high-entropy embeddings used for code-symbol token identity. Default to Q8 small over Q4 large for any new ranking/classification spec.
- **Tool-call multi-call corpus needs redesign.** Either multi-turn rollout (model sees turn-1 result before turn-2 emission) or prefix-match gold semantics. Until then, multi-call tier is audit-trail only — don't read aggregate n=50 EM as multi-step planning competence.
- **mine_t0.py and synth_t2.py do NOT match the live `memory_search` runtime.** Demonstrated divergence: 3 vs 0 hits on one query, fully disjoint candidate sets on another. Weak-gold labels today measure "BM25-counterfactual against t2_fts" not "what the agent saw". Closing this gap needs the penumbra ask #4 landed.
- **synth_t2.py pool draw is not Python-seedable.** Uses SQLite `ORDER BY RANDOM()`. Paired-row label-agreement is blocked until a future fix (`ORDER BY rowid` + Python-side shuffle).

## 4. Loose ends (carry-forward, prioritized)

Highest leverage first:

1. **granite-8b-Q8 weak-gold bench (~10 min).** Disambiguates today's Q8-vs-Q4 finding: if 8b-Q8 ≈ 3b-Q8, Q4 is the killer (rule generalizes). If 8b-Q8 still loses, the 8B base is miscalibrated for short identifier prompts (rule narrower). Either answer is informative. Hand-write a granite-8b-Q8 matrix spec, bench against `mined.jsonl` n=50 with the existing `granite-weak-gold.json` recipe.

2. **Tool-call multi-call corpus redesign (~30-60 min).** Two paths:
   - **Multi-turn rollout** — modify the matrix runner so a tool-bearing turn-1 response triggers a synthetic tool-result injection, then a second model call, then score the union. Requires runner changes; non-trivial.
   - **Prefix-match gold rewrite** — change the tool-call-grammar scorer to accept any prefix subset of gold calls (≥1 match in any order, no scoring penalty for "missing" later calls). One file change in `workloads/tool-call-grammar.ts`, fixes 11 corpus rows immediately. Recommended.

3. **Backfill per-row data for today's headline benches (~15-20 min).** The memory-recall strong-gold-fleet, n=105-fleet, fleet-fill, and tool-call-full results predate `038f4ee` and have no detail rows. Re-running them (existing spec files, just re-bench) populates `matrix_cell_row_details` with the production-reference data so future tier/family analysis can land in SQL. Mechanical, can be a single dispatch.

4. **Penumbra ask #4 follow-through.** The pilot proved divergence. Next is either (a) open a penumbra-side spec PR with the wrapped `memory_search_explain(query)` MCP endpoint, or (b) extend the llamactl-side pilot to wrap actual `mcp__penumbra__memory_search` calls and emit a structured diff so the next mining round can use runtime-matched gold. (a) is the right long-term move; (b) is a stop-gap if penumbra has higher-priority work.

5. **synth_t2.py determinism fix.** Switch `ORDER BY RANDOM() LIMIT ?` → `ORDER BY rowid` + Python-side shuffled `random.sample(...)` so paired-row label-agreement studies are possible. Unblocks per-row Qwen-vs-Granite labeler disagreement analysis. ~15 min.

## 5. Machine state at handoff

- Penumbra daemon + worker: up.
- `granite41-8b-long-lived-local` on :8083: running (t2-judge; penumbra re-enables every ~5 min).
- `granite41-3b-judge-mac-mini` on :8086 (remote): assumed running (~24h+ uptime, not re-verified this evening).
- Ollama on :11434: running (untouched).
- All bench workloads: stopped / disabled.
- Branch: `main` at `c2bf9ae`, 19 commits ahead of `origin/main` (not pushed).
- Pending handoffs: clean.
- Working tree: `docs/notes/session-summary-2026-05-18-am.md` still has the predating uncommitted diff from before this session (per PM note §5).

## 6. First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main..HEAD | head`
2. `mcp__penumbra__handoff_list_pending` → confirm clean.
3. Pick from §4. Loose ends. **#1 (granite-8b-Q8 weak-gold) is the highest-leverage next step** — it cleanly resolves the open question from today's Q8-vs-Q4 finding and primes the production model-selection rule with one more datapoint.

## 7. Decisions not to re-litigate

- Strong-gold (n=55) is the headline metric for memory-recall. n=105 is the secondary aggregate.
- gemma4-26b-a4b-mtp is the memory-recall production pick.
- gemma4-e4b-vanilla is the memory-recall budget pick (≤10 GiB nodes).
- granite-3b-Q8 is the memory-recall sub-budget pick AND the preferred granite for identifier-heavy retrieval.
- Q8-small > Q4-large for ranking/classification workloads (3-workload confirmation).
- Avoid gemma4-e4b-vanilla on structured-output workloads (3-bench confirmation).
- The tool-call multi-call tier (current corpus) is **invalid** — do not use its aggregate n=50 EM as a planning competence signal.
- The penumbra-labeled BM25 weak-gold used by `mine_t0.py` measures the wrong thing relative to runtime. The relative model ranking on it is still informative; the absolute number is not.

## 8. Memories worth reading first

- `project_qwen_relabel_control_2026-05-18.md` — corpus validation under labeler swap.
- `project_fleet_fill_2026-05-18.md` — e4b + granite-3b-Q8 leaderboard position.
- `project_tool_call_gold_tier_2026-05-18.md` — multi-call corpus bug + single-call leaderboard.
- `project_granite_q8_vs_q4_weak_gold_2026-05-18.md` — Q8-small > Q4-large mechanism + 3-workload pattern.
- `reference_matrix_cli_gotchas_2026-05-18.md` — corpus-swap-in-place pattern.
- `feedback_attention_assembly_not_ffn.md` — earlier statement of the Q8-vs-Q4 thesis.

## 9. Repo-side artifacts to know about

- `packages/eval/specs/` — added `gemma4-e4b.json`, `granite-3b-Q8.json`, `fleet-fill-2026-05-18.json`, `tool-call-tier-fleet.json`, `gemma4-vs-qwen35-headtohead.json`, `granite-weak-gold.json` this session.
- `packages/eval/results/` — added 12 new files (md + db pairs) across 6 diagnostic / leaderboard topics.
- `packages/eval/corpora/memory-recall/v0/` — added `synth-qwen.jsonl`, `memory_search_explain.py`, `RUNTIME_DIVERGENCE.md`.
- `packages/eval/corpora/tool-call-grammar/v0/` — added `tier-{nocall,single,multi}.jsonl`.
- `packages/eval/src/matrix/` — runner + store + types extended for per-row persistence; test coverage updated.

`AGENTS.md` unchanged.
