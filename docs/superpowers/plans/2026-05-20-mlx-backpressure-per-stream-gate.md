# MLX per-stream in-flight command-buffer gate — Phased TDD Plan

> **For agentic workers:** Use `penumbra:executing-plans` or `penumbra:dispatching` to run this plan task-by-task.

**Date:** 2026-05-20

**Goal:** Add a per-stream back-pressure gate to MLX's Metal backend (`ml-explore/mlx`) so
that high concurrency on a multi-model oMLX server no longer triggers Metal command-buffer
resource exhaustion. The deliverable in this repo is a unified-diff patch file plus a PR
description doc.

**Predecessor patch:** `docs/upstream-patches/mlx-exception-safe-completion-handler-2670.patch`
must already be applied to the atomic-fork branch before this patch is generated. The gate
composes with that patch's `notify_stream_error` / `throw_if_stream_error` error flow.

**Upstream working tree:** `frozename/atomic-llama-cpp-turboquant` →
`fix/gemma4-swa-full-cache-reuse-steady-state`. All `mlx/` paths below are relative to that
repo's root.

**Repo-local deliverables (llamactl only):**
- `docs/upstream-patches/mlx-backpressure-per-stream-gate.patch`
- `docs/upstream-patches/mlx-backpressure-pr-description.md`

---

## Phase 0 — Failing stressor tests

Dispatch graph: `0.1`

### Task 0.1 — Create failing back-pressure test file

```yaml meta
id: "0.1"
files:
  - mlx/tests/test_metal_backpressure.cpp
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Failing test** — create `mlx/tests/test_metal_backpressure.cpp` with three test cases:

```cpp
// TEST 1 — gate blocks a second acquire on the same stream at limit=1.
// Setup: acquire one slot on stream s with limit=1.
// Action: in a second thread, acquire again.
// Assert: second thread does not return within 50 ms.
// Then: release the first slot.
// Assert: second thread completes within 200 ms.
TEST(MetalBackPressure, StreamGateBlocksAtLimit) { ... }

// TEST 2 — hot-path regression guard.
// Loop 10 000 times: acquire(stream, INT_MAX) + release(stream).
// Assert: loop finishes in under 5 ms on an M-series Mac.
TEST(MetalBackPressure, StreamGateFastPathThroughput) { ... }

// TEST 3 — timeout injects a stream error.
// Setup: hold limit=1 on stream s.
// Action: second acquire with timeout=1 s.
// Assert: throw_if_stream_error(s) fires with message containing "backpressure timeout".
TEST(MetalBackPressure, StreamGateTimeoutInjectsStreamError) { ... }
```

Tests must not require Metal hardware — use only thread joins, timed waits, and a
synthetic harness. Do not allocate MLX arrays.

**Verify:**
```bash
cd /path/to/atomic-mlx/build
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
```
Expected: compile or link failure because `acquire_stream_slot` / `release_stream_slot`
do not exist yet.

Integration: commit the test file to the atomic-fork branch; no llamactl changes in this
phase.

---

## Phase 1 — Gate implementation

Dispatch graph: `1.1 → 1.2`

### Task 1.1 — Add gate state and API to `Scheduler`

```yaml meta
id: "1.1"
files:
  - mlx/scheduler.h
file_scope: modify-existing
depends_on: ["0.1"]
parallel_with: []
preferred_agent: gemini-acp-flash
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

**Failing test:** all three Phase 0 tests remain red until this task completes.

**Implementation** — add alongside the existing `stream_error_` members (added by the
predecessor exception-safety patch):

```cpp
// per-stream in-flight counter
std::unordered_map<int, int> stream_inflight_;
std::condition_variable      inflight_cv_;
std::mutex                   inflight_mtx_;   // MUST stay separate from error_mtx_
```

Add member methods and free-function wrappers in the `scheduler` namespace:

```cpp
// limit == INT_MAX → unbounded (default); still counts for the cv path
void acquire_stream_slot(const Stream& s, int limit, int timeout_secs = 30);
void release_stream_slot(const Stream& s);
```

Behaviour contracts:
- **Unbounded path** (`limit == INT_MAX`): increment counter, return immediately (one
  `inflight_mtx_` acquire — zero wait).
- **Finite limit**: `while (count >= limit)` wait on `inflight_cv_`; on timeout call
  `notify_stream_error(s, "[MLX] backpressure timeout")`.
- `release_stream_slot` always decrements and calls `inflight_cv_.notify_all()`.
- `inflight_mtx_` must remain separate from `error_mtx_` to prevent nested-lock deadlock
  when the timeout handler calls `notify_stream_error`, which acquires `error_mtx_`.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
```
Expected: the three unit tests from Phase 0 pass.

---

### Task 1.2 — Wire acquire/release around `encoder.commit()` in Metal eval

```yaml meta
id: "1.2"
files:
  - mlx/backend/metal/eval.cpp
  - mlx/tests/test_metal_backpressure.cpp
file_scope: modify-existing
depends_on: ["1.1"]
parallel_with: []
preferred_agent: gemini-acp-flash
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

**Failing test** — extend `test_metal_backpressure.cpp`:

```cpp
// ConcurrentStreamsRespectLimit: set MLX_METAL_MAX_INFLIGHT_PER_STREAM=1.
// Launch 8 concurrent mx.eval() calls across multiple streams in separate threads.
// Assert: zero Metal errors thrown, all results complete.
TEST(MetalBackPressure, ConcurrentStreamsRespectLimit) { ... }
```

**Implementation** — in both `eval()` and `finalize()`, immediately before every
`encoder.commit()` call:

```cpp
scheduler::acquire_stream_slot(s, std::numeric_limits<int>::max());
```

In every `addCompletedHandler` callback, enforce this ordering:

```cpp
check_error(s, cbuf);                  // 1. stash error first
scheduler::release_stream_slot(s);     // 2. open gate after error is stashed
scheduler::notify_task_completion(s);  // 3. wake task waiters last
```

**Why ordering matters:** releasing before `check_error` creates a race — a woken thread
can call `throw_if_stream_error`, see nothing, commit new work, and discover the stashed
error one eval later, breaking per-request error correlation (same invariant as the
predecessor patch).

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
python - <<'PY'
import mlx.core as mx, threading
def work(): mx.eval(mx.ones((4096,4096)) @ mx.ones((4096,4096)))
ts = [threading.Thread(target=work) for _ in range(4)]
[t.start() for t in ts]; [t.join() for t in ts]
print("ok")
PY
```
Expected: all back-pressure tests pass; Python smoke prints `ok` (unthrottled path
unchanged).

Integration: run `./mlx_tests "[backpressure]"` on M4 Pro before merging Phase 2. The
unthrottled hot path must show no measurable regression on the throughput test.

---

## Phase 2 — Env-var configuration

Dispatch graph: `2.1`

### Task 2.1 — Add `read_inflight_limit` / `read_backpressure_timeout` helpers

```yaml meta
id: "2.1"
files:
  - mlx/backend/metal/eval.cpp
  - mlx/tests/test_metal_backpressure.cpp
file_scope: modify-existing
depends_on: ["1.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Failing test** — extend `test_metal_backpressure.cpp`:

```cpp
TEST(MetalBackPressure, EnvVarSetsLimit) {
  setenv("MLX_METAL_MAX_INFLIGHT_PER_STREAM", "2", 1);
  ASSERT_EQ(read_inflight_limit(), 2);
  unsetenv("MLX_METAL_MAX_INFLIGHT_PER_STREAM");
  ASSERT_EQ(read_inflight_limit(), std::numeric_limits<int>::max());
}
```

**Implementation** — file-scope statics in `eval.cpp`:

```cpp
static int read_inflight_limit() {
  const char* v = std::getenv("MLX_METAL_MAX_INFLIGHT_PER_STREAM");
  if (!v || !*v) return std::numeric_limits<int>::max();
  char* end; long n = std::strtol(v, &end, 10);
  return (*end || n <= 0 || n > 65536) ? std::numeric_limits<int>::max() : (int)n;
}

static int read_backpressure_timeout() {
  const char* v = std::getenv("MLX_METAL_BACKPRESSURE_TIMEOUT_SECS");
  if (!v || !*v) return 30;
  char* end; long n = std::strtol(v, &end, 10);
  return (*end || n <= 0) ? 30 : (int)n;
}
```

Replace the hard-coded `INT_MAX` / `30` literals at each acquire site with calls to
`read_inflight_limit()` / `read_backpressure_timeout()`.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
MLX_METAL_MAX_INFLIGHT_PER_STREAM=1 ./mlx_tests "ConcurrentStreamsRespectLimit"
```
Expected: all five back-pressure tests pass (StreamGateBlocksAtLimit,
StreamGateFastPathThroughput, StreamGateTimeoutInjectsStreamError,
ConcurrentStreamsRespectLimit, EnvVarSetsLimit).

Integration: run the full `mlx_tests` suite before starting Phase 3 to confirm no
regressions in unrelated Metal eval tests.

---

## Phase 3 — Repo artifacts (patch + PR description)

Dispatch graph: `3.1 ∥ 3.2`

### Task 3.1 — Export upstream patch artifact to llamactl

```yaml meta
id: "3.1"
files:
  - docs/upstream-patches/mlx-backpressure-per-stream-gate.patch
file_scope: new
depends_on: ["2.1"]
parallel_with: ["3.2"]
preferred_agent: claude-acp-haiku
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test:**
```bash
test -f docs/upstream-patches/mlx-backpressure-per-stream-gate.patch
```

**Implementation** — from the atomic-fork MLX checkout:

```bash
git format-patch origin/main --stdout -- \
  mlx/scheduler.h \
  mlx/backend/metal/eval.cpp \
  mlx/tests/test_metal_backpressure.cpp \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-backpressure-per-stream-gate.patch
```

**Verify:**
```bash
# From a clean MLX main checkout
patch --dry-run -p1 \
  < /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-backpressure-per-stream-gate.patch
```
Expected: all hunks apply cleanly with no fuzz.

---

### Task 3.2 — Write upstream PR description doc

```yaml meta
id: "3.2"
files:
  - docs/upstream-patches/mlx-backpressure-pr-description.md
file_scope: new
depends_on: ["2.1"]
parallel_with: ["3.1"]
preferred_agent: claude-acp-haiku
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test:**
```bash
test -f docs/upstream-patches/mlx-backpressure-pr-description.md
```

**Implementation** — create `docs/upstream-patches/mlx-backpressure-pr-description.md`
with these sections:

- **Motivation** — multi-model Metal on M4 base / small M-series hardware overcommits
  wired command-buffer resources under concurrent requests; evidence from mac-mini 16 GB
  testing (3 models loaded, `--max-concurrent-requests=4` triggers exhaustion).
- **Change summary** — `Scheduler` gate (`stream_inflight_` counter + `inflight_cv_` +
  `inflight_mtx_`); `eval.cpp` acquire/release wiring in `eval()` and `finalize()`; two
  env-var knobs.
- **Interaction with patch #2670** — timeout errors reuse `notify_stream_error` +
  `throw_if_stream_error`; ordering invariant: `check_error` → `release_stream_slot` →
  `notify_task_completion`.
- **Performance** — unthrottled (default) path adds one `inflight_mtx_` lock per commit;
  `inflight_cv_` uncontended; `StreamGateFastPathThroughput` test guards this.
- **Tests** — `mlx/tests/test_metal_backpressure.cpp`: 5 tests covering blocking,
  hot-path throughput, timeout injection, concurrent-stream correctness, env-var parsing.
- **Known limitations** — stream map cleanup on thread teardown (shutdown safety) and
  cross-process gating are out of scope.
- **Env vars** (also add as `.. envvar::` entries to `docs/env_vars.rst` if that file
  exists in the upstream tree):

```rst
.. envvar:: MLX_METAL_MAX_INFLIGHT_PER_STREAM

   Maximum number of command buffers allowed in-flight simultaneously on a single Metal
   stream. Default: unbounded. Recommended value for M4 base with 3+ loaded models: ``1``.

.. envvar:: MLX_METAL_BACKPRESSURE_TIMEOUT_SECS

   Seconds to wait for a free stream slot before injecting a
   ``[MLX] backpressure timeout`` error into the stream. Default: ``30``.
```

**Verify:**
```bash
test -f docs/upstream-patches/mlx-backpressure-pr-description.md
```

Integration: commit both `3.1` and `3.2` artifacts in a single llamactl commit; verify
`git status --short docs/upstream-patches/` shows only the two new files.

---

## Design decisions

| Question | Decision |
|---|---|
| `cv+mutex` vs semaphore | `cv + mutex` — integrates with existing `notify_stream_error` call pattern; no new OS primitive needed |
| Gate location: `eval()` vs `mlx_lm.generate` | `eval.cpp` — must be at the Metal commit site to cover all callers uniformly |
| Counter on stream vs on encoder | On `Scheduler` keyed by `stream.id` — consistent with where `stream_error_` lives; `CommandEncoder` is per-commit, not persistent |
| `inflight_mtx_` separate from `error_mtx_` | Required: timeout path calls `notify_stream_error` (acquires `error_mtx_`) while holding `inflight_mtx_` — same mutex would deadlock |
| Default unbounded | Required: single-model fast path must see zero wait; env-var opt-in preserves upstream acceptability |
