# Maestro continuation — 2026-05-13 pm-late (llamactl cleanup pass results)

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. The previous session executed the cleanup pass described in `maestro-continuation-2026-05-13-pm.md`. Most of that note's inventory is now done — the goal "green `bun run typecheck && bun test` exits clean across the multi-workload surface" is hit. This note records what shipped, what's live, what's queued, and what NOT to redo.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; never query the live sqlite DB directly except for forensics. Keep commits, PR descriptions, and code-facing text neutral — no AI/tool authorship attribution. Delegate substantive code via `chain_start` (codex-acp-fast remains the workhorse — 4/4 successful dispatches this session); hand-implement only when the work won't boot.

## What this session shipped (11 commits, all on `origin/main`)

All commits in `f97e04e..df620f0`. Listed newest-first to match `git log`:

| # | SHA | Subject | How |
|---|-----|---------|-----|
| 11 | `df620f0` | test: pin describe-node render + MCP llamactl.node.budget projection | dispatched (codex-acp-fast); hand-fixed DELETE_USAGE indent + ModelRun fixture metadata fields |
| 10 | `5281f0e` | chore(gitignore): exclude *.tsbuildinfo | hand |
| 9 | `af55c49` | fix(app): pin cross-node-fan-out reason narrow + include transitive electron files in tsconfig.web | hand |
| 8 | `1286c9d` | templates(workloads): surface spec.enabled and resources.expectedMemoryGiB | hand (5 yaml files; ran a schema-parse loop to verify) |
| 7 | `34c5564` | feat(app): workload picker in Beacon status bar + multi-workload mutation fixes | dispatched (codex-acp-fast) — followed by drive-by fixes once the real `tsc -p tsconfig.web.json` exposed pre-existing errors the no-op script hid |
| 6 | `7c9c97d` | feat(logs): workload-scope serverLogs tail across core, remote, CLI, and app | dispatched (codex-acp-fast); hand-fixed missed CLI call site (server.ts `runLogs` needed --name + resolveWorkloadName + threading through tailServerLog + serverLogs.subscribe) |
| 5 | `0977448` | fix(core,cli): advertised host wins over bind override; workload resolver falls back to known dirs | dispatched (codex-acp-fast) |
| 4 | `de4e116` | docs(notes): session continuations + summaries 2026-05-11 → 2026-05-13 | hand |
| 3 | `14a54cb` | feat(workloads/templates): tune gemma 4 26B-A4B MTP + add granite 4.1 8B long-lived | hand (split out of an accidental `git commit -am` sweep — soft-reset and re-committed cleanly) |
| 2 | `20f3432` | test(cli): disable mDNS advertisement in e2e agent fixtures | hand |
| 1 | `03c4701` | fix(cli): narrow tRPC apply/remove unions + widen eval failure flatMaps + add pipelines to composite fixtures | dispatched (codex-acp-fast) |

### Why each, in order applied

1. **`03c4701`** — Section A from the inbound note. The three CLI tsc errors are well-specified and well-isolated; dispatched as one batch to codex-acp-fast. Clean.
2. **`20f3432`** — I started Section B (the supposed EADDRINUSE flake) and discovered:
   - `packages/remote` test suite is currently *clean* (1414/0). The flake reported in the inbound note was environmental and not reproducing.
   - The "3 fail" in `packages/cli` was three different bugs, *not* port collisions. The mDNS log noise from `bonjour-service v1.3.0` was misleading: that library `console.log`s an Error when its probe collides with the live daemon's mDNS record, and Bun's test reporter classifies `console.log(new Error(...))` as a failure even though our handler absorbs the event. Fix is `advertiseMdns: false` in four e2e agent fixtures.
   - The deeper 3-fail root cause (e2e regressions) was real and unrelated; I split it to a separate task and tackled it in `0977448`.
3. **`14a54cb`** — Mixed template work + new granite long-lived template that was uncommitted. The user (via AskUserQuestion) explicitly said commit both. First attempt accidentally included via `git commit -am`; soft-reset and split into clean commits.
4. **`de4e116`** — User explicitly said commit the 6 session-handoff notes that had been left untracked.
5. **`0977448`** — The 3 e2e fails I'd punted earlier. Two root causes:
   - **advertisedEndpoint priority inverted.** `serverStatus` passes the sidecar's bind host (`0.0.0.0`) as `override.host` so `/health` probes can reach the real bind. `advertisedEndpoint()` was treating that override as the *advertised* host — directly contradicting its own docstring. Flip so `LLAMA_CPP_ADVERTISED_HOST` wins over `override.host`. Override still wins for port.
   - **resolveWorkloadName has no post-stop fallback.** `listLocalWorkloads` requires a `llama-server.pid` file; after `server stop` the pidfile is removed, so a single-workload node hits "no live workloads" on the very next `server status`. Added a new sibling `listWorkloadDirs()` in `workloadRuntime.ts` (no pidfile requirement) and a fallback branch in `resolveWorkloadName`. Did NOT loosen `listLocalWorkloads` itself — its pidfile-required semantics are relied on by `/v1/models` discovery + `nodeModels` router.
6. **`7c9c97d`** — `serverLogs` was still reading `$LLAMA_CPP_LOGS/server.log` (legacy singleton path); per-workload log files have lived at `workloadRuntimeDir/<name>/llama-server.log` since the multi-workload migration. Threaded `workload` end-to-end through serverLogs core helper, remote procedure, CLI `server logs --name <workload>` (added the missed call site by hand), and the app's logs panel (subscription input + UI copy). Tests in core + dispatcher updated.
7. **`34c5564`** — Workload picker. `useActiveWorkload` previously returned `null` whenever `live.length !== 1` (NOT "first alphabetically" as the inbound note guessed — re-read the hook to confirm). Refactored: zustand+persist store, pure helpers for unit-testability without React/@/alias under bun:test, picker chip in status bar (0 live → hidden; 1 live → static `▸ <name>` label; 2+ → native select). Backwards-compat preserved for the four panels that destructure `{ workload, loading }`. Drive-by fixes once `tsc -p tsconfig.web.json` was run directly (the npm `typecheck` script is a no-op — memory `project_typecheck_script_broken.md`): `keepAliveStopMutation.mutate` was missing `workload`, and `serverStart`'s subscription was passing `enabled` to a v11 `Omit<..., 'enabled'>` overload.
8. **`1286c9d`** — All 5 workload templates now declare `spec.enabled: true` + `resources.expectedMemoryGiB` explicitly. Estimates calibrated against current model sizes + context settings. Hand-coded; verified each template still parses by piping each through `parseWorkload` from the remote schema.
9. **`af55c49`** — Three pre-existing errors surfaced once I started running the real `tsc -p tsconfig.web.json`. `cross-node-fan-out.ts:100` needed a `NodeFailure['reason']` annotation on the local. `tsconfig.web.json` was missing `dispatcher.ts` + `node-pinned-fetch.ts` from its `include[]` (transitively imported by `router.ts` which is already included). After: all three app subconfigs clean.
10. **`5281f0e`** — Bun emits `*.tsbuildinfo` on `tsc --build`; added to `.gitignore` so future tsc invocations don't pollute `git status`.
11. **`df620f0`** — Section D test gaps. Extracted `renderNodeBudget(view): string` from `runDescribeNode` so the render is testable without a live tRPC client. Three render tests (empty / multi-row alignment / budget-exceeded warning). MCP smoke test seeds a NodeRun (budget 24 GiB) + ModelRun (18 GiB) in the sandbox workloads dir, then round-trips through the MCP client to assert the `llamactl.node.budget` tool projection.

### Dispatches that didn't go cleanly

- **`b0dc3f77` (serverLogs)** — codex's first pass missed `packages/cli/src/commands/server.ts:352+370`. Caught by post-edit cross-package `tsc`. Hand-fixed.
- **`71cb74b5` (picker)** — codex reported its dispatcher.test.ts run as `0 pass / 5 fail` due to EADDRINUSE in *its* environment. I re-ran in mine: 5/5 clean. Environmental, not code. **Lesson:** when an agent reports a test failure, re-run the test yourself before debugging — EADDRINUSE on port 0 occasionally shows up under load.
- **`fa5dab0c` (test gaps)** — codex added `,` instead of newline somewhere in `DELETE_USAGE` (cosmetic indent regression) and used the structural `ModelRun` shape without all the schema-required fields (works at runtime via zod defaults, fails tsc strict). Hand-fixed.

### What I evaluated and explicitly skipped

- **EADDRINUSE root-cause in `serve.test.ts`** — Section B of the inbound note. Not reproducing in this session (`packages/remote` 1414/0). The reporter from Task 8 may have hit a transient. Skip until it returns.
- **KV-cache-aware memory estimator** — The continuation note flagged it. After templates 1286c9d declare `expectedMemoryGiB` explicitly, the estimator is now a low-traffic fallback. Marginal value vs effort. Defer.
- **Label-selector for `llamactl.io/evict` annotation** — Operator polish. Defer.
- **Shell smoke `test/multi-workload.zsh`** — Needs port juggling against the live Gemma+Granite workloads. Skip until those workloads are stopped or the script learns to accept port overrides.
- **agent_recommend hygiene (Section G)** — Penumbra-side concern. Defer.

## Live state at end of session

| Service | PID at session start | PID now | Endpoint | Health |
|---|---|---|---|---|
| `com.llamactl.node-agent` (launchd) | 19052 | unchanged | https://127.0.0.1:7843 | ok |
| `com.llamactl.controller` (launchd) | 60570 | unchanged | n/a | ok |
| llama-server: gemma4-26b-a4b-mtp | 94772 | unchanged | 127.0.0.1:8181 | `{"status":"ok"}` at session start |
| llama-server: granite41-8b-long-lived | 20376 | unchanged | 127.0.0.1:8083 | `{"status":"ok"}` at session start |

**No code reloaded into the running daemon this session.** Every commit touches code that loads at boot (router.ts, serve.ts, workloadRuntime.ts, core/server.ts) — the runtime is still on commit `e6cbef9`. Next session: a daemon restart will be needed before any of the new code is exercised live (workload-scoped serverLogs, advertisedEndpoint fix, resolveWorkloadName dir fallback).

`mcp__penumbra__handoff_list_pending` is clean.

## Open follow-ups (concrete next-session candidates)

### Section A — load-bearing

- **Daemon restart** to pick up this session's code. After `launchctl kickstart -k gui/$(id -u)/com.llamactl.node-agent` (or similar), re-verify Gemma + Granite stay up via per-workload pidfile adoption (the migration has already run; `.migrated-v2` is set, so this is just a normal restart path).

### Section B — nice-to-haves (in priority order)

1. **Label-selector for `llamactl.io/evict`** in `packages/remote/src/workload/apply.ts` eviction step. Today the annotation is a comma-separated name list; support `family=gemma4`-style selectors so "evict everything in this family" is one knob. ~20 lines.
2. **KV-cache-aware memory estimator** in `packages/remote/src/workload/admission.ts:50-63`. Today: `GGUF size × 1.1`. Inbound note's rough formula: `GGUF + (ctx_size × KV_bytes_per_token × num_layers)` where KV bytes depend on `-ctk`/`-ctv` from extraArgs. Without a GGUF metadata parser you'll need size-class heuristics for num_layers. Marginal value now that all templates declare `expectedMemoryGiB` — only worth doing if you're already in admission.ts for another reason.
3. **Shell smoke** `test/multi-workload.zsh`: either teach the script to take port-override env vars, or stop Gemma+Granite first. Either way, run once to confirm correctness.
4. **EADDRINUSE root-cause** if it returns. Look at `packages/remote/src/server/serve.ts:413` (port 0 bind path) and whether `reusePort: true` is hurting under Bun's listener semantics.
5. **agent_recommend hygiene** (penumbra repo, separate concern). The 0% success_rate problem the inbound note flagged: investigate whether `dispatch_land` / `lane_close` are updating `agent_performance.outcome`.

### Section C — test gaps still open

- Integration test for the boot migration in a prod-shape env. Unit-level migrations are covered; the e2e harness was conflated with the EADDRINUSE story.

## Memories worth loading first (in this order)

1. `project_multi_workload_shipped_2026-05-13.md` — what the multi-workload feature looks like end-to-end. Still the foundation.
2. `project_typecheck_script_broken.md` — **load this every session.** `packages/app`'s `bun run typecheck` exits 0 regardless of errors because `tsconfig.json` is a project-references shell. Use `bunx tsc -p tsconfig.web.json` directly. This session uncovered 3 pre-existing errors hidden by this footgun; future sessions will too if anyone trusts the script.
3. `reference_penumbra_dispatch_routing.md` — `use_worktree: false` + explicit `cd` for `chain_start` into llamactl. Used 4/4 times this session.
4. `feedback_cross_repo_validation.md` — applies whenever the change touches gateway/RAG paths.
5. `project_endgame_vision.md` — strategic frame for prioritizing nice-to-haves.

(Skip the maestro pilot 2026-05-11 memories unless the next session is about model selection — they're about Gemma 4 26B-A4B-MTP bench results, not orthogonal to cleanup work.)

## First moves

```bash
cd /Volumes/WorkSSD/repos/personal/llamactl
git status --short                                # should be clean
git log --oneline origin/main -5                  # confirm 11 new commits landed
launchctl list | grep llamactl                    # daemon + controller running
curl -fsS http://127.0.0.1:8181/health            # gemma alive
curl -fsS http://127.0.0.1:8083/health            # granite alive
mcp__penumbra__handoff_list_pending               # confirm clean
```

Then decide direction with the user:
- If the user wants the new code exercised live → restart the daemon.
- If the user wants more cleanup → start with **Label-selector evict** (Section B.1 above), small and self-contained.
- If the user wants forward feature work → ask. The cleanup pass is done.
