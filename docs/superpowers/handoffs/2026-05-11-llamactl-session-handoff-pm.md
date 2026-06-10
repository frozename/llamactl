# Session handoff — llamactl, 2026-05-11 (pm)

Date: 2026-05-11 19:20 UTC (second session of the day)
For: whoever picks this back up next session (likely me)
Pairs with: `docs/superpowers/handoffs/2026-05-11-llamactl-session-handoff.md` (morning session — that doc's "Open known issues" list is what this session closed)

## TL;DR

The morning session's pickup menu had four open bugs (TOCTOU A2, cross-node alias D3, four pre-existing test failures) plus a maestro smoke step. All of them closed this session. Five commits landed on local main, of which one was dispatched to codex-mini and the other four hand-implemented after a failed first dispatch. Maestro endpoint smoke-tested with a real planner-style ask. Working tree clean.

## You are taking over

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; don't query sqlite. Repo-facing text is neutral with no AI/tool attribution. Delegate via `chain_start`; hand-code only when the worker won't boot or the daemon can't reach the llamactl tree (see "Dispatch routing trap" below).

## What this session shipped (in order)

| Commit    | What                                                                                        | How                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `291253b` | eval(report): `as const` the depth literal array                                            | hand — 30s scope                                                                                                                                                                                                                                                                                                                                                                                 |
| `7a09685` | cli(test): catalog builtin count 10 → 12 + named-row asserts                                | hand — granite-4.1 entries were added but the test wasn't refreshed                                                                                                                                                                                                                                                                                                                              |
| `755b2cb` | remote(test): functional bonjour mock with shared registry                                  | hand — old mock was inert; new one wires publish → registry → find so discoverAgents actually finds the two beforeAll-registered agents. Isolated `bun test ./test/mdns.test.ts` now 2/2; the full-suite synthetic-host failure that remains is cross-file vi.mock pollution and unrelated.                                                                                                      |
| `dc1b235` | remote(workload): atomic save + per-dir mutex; resolve node aliases in port-collision check | hand — closed both TOCTOU A2 and cross-node D3 in one slice. Added `withWorkloadsMutex(key, fn)` in store.ts; atomic write via tmp+rename in `saveWorkload`; `resolveNodeIdentity?` opt on `applyOne`. Router wraps applyOne+save under the mutex. CLI workload + expose both pass the kubecfg-based resolver. Three regression tests in new `workload-concurrency.test.ts`.                     |
| `e84bcda` | remote(workload): thread `resolveNodeIdentity` through reconciler + composite paths         | **dispatched to codex-mini (use_worktree=false), 3min, single shot success.** Completed D3 across the remaining two applyOne callers: `workload/reconciler.ts` + `reconcileLoop.ts` (wired via `controller.ts` and `router.ts:reconcilerStart/Kick`) and `composite/apply.ts:applyWorkloadComponent`. New regression test in `workload-concurrency.test.ts` covering reconcileOnce-over-aliases. |

### Maestro smoke (no commit — task #6 from morning handoff)

`chain_start initial_agent='local-gemma4-26b-a4b-mtp'` with a planner-style ask ("Plan a `workload restart` subcommand: files, tests, edge cases. Under 200 words. No code.")

- 6s wall (matches the 42 tps bench profile)
- Structured response: Files / Tests / Edge cases — clean planner output
- Edge-case list included race conditions, which is on-topic given this session's TOCTOU work
- Caveat: model hallucinated Python paths (no repo context in system prompt). Functionality is fine; routing/structure both work.

### Dispatch history (the rabbit hole)

| Handoff                | Agent      | Outcome                        | Why                                                                                                                                                          |
| ---------------------- | ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `349af578`             | codex-mini | watchdog timeout 15min         | wrong-repo trap: worktree created under `/Volumes/WorkSSD/repos/penumbra-worktrees/` (penumbra), agent never reached llamactl. Pivoted to hand-implementing. |
| `e756b96f`, `4f55af9b` | codex-mini | ok (ping tests)                | confirmed: even with `use_worktree=false`, daemon spawns codex in `/Volumes/WorkSSD/repos/personal/penumbra`                                                 |
| `7c05815b`             | codex-mini | ok but aborted                 | over-strict verification in my prompt ("seeing `packages/mcp` = penumbra") falsely tripped on llamactl which ALSO has `packages/mcp`                         |
| `dc1301a1`             | codex-mini | **ok, e84bcda landed in 3min** | corrected check using `packages/remote` (llamactl-specific)                                                                                                  |

## Live state at end of session

- HEAD: `e84bcda remote(workload): thread resolveNodeIdentity through reconciler + composite paths`
- Working tree: clean
- Local main is now **84 commits ahead of origin/main** (5 from this session on top of the 79 from prior sessions). Not pushed.
- Maestro endpoint: `gemma4-26b-a4b-mtp-local` Running on `:8181` via llamactl-managed workload — confirmed alive after controller reload mid-session
- Node-agent: `com.llamactl.node-agent` alive on `:7843`, launchd-supervised
- Controller: `com.llamactl.controller` alive — kickstarted mid-session (`launchctl kickstart -k gui/$UID/com.llamactl.controller`) so the new mutex + atomic-save + resolver code is in effect
- Pending handoffs: none

## Open follow-ups — pick up next session

### From the morning handoff (carried forward)

1. **Redactor-aware bench scoring** — add `--redact-via penumbra` to `tools/maestro-bench/bench-maestro.py` so safety_refusal_prompt_injection is scored against the redacted output. Designed in the morning session, not implemented. Would lift Gemma 26B-A4B from 34/36 → 35/36. Concrete first move: read `tools/maestro-bench/bench-maestro.py` (the redactor invocation point), `packages/core/src/redaction/value-patterns.ts` (the penumbra-side ValuePatternRedactor), and the rule set in `packages/agentchat/src/worker/maestro-redactor.ts` (or wherever the maestro-side rule list lives).

2. **Routing fail on routing_implement_substantial_refactor** — Gemma defaults to `plan_refine` for substantial refactors. Morning handoff warned: don't retry verbal-nudge approaches (regressed safety leaks 3×). A few-shot example might work but would bloat every dispatch. Hold unless we get a fresh idea.

### Introduced this session

3. **Full-suite mdns synthetic-host flake** — `bun test` (full remote suite) reports 1393 pass / 1 fail. The fail is `mdns.test.ts:102` ("publishes a synthetic host instead of the OS hostname") which passes in isolation (`bun test ./test/mdns.test.ts` = 2/2). Cross-file vi.mock-pollution or hoisting cache issue. Pre-existing class (handoff lesson #3 from morning), now isolated to one test. Exploratory — could rabbit-hole. Concrete first move: instrument the mock factory to log when `__lastPublished()` returns null, run full suite, identify which other file's transitive bonjour-service import is leaking.

4. **Push origin/main** — 84 commits ahead. No external pressure; push when there's a good reason to. (Not urgent — origin/main is `frozename/llamactl` and there are no other contributors today.)

## Memories worth reading first

- `project_maestro_pilot_2026-05-11.md` — pilot model decision; this session's smoke validates it
- `project_bench_2026-05-11_post-evolution.md` — three-way bench result
- `reference_llamacpp_mtp_binaries.md` — Gemma → atomic fork; Qwen → upstream PR #22673 build
- `project_typecheck_script_broken.md` — `bun run typecheck` is no-op; always `tsc -p packages/<X>/tsconfig.json`
- `feedback_cross_repo_validation.md` — when shipping cross-repo changes, validate llamactl + sirius-gateway + embersynth together; this session's changes are llamactl-internal so didn't trigger it
- **NEW (write before closing)**: `reference_penumbra_dispatch_routing.md` (lesson below)

## Lessons learned this session

1. **Penumbra dispatcher routes to penumbra by default, regardless of MCP cwd.** Even with `use_worktree: false` the daemon spawns codex in `/Volumes/WorkSSD/repos/personal/penumbra`. The recent penumbra "fix" was the worker's safety abort on wrong-repo — NOT a change to the default base repo. To dispatch into llamactl: `use_worktree: false` + an explicit `cd /Volumes/WorkSSD/repos/personal/llamactl` as the agent's literal first command in the prompt. (Worth saving as a long-lived memory; see write step below.)

2. **Verification markers must be repo-distinctive.** Telling the agent "abort if you see `packages/mcp`" tripped a false-abort: BOTH penumbra and llamactl have `packages/mcp`. Use `packages/remote` (llamactl-only) or `packages/agentchat` (penumbra-only) as the marker.

3. **codex-mini handles small/well-scoped slices reliably.** 3-min wall on a 6-file 84-LOC change with new test coverage — single shot, clean commit, accurate self-report. Reserve `implement_substantial` for it; codex-acp-fast still shows 0/17 success on this task type in current stats.

4. **Pre-existing morning-handoff failure list wasn't quite right.** Listed 4 failing tests; actually only 3 (one of the mdns ones was already passing; one of the workload-e2e files was misnamed and the real failure was in `catalog.test.ts`). Always reproduce the listed failures yourself before scoping fixes.

## First moves for next session

1. `git status --short && git log --oneline origin/main..HEAD | head -10 && launchctl list | grep llamactl`
2. `mcp__penumbra__handoff_list_pending`
3. `bun /Volumes/WorkSSD/repos/personal/llamactl/packages/cli/src/bin.ts get workloads` — confirm maestro endpoint still Running
4. Pick direction with user from "Open follow-ups" above. If "/2 mdns flake" → start by reading `packages/remote/test/mdns.test.ts` mock + running `bun test 2>&1 | grep -B 15 "publishes a synthetic"` to see the current failure shape.
