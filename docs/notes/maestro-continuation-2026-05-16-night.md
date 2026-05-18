# Maestro continuation — 2026-05-16 night

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state
(`handoff_get`, `chain_wait`, `chain_get_response`); never query sqlite
directly except for forensics. Repo-facing text neutral, no AI/tool
authorship. Delegate substantive code via `chain_start`; hand-implement
only when the worker won't boot, the dispatch sandbox blocks something
structural, or the edit is small and inline.

This is the **9th** continuation note for 2026-05-16. Prior `-pm-3.md`
at `6bd9d80` ended at 19:50 UTC. This session ran 22:50 UTC → 02:20 UTC
next day, ~3.5 hours, and produced 8 commits across llamactl (6) and
penumbra (3 — auto-fire memory_verify + WAL pragmas + meta_json truncate).

## The through-line

The session opened with the pm-3 follow-up list (auto-fire memory_verify
dispatch, env-ref interpolation fix, daemon plist persistence,
home-mgmt DB-locked forensics). Those all landed in the first 90 minutes.
Then the user introduced Needle (a 26M attention-only tool-call model) as
a conceptual reframe. That triggered a real engineering arc:

1. **Reframe** — recognized that today's earlier "+20.6 pp few-shot beats
   LoRA" result is Needle's thesis (retrieval-and-assembly, not reasoning)
   stated on our own data. Saved as `feedback_attention_assembly_not_ffn`.
2. **Cross-family eval** — built `eval-base-only.sh`, ran 9 models on the
   memory-efficacy 4-way corpus with the same few-shot prompt. Found that
   Gemma 4 E4B at ~4B effective params ties Qwen3-8B byte-identically
   (0.8931). Granite-3B Q4_K_M within -1.97 pp.
3. **Quant sweep on the top two** — Granite-3B Q4→Q8 lifts +5 pp to
   **0.9235** (now best in the table, beating the 8B by +3.04 pp).
   Gemma 4 E4B Q4_K_XL → Q8 *drops* -2.49 pp (smart per-tensor Q4 wins
   for MatFormer architectures). Asymmetric quant×architecture
   interaction documented.
4. **Production swap** — replaced the `qwen3-8b-local` workload at
   `127.0.0.1:8085` with `granite41-3b-judge-local` (Granite-3B-Q8).
   Same port, same daemon plist, byte-identical end-to-end macro-F1
   reproduced (0.9235) through the daemon-managed server.
5. **Fleet eval scoping** — when the user asked about evaluating the
   *other* workloads, dug into the DB and discovered no on-disk corpus
   exists. Wrote a scoping doc identifying the corpus-availability
   constraint and proposing instrument-vs-synthesize paths per workload.

The arc moved from "fix yesterday's loose ends" through "find a unifying
frame" to "ship the production change the frame implied" to "scope what
the frame implies for the rest of the fleet."

## What this session shipped — commit-by-commit

### Penumbra side (3 landed on main + 2 pre-spec)

- **`eca9e319`** `feat(daemon): auto-fire memory_verify on lane close` —
  implements the spec landed yesterday. Dispatched to `codex-acp-fast`
  (handoff `10810371-...`), 127s wall, single retry needed for stale
  worktree but otherwise clean. Three unit tests covering the spec's
  three cases. Pre-existing baseline test failures (port-in-use, etc.)
  documented + scoped out.
- **`f74f9bd`** `fix(core/db): enable WAL + busy_timeout on db open` —
  adds `applyRuntimePragmas(db)` to `sqlite-vec.ts`, called from
  `loadSqliteVec` after `enableForeignKeys`. WAL gated on
  `db.filename !== ':memory:'`. Eliminates the 800+ SQLITE_BUSY entries
  in the daemon err log.
- **`b462bcb`** `fix(core/services): truncate oversized meta_json in
  dispatch-event-log` — caps `meta_json` at 4096 chars before insert.
  Oversized payloads become `{_truncated: true, kind, original_size}`.
  Bus event sees the same truncated shape. Eliminates the 22 CHECK
  constraint failures.

Both reliability fixes came from dispatch `a48325c6-...` (codex-acp-fast,
93s wall) — two-commits-in-one-dispatch worked as instructed.

### Llamactl side (6 commits)

- **`10a8d76`** `feat(remote): interpolate ${env:VAR} in workload
  manifests` — `interpolateEnvRefs(raw, env)` in `parseWorkload`,
  fail-loud on unset. Fixes the `qwen3-8b-mac-mini.yaml` env-ref
  that was previously a no-op. Hand-edited; 4 new unit tests.
- **`9c8328f`** `feat(train)+docs(notes): cross-family eval of few-shot
  lift on memory-efficacy` — adds `packages/train/scripts/eval-base-only.sh`
  + the 7-model writeup at
  `docs/notes/attention-thesis-cross-family-eval-2026-05-16-night.md`.
- **`d551473`** `docs(notes): attention-thesis eval — add Gemma 4 E2B
  datapoint` — Gemma 4 E2B Q8 = 0.8386, confirms Gemma 3n E2B (0.8469).
- **`c9f8c5b`** `docs(notes): attention-thesis eval — quant sweep on top
  performers` — Granite-3B Q8 = 0.9235 (new headline), Gemma 4 E4B Q8 =
  0.8682 (regression). Asymmetric quant×arch interaction documented.
- **`e4ada9e`** `templates(workloads): granite41-3b-judge-local —
  production swap on :8085` — the new YAML. Daemon-managed via
  reconciler. End-to-end eval reproduces 0.9235 against the live
  server.
- **`e7654af`** `docs(notes): fleet eval scoping — what each
  non-memory-efficacy workload needs` — enumerates 7 LLM workloads,
  task class per workload, corpus constraint, recommended order of
  operations.

## Live state at session end

- **Llamactl HEAD:** `e7654af`. Untracked: only the docs/notes/*.md
  bag-of-continuation-notes from across the day.
- **Penumbra HEAD on main:** `b462bcb` + descendant of `f74f9bd` and
  `eca9e319` (all squash-landed via dispatch_land).
- **Daemon plist (`~/Library/LaunchAgents/dev.penumbra.daemon.plist`)**
  now has `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:8085` +
  `PENUMBRA_REVIEWS_DIR=/Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews`
  persisted. Backup at `/tmp/dev.penumbra.daemon.plist.bak`.
- **`:8085` workload:** `granite41-3b-judge-local` is daemon-managed,
  running Granite-4.1-3b-Q8_0 with alias=local. The replaced
  `qwen3-8b-local` is set to `enabled: false` in
  `~/DevStorage/workloads/qwen3-8b-local.yaml` (reconciler-managed; not
  in repo). Roll back by flipping `enabled: true` and the reconciler
  will stop Granite and start Qwen.
- **penumbra daemon:** PID changed during session (kickstart for plist
  reload); current PID ~42xxx. Healthy.
- **home-mgmt:** still `status: active`, but the session-start state
  showed `last_intent_summary: "database is locked"`. The WAL +
  busy_timeout pragmas landed mid-session should eliminate that on
  next daemon restart (pragmas apply at db open).
- **t2-promotion judge pool:** still 100% unhealthy. 13,355 "all judges
  unhealthy" errors in `~/.penumbra/launchd.daemon.out.log` going back
  to 2026-05-06. Not addressed this session; first item in the fleet
  eval scoping order of operations.
- **Memory updated:** new entries `feedback_attention_assembly_not_ffn`
  and `project_attention_thesis_eval_2026-05-16` with reciprocal
  cross-links. MEMORY.md updated.

## Open follow-ups (concrete first moves)

### 1. t2-promotion ops triage (highest leverage; ~30 min)

`granite-mini-8b` (mac-mini :7843) and `local-granite-8b` (:8080) are
the two agents in the judge pool. Daemon log says "all judges
unhealthy this tick" 13k+ times. Diagnose: (a) are the endpoints
listening? (b) are the agent_kind/role/baseUrl mappings correct?
(c) is the rollup pipeline even producing rollups to judge? Once
diagnosed, fix or disable. After revival, the workload becomes a
classification eval candidate (same harness pattern as memory-efficacy).

### 2. Memory recall scoring inspection (~15 min)

Find where penumbra ranks t2 candidates against incoming dispatches.
Confirm whether it's LLM-driven or pure-embeddings. If LLM-driven,
it's the highest-volume LLM call in the daemon and a top eval target.
Grep starting points: `recallEnrichment`, `injectRecalled`,
`retrieveT2`, `scoreCandidate` in `packages/core/src/services/`.

### 3. home-mgmt instrumentation spec

Write a spec analogous to `2026-05-16-memory-verify-auto-fire.md` that
captures `(pulse_payload, intent_summary, working_memory_diff,
chain_start_request_or_null)` on each successful tick. The DB query in
this session confirmed `long_lived_ticks` has NULL `intent_summary`
and NULL `working_memory_diff_json` on successful rows. ~1 hour to spec,
~2 hours to implement via dispatch. Then wait ~7 days for ~1000 ticks.

### 4. Concurrent — synthesize a home-mgmt v0 corpus

Use the codex-acp-spark pattern. Prompt a strong model with the
`home-mgmt` `standing_brief` + a few hand-curated example pulses to
generate 50-100 (pulse, gold_action_class) pairs. 4-way:
`short_circuit_no_change` / `note_to_thread` / `escalate_for_diagnosis`
/ `act_with_approval`. Then run `eval-base-only.sh` with anchor=Qwen3-8B
(current mac-mini judge) vs Granite-3B-Q8 + Gemma 4 E4B.

### 5. Replicate the memory-efficacy result on the auto-fire corpus

Once `t2_memory_verification_events` accumulates ~100+ rows (the
auto-fire spec we landed today predicts 5-7 days of operation), re-run
the 12-config attention-thesis eval. The current n=60 result has 4-row
minority classes; one row of label noise = 25 pp per-class recall.
Replication on the larger corpus is necessary before treating
"Granite-3B Q8 beats Qwen3-8B" as a firm fleet rule.

### 6. Generation-shape eval harness (task-refiner / dispatch-refine)

Bigger build. Need `eval-generation-rubric.sh` — feeds (input, gold,
candidate_output) to a strong judge model and scores per-axis. Holding
until home-mgmt results inform whether the rubric-judge approach is
trustworthy.

## Memories worth reading first

The 6 entries most relevant for picking up cold:

1. `feedback_attention_assembly_not_ffn` — the rule. For retrieval-and-
   assembly tasks, few-shot beats LoRA architecturally. Reach for
   training only when prompt can't carry the patterns.
2. `project_attention_thesis_eval_2026-05-16` — the 12-config eval.
   Granite-3B Q8 = 0.9235 headline. Production swap candidate (now
   landed).
3. `project_fewshot_beats_lora_2026-05-16` — the predecessor result
   (+20.6 pp on Qwen3-8B with few-shot). The data point that motivated
   the cross-family follow-up.
4. `project_m_track_corpus_bootstrap_2026-05-16` — the auto-fire
   memory_verify pattern. The instrumentation template for any future
   workload eval.
5. `reference_qwen3_jinja_tool_call_gold_standard` — the labeler
   pattern for tool-call corpora. Use Qwen3-8B + `--jinja` for any
   tool-call gold-label generation.
6. `project_k_track_frozen_2026-05-16` — K-track stays frozen. Don't
   re-open tool-call LoRA without a labeler-diversity story; the
   ceiling is labeler-bound, not model-bound.

## Decisions worth not re-litigating

- **Granite-4.1-3B Q8_0 is the memory-efficacy judge.** The swap is
  live on :8085. Don't revert without re-running the full 12-config
  eval on the production corpus first.
- **Modern-arch is the floor, not parameter count.** Gemma 3n E2B at
  ~2B beats Qwen3-1.7B at 1.7B by 26 pp. Don't propose "use Qwen3-1.7B
  it's smaller" without re-checking the attention-thesis writeup.
- **MatFormer architectures prefer smart Q4 over naive Q8.** Gemma 4
  E4B UD-Q4_K_XL (0.8931) > Gemma 4 E4B Q8_0 (0.8682). Conventional
  dense models (Granite, Qwen3) prefer Q8 monotonically. Don't pick
  quants without knowing the architecture's intent.
- **The corpus is the binding constraint, not the harness.** Don't
  scope another model swap until the target workload has either a
  labeled corpus or an instrumentation plan.

## What NOT in scope for next session

- **Don't re-run the memory-efficacy cross-family eval.** It's
  conclusive; replication waits on the auto-fire corpus.
- **Don't try a new LoRA on memory-efficacy or tool-call.** Frozen by
  decision; reframe says it's an architecture mismatch for this task
  class.
- **Don't touch the daemon plist further.** Two env vars persisted +
  daemon healthy. Next plist edit should be a deliberate operator
  decision with a backup.
- **Don't blow away the `qwen3-8b-local` workload YAML in
  `~/DevStorage/workloads/`.** It's the rollback safety net; the
  `enabled: false` is intentional.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -10`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `curl -fsS http://127.0.0.1:8085/props | jq -r '.model_path, .model_alias'` →
   confirm the Granite swap is still live
4. Read `docs/notes/fleet-eval-scoping-2026-05-16-night.md` end-to-end
5. Pick a thread with the user. **t2-promotion ops triage is the
   highest-leverage next move** — ~30 min and unblocks the next
   eval candidate. Memory recall scoring inspection is the second.

## Non-obvious bites this session (worth remembering)

- **Workload name regex rejects dots.** `granite-4.1-3b-judge-local`
  was silently dropped from the workload list. Schema:
  `^[a-z0-9][-a-z0-9]{0,62}$`. Renamed to `granite41-3b-judge-local`.
- **HF Q4_K_M not always shipped.** Both Qwen3-1.7B and Gemma 3n E2B
  on `ggml-org/*-GGUF` only have Q8_0 + f16 (or bf16). Fall back to
  Q8 — at 2B params, quant overhead is small.
- **`jq -n` pretty-prints by default.** Use `jq -nc` for JSONL
  output. Otherwise re-parsing breaks. Cost me one round-trip eval
  (~5 min) until I caught it.
- **Daemon-managed model paths differ from hand-spawn paths.** The
  reconciler resolves `target.kind: rel` against `/Volumes/WorkSSD/ai-models/`
  while hand-spawn used `/Users/acordeiro/DevStorage/ai-models/`. They
  resolve to byte-identical files (verified via sha256) but the /props
  string differs. Compare model identity by alias, not path.
- **Reconciler reacts to YAML changes in seconds.** Flipping
  `enabled: true` → `false` triggered server stop within ~15s. New
  YAML files in `~/DevStorage/workloads/` get picked up on the same
  cadence. No restart needed.
