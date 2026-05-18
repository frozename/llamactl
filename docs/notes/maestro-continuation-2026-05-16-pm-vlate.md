# Maestro continuation — 2026-05-16 pm-vlate

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state. Keep commits/PR descriptions neutral. Delegate substantive code via `chain_start`; hand-code only when the worker won't boot, when a dispatch has structurally failed twice, or when the fix is a single small inline edit.

## What this session shipped (continues from 2026-05-16-pm-late note)

User asked for K → M → N in order. All three completed (with M.2 deferred).

### llamactl commits (today, 5 total this session)

- `578898d` `feat(train): tool-call grammar train/valid/test splits + prep.py` — Thread K corpus prep, 24/3/3 split by `id`-sorted mod-10 with deterministic `call_<idx>` tool_call IDs.
- `e3ab1e0` `feat(train): eval-tool-calls.sh — base-vs-adapter parse-success rate harness` — Thread K eval harness with lsof-kill, /props zombie guard, /v1/chat/completions per-row scoring.
- `4206279` `fix(train): eval-tool-calls.sh reads gold tool_calls from messages[-1]` — scorer bug fix: initial version read non-existent `expected_tool_calls` field; prep.py drops it in favor of bundling the gold turn in `messages[-1]`. Also fixed inline `eval-raw.jsonl` template literal silently emitting nothing.
- `48ceae1` `docs(notes): syn-mi-* audit — 4 of N borderline rows flagged for relabel review` — Thread M.1 audit. 4 of 15 synthetic memory_ignored rows flagged: `syn-mi-008/010/012/015`.
- `3e17135` `fix(corpus): memory-efficacy mod-10 split by hash(findingId) — break synthetic family-leakage` — Thread M.1 hash-mod fix + 12 regenerated jsonl + README counts.

### penumbra (no commits this session)

Registry parser balked on `gh_repo: frozename/penumbra` because the schema only accepts `remote.{kind,repo}`. Hand-fix in `~/.penumbra/projects.yaml` removed the bad line; user later restored it under the `remote.{kind,repo}` shape. **No penumbra repo work pending.**

## Thread K — tool-call grammar LoRA pilot ✅

Qwen3-4B-Instruct-2507 + LoRA (ITERS=300 BATCH=1 NUM_LAYERS=16 RANK=16) on the 30-row tool-call corpus. Pipeline:
- prep.py → train-lora.sh (smoke FAIL as expected, train/bridge/convert PASS) → eval-tool-calls.sh.

**Result**: base 100% (3/3), adapter 100% (3/3) on the held-out test split.

LoRA value not measurable: test n=3, base already saturates. Same pattern as memory-efficacy slice 2c. The toolchain itself is verified end-to-end. See `project_tool_call_lora_pilot_2026-05-16` memory + `reference_eval_tool_calls_gold_from_messages` for scoring convention.

Note on dispatching: the first two K dispatches failed for cosmetic reasons (worktree routed to penumbra repo by default; agent picked wrong HF repo IDs `Qwen3-4B-Instruct` / `Qwen3.5-4B-Instruct` which don't exist — public ID is `Qwen/Qwen3-4B-Instruct-2507`). Ended up hand-running the train+eval after the prep.py + eval-tool-calls.sh scripts shipped via dispatch.

## Thread M.1 — memory-efficacy corpus hardening ✅

Two adversarial-review findings (from `.penumbra/reviews/2026-05-16T04-41-12.358Z/synthesis.md`) addressed:

(a) **Family-leakage fix**: split bucketing was `idx % 10` after per-class sort by `findingId`. Synthetic IDs sorted next to each other and clustered in the same bucket. Switched to `int(hashlib.md5(findingId.encode()).hexdigest()[:8], 16) % 10`. Re-ran prep.py + prep_chat.py.

New 4-way counts: `train 13/18/15/371 · valid 2/2/2/37 · test 2/3/2/48` for `missed_registration / recall_miss / memory_ignored / not_memory_related`. Test split now has 2-3 of each minority class (was 1/2/1).
New binary counts: `train 46/371 · valid 6/37 · test 7/48`.

(b) **syn-mi-* audit**: 4 of 15 synthetic memory_ignored rows flagged for relabel review (`syn-mi-008/010/012/015`). Pattern: "recall happens in metadata/preview but executed prompt never contains the memory body" → that's recall_miss, not memory_ignored. Proposal-only; `gold-labels.json` is unchanged pending user review.

Audit lives at `docs/notes/memory-efficacy-syn-mi-audit-2026-05-16.md`.

## Thread N — ops triage ✅

Written up at `docs/notes/ops-triage-2026-05-16-pm-late.md`. Summary:

- **(A) gh-task-sync errored 100% (15→17, growing)**: Real penumbra bug. Per-task error not surfaced at warn level. Suspect either network family or the `gh_repo` → `remote.{kind,repo}` registry-schema migration.
- **(B) task-refiner-{primary,escalation} federation-tools-listTools-failed every :00/:15/:30/:45**: Real penumbra bug. Cron-firing-vs-federation-readiness race.
- **(C) home-mgmt federation-tools-listTools-failed sporadically**: Symptom of (B); home-mgmt ticks still succeed.
- (D)-(G) cosmetic / benign / resolved.

(A) and (B) are penumbra-side; flagging only — no llamactl change needed.

## Memories written today (3 new, 1 MEMORY.md index update)

- `project_tool_call_lora_pilot_2026-05-16` — Thread K outcome
- `reference_eval_tool_calls_gold_from_messages` — eval-tool-calls.sh scoring convention
- `project_memory_efficacy_v0_1_2026-05-16` — Thread M.1 hash-mod fix + audit pattern (labeling rule for memory_ignored vs recall_miss)

MEMORY.md index updated for all three.

## Live state at session end

- **penumbra daemon**: pid 38905 (unchanged from prior session)
- **penumbra worker**: pid 41726 (unchanged from prior session)
- mac-mini at 192.168.68.76: still unreachable (carry-forward; off home LAN)
- **llamactl HEAD**: `3e17135`. Working tree has the same untracked `docs/notes/` files from previous sessions plus today's new ones (`ops-triage-2026-05-16-pm-late.md`, `memory-efficacy-syn-mi-audit-2026-05-16.md` — the latter is committed). All can be committed when convenient.
- **penumbra HEAD**: `0c6452b` (unchanged from prior session).
- **home-mgmt**: `status: active`. Last 7+ ticks `success`. `working_memory.updated_at` advancing each tick. Bug B (proxy-wrapped MCP env injection) end-to-end verified mid-session via two `long_lived_get` snapshots ~15 min apart.

## Open threads (concrete first moves)

### Thread M.2 — Expand minority pool to 30-50/class

Current minority counts: recall_miss=23, memory_ignored=19, missed_registration=17. Need ~30 more rows to hit 30-50/class. Generate via codex-acp-deep-synth dispatch (or whichever synth-capable agent was used for the prior 45-row batch — see `ab46af5` for the prior approach). Then re-run prep + prep_chat. Only then can macro-F1 actually move.

### Thread M.3 (optional) — Apply the syn-mi audit relabels

If user agrees with the audit verdicts: change `classification` for `syn-mi-008/010/012/015` from `memory_ignored` to `recall_miss` in `tools/memory-efficacy-bench/corpus/gold-labels.json`. Then re-run prep + prep_chat.

### Thread K.2 — Bigger / harder tool-call eval

To measure LoRA value, need either:
- Larger held-out test set (mine ~20-30 adversarial prompts where base struggles)
- Weaker base model with measurable headroom (Qwen3-1.5B? 3B?)
- Or accept the strategic reframing: tool-call fine-tuning is defense-in-depth, not a primary fix. Qwen3-8B + `--jinja` already produces clean OpenAI tool_calls.

### Thread N.2 — Penumbra-side ops fixes (next penumbra session)

1. Add per-task warn-level error logging in gh-task-sync inner loop.
2. Investigate task-refiner federation-readiness race; add startup grace or federation `ready` gate.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__long_lived_get home-mgmt` → confirm `working_memory.updated_at` is recent.
4. Pick a thread with the user. M.2 (expand minority pool) is the highest-leverage next move on the fine-tune track; K.2 is the next move on the tool-call track.
