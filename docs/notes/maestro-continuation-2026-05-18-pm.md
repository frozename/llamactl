# Maestro continuation — 2026-05-18 PM

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. Follow `AGENTS.md`. Use Penumbra MCP for chain state. Keep commits and repo-facing text neutral; no AI/tool attribution. Delegate via `chain_start` when possible; hand-code only when worker/daemon won't boot.

## 1. What this session shipped (11 commits on `main`, 40 ahead of origin)

Corpus + scoring work:

- `9c11863` ops hygiene — archived 63 pre-2026-05-18 notes under `docs/notes/archive/`; deleted redundant `gemma4-26b-a4b-mtp-b-{1024,4096}-local` workload manifests (same alias + port as base variant, no remaining bench role).
- `1668d5e` tool-call-grammar corpus n=8 → n=50 at `packages/eval/corpora/tool-call-grammar/v0/test.jsonl`. First 8 rows are byte-identical to prior K-track test split — last week's per-model cells recoverable by filtering. K-track corpus stays frozen.
- `ab0d048` memory-recall mining helper `mine_t0.py` + mined half (n=50 from penumbra `t0_events` `memory_search` calls; weak BM25-top-1 gold).
- `def51b7` memory-recall synth half (n=50): `synth_t2.py` calls granite-4.1-8b on :8083, generates question + 3 near-miss per random t2 body, accepts when BM25 returns seed in top-10. Corpus now n=105.

Bench artifacts:

- `362ab51` Qwen3.5-9B-MTP matrix spec at `packages/eval/specs/qwen35-9b-mtp.json`. Atomic-qwen binary + `--spec-type nextn` shared-model draft. Smoke OK: 0.58 draft acceptance.
- `e5f6380` head-to-head: gemma4-26b-a4b-mtp 0.8079 / 32.63 tps beats Qwen3.5-9B-MTP 0.6622 / 8.59 tps on n=105 (quiet machine).
- `a7f12d1` 6-model fleet bench on n=105.
- `d5f4d38` gold-tier diagnostic: split n=105 → strong (n=55) + weak (n=50); weighted arithmetic reproduces gemma4's n=105 number exactly.
- `bc0672e` strong-gold fleet leaderboard. Qwen3.5-9B-MTP jumps from #4 → #2 on strong-gold (+13 pp swing).

Other:

- `dd41468` penumbra-team asks doc at `docs/notes/penumbra-mining-asks-2026-05-18.md`. Ten ranked pain points for the penumbra team — top 3 unlock new gold signals (verify-events population, tool-call event linkage, production-trace tools+messages snapshot).

## 2. Production read

**Memory-recall winner is gemma4-26b-a4b-mtp by clear margins on every sub-distribution.**

Strong-gold (n=55, production-signal headline):

| Rank | Model | NDCG@5 | tps |
|---|---|---:|---:|
| 1 | gemma4-26b-a4b-mtp | **0.9119** | 34.60 |
| 2 | qwen3.5-9b-mtp-UDQ4KXL | 0.7782 | 9.15 |
| 3 | qwen3.6-35b-A3B-MTP-UDQ4KXL | 0.7368 | 18.50 |
| 4 | qwen3.6-35b-A3B-UDQ4KXL | 0.6932 | 26.99 |
| 5 | granite-8b-Q4 | 0.6839 | 26.52 |
| 6 | qwen3-8b-Q4 | 0.4204 | 20.04 |

n=105 leaderboard exists in `packages/eval/results/2026-05-18-memory-recall-n105-fleet.md` for reference; strong-gold is the headline going forward.

## 3. Decisions / facts that updated this session

- **MTP-first rule has a workload qualifier:** memory-recall (ranking) ranks MTP-on-A3B at +4.4 pp over plain A3B on strong-gold. Memory `project_a3b_beats_mtp_dense_2026-05-18.md`'s claim "for A3B/MoE families, plain MoE beats dense+MTP" was for classification only; ranking workloads benefit from MTP.
- **Qwen 3.5/3.6 family is a ~30 pp jump over Qwen 3.0 on memory-recall.** `qwen3-8b-local` workload is the worst model on this task; not a credible production candidate for any ranking-shaped workload.
- **Gold-tier diagnostic validates the n=105 corpus.** Strong-gold (n=55) is the production-signal headline; n=105 weighted average reproduces exactly. Weak-gold half is genuinely noisier but still discriminates models.
- **`llamactl disable` doesn't persist for `granite41-8b-long-lived-local`.** Penumbra re-enables it ~5 min after every disable because the t2-judge config depends on it. NDCG@5 is deterministic under contention (only tps takes ~2-3% hit), so single-model benches under contention are still valid. For truly-quiet benches longer than ~5 min, pause penumbra's judge config (daemon restart) or `delete workload` (destructive).
- **t2_fts unicode61 tokenizer drops underscores.** `chain_start` → `chain` + `start`. Miners must normalize via `[A-Za-z0-9]+` tokens (see `mine_t0.py`).
- **`t2_memory_verification_events` is still 0 rows.** Spec `penumbra/docs/specs/2026-05-16-memory-verify-auto-fire.md` hasn't landed. Top penumbra ask.
- **Recipe C (mine t0_events `memory_search` queries)** is the practical mining surface — 493 calls / 245 distinct queries in the DB today. Recipe A (verify-events) is blocked until the above lands.

## 4. Loose ends (carry-forward, prioritized)

Highest leverage first:

1. **Qwen-relabel control on synth half.** Boot Qwen3.5-9B-MTP, regenerate the 50 synth rows using `synth_t2.py --labeler-url http://127.0.0.1:8191`, diff against granite's labels, re-bench gemma4 + qwen3.5-9b-mtp on relabeled corpus. ~25-35 min. Nails down residual labeler-style bias (which is real but small per today's diagnostic — granite's strong-vs-weak boost was largest of any model, +0.21 absolute).

2. **Fill the fleet** with `gemma4-e4b` + `granite-3b-Q8`. No complete matrix spec for either exists (granite-3b-Q8 entry in tier files is partial — missing `binary`, `start_args`, `managed`). Hand-write specs at `packages/eval/specs/{gemma4-e4b,granite-3b-Q8}.json` then bench on n=55 strong. ~20-30 min.

3. **Apply the same gold-tier methodology to tool-call-grammar.** The n=50 corpus has implicit difficulty tiers (single-call vs multi-call vs no-call). Splitting and benching across the fleet would mirror today's memory-recall arc on a different workload shape. ~30-45 min.

4. **Per-row score persistence in the matrix runner.** Today's diagnostic required corpus-file swapping to get per-tier breakdowns. A `matrix_cell_rows` table with `{run_id, model_name, workload_name, row_index, prediction, gold, metric_value}` would let any future tier/family analysis run in SQL without re-benching. Spec it before implementing — ~20 min code + careful tests.

5. **Pilot one penumbra ask from llamactl side.** The most tractable is ask #4 (expose `search()`'s query rewriter). I have the t2_fts tokenization quirks documented in `mine_t0.py` already; a small llamactl-side script that wraps the penumbra `memory_search` MCP tool and exposes `memory_search_explain(query) → {fts_query, candidates, scores}` would prove the value of the API surface before asking penumbra to land the real version.

## 5. Machine state at handoff

- Penumbra daemon + worker: up.
- `granite41-8b-long-lived-local` on :8083: re-enabled, running (t2-judge).
- `granite41-3b-judge-mac-mini` on :8086 (remote): running (~23h uptime).
- All other workloads: stopped / disabled (bench-on-demand).
- Branch: `main` at `bc0672e`, 40 commits ahead of `origin/main` (not pushed).
- Pending handoffs: clean.
- `docs/notes/session-summary-2026-05-18-am.md` has uncommitted changes (3 commit lines appended in the morning session — predates this session).

## 6. First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main..HEAD | head`
2. `mcp__penumbra__handoff_list_pending` → confirm clean.
3. Pick from §4. Loose ends. The Qwen-relabel control (#1) is the highest-leverage next step — it resolves the only open question about the memory-recall corpus's interpretive validity.

## 7. Decisions not to re-litigate

- Strong-gold is the headline metric. Report n=105 as a secondary aggregate but lead with n=55 strong-gold.
- gemma4-26b-a4b-mtp is the memory-recall production pick. Spend bench cycles on the model **right below it** (which sub-distribution favors what) rather than re-validating the top.
- Synth labeler bias is real but small + rank-preserving (granite scored 5th on both n=105 and strong-only). Don't treat the corpus as compromised; the Qwen-relabel control is rigor, not a fix.
- The atomic + atomic-qwen forks still accept `--spec-type mtp` / `nextn`. The upstream `--spec-type draft-mtp` rename (2026-05-13) hasn't propagated to either fork; existing MTP workload yamls are safe.

## 8. Memories worth reading first

- `project_memory_recall_fleet_2026-05-18.md` — full leaderboard + strong-gold reordering.
- `project_corpus_expansion_2026-05-18-pm.md` — tool-call + memory-recall corpus build context.
- `feedback_model_selection_mtp_first.md` — original rule, now needs the ranking-vs-classification qualifier from this session.
- `project_a3b_beats_mtp_dense_2026-05-18.md` — classifier-side counterpart to today's ranking-side finding.
- `reference_fork_branches_correct_2026-05-17.md` — atomic vs atomic-qwen branch/binary mapping.
- `reference_qwen3_jinja_tool_call_gold_standard.md` — for the Qwen-relabel control: Qwen3 + `--jinja` is the gold-standard tool-call labeler.
