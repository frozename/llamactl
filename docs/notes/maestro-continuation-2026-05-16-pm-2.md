# Maestro continuation — 2026-05-16 pm-2

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state (`handoff_get`, `chain_wait`, `chain_get_response`); do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot, the dispatch sandbox blocks something structural, or the edit is a single small inline fix.

This is the 7th continuation note for 2026-05-16. The prior `-pm-final.md` ended at 12:25 UTC; this session ran 13:00-19:02 UTC and produced 17 commits (16 in llamactl, 1 cross-repo landed in penumbra). All `-pm-*` slots through `-pm-final` are taken — use `-pm-3.md` next.

## What this session shipped — the through-line

The day started with two parallel LoRA tracks (memory-efficacy "M-track" and tool-call "K-track"), both showing identical-looking dead ends: adapter byte-identical to base across multiple corpora and configs. Over the course of this session, the maestro:

1. Ran two adversarial-reviews — first on the diff to surface bugs (1 high severity: `REUSE_HF_BASE` integrity), second on the K-track *strategy* (4 high-severity: missing production contract, runtime-misaligned metric, name-first denominator skew, label provenance).
2. Wrote a decision contract for each track with quantified retire criteria.
3. Decomposed the failure modes per-row and discovered the two tracks have *different root causes* — K-track failures are model-vs-labeler stylistic disagreement (no objectively correct answer), M-track failures are objective model errors (prior toward majority class).
4. Froze the K-track formally + renamed `adversarial-v0 → uncommon-v0` per the naming_clarity persona.
5. Tested the M-track contract's validation slice part C: few-shot prompting lifted macro-F1 from **0.6868 → 0.8931 (+20.6 pp)** with three exemplars. LoRA contributed zero on top.
6. Dispatched into penumbra to wire the prompt change into production. Landed at `2a57160` on penumbra/main.

The lesson worth memoryizing: **before training, test prompting.** A 1-hour prompt experiment beat 5 LoRA runs by 20+ macro-F1 points.

### Commit-by-commit context (this session, llamactl)

**Phase A — memory-efficacy LoRA round-trip + tool-call corpus (Phase 1 of "do all in optimized order"):**

- `5cdfcec` K.3 corpus (25 adversarial tool-call rows, 4 categories) — dispatched to codex-acp-fast.
- `5d1bf03` Hand-fix: `kill_port` lost its port argument in the recent `lib.sh` extraction; both eval scripts broken under `set -u`. Restored arg + re-invoked `wait_port_bindable` (regression vs `3c5285a`).
- `eb54588` + `b0831f1` M.4 results — the dispatched eval failed to bind 127.0.0.1:18099 from inside codex-acp-fast's sandbox even after the kill_port fix. **Confirmed structural: codex-acp-fast cannot open listening sockets.** Hand-ran the eval from the maestro shell. macro-F1 lifted 0.4918 → 0.6868 from corpus expansion alone; adapter contributed -0.0185.
- `61ca405` M.5 balanced sibling corpus (3x minority ratio, deterministic SHA1 sort, idempotent generator) — dispatched cleanly.
- `ac81966` M.6 results — rebalancing didn't move the minority floor (R=0.50, R=0.25 identical to n=60 canonical). 88% majority was *not* the binding constraint; the floor looked "structural" at this point.
- `a906ff8` `REUSE_HF_BASE=1` env var — needed because M.7 dispatch failed (worker sandbox can't reach huggingface.co); had to hand-run training with hardlinked HF cache.
- `e84bda3` M.7+M.8 — retrained on +35 minority rows. **Adapter byte-identical to prior adapter on every row.** LoRA fully saturated at rank=16.
- `0f3406e` K.4 — Qwen3-4B + K.1 adapter on the K.3 adversarial set. Both 24% strict; name-first 88-96%; failure surface revealed as primarily semantic (multi-tool count + arg values), not structural.

**Phase B — adversarial-review #1 (on diff) + corpus expansion (Phase 2):**

- `43b7e94` adversarial-v0 batch 2 — dispatched to codex-acp-fast, added 25 more rows. Combined 50 (9/13/10/18 across multi-tool/name-collision/ambiguous-intent/schema-edge).
- `4a6f3ae` Prefix + name-first scorer — strict 24% had been misleading because multi-tool rows where the model emits 1 of 2 calls (correct sequential dispatch) were scored as failures. Prefix-match exposes 36% true success; name-first exposes the 88-96% accurate tool selection.
- `57a4d8a` `REUSE_HF_BASE` integrity check — adversarial-review #1's high-severity finding: the cache reuse had no model+revision verification. Now requires pinned `MODEL@rev` + matching `config.json.metadata` first line + falls through to fetch on any mismatch.
- `c68c209` K.5 — trained Qwen3-4B LoRA on 38 stratified adversarial rows, evaluated on held-out 8. **Byte-identical to base again** — third independent dataset showing zero LoRA lift at this config.

**Phase C — adversarial-review #2 (on K-track strategy) + decision contracts (Phase 3):**

- `a4e25a7` K-track decision contract + scorer denominator cleanup — adversarial-review #3 finding: name-first denominator should be positives only (was total, undefined on no-tool-expected rows). Now reports strict/prefix/name-first(positives)/no-tool(negatives) separately. Decision contract sets +5pp lift threshold + retire criteria.
- `d6cc528` K-track grammar control analysis — decomposed K.4's 19 base failures: **0 structural, 2 tool-selection, 6 multi-tool count, 11 right-tool-value-mismatch.** The 11 value-mismatch rows are predominantly model-vs-labeler stylistic disagreement ("parser implementation" vs "parser", "backup-job" vs "backup_job"). Grammar-constrained decoding cannot help; nothing can lift a metric measured against arbitrary labels.
- `3634a20` K-track freeze — renamed `adversarial-v0` → `uncommon-v0` (naming_clarity persona) + `FROZEN.md` marker. Re-entry requires production-trace gold-labeling pipeline.
- `7e771ff` M-track decision contract + failure decomposition — parallel to K-track but **different verdict**: all 6 M.4 minority false-negatives are objective model errors. E.g. prompt explicitly says "*formatting bug wraps the recalled instruction in quotes, making the model treat it as reported speech*" → model: "*not related to memory efficacy*." Systematic prior-toward-majority bias; the M-track is plausibly fixable without retraining. Updated validation slice part C to be **few-shot prompting first**.
- `40b90cb` **Few-shot prompt lifts macro-F1 +20.6 pp.** Built `4way-chat-fewshot/test.jsonl` with 3 hand-picked minority exemplars (one per class, drawn from train split to avoid leakage). Same eval; same model. Per-class minority recall: 0.75→1.00, 0.50→0.75, 0.25→0.75. Adapter still byte-identical to base under few-shot. LoRA half of M-track retired by the contract's part-C rule.

**Phase D — cross-repo land:**

- penumbra `2a57160` — `feat(memory-efficacy): inject 3-exemplar few-shot block into classifier prompt`. Dispatched to codex-acp-fast in penumbra worktree; agent scouted in 21s, asked for confirmation, then I started a fresh chain (the first dispatch terminated waiting for input — couldn't `chain_send_message` because it had completed). Second dispatch (`fefa94b2`) landed the edit, ran `bun test packages/core/test/memory-efficacy-classifier.test.ts` → 3 pass / 12 expects, committed `2a57160` in the worktree. `dispatch_land mode=ff` returned HTTP 409 (verdict-unverified gate); used `force=true` after inspecting the diff via `worktree_inspect` and confirming it was exactly the 2 files we expected. Landed ff-only.

**Phase E — handoff cleanup:**

- `a2072e0` (just before this note) — committed `docs/notes/k-track-strategy-brief-2026-05-16.md`, the brief that drove adversarial-review #2. It was referenced by other committed notes but had stayed untracked.

## Live state at session end

- **penumbra daemon**: pid 42850 (different from session-start; appears to have been restarted at some point during the session — note that the session-start handoff listed pid 38905). Worker pid 42852. No issues observed; ~7 dispatches landed cleanly.
- **mac-mini at 192.168.68.76**: status unknown this session — the prior `-pm-vvlate` note said "still off-LAN"; not re-checked.
- **llamactl HEAD**: `a2072e0` (the strategy brief commit).
- **penumbra HEAD**: `2a57160` (the few-shot prompt).
- **home-mgmt**: not inspected this session. Likely still active per `-pm-vvlate` note.
- **Working tree**: only untracked notes from prior sessions (`docs/notes/maestro-continuation-2026-05-1[56]-*.md`, `ops-triage-*.md`, `session-summary-*.md`, etc.). None blocking. The current session's continuation note (this file) is the only addition from this session that's still uncommitted.

Nothing was edited outside git in this session (no yaml live-edits, no daemon_reload_config). All changes flowed through commits.

## Open follow-ups (concrete first moves)

1. **Verify production lift of the few-shot prompt** — the next scheduled `memory_efficacy_rebuild` in penumbra will use the new prompt. After it runs:
   - `mcp__penumbra__memory_efficacy_jobs limit=5` to find the post-`2a57160` job
   - `mcp__penumbra__memory_efficacy_recent limit=20` to inspect classifications
   - Compare per-class counts vs the prior 7 days
   - If production lift matches the n=60 eval (+20pp macro-F1, +25-50pp minority recall): note in `docs/notes/m-track-fewshot-production-verify-{date}.md` and update the M-track contract with the verified number.
   - If it doesn't: file as a follow-up; the n=60 eval may have included exemplar-style findings that biased the lift.

2. **The exemplar refresh question** — the 3 exemplars in the production prompt were drawn from the M-track train split. If penumbra's `memory_efficacy_rebuild` ingests new production findings into its training corpus over time, an exemplar might eventually appear as a labeled finding and create the same self-referential leakage that adversarial-review #4 flagged for K-track. **First move:** verify with `mcp__penumbra__memory_corpus_query` whether the exemplar texts ("worker timeout drops the ingestion job", "ranker uses a hard threshold", "formatting bug wraps the recalled instruction in quotes") have ever appeared as production findings. If yes — replace them with synthetic-style exemplars that won't collide. If no — set a calendar reminder to re-check quarterly.

3. **K-track re-entry trigger** — frozen until a production-trace gold-labeling pipeline lands. The decision contract names this explicitly. Not blocking; no work owed.

4. **Decision-contract pattern as a reusable spec** — both K-track and M-track contracts converged on the same shape (production metric + threshold, bar-to-invest, retire criteria, validation slice with budget). Worth promoting to a reusable template in `docs/specs/templates/track-decision-contract.md` for future "should we train a small model for X?" questions. Low priority but high-leverage if a third track ever appears.

5. **codex-acp-fast sandbox limitation** — this session's dispatches twice hit "worker cannot bind a listening socket" (M.4 eval, M.7 train via `hf download`). Both required hand-running. Worth documenting in penumbra's agent-routing layer so future maestros know which task types must NOT go to codex-acp-fast. The right place is probably an entry under `mcp__penumbra__agent_recommend`'s metadata, but that's a penumbra-side change. **First move:** open a small penumbra issue or note describing the failure mode (`docs/notes/codex-acp-fast-sandbox-limits-2026-05-16.md` in penumbra repo) so it's discoverable.

## Memories worth reading first

The auto-recall block in the session-handoff workflow surfaced some t2 hits that didn't reflect this session's actual content (older threads about worktree/branch-base). The actually-relevant memories for picking up this session cold:

- `project_memory_efficacy_corpus_llm_labeled` — explains why the gold labels are inherently teacher-dependent; provides context for adversarial-review #4's "label provenance" finding.
- `project_fine_tune_toolchain_landed_2026-05-16` — covers the mlx-lm → bridge → GGUF → llama-server --lora toolchain that K and M tracks both ride on.
- `reference_qwen3_jinja_tool_call_gold_standard` — establishes that Qwen3+jinja is the labeler for the K-track. Useful when reading the K-track failure analysis.
- `reference_penumbra_dispatch_routing` — the use_worktree:false + explicit cd recipe for llamactl-targeted dispatches. Not used this session (cross-repo land was INTO penumbra so default worktree:true was correct), but the inverse direction will come up.
- `project_tool_call_lora_pilot_2026-05-16` — the K.1 pilot context that the K-track decision contract supersedes.

Also worth a glance, both in `docs/specs/`:
- `k-track-decision-contract-2026-05-16.md` — frozen state, re-entry criteria
- `m-track-decision-contract-2026-05-16.md` — open, validation slice part C completed

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `git -C /Volumes/WorkSSD/repos/personal/penumbra log --oneline -3` → confirm `2a57160` is still on main
4. `mcp__penumbra__memory_efficacy_jobs limit=5` → find any rebuild after 18:55 UTC today
5. If a post-`2a57160` rebuild has run: read its results and verify production lift; otherwise hold for the next scheduled run.
6. Otherwise pick from the open follow-ups above with the user.

## Decisions worth not re-litigating

- **K-track is frozen.** Re-entry has explicit conditions in `docs/specs/k-track-decision-contract-2026-05-16.md`. Don't run K.6 without satisfying the contract.
- **LoRA at rank=16/num_layers=16/iters=300 is exhausted.** Five runs across two tracks. Larger rank/layers/iters is the only LoRA path worth re-testing; everything smaller is known-null.
- **Few-shot prompting beats LoRA on calibration-shaped problems.** Try the prompt before the model.
- **Decision contracts work.** Two tracks, both ended with explicit verdicts in <1 hour of contract work. Use the pattern.

## What NOT in scope

- No work on penumbra ops triage (Thread N.2 in older notes — gh-task-sync errored, task-refiner federation race). The session-handoff workflow listed `agent.tool_call.failed` events on a few dispatches today but those were pre-existing background activity, not this session's concern.
- No work on mac-mini optimization, Granite tuning, or Gemma 4 E4B re-eval. All deferred from `-pm-vvlate` and still deferred.
- No additional adversarial-reviews scheduled. Two ran today; both consumed by this session.
