# MLX + oMLX Second Wave — Phased TDD Plan

> Synthesized from adversarial-plan run `2026-05-21T00-04-23.856Z` (personas timed out)
> and earlier run `2026-05-20T23-09-27.260Z` (risk + simplifier personas completed).
> Covers the full second-wave spec at
> `docs/superpowers/specs/2026-05-20-mlx-second-wave-full-spec.md`.

## Architectural decisions (pre-implementation contracts)

### AD-1: Back-pressure gate lives in `mlx::core::scheduler`, not in callers

Both risk and simplifier personas agree: the throttle must be
inside the MLX Metal backend, not in `mlx_lm.generate` or oMLX's
scheduler. This keeps correctness automatic for every caller path and
composes with the existing exception-safety patch without spreading
policy into higher layers.

Concrete: add `try_acquire_stream_slot` / `release_stream_slot` to
`mlx/scheduler.h`. Wire acquire before `encoder.commit()` and release
in every completion-handler path in `mlx/backend/metal/eval.cpp`.
Do NOT overload `notify_new_task` / `notify_task_completion` — those
track scheduler activity, not command-buffer depth.

### AD-2: Stream tag + generation counter go directly on `Stream`

M3 and M4 are identity fields, not policy. They belong on `Stream`
directly (`stream.h`), not on a sibling `StreamMeta` struct.
`StreamMeta` would be premature abstraction (only two fields, used
in one subsystem).

```cpp
// stream.h additions
struct Stream {
  // ... existing fields ...
  std::optional<std::string> tag;   // M3 — model identity for per-stream lifecycle
  uint64_t generation = 0;          // M4 — closes stream-index-reuse race
};
```

### AD-3: M1 + M2 ship as one PR, two commits

Per-stream `MTL::CommandQueue` (M1) without per-stream
`MTL::ResidencySet` (M2) is a half-fix — the driver still competes on
residency during inter-model context switches. They should land
together for a coherent story ("stream isolation"). Two separate
commits within one PR gives zcbenz a clean review trail.

### AD-4: Default path stays unthrottled

`MLX_METAL_MAX_INFLIGHT_PER_STREAM` unset → unlimited (existing
behavior). Setting it to `<=0` → also unlimited. Only positive values
engage the gate. The unthrottled hot path must have no overhead beyond
reading a cached env var.

### AD-5: O1 (--isolate-models) is a fallback, not the primary fix

If M1/M2 ship upstream and deliver single-process multi-model parity
with the current three-process workaround, O1 is not needed. It
becomes graceful-degradation for environments running older MLX.
Implement O1 only after M1/M2 benchmark on mac-mini confirms parity
or not.

### AD-6: Patch ordering — keep back-pressure separate from exception-safety

`8c514a1a` (exception-safe) and `982ef62d` (back-pressure) stay as
two upstream PRs. Folding them loses the ability to merge the
exception-safety win if back-pressure faces objections. Back-pressure
PR text should reference the exception-safety PR as predecessor.

---

## Phase A — Small upstream-able wins (1–3 days, low risk)

**Goal:** Land the easy items that close known issues and make operator
life better, before touching the harder Metal internals.

### A1. M4: Stream generation counter

**Why first:** Closes a confirmed HIGH finding from the adversarial
review. Smallest change; doesn't depend on M3.

**Failing test** (`tests/stream_tests.cpp` or equivalent):
```cpp
TEST(StreamGeneration, ReusedIndexRaceIsClosed) {
  // Create stream s1, capture its {index, generation}.
  // Destroy s1. Create s2 that reuses the same index.
  // Call notify_stream_error with the old {index, generation}.
  // Assert: s2 has NO error — generation mismatch rejected the stale error.
  // Without M4 this test fails (stale error bleeds into s2).
}
```

**Implementation:**
- `mlx/stream.h`: add `uint64_t generation = 0`
- `mlx/stream.cpp`: increment on construction or reuse
- `mlx/backend/metal/eval.cpp`: in `notify_stream_error` /
  `throw_if_stream_error`, validate `{index, generation}` pair

**Verify:**
```bash
cd /Volumes/WorkSSD/src/mlx-fix
cmake -S . -B build -DMLX_BUILD_TESTS=ON
cmake --build build --target tests -j8
./build/tests --test-case="*generation*"
```

**Rollback:** revert the three-file change.

---

### A2. M5: `MLX_METAL_MAX_OPS_PER_BUFFER` env knob

**Failing test** (env-parsing unit):
```cpp
TEST(MetalDevice, MaxOpsPerBufferEnvOverride) {
  setenv("MLX_METAL_MAX_OPS_PER_BUFFER", "20", 1);
  // Re-initialize or invoke the parser path.
  EXPECT_EQ(metal::device().max_ops_per_buffer(), 20);
  unsetenv("MLX_METAL_MAX_OPS_PER_BUFFER");
}
```

**Implementation:**
- `mlx/backend/metal/device.cpp` line ~445: replace compile-time
  literal with `env_or(MLX_METAL_MAX_OPS_PER_BUFFER, 40)`
- Use the same env-parsing helper already used for other MLX knobs

**Verify:** unit test + smoke run confirms default is unchanged when
env var is unset.

---

### A3. O4: Upstream PR for `--max-completion-batch-size`

Already implemented on mac-mini. This task cleans the diff and
opens the upstream PR.

**Failing test** (settings round-trip):
```python
# tests/test_settings.py in oMLX repo
def test_max_completion_batch_size_default():
    cfg = SchedulerConfig()
    assert cfg.max_completion_batch_size is None  # unbounded

def test_max_completion_batch_size_cli():
    # Parse argv ["--max-completion-batch-size", "4"]
    cfg = parse_settings(["--max-completion-batch-size", "4"])
    assert cfg.max_completion_batch_size == 4
```

**Files:** `omlx/settings.py`, `omlx/cli.py` (already patched on
mac-mini; just clean the diff)

**Deliverable:** PR opened against `jundot/omlx` with test attached.

---

### A4. L2: `env` field on ModelHost manifest schema

**Failing test** (`packages/remote/src/workload/modelhost-schema.test.ts`):
```typescript
it("accepts env field", () => {
  const manifest = parse({
    kind: "ModelHost",
    env: { MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1", HF_HUB_OFFLINE: "1" },
    // ... other required fields
  });
  expect(manifest.env).toEqual({ MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1" });
});

it("rejects non-allowlisted env keys", () => {
  expect(() => parse({ kind: "ModelHost", env: { SECRET: "x" } }))
    .toThrow();
});
```

**Files:**
- `packages/remote/src/workload/modelhost-schema.ts`: add optional
  `env: Record<string, string>` with a Zod `.refine()` that checks
  keys against `CHILD_ENV_ALLOWLIST`
- Server-side spawn logic: merge manifest `env` with process env
  before spawning the child

**Verify:** `bun test packages/remote` green.

---

## Phase B — Back-pressure gate (3–5 days, medium complexity)

**Goal:** Per-stream in-flight command buffer limit that prevents Metal
watchdog timeouts under multi-stream concurrency, defaulting to
unthrottled so single-model performance is unaffected.

**Predecessor patches assumed landed:**
- `8c514a1a` (exception-safe completion handler)

### B0. Deterministic failing test for gate semantics

**Failing test** (`tests/scheduler_tests.cpp`):
```cpp
TEST(MetalBackPressure, GateBlocksWhenAtLimit) {
  // Acquire up to limit=2 slots on stream s.
  StreamGate gate(/*limit=*/2);
  EXPECT_TRUE(gate.try_acquire(s.index, s.generation, /*timeout_ms=*/100));
  EXPECT_TRUE(gate.try_acquire(s.index, s.generation, /*timeout_ms=*/100));
  // Third acquire should time out (limit=2).
  EXPECT_FALSE(gate.try_acquire(s.index, s.generation, /*timeout_ms=*/50));
  // After release, acquire succeeds again.
  gate.release(s.index, s.generation);
  EXPECT_TRUE(gate.try_acquire(s.index, s.generation, /*timeout_ms=*/100));
}

TEST(MetalBackPressure, StaleGenerationReleasedSafely) {
  // Release with a stale generation should not corrupt the live count.
}

TEST(MetalBackPressure, CloseWakesAllWaiters) {
  // gate.close() should unblock any threads waiting on acquire.
}
```

**Files to create/modify:**
- `mlx/scheduler.h`: `StreamGate` struct (counter, mutex, cv, closed flag)
- `mlx/scheduler.cpp`: implementation
- `tests/scheduler_tests.cpp`: above tests

**Verify:** red → green on CPU-only build (no Metal device needed).

---

### B1. Wire throttle into Metal eval path

**Failing test** (GPU-level, requires Metal host):
```cpp
TEST(MetalBackPressure, ConcurrentStreamsUnderLimitCompleteWithoutError) {
  // Set MLX_METAL_MAX_INFLIGHT_PER_STREAM=1 in env.
  // Submit 4 concurrent tiny evals on 2 streams.
  // Assert: all complete, no Metal command-buffer errors.
  // Without B1 wiring, errors occur at concurrency > gate limit.
}
```

**Files:**
- `mlx/backend/metal/eval.cpp`: call `scheduler::acquire_stream_slot()`
  before `encoder.commit()`; call `release_stream_slot()` in every
  branch of the `addCompletedHandler` callback (success AND error)
- Error timeout route: when acquire times out, call
  `notify_stream_error(index, generation, error)` (existing path from
  `8c514a1a`)

**Verify:**
```bash
MLX_METAL_MAX_INFLIGHT_PER_STREAM=1 ./build/tests --test-case="*BackPressure*"
# Also rerun exception-safety tests to confirm no conflict.
./build/tests --test-case="*exception*"
```

---

### B2. Env var config + unit tests

**Failing test:**
```cpp
TEST(MetalBackPressure, EnvVarUnsetMeansUnlimited) {
  unsetenv("MLX_METAL_MAX_INFLIGHT_PER_STREAM");
  EXPECT_EQ(metal::stream_gate_limit(), 0);  // 0 = unlimited
}
TEST(MetalBackPressure, EnvVarParsedCorrectly) {
  setenv("MLX_METAL_MAX_INFLIGHT_PER_STREAM", "1", 1);
  EXPECT_EQ(metal::stream_gate_limit(), 1);
}
```

**Files:** `mlx/utils.h` / `mlx/utils.cpp` — add `env_or_int()` if
not already present; wire parsed value into `StreamGate` construction.

---

### B3. Docs + upstream PR + production validation

- Update `docs/upstream-patches/` with the cleaned back-pressure patch
- PR text: reference `#2670` (exception-safety) as predecessor;
  explain env var semantics; note that default is unchanged
- Production validation on mac-mini:
  ```bash
  ssh macmini.ai
  MLX_METAL_MAX_INFLIGHT_PER_STREAM=1 \
    omlx serve --model-dir /Volumes/AI-MODELS/omlx-fleet \
    --max-concurrent-requests 4 --port 8200
  # From M4 Pro: run matrix bench against :8200 vs baseline :8190
  ```
- Verify: error count 0, wall time within 10% of mcr=1 baseline.

**Rollback:** unset env var + restart oMLX process. No llamactl daemon
restart needed.

---

## Phase C — Per-stream Metal isolation (5–10 days, high impact, upstream)

**Goal:** M3 (Stream tag) → M1 (per-stream CommandQueue) → M2
(per-stream ResidencySet). If these land, ONE oMLX process can safely
serve N models at mcr=4 without the three-process workaround.

**Metal driver queue limit:** ~256 concurrent queues per process on
Apple Silicon. For 3–10 MLX streams, well within budget. Growth must
be bounded by coupling to `Scheduler::clear_streams()` on stream
teardown.

**mlx-lm threading concern:** mlx-lm uses one thread-local
`generation_stream` per worker thread. With per-stream queues, that
stream automatically gets its own queue — no mlx-lm changes needed,
since the single-thread serialization within each stream is preserved.

---

### C0. M3: `Stream::tag` field (prerequisite for C1/C2 API ergonomics)

**Failing test:**
```cpp
TEST(Stream, TagDefaultsEmpty) {
  Stream s = gpu::new_stream(/*device=*/0);
  EXPECT_FALSE(s.tag.has_value());
}
TEST(Stream, TagCanBeSet) {
  Stream s = gpu::new_stream(0);
  s.tag = "qwen3-8b";
  EXPECT_EQ(s.tag.value(), "qwen3-8b");
}
```

**Files:** `mlx/stream.h`, `mlx/stream.cpp` (trivial; couples with M4
in same struct edit).

---

### C1. M1: Per-stream `MTL::CommandQueue`

**Failing test** (requires Metal host):
```cpp
TEST(MetalDevice, IndependentStreamsDontSerializeOnCommandQueue) {
  // Create stream s1, s2. Submit identical small matmul on both simultaneously.
  // Wall time for concurrent submission should be < 1.5× serial time.
  // Before M1 (shared queue): they serialize → ~2× serial.
  // After M1 (independent queues): they overlap → <1.5× serial.
  auto t0 = now();
  auto f1 = std::async([&]{ eval_on(s1, workload); });
  auto f2 = std::async([&]{ eval_on(s2, workload); });
  f1.get(); f2.get();
  EXPECT_LT(now() - t0, 1.5 * serial_time);
}
```

**Files:**
- `mlx/backend/metal/device.h`: replace single `queue_` member with
  `std::unordered_map<int, NS::SharedPtr<MTL::CommandQueue>> queues_`
- `mlx/backend/metal/device.cpp`: allocate in `new_stream(s)`, release
  in `clear_streams()` / stream teardown; ~269 is the current `queue_`
  initialization site
- `mlx/backend/metal/eval.cpp`: pass stream's queue (not device's global
  queue) to `CommandEncoder` constructor

**CI note:** gate behind `MLX_BUILD_METAL` — existing pattern in
MLX CI.

---

### C2. M2: Per-stream `MTL::ResidencySet`

Same shape as C1. After C1, residency sets are the remaining
cross-stream contention point during model weight paging.

**Files:**
- `mlx/backend/metal/resident.h`: `ResidencySet` becomes per-stream
  rather than device-global
- `mlx/backend/metal/device.cpp`: allocation/teardown parallels C1

**Benchmark gate:** after C1+C2, run the three-model oMLX bench on
mac-mini at mcr=4 with ONE process. Target: ≤10% error rate and
throughput within 15% of the three-process baseline. If target is
not met, revisit O1 (--isolate-models).

---

## Phase D — oMLX improvements (2–4 days, medium complexity)

Order: O3 → O2 → O1 (O1 only if Phase C benchmark doesn't deliver).

### D1. O3: Recovery-on-Metal-error in batch step

When `notify_stream_error` fires via the `8c514a1a` path, oMLX
currently fails the whole batch step. Fix: mark only that request
failed, rebuild the remaining-sequences batch, continue.

**Files:** `omlx/scheduler.py`, `omlx/engine/batched.py`

**Failing test:**
```python
def test_batch_partial_recovery(mock_metal_error):
    # Inject a Metal error for sequence 0 of a 4-sequence batch.
    # Assert: sequence 0 returns error, sequences 1-3 return results.
```

---

### D2. O2: Per-model concurrency caps

```yaml
# In oMLX config / CLI
per_model_max_concurrent:
  qwen3-8b: 1
  granite-3b: 4
```

**Files:** `omlx/settings.py`, `omlx/scheduler.py`

Useful for operators who accept lower concurrency on heavy models
to protect light models' throughput.

---

### D3. O1: `--isolate-models` (spawn-per-model mode)

**Only implement if Phase C benchmark gate is not met.**

oMLX manages N child processes on adjacent ports; parent is a thin
router forwarding by `model` field. Risk: process lifecycle
management is non-trivial (readiness probe, restart on failure,
graceful shutdown, log multiplexing). Do not start without a clear
Phase C benchmark result justifying it.

---

## Phase E — llamactl polish (deferred)

### E1. L3: `kind: Fleet` abstraction

Single Fleet spec expands to N ModelHost manifests with shared
`family`/`binary`/`env`. Defer until at least 3 independent
use-cases demand it beyond the current three-model Fleet L setup.
The current explicit manifests are understandable and commit-diff
friendly.

---

## Open questions — decisions needed before C1/C2

| # | Question | Recommended answer |
|---|---|---|
| Q1 | Metal driver queue limit on M4 base (10-core GPU) vs M-series Max? | Run `metal_feature_set_families` probe; cap `unordered_map` at 64 per process to be safe |
| Q2 | Does mlx-lm need changes for M1? | No — single thread-local stream per worker still works; stream gets its own queue automatically |
| Q3 | M1+M2 as one PR or two? | One PR, two commits (see AD-3) |
| Q4 | O1 still needed after M1/M2? | Benchmark gate in C2 decides (see Phase C benchmark gate) |
| Q5 | Fold back-pressure into exception-safety PR? | No — keep separate (see AD-6) |
| Q6 | CI strategy for M1/M2 Metal tests? | Gate behind `MLX_BUILD_METAL` flag; existing pattern; no new CI infra needed |

---

## Dispatch-ready task cards

```
Task A1 — M4 Stream generation counter
  files: mlx/stream.h, mlx/stream.cpp, mlx/backend/metal/eval.cpp
  test: tests/stream_tests.cpp::StreamGeneration::*
  exit: generation mismatch rejects stale errors; all existing tests pass

Task A2 — M5 MLX_METAL_MAX_OPS_PER_BUFFER env knob
  files: mlx/backend/metal/device.cpp (~line 445)
  test: env-parsing unit in existing device tests
  exit: default behavior unchanged when unset; 20-op limit enforced when set

Task A3 — O4 upstream PR for --max-completion-batch-size
  files: omlx/settings.py, omlx/cli.py, tests/test_settings.py (oMLX repo)
  exit: PR opened against jundot/omlx with settings round-trip test

Task A4 — L2 env field on ModelHost manifest
  files: packages/remote/src/workload/modelhost-schema.ts + spawn logic
  test: packages/remote/src/workload/modelhost-schema.test.ts
  exit: bun test green; env field passed through to child process

Task B0 — Scheduler gate TDD (CPU-only)
  files: mlx/scheduler.h, mlx/scheduler.cpp, tests/scheduler_tests.cpp
  exit: gate limit/release/close/stale-generation tests red→green on CPU build

Task B1 — Wire gate into Metal eval path
  files: mlx/backend/metal/eval.cpp
  test: tests/gpu_tests.cpp::MetalBackPressure::ConcurrentStreamsUnderLimitCompleteWithoutError
  exit: concurrent eval under limit=1 produces 0 Metal errors on M4 host

Task B2 — Env var config
  files: mlx/utils.h (or mlx/utils.cpp)
  test: env-parsing unit for MLX_METAL_MAX_INFLIGHT_PER_STREAM
  exit: unset=unlimited, >0=throttled, negative=unlimited

Task B3 — Docs + upstream PR + mac-mini production validation
  deliverable: PR opened against ml-explore/mlx; mac-mini mcr=4 bench shows 0 errors

Task C0 — M3 Stream::tag field
  files: mlx/stream.h, mlx/stream.cpp
  exit: tag optional field accessible; default empty; existing tests unaffected

Task C1 — M1 per-stream CommandQueue
  files: mlx/backend/metal/device.h, device.cpp, eval.cpp
  test: MetalDevice::IndependentStreamsDontSerializeOnCommandQueue
  exit: concurrent 2-stream bench <1.5× serial wall time

Task C2 — M2 per-stream ResidencySet + benchmark gate
  files: mlx/backend/metal/resident.h, device.cpp
  exit: 3-model oMLX bench on mac-mini at mcr=4, 1 process: ≤10% error rate,
        throughput within 15% of 3-process baseline

Task D1 — O3 recovery-on-Metal-error
  files: omlx/scheduler.py, omlx/engine/batched.py
  test: test_batch_partial_recovery
  exit: single-sequence failure does not abort the rest of the batch

Task D2 — O2 per-model concurrency caps
  files: omlx/settings.py, omlx/scheduler.py
  exit: per_model_max_concurrent config parsed and enforced in admission

Task D3 — O1 --isolate-models (contingent on C2 benchmark gate)
  trigger: only if C2 benchmark gate is NOT met
```
