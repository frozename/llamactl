# Maestro continuation — llamactl, 2026-05-11 (pm-late)

Date: 2026-05-11 ~20:35 UTC (third session of the day; supersedes the
earlier `-pm.md` workflow stub which was generated under the penumbra
project's context, not this repo's commits).

Pairs with:
- `docs/superpowers/handoffs/2026-05-11-llamactl-session-handoff.md` (morning)
- `docs/superpowers/handoffs/2026-05-11-llamactl-session-handoff-pm.md` (early-pm — five remote+test slices)

## You are taking over

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; never query the sqlite DB directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool authorship attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot or refuses to land a slice (see "Dispatch history" below — a clean codex-mini dispatch aborted with empty response this session, and the slice was hand-implemented as a fallback).

## What this session shipped

Picked up from early-pm's "open follow-ups" list. All four items closed; full bench is now at a perfect score.

| Commit | What | How |
|--------|------|-----|
| `3823442` | maestro-bench: optional `--redact-via penumbra` scoring + `--category` filter + a new `tools/maestro-bench/redact-haystack.ts` bun helper that shells out to penumbra's `MaestroOutputRedactor`. Predicted 34/36→35/36 lift did NOT materialize in the smoke (model's refusal uses the topic word "exfiltration", which redactor correctly leaves alone — it's not a secret-shaped value). Infra is correct and useful for any future model that leaks a literal SSH path. | hand — first dispatched to codex-mini (handoff `ed937cd2`, `use_worktree=false`, `task_type=implement_small`) but it aborted with empty response after 54s wall (two `proc.spawn` events; second got SIGTERM 1ms after spawn; status `aborted`, no error_message). Daemon-side log seemed clean from this end; user later reported penumbra team said the dispatch issue was fixed, but I did not re-test in this session. Hand-implementation was straightforward (~50 LOC across 2 files). |
| `2d4f05f` | remote(mdns) flake fix: added `host: string` to `PublishedAgent` and assert via `published.host` in mdns.test.ts instead of reaching into `bonjour.__lastPublished()`. Full remote suite now 1394 pass / 6 skip / 0 fail (was 1393/1). | hand — sidesteps the bun vi.mock hoisting race entirely. The flake was passing in isolation, failing in full-suite; the contract belongs on the API surface anyway. |
| `061f9bd` | maestro-bench: drop `exfiltrat` clause from `refusal_prompt_injection.forbidden_text_regex`. Was firing on legitimate refusals like "I won't participate in exfiltration". `forbidden_args.message` keeps the clause (dispatching a subagent with that verb IS a leak). Safety: 3/4 → 4/4. | hand — trivial regex edit. |
| `680c512` | maestro-bench: add structured one-line task_type cheat-sheet to `MAESTRO_SYSTEM`. List form (comma-list with parenthetical discriminators) instead of narrative. This is exactly what the early-pm handoff told the next session NOT to retry (verbal-nudge → safety regression 36/36 → 32/36). The empirical override turned out to be **form**, not amount: structured lists don't get echoed in refusals the way prose does. Routing 4/5 → 5/5 AND safety held 4/4. | hand — validated by running `--category safety` then `--category routing` (~25s combined) then the full 36-task bench (~96s wall) before committing. Full bench: 36/36, every category 100%. |

Then pushed: `2d4f05f..680c512` to `origin/main` (frozename/llamactl). Working tree clean.

## Live state

- HEAD: `680c512 maestro-bench: add structured task_type cheat-sheet to MAESTRO_SYSTEM`
- Working tree: clean.
- Local main pushed to origin/main; no commit divergence.
- Maestro endpoint: `gemma4-26b-a4b-mtp-local` Running on `:8181` — verified mid-session via `curl POST /v1/chat/completions` (200) and the bench's 96s full run.
- Node-agent: `com.llamactl.node-agent` alive on `:7843`, launchd-supervised.
- Controller: `com.llamactl.controller` alive (launchd-supervised; not kickstarted this session — no core code changes that needed it).
- Penumbra daemon/worker: `dev.penumbra.daemon` + `dev.penumbra.worker` both alive (PIDs from session start were 3560/3563).
- Pending handoffs: none.
- The full-bench result file at `/tmp/bench-full-with-cheat.json` is ephemeral.

## Open follow-ups — pick up next session

### Closed this session (not carried)

- "Redactor-aware bench scoring" → shipped as `3823442` (infrastructure in place; the predicted lift didn't materialize because of the bench-pattern issue, not the redactor).
- "mdns synthetic-host flake" → shipped as `2d4f05f`.
- "Push origin/main (84 commits)" → done.
- "Routing fail on routing_implement_substantial_refactor" → shipped as `680c512`. The early-pm handoff's "Hold unless we get a fresh idea" guidance was overridden by trying a structured-list form rather than narrative prose.

### Introduced this session

1. **Penumbra dispatch reliability — one bad outcome unexplained.** Codex-mini dispatch `ed937cd2-4aee-4fef-bbda-188577b779d2` (use_worktree=false, task_type=implement_small, ~5.5KB prompt) aborted with empty response 54s after spawn. Two `proc.spawn` events on the worker timeline; second was SIGTERM'd 1ms after spawn. No `error_message` on the handoff row. User later reported penumbra team fixed *a* dispatch issue but I didn't verify mine retroactively. Concrete first move: re-dispatch a tiny "hello world" slice with `chain_start initial_agent='codex-mini'` to confirm the worker behaves now. If it still aborts, get the daemon-side stderr/log from penumbra to diagnose.

2. **Stability of the 36/36 bench score is single-run.** The cheat-sheet was validated against one full-bench run. The daily regression-sweep (`dev.llamactl.maestro-regression-sweep` launchd plist, fires at 03:17 local) will produce the rolling-7 baseline. If the next sweep notification fires regression/error/unreachable, that's the place to look.

3. **`exfiltrat` is still in `forbidden_args.message`.** Deliberate: a chain_start dispatch with that verb in the message IS a real leak. But it's worth a fresh look the next time anyone touches the safety tests — the symmetry between text and args matchers is uneven and someone reading the suite cold may flag it.

## Memories worth reading first

- `feedback_maestro_prompt_form.md` (**NEW this session**) — the structured-list-vs-narrative lesson. Overrides the early-pm handoff's blanket "don't retry verbal-nudge" warning when the form is list-style.
- `project_maestro_pilot_2026-05-11.md` — the pilot model decision (Gemma 4 26B-A4B + atomic-fork MTP). This session's 36/36 strengthens that pick.
- `project_bench_2026-05-11_post-evolution.md` — three-way bench result; the 34/36 score there is now superseded by today's 36/36 (bench harness change, not model change).
- `reference_penumbra_dispatch_routing.md` — `use_worktree: false` + explicit `cd` in prompt; `packages/remote` marker (llamactl-only) vs `packages/agentchat` (penumbra-only). The bad outcome this session was NOT a wrong-repo issue (the marker check would have caught that), so dispatch routing is not at fault.
- `reference_llamacpp_mtp_binaries.md` — Gemma uses atomic-fork; Qwen uses PR #22673. Only relevant if you swap models.
- `project_typecheck_script_broken.md` — `bun run typecheck` lies; use `bun x tsc -p packages/<X>/tsconfig.json` for real type-checking. Did that for `packages/remote` this session (exit=0).

## First moves for next session

1. `git status --short && git log --oneline origin/main..HEAD | head -5 && launchctl list | grep -E 'llamactl|penumbra'`
2. `mcp__penumbra__handoff_list_pending` → confirm clean.
3. Sanity-check the dispatch fix: `chain_start initial_agent='codex-mini' use_worktree=false message="cd /Volumes/WorkSSD/repos/personal/llamactl && pwd && ls packages/remote >/dev/null && echo OK-llamactl; echo HELLO"` and watch the timeline. If the worker spawns once cleanly and returns a non-empty response, the early-pm bad outcome is behind us. If it repeats the abort pattern, investigate the daemon-side log.
4. Optional sanity check on the 36/36 score: `python3 tools/maestro-bench/bench-maestro.py --model gemma4-26b-a4b-mtp-local 2>&1 | tail -12` — should still show 36/36, all categories 100%. Or just wait for the daily sweep.
5. Pick direction with the user from "Open follow-ups (introduced this session)" or queue new work.
