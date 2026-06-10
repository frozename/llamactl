# MLX Metal Per-Stream Back-Pressure: Phased TDD Plan

Assumed predecessor: [`mlx-exception-safe-completion-handler-2670.patch`](./mlx-exception-safe-completion-handler-2670.patch) is already applied.

## Scope and boundaries

- Target codebase for implementation: `ml-explore/mlx` (upstream), not `llamactl`.
- This plan only changes MLX Metal backend scheduling behavior inside one process.
- Cross-process contention mitigation stays out of scope (Fleet C/D concern).

## Persona briefs

### Persona A: Scheduler correctness

- Recommendation: keep throttle in `mlx::core::gpu::eval` and state in `scheduler` keyed by `Stream.index`.
- Why: `scheduler::notify_new_task`/`notify_task_completion` already model stream lifecycle edges and are the narrowest integration seam; callers like `mlx_lm.generate` should not own backend queue safety.
- Concurrency note: keep state per stream, not per `CommandEncoder` object, to remain compatible with thread-local encoder changes (PR #3348 direction) while preserving stream semantics.

### Persona B: Metal runtime pragmatism

- Recommendation: use `mutex + condition_variable` with bounded wait, not semaphore API surfacing.
- Why: no new platform primitive dependency, straightforward timeout path, clearer shutdown behavior.
- Error flow: timeout or stale-stream detection should forward to existing `notify_stream_error` -> `throw_if_stream_error` path, preserving caller behavior.

### Persona C: Testability / deterministic repro

- Recommendation: introduce a test-only scheduler/encoder seam to force deterministic "resource exhaustion" when in-flight commits exceed a synthetic limit.
- Why: real Metal queue exhaustion is hardware-dependent and flaky; deterministic failure is required for TDD and CI.
- Stress profile for manual validation: mixed short GPU ops + concurrent streams at request fanout 4+, with Metal capture enabled for postmortem.

## Synthesized design choice (what to build)

1. Add per-stream in-flight tracking in `scheduler` (`inc`, `dec`, `wait_until_below`).
2. In `mlx/backend/metal/eval.cpp`, gate `encoder.commit()` on `wait_until_below(...)`.
3. Maintain zero-overhead default by keeping gate disabled unless explicitly configured.
4. Add env-driven config in Metal backend init path:
   - `MLX_METAL_MAX_INFLIGHT_PER_STREAM` (default: disabled/unbounded)
   - `MLX_METAL_INFLIGHT_WAIT_TIMEOUT_MS` (default: conservative finite timeout)
5. Route all timeout/stale errors through existing stream-error stash/rethrow APIs from patch #2670.

## Phased TDD plan

Each phase uses: **fail first -> minimal fix -> verify**.

---

### Phase 0: Deterministic failing reproduction harness

**Goal:** Prove current behavior can exceed a safe in-flight threshold and fail deterministically in tests.

**Files (upstream MLX):**

- Modify: `mlx/scheduler.h`
- Modify: `mlx/backend/metal/eval.cpp`
- Add: `tests/metal/stream_backpressure_test.cpp` (or nearest existing Metal backend C++ test module)

**Failing test first**

- Add a deterministic test double path (compile-time test hook) that:
  - simulates commit admission events per stream,
  - raises a synthetic "command buffer resource exhausted" error when in-flight count exceeds `N`.
- Test case:
  - given `N=1`, concurrent commits on same stream with effective fanout `4`,
  - expect reproducible failure on current code path (no gating).

**Minimal implementation for this phase**

- No behavior fix yet.
- Only test hook plumbing and assertions to ensure the failure is deterministic.

**Verify**

- `cmake --build build --target stream_backpressure_test` (or repo-equivalent target)
- `ctest -R stream_backpressure_test --output-on-failure`
- Expected: test fails with synthetic exhaustion before any back-pressure is added.

**Operational impact**

- Daemon/service restarts: none
- Schema migrations: none
- MCP federation changes: none
- Registry mutations: none
- Strict-mode toggles: none
- Env/YAML changes: none

---

### Phase 1: Smallest behavior change to pass deterministic test

**Goal:** Prevent over-commit per stream using an internal gate, without user-facing config yet.

**Files (upstream MLX):**

- Modify: `mlx/scheduler.h`
- Modify: `mlx/backend/metal/eval.cpp`

**Failing test first**

- Reuse Phase 0 failing test unchanged.

**Minimal implementation**

- Add per-stream counters in `Scheduler`:
  - `notify_stream_commit_started(stream)`
  - `notify_stream_commit_finished(stream)` (called from completion handlers)
  - `wait_until_stream_inflight_below(stream, limit, timeout_ms)`
- In `eval.cpp`:
  - before `encoder.commit()`, call wait function with internal fixed limit used only in test-mode path.
  - on timeout/stale-stream, stash exception via `notify_stream_error`.
  - preserve completion ordering: publish error before task completion notify.

**Verify**

- `ctest -R stream_backpressure_test --output-on-failure`
- Expected: previously failing deterministic test now passes.
- Run Metal regression subset:
  - `ctest -R metal --output-on-failure`

**Operational impact**

- Daemon/service restarts: none
- Schema migrations: none
- MCP federation changes: none
- Registry mutations: none
- Strict-mode toggles: none
- Env/YAML changes: none (internal/test-only threshold in this phase)

---

### Phase 2: Runtime config surface (env vars) + safety semantics

**Goal:** Make throttling configurable for operators while keeping default hot path unchanged.

**Files (upstream MLX):**

- Modify: `mlx/backend/metal/eval.cpp`
- Modify: `mlx/backend/metal/device.cpp` (or existing Metal env-config resolver)
- Modify: `mlx/backend/metal/device.h` if config struct is introduced
- Add/Modify tests:
  - `tests/metal/stream_backpressure_test.cpp`
  - `python/tests/test_metal.py` (if env behavior is validated via Python API)

**Failing tests first**

- Add tests that assert:
  - when `MLX_METAL_MAX_INFLIGHT_PER_STREAM` is unset/0 => gate is disabled,
  - when set to `1` => deterministic stress path is throttled and no synthetic exhaustion,
  - timeout path raises a surfaced stream error (not hang, not abort).

**Minimal implementation**

- Parse env vars once in backend init:
  - `MLX_METAL_MAX_INFLIGHT_PER_STREAM`
  - `MLX_METAL_INFLIGHT_WAIT_TIMEOUT_MS`
- Keep no-config path cheap:
  - fast check branches away before mutex/CV wait logic.
- Ensure teardown clears per-stream gate state when streams are cleared/reused.

**Verify**

- `ctest -R stream_backpressure_test --output-on-failure`
- `ctest -R metal --output-on-failure`
- `python -m unittest discover python/tests -k metal` (or project-standard equivalent)
- Expected: all new env behavior tests pass; no regressions in existing Metal tests.

**Operational impact**

- Daemon/service restarts: required only for long-lived host processes to pick up env var changes
- Schema migrations: none
- MCP federation changes: none
- Registry mutations: none
- Strict-mode toggles: none
- Env/YAML changes:
  - add optional process env:
    - `MLX_METAL_MAX_INFLIGHT_PER_STREAM=1` (recommended starting point on M4 base under multi-model high concurrency)
    - `MLX_METAL_INFLIGHT_WAIT_TIMEOUT_MS=5000` (example safe default)
  - no YAML config change in MLX itself

---

### Phase 3: Docs + upstream PR package + manual stress validation

**Goal:** Ship upstream-ready documentation and reproducible validation artifacts.

**Files (upstream MLX and this repo support docs):**

- Modify upstream docs (likely under `docs/src/dev/` and/or `docs/src/python/metal.rst`)
- In this repo, update:
  - `docs/upstream-patches/back-pressure-design-prompt.md` with final accepted approach
  - add `docs/upstream-patches/mlx-back-pressure-validation-notes.md`

**Failing check first**

- Documentation lint/check target fails if new env vars are undocumented (or add explicit checklist test in local validation script).

**Minimal implementation**

- Document:
  - what back-pressure solves,
  - default behavior (off),
  - low-GPU recommended settings,
  - timeout/error semantics and relation to #2670 patch.
- Add PR text template summarizing:
  - rationale,
  - test strategy,
  - no-impact default path claim and supporting numbers.

**Verify**

- Upstream docs build command (repo standard)
- Re-run stress scenario on Mac:
  - `--max-concurrent-requests=4` with three-model `--model-dir`
  - compare before/after error rate and throughput
- Capture and archive:
  - command lines,
  - env settings,
  - pass/fail matrix.

**Operational impact**

- Daemon/service restarts: none for docs; runtime restarts only when changing env during manual validation
- Schema migrations: none
- MCP federation changes: none
- Registry mutations: none
- Strict-mode toggles: none
- Env/YAML changes: documented only (no new config file schema)

## Dispatch-ready task list

1. Build deterministic failing Metal back-pressure test harness (Phase 0).
2. Implement scheduler-backed per-stream inflight gate to make test pass (Phase 1).
3. Add env-config parsing and runtime semantics with regression tests (Phase 2).
4. Produce docs + upstream PR packet + macOS stress evidence (Phase 3).

## Risk register and mitigations

- Deadlock on shutdown:
  - Mitigation: wait calls must observe stream clear/stop state and return timeout error; broadcast CV on clear.
- Hidden throughput regression on default path:
  - Mitigation: branch away before lock/CV when gate disabled; benchmark single-model baseline before/after.
- Error ordering race with task completion:
  - Mitigation: keep completion handler order as in #2670 follow-up (`error publish` before `notify_task_completion`).
- `mx.synchronize()` behavior surprises:
  - Mitigation: explicit test asserting surfaced timeout/error at sync waitpoint via `throw_if_stream_error`.
