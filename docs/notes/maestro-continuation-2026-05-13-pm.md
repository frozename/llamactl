# Maestro continuation — 2026-05-13 pm (llamactl cleanup pass)

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. The previous session shipped multi-workload local nodes end-to-end and merged it to `main`. Your job this session is **cleanup**: every known follow-up, gap, refactor, and pre-existing wart the project carries. The goal is a `bun run typecheck && bun test` that exits clean — no asterisks, no "pre-existing flakes." Repo state, conventions, and follow-up inventory are below.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; never query the live sqlite DB directly except for forensics. Keep commits, PR descriptions, and code-facing text neutral — no AI/tool authorship attribution. Delegate substantive code via `chain_start` (prefer `codex-acp-fast` for paste-ready fixes ~30–90s; `claude-acp-sonnet` is currently flaky with early-stop bugs — see "Dispatch tips" below). Hand-implement only when the work won't boot.

## What the previous session shipped

The multi-workload local nodes feature, end-to-end: spec + plan + 22 commits, all on `main`. Range `876ff1f..e6cbef9`. The footgun "applying Granite stopped Gemma" is dead; multiple llama-server processes coexist per node, gated by per-workload runtime dirs + soft RAM admission. Live-verified: Gemma 4 26B-A4B MTP on `:8181` and Granite 4.1 8B on `:8083` ran concurrently, `disable`/`enable` round-trip worked, daemon restart migrated the legacy singleton state under the per-workload dir without dropping Gemma.

Architecture details and field reference are in `~/.claude/projects/-Volumes-WorkSSD-repos-personal-llamactl/memory/project_multi_workload_shipped_2026-05-13.md` (also indexed in MEMORY.md). Spec and plan: `docs/superpowers/specs/2026-05-13-multi-local-workloads-design.md` + `docs/superpowers/plans/2026-05-13-multi-local-workloads.md`. Don't re-derive the design from those — read the memory first.

## Live system state at end of session

| Service | PID | Endpoint | Health |
|---|---|---|---|
| `com.llamactl.node-agent` (launchd) | 19052 | https://127.0.0.1:7843 | ok |
| `com.llamactl.controller` (launchd) | 60570 | n/a | ok |
| llama-server: gemma4-26b-a4b-mtp | 94772 | 127.0.0.1:8181 | `{"status":"ok"}` |
| llama-server: granite41-8b-long-lived | 20376 | 127.0.0.1:8083 | `{"status":"ok"}` |

Runtime dir is `/Volumes/WorkSSD/ai-models/local-ai/` (with `~/DevStorage` symlink). Per-workload state lives under `workloads/gemma4-26b-a4b-mtp-local/` and `workloads/granite41-8b-long-lived-local/`. The `.migrated-v2` flag is set; migration won't re-run. Workload manifests on disk at `/Volumes/WorkSSD/workloads/{gemma4-26b-a4b-mtp-local,granite41-8b-long-lived-local}.yaml`.

No daemon restart is needed unless you change code that's loaded at boot (server.ts, workloadRuntime.ts, serve.ts, router.ts).

## Cleanup inventory (this session's "to do")

### A. Pre-existing CLI typecheck errors — blockers for `bun run typecheck`

These existed before the multi-workload work and are unrelated to it. They're what's gating a green typecheck across the repo.

- `packages/cli/src/commands/eval.ts:64` — `flatMap` callback returns a `string[]`-flavored union (`{name; reason: "invalid JSON"}[] | ... | "args mismatch"[]`) but TS wants `T | readonly T[]`. The fix is likely to widen the return type so the four reason-branches share a common shape — e.g. `Array<{name: string; reason: string}>` or a tagged union outside the array — then map back inside. ~10-line fix.
- `packages/cli/src/commands/rag-pipeline.ts:190` — `Property 'created' does not exist on type '{ok:false; conflict} | {ok:true; created}'`. Missing discriminant narrowing before the access. Add a `if (result.ok)` gate (or `result.ok ? a : b`). Same pattern recurs in the surrounding lines. ~5-line fix.
- `packages/cli/src/commands/rag-pipeline.ts:335` — `Property 'removed' does not exist on type` — same union-narrowing pattern.
- `packages/cli/test/composite.test.ts:178,226,273` — `Property 'pipelines' is missing` on composite fixtures. Composite schema added `pipelines` somewhere on `main` (pre-multi-workload). Add `pipelines: []` to the three fixtures. ~3-line fix.

**Triage first.** A green `bun run --cwd packages/cli tsc --noEmit` is the prerequisite for everything else "clean."

### B. Pre-existing test flakiness — EADDRINUSE / port-0 binding in Bun

Several test suites get unstable in Bun's harness because they bind to ephemeral ports and Bun occasionally collides. The implementer who shipped Task 8 (migration boot wiring) spent time on this and concluded it's environmental, not logic. Worth a targeted dig now:

- `packages/remote/test/serve.test.ts` — agent-server bootstrap tests. Symptom: EADDRINUSE on `port: 0` listen. Fix candidates: (a) move suites to fixed but unique ports computed from `process.pid % range`, (b) catch + retry on EADDRINUSE with backoff in the test helper, (c) check whether `reusePort` flag is doing harm.
- `packages/cli/test/dispatcher.test.ts` — 5 EADDRINUSE failures observed during Task 6.
- Various `packages/remote/test/` suites that spin up live agents — reported as "Bun listener-binding failures across several server-heavy tests."

Root-cause this in one place if possible (likely a test helper that builds an HTTPS server) rather than patching each suite.

### C. Out-of-scope spec items, now in cleanup scope

The multi-workload spec explicitly deferred these. Whether each is worth doing now depends on priorities — pick what's load-bearing:

- **Workload picker UI in Electron app.** The data path is wired (`useActiveWorkload`), but each panel currently auto-selects the single live workload. With Gemma + Granite both running, the app picks the first one alphabetically; the operator has no UI to switch. Add a dropdown in the app shell (or chat panel) that surfaces all live workloads and persists the selection in localStorage. Spec gestured at this; Task 7 was minimum-viable. Files: `packages/app/src/modules/chat/index.tsx`, `packages/app/src/modules/server/index.tsx`, `packages/app/src/hooks/useActiveWorkload.ts`.
- **`serverLogs` tRPC isn't workload-scoped.** `packages/remote/src/router.ts:1582` (approx) — the logs procedure reads a single legacy log path. Should take `{ workload: string }` and tail that workload's `runtime/workloads/<name>/llama-server.log`. Mirror the pattern used for `serverStatus`. Logs panel (`packages/app/src/modules/logs/index.tsx`) needs to thread the workload too — its empty-state copy currently overstates the relationship (Task 7 reviewer note).
- **Label-selector for `llamactl.io/evict` annotation.** Currently the annotation is a comma-separated list of names. Operator-friendly upgrade: support label-selector syntax (e.g. `family=gemma4`) so "evict everything in this family" is one knob. Small change in `packages/remote/src/workload/apply.ts` eviction step.
- **KV-cache-aware memory estimator.** Current `estimateWorkloadMemoryGiB` is GGUF-size × 1.1 — naïve. Real estimate: GGUF + (ctx-size × KV-bytes-per-token × num-layers) where KV bytes depend on `-ctk`/`-ctv` quantization. Read those from `spec.extraArgs`. Useful primarily for the `describe node` warning when operator hasn't declared `expectedMemoryGiB`.
- **Auto-priority eviction.** The "C" option from brainstorming — manifests declare `priority: low|normal|high|critical`; admission auto-evicts lowest to fit. The user explicitly chose option A (advisory) at brainstorming. **Skip unless requested** — over-engineering relative to current pain.
- **Sub-node GPU/CPU isolation (cgroups, taskset, Metal queue carving).** Out of scope. Skip.

### D. Test gaps from this session's work

- No integration test for the boot migration in a production-shape env. Unit-level tests cover `migrateLegacySingletonRuntime` in isolation. `packages/remote/test/serve.test.ts` has a case but it's caught up in the EADDRINUSE flake (Section B).
- No tests for `llamactl describe node <name>` rendering.
- No tests for the MCP `llamactl.node.budget` tool registration / projection.
- The shell smoke `test/multi-workload.zsh` never ran in the previous session (ports conflicted with live Gemma). Run it once with port overrides to confirm correctness: `LLAMACTL_TEST_GGUF_A=granite-4.1-3b-Q4_K_M.gguf zsh test/multi-workload.zsh` — but the script hardcodes 8181/8090 in the YAML; you'll need to either tweak the script to take port env vars or stop Gemma+Granite first.
- `apply.multi.test.ts` has 5 cases (disabled, parallel, evict, budget, force-admit). The per-node mutex test (Fix 4) was added; verify it's actually serializing in practice — check `packages/remote/src/workload/apply.multi.test.ts` for the `serialize through the mutex` case.

### E. Repo housekeeping

Uncommitted state at end of previous session:

```
 M templates/workloads/gemma4-26b-a4b-mtp-local.yaml
?? docs/notes/maestro-continuation-2026-05-11-pm.md
?? docs/notes/maestro-continuation-2026-05-13-am.md
?? docs/notes/maestro-continuation-2026-05-13-pm.md      (this file)
?? docs/notes/session-summary-2026-05-11-pm.md
?? docs/notes/session-summary-2026-05-13-am.md
?? docs/notes/session-summary-2026-05-13-pm.md
?? templates/workloads/granite41-8b-long-lived-local.yaml
```

- `templates/workloads/gemma4-26b-a4b-mtp-local.yaml` is the modified Gemma template (the user bumped `--ctx-size` to 65536 earlier — commit f97e04e is part of recent history but this further modification is uncommitted). Decide: commit, revert, or leave.
- `templates/workloads/granite41-8b-long-lived-local.yaml` is new and active in the live system. **Commit it** so the canonical home-mgmt config is in git.
- `docs/notes/*` files are session-handoff drafts. Decide whether to keep them tracked or `.gitignore` the dir.

### F. Docs

- `README.md` — scan for any single-workload assumptions. The schema docstring was refreshed (Task 17 / commit cb80e45) but README likely wasn't.
- `AGENTS.md` — the `packages/remote/` summary may still imply singleton workload. Check the "Layout" section.
- `templates/workloads/*.yaml` — none of the templates declare `spec.enabled` or `spec.resources.expectedMemoryGiB`. Add `enabled: true` (explicit) and a sane `expectedMemoryGiB` estimate to each template so operators see the fields in real use.

### G. Memory / agent_recommend hygiene

`mcp__penumbra__agent_recommend` showed 0% success_rate across most agents for `implement_substantial`, `review_adversarial`, etc. (with samples in the dozens). Either the post-gate signal isn't being recorded properly, or the gate is failing every dispatch silently. Investigate in penumbra: is `agent_performance.outcome` being updated by `dispatch_land`/`lane_close`? Look at `packages/penumbra/...` (this is cross-repo — penumbra lives at `~/DevStorage/repos/personal/penumbra`).

## Dispatch tips for this session

- **claude-acp-sonnet is flaky right now.** Two dispatches in the previous session early-terminated within 6–11 seconds and returned `Model set to default. Ready when you are`. The maestro layer (agent id `473ff22b`) is auto-closing claude-acp-sonnet sessions before the worker fires. Avoid claude-acp-sonnet for now; if you need its longer context window, retry once and fall back to `codex-acp-fast` or `codex-acp-deep`.
- `codex-acp-fast` is reliable (8/8 in the prior session). Best for small, well-specified fixes.
- For multi-package refactors, `codex-acp-fast` can handle them if the prompt is concrete (file paths, exact code blocks). It handled the 5-fix batch (commits 0829d28..e6cbef9) in 3m12s.
- **Use `use_worktree: false`** when dispatching for llamactl work. The penumbra worktree manager doesn't route by `project_id` and tries to create the worktree against the penumbra repo, which doesn't have llamactl's branches. Failing fast (0s) is the symptom. Recorded in memory `reference_penumbra_dispatch_routing.md`.

## Memories worth loading first (read in this order)

1. `project_multi_workload_shipped_2026-05-13.md` — what was built and how. Read before touching any of the new code surfaces.
2. `reference_penumbra_dispatch_routing.md` — `use_worktree: false` + explicit `cd` for chain_start dispatches into llamactl.
3. `feedback_cross_repo_validation.md` — run integration smoke across llamactl + sirius-gateway + embersynth after each big slice. Apply this when any of the cleanup items touch the gateway/RAG paths.
4. `project_typecheck_script_broken.md` — `bun run typecheck` reports success regardless of errors. **Use the per-package `tsc -p tsconfig*.json` invocations** to verify cleanliness, not the npm-style script. Critical for this cleanup pass.
5. `project_convergence_strategy.md` — strategic frame. Helps decide which cleanup items are load-bearing vs nice-to-have.
6. `feedback_nova_distribution.md` — for any cleanup touching `@nova/*` imports.

## Suggested order of operations

1. **Bun harness EADDRINUSE root-cause** — single fix unblocks multiple suites. Start here so subsequent verification is trustworthy.
2. **Pre-existing CLI typecheck errors (Section A)** — three files, ~30 lines total. Quick win; unlocks green `tsc` everywhere.
3. **Repo housekeeping (Section E)** — commit/ignore the loose files so `git status` is clean.
4. **Workload picker UI (Section C)** — biggest user-facing gap from the multi-workload work. Affects daily app use.
5. **`serverLogs` workload-scoped (Section C)** — finishes the multi-workload migration story for the app.
6. **Test gaps (Section D)** — add the missing cases. Don't sink time into perfect coverage; aim for the load-bearing paths.
7. **Docs (Section F)** — once code is clean, refresh templates + README + AGENTS.md.
8. **Label-selector evict + KV-aware estimator (Section C)** — nice-to-have polish. Skip if time-bound.
9. **agent_recommend hygiene (Section G)** — penumbra work, separate concern. Defer to a penumbra-focused session.

## First moves

```bash
cd /Volumes/WorkSSD/repos/personal/llamactl
git status --short
git log --oneline origin/main..HEAD            # confirm 22 unpushed commits
launchctl list | grep llamactl                 # verify daemon running
curl -fsS http://127.0.0.1:8181/health         # gemma alive
curl -fsS http://127.0.0.1:8083/health         # granite alive
mcp__penumbra__handoff_list_pending            # confirm clean
bun run --cwd packages/cli tsc --noEmit 2>&1 | head -20   # see the 3 known CLI errors
```

Then triage Section A — the eval.ts / rag-pipeline.ts / composite.test.ts errors are the simplest entry into "the codebase types clean." From there, dispatch one fix per file via `codex-acp-fast` and verify after each.

If anything in the live system looks off — Gemma stopped, Granite missing — read `project_multi_workload_shipped_2026-05-13.md` first: the daemon should adopt detached llama-server PIDs via per-workload pidfiles on restart.
