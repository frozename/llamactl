# Maestro continuation — 2026-05-16 pm-final

> Paste this as the kickoff message in the next session.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits/PR descriptions neutral with no AI/tool authorship. Delegate substantive code via `chain_start`; hand-code only when the worker won't boot, when a dispatch has structurally failed twice, or when the fix is a single small inline edit.

## What this session shipped (continues from 2026-05-16-pm-vvlate)

User asked for "all in recommended order" three times today. First two legs shipped K + M + N + M.2 + M.3 + K.2. The third leg ran an **adversarial review of all session-leg commits** then executed the action list in three batches.

### Adversarial review (2026-05-16T14-35-32.620Z)

Eight personas (architect, security, performance, simplicity, data_correctness, maintainability, naming_clarity, devils_advocate) + synthesizer ran via `mcp__penumbra__workflow_run({name:"adversarial-review"})`. The MCP call timed out at 15 min but the workflow continued async on the daemon; I polled with a background until-loop on synthesis.md. Verdict: **"Land with revisions — directionally valuable but block on correctness/security/maintainability."** 5 High + 7 Medium + 4 Low findings. Full artifacts at `.penumbra/reviews/2026-05-16T14-35-32.620Z/`.

Two of the High findings were on this session's code; the rest were carry-overs. User said "do all" — bundled into three batches.

### Batch commits (5 new this leg)

**`ed6c087`** `fix(train): strict tool-call scorer, stratified split, port-kill identity guard` — findings #1, #2, #11.
- Dispatched to codex-acp-fast (handoff `c745845f`); agent edited all files correctly but **stalled at the commit step**. The dispatch sat in `dispatched` for 22m+. I cancelled, verified the on-disk diff, and committed by hand. Two near-misses: (1) `cd packages/train/corpora/tool-call-grammar && python3 prep.py` left cwd persisted across Bash tool calls — subsequent paths broke. Used `cd /Volumes/.../llamactl && ...` to recover. (2) `prep.py` hash-mod gave 20/8/2 split on n=30 — uneven but stratification works (negatives in every split). User had also hand-applied #1 + #11 in parallel via linter; on-disk state matched what I'd have produced.

**`cffe15f`** `chore(train): drop dead/one-shot scripts + fail-loud on unknown classification` — findings #5, #10, #13. Hand-committed from the same partial dispatch (separate commit per the contract). Deletes `spike-mlx-to-llamacpp.sh` (266 lines, dead post-train-lora.sh) and `mine_qwen3.py` (one-shot, gold-corpus.jsonl committed). Side effect: `packages/train/package.json` `spike` script became stale — fixed in next commit.

**`6a23551`** `chore(train): syntax-check tier + drop dead package.json script` — finding #4. Dispatched to codex-acp-fast (handoff `7bad5c90`), 80s, committed cleanly. Adds `packages/train/scripts/check-syntax.sh` and wires it into `test/run-all.zsh` as a new fail-fast tier between core and cli. Replaces the stale `spike` script with `test:bridge` + `check:syntax` in package.json.

**`5186498`** `refactor(train): extract scripts/lib.sh + env-ref template binary path` — findings #8, #9. Same dispatch as above. Pulls `kill_port` + `wait_for_health` + `wait_port_bindable` into `packages/train/scripts/lib.sh`; the 3 callers source it. Templates `templates/workloads/qwen3{,5}-8b-mac-mini.yaml` switched to `binary: ${env:LLAMA_SERVER_BIN}` instead of hardcoded `/Volumes/AI-DATA/`. Dispatch noted that `zsh test/run-all.zsh` hit pre-existing core failures before reaching the new tier 2 — see Live state.

**`3b88bb2`** `fix(core): refuse non-loopback --host bind without explicit opt-in` — finding #6. Dispatched to codex-acp-fast (handoff `1fc962a0`), 2m, committed cleanly. Adds `allowExternalBind?: boolean` to `packages/remote/src/workload/schema.ts` and threads it through `packages/remote/src/router.ts` + `apply.ts`. `packages/core/src/server.ts` scans `--host` value in `launchBackground` + `startServer` and throws unless value is in {127.0.0.1, localhost, ::1} OR `allowExternalBind === true`. New tests in `packages/core/test/server.test.ts` cover deny/allow/loopback.

### Deferred

**Fix #3** (hash-locked pip requirements). The agent on the same dispatch as `3b88bb2` correctly refused to fake a lockfile without `pip-compile` or equivalent toolchain available locally. Tracked as task #9. Needs offline-toolchain pass with user review of the lock content.

**Fix #7** (cross-module coupling: `parents[4]` traversal in `memory-efficacy/prep.py` reaching into `tools/memory-efficacy-bench/corpus/`). Architectural refactor; deferred to a separate session.

**Fix #12** (naming/readability debt in long shell scripts). Broad cleanup; lower-leverage than the other deferred items.

## Live state

- **penumbra daemon**: pid 38905 (unchanged from prior sessions today).
- **penumbra worker**: pid 41726 (unchanged).
- mac-mini at 192.168.68.76: still off home-LAN. Templates now reference `${env:LLAMA_SERVER_BIN}` so when it returns, set `LLAMA_SERVER_BIN` env on the workload.
- **llamactl HEAD**: `3b88bb2` (12 commits past `origin/main` covering K + M + N + M.2 + K.2 + adversarial-review batches 1-3). Working tree has untracked `docs/notes/maestro-continuation-2026-05-16-*.md` from each leg of today's session and `docs/notes/ops-triage-2026-05-16-pm-late.md`.
- **penumbra HEAD**: `0c6452b` (unchanged from prior sessions; no llamactl-side change needed there).
- **home-mgmt**: still `status: active`. Working through normal `*/10 * * * *` ticks. Bug B (proxy-wrapped MCP env injection, fixed in penumbra@0c6452b earlier today) verified end-to-end this morning — state_set persisting.
- **`~/.penumbra/projects.yaml`**: live-edited mid-session. The registry had `gh_repo: frozename/penumbra` which the parser rejected — I removed it; user re-added under the supported `remote: {kind, repo}` shape mid-session. Don't touch.
- **Pre-existing core test failures** (not introduced this session; surfaced when batch 2's full suite ran): `detectMemoryBytes > returns a number on supported platforms, null otherwise` and `rpcServer > starts, reports status=up with host+port, stops cleanly`. The new train syntax-check tier never executed because tier 1 (core) fails first.
- **HF caches** (gitignored): `packages/train/.spike-work/` has both `tool-call-grammar-qwen3-4b/` and `tool-call-grammar-qwen3-1_7b/` with full GGUFs + eval artifacts.

## Open follow-ups (concrete first moves)

### M.4 — Re-run memory-efficacy classifier eval on the expanded corpus

The expansion (M.2: +46 synthetic rows, 35 per minority class) landed but no classifier has been re-evaluated against the new splits. New 4-way test split: `4/4/4/48` (was `1/2/1/45` pre-fix). Run `packages/train/scripts/eval-classifier.sh` on the existing Qwen3-8B 4-way LoRA adapter at `packages/train/.spike-work/memory-efficacy-4way-qwen3-8b-chat/` against the new `4way-chat/test.jsonl`. Macro-F1 should *move* this time — the prior n=49 made the metric statistically dead. **This is the highest-leverage next move** — actually measures whether all the M.1/M.2/M.3 corpus hardening was worth doing.

### K.3 — Adversarial tool-call test set mining

The stratified split landed in `ed6c087` but test split is n=2. To measure tool-call LoRA value, mine 20-30 prompts where Qwen3+jinja fails or hesitates: multi-tool dispatch where the right answer requires 2+ sequential calls; prompts with similar tool names; ambiguous intent; datetime/regex edge cases per [[project-qwen-tool-grammar-2026-05-15]]. Then re-run eval-tool-calls.sh — strict scorer is now in place so any args/count regressions will surface.

### Fix #3 (deferred) — hash-locked pip requirements

Task #9 in this session's task list. Run `packages/train/.venv/bin/pip download --no-deps --dest=/tmp/pin-stage` over each pin in `train-lora.sh` `PIP_PINS`, compute sha256, write `packages/train/requirements.lock`. Then switch the install command to `pip install --require-hashes -r packages/train/requirements.lock`. Defer the transitive-dep tree question — partial hardening (top-level pins only) is fine for v1; document the gap in `packages/train/SECURITY.md`.

### Fix #7 (deferred) — packages/train ↔ tools/memory-efficacy-bench coupling

`packages/train/corpora/memory-efficacy/prep.py:10-11` does `parents[4] / "tools/memory-efficacy-bench/corpus"`. Architect flagged as cross-module coupling. Concrete fix: define a versioned export contract — e.g., `tools/memory-efficacy-bench/scripts/export-corpus.ts` writes a snapshot `corpus-vN.json` to a known location, and `prep.py` reads only that. Defer until either side is reorganized.

### Fix #12 (deferred) — naming/readability in long shell scripts

`naming_clarity` persona's findings (in `.penumbra/reviews/2026-05-16T14-35-32.620Z/naming_clarity.md`) flag the long shell scripts. Lower-priority — read for context if doing cleanup work.

### N.2 — Penumbra-side ops fixes

Documented at `docs/notes/ops-triage-2026-05-16-pm-late.md`. Two real penumbra bugs (gh-task-sync 100% errored + task-refiner federation race). Not actionable from llamactl; surface to next penumbra session.

## Memories worth reading first

The 5 entries most relevant to picking up this work:

1. `project_memory_efficacy_v0_1_2026-05-16` — Includes the M.2/M.3 follow-up appendix. Has the labeling rule "executed prompt has memory body?" → memory_ignored vs recall_miss. Has new split counts.
2. `project_tool_call_lora_pilot_2026-05-16` — Has K + K.2 outcomes. Strategic reframing: tool-call LoRA is defense-in-depth, not a primary fix. Qwen3+jinja saturates 3-row tests.
3. `reference_eval_tool_calls_gold_from_messages` — Scorer reads gold from `messages[-1]`; prep.py drops `expected_tool_calls`.
4. `reference_qwen3_jinja_tool_call_gold_standard` — Qwen3-8B + `--jinja` = textbook OpenAI tool_calls; use as labeler.
5. `reference_penumbra_dispatch_routing` — `use_worktree: false` + explicit `cd` for llamactl dispatches; worktree defaults to penumbra repo otherwise.

## First moves for next session

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__long_lived_get home-mgmt` → confirm `working_memory.updated_at` is fresh (within ~15 min of now)
4. Pick a thread with the user. **M.4 is the highest-leverage next move** — actually measure whether the corpus hardening moved macro-F1.

## Non-obvious bites this session (worth remembering)

- **Dispatch stall trap**: codex-acp-fast (handoff `c745845f-1672-4b7e-98a9-6419c18391b9`) edited all files correctly but sat in `dispatched` for 22m+ never committing. Diagnostic: `mcp__penumbra__chain_status` returned `reliability.status: non_terminal_stale, trustworthy: false, recommended_action: cancel`. Fix: cancel + verify on-disk diff + hand-commit. **Prompt mitigation**: explicit "HARD STOP: commit before reporting" in the contract worked for subsequent dispatches.
- **Bash tool cwd persistence**: the Bash tool persists cwd across calls (despite per-call fresh shells). Stale `cd packages/train/corpora/tool-call-grammar` from an earlier call broke later `packages/...` paths. Use absolute paths or `cd /Volumes/.../llamactl && ...` to be safe.
- **Adversarial review big-diff warning**: workflow logged `git.diff: stdout maxBuffer length exceeded` on the 29k-line diff. 3 of 8 personas (devils_advocate, performance, simplicity initially) reported "diff is empty" before recovering via commit log or file reads. simplicity, architect, security, data_correctness saw enough. For future big-diff reviews, narrow scope via explicit file globs.
- **MCP timeout vs workflow async**: `mcp__penumbra__workflow_run` with `timeout_ms: 900000` returned `operation timed out` after 15 min, but the workflow continued on the daemon. Poll for `synthesis.md` to know when it's actually done. Don't assume MCP timeout = workflow failure.
