# MLX Metal Back-Pressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest safe per-stream back-pressure gate to MLX's Metal backend so multi-model concurrency stops overcommitting Metal command buffers on small GPUs.

**Architecture:** Keep the throttle on the GPU eval path, not in higher-level callers. Reuse the existing `mlx::core::scheduler` as the coordination point, but add a separate per-stream in-flight gate so completion-handler bookkeeping and back-pressure share the same stream identity without mixing concerns. The unthrottled path must remain the default: if no threshold env var is set, behavior should match today except for the new safety checks and tests.

**Tech Stack:** C++17, MLX core/backend Metal code, existing scheduler/stream primitives, env-var parsing already used by MLX.

---

### Task 1: Prove the saturation case with a failing stress test

**Files:**
- Create: `tests/backend/metal/back_pressure_test.cpp`
- Modify: `tests/backend/metal/CMakeLists.txt` or the upstream Metal test registration file that already lists backend tests

- [ ] **Step 1: Write the failing test**

```cpp
TEST(MetalBackPressure, MultipleConcurrentStreamsNeedAThrottle) {
  // Use a tiny kernel / small matmul or add a test helper that submits work
  // on several streams at once.
  //
  // The test should assert that four concurrent submissions on a small-GPU
  // stress configuration do not all fail once the throttle exists.
  // Before the implementation, the test should fail by observing Metal
  // command-buffer errors or a missing wait/limit mechanism.
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `ctest -R MetalBackPressure -V`

Expected: fail with Metal command-buffer errors or the missing gate assertion.

- [ ] **Step 3: Keep the test synthetic and deterministic**

Use a helper that submits a small GPU workload repeatedly across several streams and waits only after a known number of commits. Prefer a tiny compute primitive already used in Metal tests over a large real model load; the goal is to reproduce queue pressure, not benchmark model quality.

- [ ] **Step 4: Re-run the test**

Run: `ctest -R MetalBackPressure -V`

Expected: still failing until the back-pressure gate exists.

### Task 2: Add the per-stream in-flight gate in scheduler + eval

**Files:**
- Modify: `mlx/scheduler.h`
- Modify: `mlx/backend/metal/eval.cpp`

- [ ] **Step 1: Write the failing test for the new gate behavior**

```cpp
TEST(MetalBackPressure, RespectsPerStreamInflightLimit) {
  // Set MLX_METAL_MAX_INFLIGHT_PER_STREAM=1.
  // Submit two commits on the same stream before the first completion drains.
  // Expect the second submission path to block until completion rather than
  // issuing a second in-flight command buffer.
}
```

- [ ] **Step 2: Run it and confirm the failure**

Run: `MLX_METAL_MAX_INFLIGHT_PER_STREAM=1 ctest -R MetalBackPressure -V`

Expected: fails because the gate is not implemented yet.

- [ ] **Step 3: Implement the smallest gate**

Add a per-stream counter plus a condition variable/mutex pair in `Scheduler`. Increment before `encoder.commit()` only for committed command buffers. Decrement inside the completed-handler path after the existing asynchronous error stash is published. Keep the gate keyed by `stream.index` so it composes with existing stream reuse behavior.

Add a small wait helper in `eval.cpp` before `encoder.commit()` that:
- no-ops when the env var is unset or invalid
- waits while the stream's in-flight count is at or above the threshold
- uses a timeout fallback so a wedged GPU does not deadlock the caller
- wakes on completion and re-checks the stream error stash before retrying

- [ ] **Step 4: Re-run the failing test**

Run: `MLX_METAL_MAX_INFLIGHT_PER_STREAM=1 ctest -R MetalBackPressure -V`

Expected: pass.

### Task 3: Wire the env var and keep the default path unchanged

**Files:**
- Modify: `mlx/backend/metal/eval.cpp`
- Modify: `mlx/scheduler.h`
- Modify: `docs/` upstream docs file for Metal back-pressure, if the upstream repo keeps runtime knobs documented there

- [ ] **Step 1: Write the failing test for default behavior**

```cpp
TEST(MetalBackPressure, UnsetEnvKeepsDefaultThroughputPath) {
  // With the env var unset, a single-stream eval path should not take any
  // throttle wait and should still complete successfully.
}
```

- [ ] **Step 2: Run it and confirm it fails if the code regresses**

Run: `ctest -R MetalBackPressure -V`

Expected: catches any accidental default-path slowdown or unconditional waiting.

- [ ] **Step 3: Implement env parsing**

Read `MLX_METAL_MAX_INFLIGHT_PER_STREAM` once on first use. Treat missing, zero, negative, and malformed values as "disabled" so the default remains identical to current behavior. Do not add a second knob or a config struct.

- [ ] **Step 4: Re-run the test suite**

Run:

```bash
ctest -R MetalBackPressure -V
ctest -R Metal -V
```

Expected: both pass, with no new failures in existing Metal tests.

### Task 4: Verify shutdown, sync ordering, and stream reuse

**Files:**
- Modify: `tests/backend/metal/back_pressure_test.cpp`
- Modify: `mlx/backend/metal/eval.cpp`
- Modify: `mlx/scheduler.h`

- [ ] **Step 1: Write tests for the edge cases that matter**

```cpp
TEST(MetalBackPressure, ClearOnStreamReuse) {
  // Create a stream, force a completion-path error or queued work, destroy it,
  // recreate the same stream index, and confirm stale state is cleared.
}

TEST(MetalBackPressure, SynchronizeStillSurfacesStashedErrors) {
  // Ensure mx::synchronize() still rethrows the first stashed error and does
  // not get masked by the back-pressure wait path.
}
```

- [ ] **Step 2: Run the focused tests**

Run: `ctest -R "MetalBackPressure|Synchronize" -V`

Expected: one or more failures if stale state or sync ordering regresses.

- [ ] **Step 3: Implement the minimum cleanup**

Clear the per-stream gate state alongside the existing stream-error cleanup on stream teardown / backend reset. Keep `throw_if_stream_error()` at the synchronous waitpoints so back-pressure never hides an actual Metal failure.

- [ ] **Step 4: Re-run focused and full Metal tests**

Run:

```bash
ctest -R "MetalBackPressure|Synchronize" -V
ctest -R Metal -V
```

Expected: pass.

### Task 5: Document the knob and upstream patch intent

**Files:**
- Modify: `docs/upstream-patches/back-pressure-design-prompt.md` or the upstream PR notes file
- Modify: the upstream MLX docs page for Metal runtime knobs, if available

- [ ] **Step 1: Write the documentation check**

```text
The docs must say:
- what MLX_METAL_MAX_INFLIGHT_PER_STREAM does
- that unset means no throttle
- that `1` is the recommended conservative setting on small GPUs
- that this is a per-stream ceiling, not a global queue limit
```

- [ ] **Step 2: Update the docs**

Keep it short. Document the new variable where Metal runtime knobs already live instead of inventing a new configuration section.

- [ ] **Step 3: Final verification**

Run:

```bash
ctest -R MetalBackPressure -V
ctest -R Metal -V
```

Expected: all pass, and the docs match the implemented behavior.

### Recommended Sprint Sequence

1. Land Task 1 first so the regression is real and visible.
2. Land Task 2 next with the smallest scheduler/eval change that makes the test pass.
3. Land Task 3 only after the default path is confirmed unchanged.
4. Land Task 4 to prove the patch does not break shutdown, stream reuse, or sync ordering.
5. Land Task 5 last so the upstream patch text stays aligned with the code.

