# Maestro continuation prompt — 2026-05-20 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-implement only when the worker/daemon won't boot.

## TL;DR for last session

Started from the 2026-05-20 am maestro continuation note focused on cross-node MLX + mac-mini fleet shaping. Pivoted into a deeper investigation when dual-8B fleets on mac-mini kept reproducing `mlx::core::gpu::check_error → std::terminate → abort` IPS crash reports. Result of the session:

- Root-caused dual-8B failure to **Metal command-buffer error thrown from libdispatch completion handler**. Exceptions cannot unwind across libdispatch dispatch blocks → process abort.
- Authored an upstream MLX patch that converts the throw into a per-stream `exception_ptr` stash, re-thrown synchronously at the next eval/finalize/synchronize waitpoint. Branch in `/Volumes/WorkSSD/src/mlx-fix` is `fix/exception-safe-completion-handler` at `4f7c4a7a` (v3).
- Validated three times on mac-mini Fleet L (3 MLX models, single oMLX process at `--max-concurrent-requests=1`): **0 errors across 240 rows, 1041s wall, 0.9235/0.731/0.9/0.84 scores**. Process stays alive throughout; no new IPS crashes.
- Iterated through three adversarial-review rounds with steadily-decreasing severity: round 1 (4 HIGH / 4 MEDIUM / 1 LOW) → round 2 (2 HIGH / 5 MEDIUM / 2 LOW) → round 3 (**1 HIGH (deferred) / 6 MEDIUM / 3 LOW**). The remaining HIGH is the stream-identity generation-counter limitation; it requires an upstream Stream API change and is explicitly documented in the patch.
- Ran an adversarial-plan workflow for the back-pressure follow-up. Synthesizer timed out twice; planner personas independently agreed on the same per-stream gate design. A planner left a 15 KB draft patch + 10 KB phased TDD plan in `docs/upstream-patches/`.

User instruction at end of session was `handoff`.

## Patch artifacts staged in repo (under `docs/upstream-patches/`)

| File | Purpose | Status |
|------|---------|--------|
| `mlx-exception-safe-completion-handler-2670.patch` | The v3 patch: stash-on-completion, throw-at-waitpoint. Two files in MLX (`mlx/scheduler.h`, `mlx/backend/metal/eval.cpp`). | Validated 3× live |
| `scheduler.h.after` / `eval.cpp.after` | Reference copies of the patched files. | Synced with v3 |
| `back-pressure-design-prompt.md` | Spec fed to the adversarial-plan workflow. | Owned, not changed |
| `mlx-back-pressure-phased-tdd-plan.md` | Persona-synthesized 4-phase TDD plan. | Reference for next step |
| `mlx-backpressure-per-stream-gate.patch` | Persona-drafted back-pressure patch with 3 unit tests. | Not yet validated |

The upstream branch `fix/exception-safe-completion-handler` in `/Volumes/WorkSSD/src/mlx-fix` carries the v3 patch as one squashed commit (`4f7c4a7a`). Patched wheel `mlx-0.31.2-cp314-cp314-macosx_26_0_arm64.whl` is installed in mac-mini's oMLX venv at `/Volumes/AI-DATA/src/omlx/.venv`. `MAX_INFLIGHT_PER_STREAM` env var is **not yet implemented** — back-pressure happens at the oMLX layer via `--max-concurrent-requests=1` in `templates/workloads/stress-fleet-L-mac-mini.yaml`.

## Open threads (pick one with the user)

### A. Back-pressure follow-up patch (the natural next step)

The persona-drafted patch in `docs/upstream-patches/mlx-backpressure-per-stream-gate.patch` is the input. It composes on top of the v3 exception-safety patch:

1. Add `acquire_stream_slot(s, limit, timeout_secs=30)` and `release_stream_slot(s)` to `scheduler::Scheduler`. Separate `inflight_mtx_` from `error_mtx_` to avoid deadlock when timeout calls `notify_stream_error`.
2. Wire `acquire`/`release` around `encoder.commit()` in `eval()` and `finalize()`.
3. Env-driven config: `MLX_METAL_MAX_INFLIGHT_PER_STREAM` (default INT_MAX → no-op fast path), `MLX_METAL_BACKPRESSURE_TIMEOUT_SECS` (default 30).
4. 3 unit tests: gate-blocks-at-limit, fast-path-throughput (<5 ms for 10k acquire/release), timeout-injects-stream-error.

Path: apply that patch to the local mlx-fix branch, rebuild wheel, reinstall on mac-mini, raise `--max-concurrent-requests` to 4 in Fleet L manifest, raise `MLX_METAL_MAX_INFLIGHT_PER_STREAM` to 1 in `engineDirectives.env` for oMLX, re-run stress. Target: same 0-error result at ~2-3× the current throughput. If the throughput target lands, run another adversarial-review on the back-pressure diff before considering it done.

### B. Address the remaining round-3 round-3 MEDIUM findings on the exception-safety patch

- `new_stream()` `try_emplace` no-op when key exists: should `insert_or_assign` (or call `clear_stream_error` then emplace).
- Per-stream sentinel array instead of single `any_stream_error_` to avoid degraded-path contention.
- `clear_streams()` quiescent barrier: wait for in-flight completion handlers before clearing. Best implemented alongside back-pressure (uses the same in-flight counter).
- Sanitize externally-surfaced `localizedDescription` text.

These are all worth doing before opening any upstream PR but none are merge-blockers for local use. Bundling them with the back-pressure patch is the cleanest delivery.

### C. Production rollout to mac-mini Fleet B

The existing plan from earlier today still stands. Granite-3B-Q8 judge swap to MLX is **not active yet** — `mlx-granite-3b-judge-mac-mini.yaml` exists but routing in `agentchat.yaml` was never flipped. Fleet B remains a real candidate now that we know Fleet L works with serialization (so Fleet B-with-MLX-3B-judge is even safer).

### D. Stray file cleanup

There is an untracked file at the repo root called `name` containing `--- agent listing role- ---`. Looks like a terminal-paste accident. Confirm with the user, then `rm name`.

Also untracked auto-generated artifacts: several `docs/notes/session-summary-*.md`, two `docs/superpowers/plans/2026-05-20-*.md`, one `docs/superpowers/specs/2026-05-20-*.md`. Decide whether to commit, keep ignored, or delete.

## Validation evidence (last session)

```
Fleet L mcr=1, three rebuilds of patched MLX, identical results:

WALL: 1039-1042s
memory-efficacy-4way | 0.9235 | 0 errors | 60 rows
memory-recall        | 0.7310 | 0 errors | 105 rows
tool-call-grammar    | 0.9000 | 0 errors | 50 rows
task-refiner-rubric  | 0.84   | 0 errors | 25 rows

oMLX process alive throughout (~50+ min uptime)
No new IPS crash report since 13:59 (pre-patch)
```

Adversarial-review trajectory:
```
round 1 (v1):  4 HIGH / 4 MEDIUM / 1 LOW
round 2 (v2):  2 HIGH / 5 MEDIUM / 2 LOW   (race + null + lifecycle + hot-path atomic)
round 3 (v3):  1 HIGH / 6 MEDIUM / 3 LOW   (sentinel race moved inside lock + docs)

Remaining HIGH: stream.index reuse needs upstream Stream API change (generation counter).
Documented as known limitation in the patch.
```

Synthesis files:
- v1 review: `.penumbra/reviews/2026-05-20T23-03-52.800Z/synthesis.md`
- v3 review: `.penumbra/reviews/2026-05-21T01-08-00.245Z/synthesis.md`
- Back-pressure plan: `.penumbra/reviews/2026-05-20T23-08-59.356Z/` (synthesizer timed out — read per-persona `risk.md` and `simplifier.md` for the design)

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean (was clean at handoff)
3. `ssh macmini.ai 'pgrep -af "omlx serve"; ls ~/Library/Logs/DiagnosticReports/python3.14-2026-05-2*.ips | tail -3'` — confirm patched oMLX still alive on mac-mini
4. Pick A / B / C / D above with the user before resuming.

## Conventions for this session

- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot.
- Use Penumbra MCP for state (`handoff_get`, `chain_wait`, `chain_get_response`); never query the live sqlite DB directly except for forensics.
- Search memory before non-trivial work — `mcp__penumbra__memory_search`.
- Repo text (commits, PR descriptions) is neutral; no AI-tool authorship attribution.
- For cross-node MLX work, use `mcp__llamactl_*` via the daemon; do not ssh into mac-mini and run `llamactl` from there (the source tree is often stale).
