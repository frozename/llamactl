# Maestro continuation prompt — 2026-05-21 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-implement only when the worker/daemon won't boot.

## TL;DR for last session

Built a second wave of upstream improvements on top of the v3 MLX exception-safety + back-pressure work. Net deliverables:

- **5 patches ready to PR upstream**, each on its own fork branch.
- **2 task specs retired** because the features already exist upstream (the original plan was based on outdated info).
- **1 patch (C.1) live-tested and found incomplete** — catches decode-path Metal errors but the actual failure path on mac-mini is prefill. This is the only outstanding work for next session.
- **Per-process Fleet L on mac-mini is the production answer** — three daemon-managed iso oMLX procs, validated end-to-end with the new MLX wheel + oMLX patches.

User instruction at end of session: "handoff first and we'll tackle [the C.1 prefill gap] next session".

## What's on the forks

Two GitHub forks at `https://github.com/frozename/mlx` and `https://github.com/frozename/omlx`. Each patch sits on its own branch:

| Repo | Branch | Patch | State |
|---|---|---|---|
| `frozename/mlx` | `fix/exception-safe-completion-handler` | v3 exception-safety + back-pressure (8c514a1a, 982ef62d) | already pushed |
| `frozename/mlx` | `feat/stream-tag-field` (20221bc8) | B.1 | local, push when ready |
| `frozename/mlx` | `feat/per-stream-residency-set` (127905b8) | B.3 | local, push when ready |
| `frozename/omlx` | `feat/max-completion-batch-size` (26a2033) | A.3 | already pushed |
| `frozename/omlx` | `feat/recovery-on-metal-error` (d461e32) | C.1 (needs prefill follow-up) | local, push when ready |
| `frozename/omlx` | `feat/per-model-concurrency` (2bdc21b) | C.2 | local, push when ready |

The MLX stack also has a `validate/all-mlx` branch with A.1 + B.1 + B.3 cherry-picked on top of the v3 base, conflicts resolved. The wheel built from that branch is what's installed on mac-mini.

## What's deployed on mac-mini

- New MLX wheel `mlx-0.31.2-cp314-cp314-macosx_26_0_arm64.whl` (built from `validate/all-mlx`) installed at `/Volumes/AI-DATA/src/omlx/.venv`.
- oMLX source at `/Volumes/AI-DATA/src/omlx/` has the three Python patches applied directly to `omlx/scheduler.py`, `omlx/settings.py`, `omlx/cli.py`. Add `tests/test_metal_error_recovery.py` + `tests/test_per_model_concurrency.py` to the deployed source next time if you want pytest coverage local.
- Three daemon-managed ModelHosts live on ports 8194 (granite-3b), 8195 (granite-8b), 8196 (qwen3-8b). The granite-3b manifest demonstrates A.4's new `spec.env: MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1"` — confirmed flowing through to the spawned process.
- llamactl agent on mac-mini was restarted (`launchctl kickstart -k gui/$(id -u)/com.llamactl.agent`) to pick up the new oMLX adapter + ModelHost schema.

## Live test result (2026-05-21)

Fleet L stress run, mcr=4 on each iso proc, full new stack:

| Workload | Score | Errors | Status |
|---|---|---|---|
| memory-recall | 0.7445 | 0 | ✓ identical to baseline |
| tool-call-grammar | 0.9000 | 0 | ✓ identical to baseline |
| task-refiner-rubric | 0.8222 | 0 | ✓ identical to baseline |
| memory-efficacy-4way | — | 5 prefill-OOM errors then stall | **C.1 prefill gap** |

The 5 errors are real Metal OOMs (`kIOGPUCommandBufferCallbackErrorOutOfMemory`, NOT watchdog timeouts). Cold-start memory pressure: all three oMLX processes loading their models simultaneously when matrix CLIs fire 4-concurrent at each. Total memory budget is tight (25% + 35% + 35% = ~95% of 16 GB).

Traceback shows the OOM in `_do_external_prefill` → `mx.eval([c.state for c in prompt_cache])` (scheduler.py:1810). My C.1 catch is at the decode-path `BatchGenerator.next_generated()`. Prefill errors percolate to the existing outer try/except at scheduler.py:5629 which logs + 500s the client rather than isolating-and-continuing.

## The one outstanding task

**Patch C.1 to cover the prefill path.**

In `/tmp/omlx-push/omlx/omlx/scheduler.py` (and mirror to `/Volumes/AI-DATA/src/omlx/omlx/scheduler.py` on mac-mini):

Option A — inside `_do_external_prefill` at line ~1810: wrap the `mx.eval` in try/except `RuntimeError` whose message starts with `[METAL]`, raise a sentinel exception type that the caller in `_schedule_waiting` can catch and convert to a per-request rejection.

Option B (cleaner) — wrap the `_do_external_prefill` call in `_schedule_waiting` (line ~4719):

```python
try:
    prefilled_cache, last_token = self._do_external_prefill(
        request,
        prompt_cache,
        vlm_embeds=vlm_embeds,
    )
except RuntimeError as e:
    if not str(e).startswith("[METAL]"):
        raise
    rejected.append(RequestOutput(
        request_id=request.request_id,
        finished=True,
        finish_reason="error",
        error=f"metal_command_buffer_failed_prefill: {e}",
    ))
    self._metal_errors_recovered = getattr(self, "_metal_errors_recovered", 0) + 1
    logger.warning(
        "Metal command buffer failure during prefill of %s; isolating "
        "request and continuing batch (total recoveries: %d). "
        "Underlying error: %s",
        request.request_id,
        self._metal_errors_recovered,
        e,
    )
    # Remove from self.waiting / self.requests as already-finished.
    self.waiting.popleft()  # or appropriate removal — match the existing rejected-path semantics
    continue
```

`_schedule_waiting` already has a `rejected` list (see scheduler.py:2125-2145 for the chunked-prefill rejected pattern). The failure routes through the same finalization machinery as my decode-path catch.

After patching:
1. Update `docs/upstream-patches/omlx-recovery-on-metal-error.patch` (regenerate via `git format-patch -1 HEAD --stdout`).
2. Update `docs/upstream-patches/omlx-recovery-on-metal-error-pr-description.md` to mention both decode AND prefill coverage.
3. Mirror to mac-mini: `scp /tmp/omlx-push/omlx/omlx/scheduler.py macmini.ai:/Volumes/AI-DATA/src/omlx/omlx/scheduler.py`.
4. Bounce oMLX procs: `bun packages/cli/src/bin.ts --node mac-mini disable <each>` then `apply`. Or just `kill -9` the three PIDs and re-apply.
5. Re-run Fleet L stress and expect 4/4 workloads at 0 errors. If still seeing errors, check `~/.omlx/logs/server.log` on mac-mini for the new traceback shape.

## After the C.1 fix lands cleanly

Open the upstream PRs in this order:
1. **MLX**: push `feat/stream-tag-field` + `feat/per-stream-residency-set` to `frozename/mlx`, open PRs against `ml-explore/mlx`.
2. **MLX**: also open the exception-safety + back-pressure PRs against `ml-explore/mlx` (already on `frozename/mlx fix/exception-safe-completion-handler`).
3. **oMLX**: push `feat/recovery-on-metal-error` (with prefill fix) + `feat/per-model-concurrency` to `frozename/omlx`, open PRs against `jundot/omlx`.
4. **oMLX**: open the `--max-completion-batch-size` PR against `jundot/omlx` (already pushed).

Each PR is independent and can land in any order. Each has a PR description ready in `docs/upstream-patches/*-pr-description.md`.

## Memory of what's already done

- `[upstream patches 2026-05-21]` — full state of the second wave (this is the load-bearing memory entry)
- `[MLX exception-safety patch 2026-05-20]` — the predecessor (v3 + back-pressure)
- `[multi-workload local nodes 2026-05-13]` — the per-workload runtime + apply parallel infrastructure that made all of this possible
- `docs/upstream-patches/mlx-omlx-improvements-plan.md` — the original plan doc
- `docs/superpowers/plans/2026-05-21-mlx-upstream-improvements.md` — auto-generated dispatch-ready plan

## First moves

1. `git status --short && git log --oneline -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `ssh macmini.ai 'pgrep -af "omlx serve"; lsof -iTCP -P -sTCP:LISTEN 2>/dev/null | grep -E ":819[456]"'` — confirm the 3 iso procs are still alive
4. Read `project_upstream_patches_2026-05-21` memory for the full state
5. Apply the C.1 prefill-coverage fix per the "outstanding task" section above. Validate against the same Fleet L stress.

## Conventions for this session

- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot.
- Use Penumbra MCP for state; never query the live sqlite DB directly except for forensics.
- Search memory before non-trivial work — `mcp__penumbra__memory_search`.
- Repo text (commits, PR descriptions) is neutral; no AI-tool authorship attribution.
- For cross-node MLX work, use `mcp__llamactl_*` via the daemon; do not ssh into mac-mini and run `llamactl` from there (the source tree is sometimes stale).
- C.1 needs BOTH decode and prefill coverage to be PR-ready upstream. The decode catch alone is half the fix.
