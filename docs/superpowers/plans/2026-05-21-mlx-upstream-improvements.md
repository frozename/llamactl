# MLX + oMLX Upstream Improvements — Phased TDD Plan

> **For agentic workers:** Use `penumbra:executing-plans` or `penumbra:dispatching` to run this plan task-by-task.

**Date:** 2026-05-21

**Goal:** Ship a second wave of MLX/oMLX improvements that make multi-model coexistence on Apple
Silicon clean without requiring per-process workarounds. Four phases: Phase A ships the small
upstream-PR-able items (Stream generation counter, GPU-watchdog env knob, oMLX batch-size PR,
llamactl `env` field); Phase B ships the load-bearing MLX per-stream isolation (Stream tag, per-stream
`MTL::CommandQueue`, per-stream `MTL::ResidencySet`); Phase C improves oMLX recovery and concurrency
control; Phase D adds the llamactl Fleet abstraction.

**Predecessor patches (already on `fix/exception-safe-completion-handler` in `/Volumes/WorkSSD/src/mlx-fix`):**

- `8c514a1a` — exception-safe Metal command-buffer error handling (v3, validated)
- `982ef62d` — per-stream in-flight back-pressure gate (validated unit-only)

**Evidence chain:**

- 3 × 8B-class MLX models in one oMLX process @ `mcr=1` → 0 errors, 1041 s wall.
- Same @ `mcr=2/4` → ~100% failures: `kIOGPUCommandBufferCallbackErrorTimeout`.
- Back-pressure gate at `limit=1` keeps process alive but GPU still times out (intra-buffer contention).
- `--max-completion-batch-size 1` doesn't help (inter-model context switching is the floor).
- **Three separate oMLX processes (one per model, `mcr=4` each)** → 0 errors, identical quality. Per-process Metal context isolation is the architectural unlock.

**Upstream working trees:**

- MLX core: `/Volumes/WorkSSD/src/mlx-fix` (`fix/exception-safe-completion-handler` branch)
- oMLX: `/Volumes/WorkSSD/src/omlx` (local fork of `jundot/omlx`)

**Llamactl deliverables per phase** — patches, PR descriptions, schema changes, and workload
templates all land in this repo under `docs/upstream-patches/` or `packages/`.

---

## Phase A — Small upstream-PR-able items

Dispatch graph: `A.1 ∥ A.2 ∥ A.3 ∥ A.4`

> All four tasks are independent. Run in parallel.

---

### Task A.1 — M4: Stream generation counter

```yaml meta
id: "A.1"
files:
  - docs/upstream-patches/mlx-stream-generation-counter.patch
  - docs/upstream-patches/mlx-stream-generation-pr-description.md
file_scope: new
depends_on: []
parallel_with: ["A.2", "A.3", "A.4"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Context:** The exception-safety patch (`8c514a1a`) captures a `stream.index` in a Metal completion
handler closure. If the stream is destroyed and a new stream reuses the same index before the
handler fires, the error is stashed against the wrong (new) incarnation. Adding a `uint64_t
generation` field to `Stream` and checking it in `notify_stream_error` / `throw_if_stream_error`
closes this window. Identified as a HIGH finding in the adversarial review of v3.

**Failing test** — add to `mlx/tests/test_metal_backpressure.cpp` (or a new
`mlx/tests/test_stream_generation.cpp`):

```cpp
// TEST: stale-stream error does not land on new incarnation.
// 1. Create stream S1, capture its {index, generation}.
// 2. Destroy S1. Create a new stream S2 that reuses S1's index.
// 3. Call notify_stream_error({index=S1.index, generation=S1.generation}, "stale").
// 4. Assert throw_if_stream_error(S2) does NOT throw (generation mismatch).
// 5. Assert throw_if_stream_error(S1_meta) DOES throw when generation matches.
TEST(StreamGeneration, StaleCompletionHandlerDoesNotPolluteLiveStream) { ... }
```

Tests must not require Metal hardware — drive through the `Scheduler` API directly.

**Implementation** — in `/Volumes/WorkSSD/src/mlx-fix`:

1. `mlx/stream.h` — add `uint64_t generation = 0;` to the `Stream` struct.
2. `mlx/stream.cpp` (`new_stream` / `gpu::new_stream`) — bump a process-global `std::atomic<uint64_t>
stream_generation_counter_` and set `s.generation` on allocation.
3. `mlx/scheduler.h` — extend `stream_error_` map from `unordered_map<int, string>` to
   `unordered_map<int, pair<uint64_t, string>>` (generation + message).
4. `mlx/scheduler.cpp` — in `notify_stream_error(s, msg)`: store `{s.generation, msg}`.
   In `throw_if_stream_error(s)`: only throw if stored generation == `s.generation`; otherwise
   silently drop and erase.

**Verify:**

```bash
cd /Volumes/WorkSSD/src/mlx-fix/build
cmake --build . -t mlx_tests && ./mlx_tests "[StreamGeneration]"
```

Expected: `StaleCompletionHandlerDoesNotPolluteLiveStream` passes; all prior back-pressure tests
still pass.

**Artifact export:**

```bash
cd /Volumes/WorkSSD/src/mlx-fix
git format-patch origin/main --stdout -- \
  mlx/stream.h mlx/stream.cpp mlx/scheduler.h mlx/scheduler.cpp mlx/tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-stream-generation-counter.patch
```

**Verify artifact:**

```bash
test -s docs/upstream-patches/mlx-stream-generation-counter.patch
```

Integration: commit both the patch and PR description to llamactl in one commit. The PR description
(`mlx-stream-generation-pr-description.md`) must cover: motivation (stale-index race), API shape
(`Stream.generation`), interaction with `notify_stream_error`, and the test.

---

### Task A.2 — M5: GPU-watchdog env knob

```yaml meta
id: "A.2"
files:
  - docs/upstream-patches/mlx-metal-max-ops-per-buffer-env.patch
  - docs/upstream-patches/mlx-metal-max-ops-per-buffer-pr-description.md
file_scope: new
depends_on: []
parallel_with: ["A.1", "A.3", "A.4"]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Context:** `Device` already has `max_ops_per_buffer_ = 40` and `max_mb_per_buffer_ = 40` in
`mlx/backend/metal/device.cpp:445-448`. These are static and don't shrink under multi-stream
load. Exposing `MLX_METAL_MAX_OPS_PER_BUFFER` and `MLX_METAL_MAX_MB_PER_BUFFER` env vars lets
operators dial them down on small M-series GPUs without a rebuild.

**Failing test** — new `mlx/tests/test_metal_device_knobs.cpp`:

```cpp
TEST(MetalDeviceKnobs, MaxOpsPerBufferEnvVar) {
  setenv("MLX_METAL_MAX_OPS_PER_BUFFER", "20", 1);
  // Re-initialize or call the reader function directly.
  ASSERT_EQ(read_max_ops_per_buffer(), 20);
  unsetenv("MLX_METAL_MAX_OPS_PER_BUFFER");
  ASSERT_EQ(read_max_ops_per_buffer(), 40);  // default
}

TEST(MetalDeviceKnobs, MaxMbPerBufferEnvVar) {
  setenv("MLX_METAL_MAX_MB_PER_BUFFER", "10", 1);
  ASSERT_EQ(read_max_mb_per_buffer(), 10);
  unsetenv("MLX_METAL_MAX_MB_PER_BUFFER");
  ASSERT_EQ(read_max_mb_per_buffer(), 40);
}

TEST(MetalDeviceKnobs, InvalidEnvVarFallsBackToDefault) {
  setenv("MLX_METAL_MAX_OPS_PER_BUFFER", "notanumber", 1);
  ASSERT_EQ(read_max_ops_per_buffer(), 40);
  unsetenv("MLX_METAL_MAX_OPS_PER_BUFFER");
}
```

**Implementation** — in `mlx/backend/metal/device.cpp`:

```cpp
static int read_max_ops_per_buffer() {
  const char* v = std::getenv("MLX_METAL_MAX_OPS_PER_BUFFER");
  if (!v || !*v) return 40;
  char* end; long n = std::strtol(v, &end, 10);
  return (*end || n <= 0 || n > 4096) ? 40 : (int)n;
}

static int read_max_mb_per_buffer() {
  const char* v = std::getenv("MLX_METAL_MAX_MB_PER_BUFFER");
  if (!v || !*v) return 40;
  char* end; long n = std::strtol(v, &end, 10);
  return (*end || n <= 0 || n > 65536) ? 40 : (int)n;
}
```

Replace the hard-coded `40` literals at the `max_ops_per_buffer_` / `max_mb_per_buffer_`
initialization sites with calls to `read_max_ops_per_buffer()` / `read_max_mb_per_buffer()`.

**Verify:**

```bash
cmake --build . -t mlx_tests && ./mlx_tests "[MetalDeviceKnobs]"
```

**Artifact export:**

```bash
git format-patch origin/main --stdout -- \
  mlx/backend/metal/device.cpp mlx/tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-metal-max-ops-per-buffer-env.patch
```

**Verify artifact:**

```bash
test -s docs/upstream-patches/mlx-metal-max-ops-per-buffer-env.patch
```

Integration: commit both files in one llamactl commit. PR description must include recommended
values for M4 base (try `MLX_METAL_MAX_OPS_PER_BUFFER=20` as a first dial before the per-stream
queue work lands).

---

### Task A.3 — O4: `--max-completion-batch-size` upstream PR for oMLX

```yaml meta
id: "A.3"
files:
  - docs/upstream-patches/omlx-max-completion-batch-size.patch
  - docs/upstream-patches/omlx-max-completion-batch-size-pr-description.md
file_scope: new
depends_on: []
parallel_with: ["A.1", "A.2", "A.4"]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Context:** `--max-completion-batch-size` was implemented locally in this session (~12 lines across
`omlx/settings.py` and `omlx/cli.py` in `/Volumes/WorkSSD/src/omlx`). It needs a clean diff plus a
unit test on the settings round-trip before opening an upstream PR to `jundot/omlx`.

**Failing test** — add to `tests/test_settings.py` (or equivalent oMLX test file):

```python
def test_max_completion_batch_size_default():
    cfg = SchedulerConfig()
    assert cfg.max_completion_batch_size is None  # or system default

def test_max_completion_batch_size_round_trip():
    cfg = SchedulerConfig(max_completion_batch_size=1)
    assert cfg.max_completion_batch_size == 1

def test_max_completion_batch_size_cli_parse(tmp_path):
    # Verify the CLI flag is wired: parse argv with --max-completion-batch-size 1
    # and assert the resulting SchedulerConfig carries the value.
    from omlx.cli import build_config
    cfg = build_config(["serve", "--model-dir", str(tmp_path),
                        "--max-completion-batch-size", "1"])
    assert cfg.scheduler.max_completion_batch_size == 1
```

**Implementation** — in `/Volumes/WorkSSD/src/omlx`:

1. Confirm `omlx/settings.py` has `max_completion_batch_size: int | None = None` on `SchedulerConfig`.
2. Confirm `omlx/cli.py` has `--max-completion-batch-size` flag wired to that field.
3. Write the three test cases above.

**Verify:**

```bash
cd /Volumes/WorkSSD/src/omlx
python -m pytest tests/test_settings.py -k "max_completion_batch_size" -v
```

Expected: three tests pass.

**Artifact export:**

```bash
cd /Volumes/WorkSSD/src/omlx
git diff origin/main -- omlx/settings.py omlx/cli.py tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/omlx-max-completion-batch-size.patch
```

**Verify artifact:**

```bash
test -s docs/upstream-patches/omlx-max-completion-batch-size.patch
```

Integration: commit both artifacts to llamactl. The PR description must note the `mcr=1` evidence
from mac-mini testing (confirmed no improvement on M4 base — inter-model context switching is
irreducible in one process) so upstream understands the motivation for the flag even if it isn't a
silver bullet.

---

### Task A.4 — L2: `env` field on ModelHost manifest schema

```yaml meta
id: "A.4"
files:
  - packages/remote/src/workload/modelhost-schema.ts
  - packages/remote/src/workload/spawn.ts
  - packages/remote/src/workload/modelhost-schema.test.ts
file_scope: modify-existing
depends_on: []
parallel_with: ["A.1", "A.2", "A.3"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: schema-aware
```

**Context:** ModelHost manifests currently have no way to declare per-process env vars. Operators
have to patch plist files to set `MLX_METAL_MAX_INFLIGHT_PER_STREAM`, `HF_HUB_OFFLINE`, etc. The
`env` field should merge into a `CHILD_ENV_ALLOWLIST` on spawn, keeping the daemon's ambient
environment clean.

**Failing test** — add to `packages/remote/src/workload/modelhost-schema.test.ts`:

```typescript
it("accepts env field with string values", () => {
  const raw = {
    kind: "ModelHost",
    name: "test-model",
    modelDir: "/tmp/model",
    env: { MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1", HF_HUB_OFFLINE: "1" },
  };
  const parsed = ModelHostSchema.parse(raw);
  expect(parsed.env).toEqual({
    MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1",
    HF_HUB_OFFLINE: "1",
  });
});

it("env field is optional — missing env parses cleanly", () => {
  const raw = { kind: "ModelHost", name: "test-model", modelDir: "/tmp/model" };
  const parsed = ModelHostSchema.parse(raw);
  expect(parsed.env).toBeUndefined();
});

it("rejects non-string env values", () => {
  const raw = {
    kind: "ModelHost",
    name: "test-model",
    modelDir: "/tmp/model",
    env: { KEY: 42 },
  };
  expect(() => ModelHostSchema.parse(raw)).toThrow();
});
```

**Verify (red):**

```bash
cd packages/remote && bun test --filter "env field"
```

Expected: compile or assertion failure because `env` is not in the schema.

**Implementation:**

1. `packages/remote/src/workload/modelhost-schema.ts` — add to the Zod schema:
   ```typescript
   env: z.record(z.string(), z.string()).optional(),
   ```
2. `packages/remote/src/workload/spawn.ts` (or wherever `ModelHost` processes are spawned) —
   when launching a child process, merge `spec.env ?? {}` with `CHILD_ENV_ALLOWLIST`:
   ```typescript
   const childEnv = {
     ...pick(process.env, CHILD_ENV_ALLOWLIST),
     ...(spec.env ?? {}),
   };
   // Pass childEnv as the `env` option to the child-process spawn call.
   ```

**Verify (green):**

```bash
cd packages/remote && bun test --filter "env field"
```

Expected: all three tests pass.

**Integration:** run the full `packages/remote` test suite:

```bash
bun test packages/remote
```

Expected: existing tests unaffected. Commit as a standalone llamactl commit.

---

Integration (Phase A): all four tasks are independent. Merge in any order after their individual
verify steps pass. No daemon restart needed for A.1/A.2/A.3 (artifact-only changes). A.4 requires
a daemon restart (`launchctl kickstart -k system/penumbra`) after deploy for the schema change to
take effect.

---

## Phase B — MLX per-stream isolation

Dispatch graph: `B.1 → B.2 ∥ B.3 → B.4`

> B.2 (per-stream CommandQueue) and B.3 (per-stream ResidencySet) both depend on B.1 (Stream tag)
> but are independent of each other and can fan out. B.4 (benchmark) gates on both.

---

### Task B.1 — M3: Stream `tag` field

```yaml meta
id: "B.1"
files:
  - docs/upstream-patches/mlx-stream-tag.patch
  - docs/upstream-patches/mlx-stream-tag-pr-description.md
file_scope: new
depends_on: ["A.1"]
parallel_with: []
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Context:** M1 (per-stream `CommandQueue`) and M2 (per-stream `ResidencySet`) need a way for
higher layers (oMLX, mlx-lm) to say "this stream belongs to model X" without inventing their own
keying. An `optional<string> tag` on `Stream` gives that without breaking existing callers.

**Failing test** — new `mlx/tests/test_stream_tag.cpp`:

```cpp
TEST(StreamTag, DefaultTagIsEmpty) {
  auto s = new_stream(Device::gpu);
  ASSERT_FALSE(s.tag.has_value());
}

TEST(StreamTag, TagRoundTrips) {
  Stream s = new_stream(Device::gpu);
  s.tag = "granite-3b";
  ASSERT_EQ(s.tag.value(), "granite-3b");
}

TEST(StreamTag, UntaggedAndTaggedStreamsDifferentiate) {
  Stream s1 = new_stream(Device::gpu);
  Stream s2 = new_stream(Device::gpu);
  s2.tag = "qwen3-8b";
  ASSERT_NE(s1.tag.has_value(), s2.tag.has_value());
}
```

**Implementation** — in `/Volumes/WorkSSD/src/mlx-fix`:

1. `mlx/stream.h` — add `std::optional<std::string> tag;` to the `Stream` struct (after
   `generation` added in A.1, keeping the struct layout stable).
2. No changes to `stream.cpp` — `tag` is value-initialized to `nullopt`.
3. No changes to `scheduler.cpp` or `eval.cpp` — the tag is informational only at this stage;
   M1/M2 wire it in B.2/B.3.

**Verify:**

```bash
cmake --build . -t mlx_tests && ./mlx_tests "[StreamTag]"
```

Expected: all three tag tests pass.

**Artifact export:**

```bash
git format-patch <A.1-commit>..HEAD --stdout -- mlx/stream.h mlx/tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-stream-tag.patch
```

Integration: this patch is intentionally tiny (~10 lines). PR description should note it is a
prerequisite for the per-stream CommandQueue and ResidencySet follow-on PRs.

---

### Task B.2 — M1: Per-stream `MTL::CommandQueue`

```yaml meta
id: "B.2"
files:
  - docs/upstream-patches/mlx-per-stream-command-queue.patch
  - docs/upstream-patches/mlx-per-stream-command-queue-pr-description.md
file_scope: new
depends_on: ["B.1"]
parallel_with: ["B.3"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: substantial
risk_class: schema-aware
```

**Context:** Today `mlx::core::metal::Device` holds ONE `MTL::CommandQueue` shared by every stream.
Two models' eval calls therefore queue-block each other at the driver level even when they use
different `Stream` objects. Refactoring to one queue per stream gives independent GPU command-list
managers. Risk: Metal has a driver-level limit (~256 queues per process on M4). The implementation
must bound growth by releasing queues when streams are destroyed.

**Failing test** — new `mlx/tests/test_per_stream_queue.cpp`:

```cpp
// Requires MLX_BUILD_METAL=ON; skip on CPU-only CI.
#ifdef MLX_METAL_ENABLED

TEST(PerStreamQueue, TwoStreamsGetDistinctQueues) {
  // Create two GPU streams and retrieve their MTL::CommandQueue pointers
  // via a test-friend accessor on Device. Assert they are not equal.
  auto& dev = metal::device(Device::gpu);
  auto s1 = new_stream(Device::gpu);
  auto s2 = new_stream(Device::gpu);
  ASSERT_NE(dev.queue_for_stream(s1), dev.queue_for_stream(s2));
}

TEST(PerStreamQueue, DestroyedStreamReleasesQueue) {
  auto& dev = metal::device(Device::gpu);
  size_t before = dev.active_queue_count();
  {
    auto s = new_stream(Device::gpu);
    ASSERT_EQ(dev.active_queue_count(), before + 1);
  }  // s destroyed here
  ASSERT_EQ(dev.active_queue_count(), before);
}

TEST(PerStreamQueue, DefaultStreamQueueExists) {
  auto& dev = metal::device(Device::gpu);
  auto s = default_stream(Device::gpu);
  ASSERT_NE(dev.queue_for_stream(s), nullptr);
}

#endif
```

CPU-only CI: gate with `#ifdef MLX_METAL_ENABLED` so the tests compile but are empty stubs on
Linux/CPU-only.

**Implementation** — in `/Volumes/WorkSSD/src/mlx-fix`:

1. `mlx/backend/metal/device.h` — replace:

   ```cpp
   NS::SharedPtr<MTL::CommandQueue> queue_;
   ```

   with:

   ```cpp
   std::unordered_map<int, NS::SharedPtr<MTL::CommandQueue>> stream_queues_;
   std::mutex stream_queue_mtx_;
   ```

   Add public accessors:

   ```cpp
   MTL::CommandQueue* queue_for_stream(const Stream& s);
   MTL::CommandQueue* get_or_create_queue(const Stream& s);
   void release_queue(const Stream& s);
   size_t active_queue_count() const;
   ```

2. `mlx/backend/metal/device.cpp` — implement:
   - `get_or_create_queue`: lock `stream_queue_mtx_`, look up `s.index`, create via
     `device_->newCommandQueue()` if absent, store and return.
   - `release_queue`: lock, erase from map, NS release.
   - Wire `get_or_create_queue` into `gpu::new_stream(s)` / `gpu::delete_stream(s)` lifecycle hooks.
   - `active_queue_count`: return `stream_queues_.size()`.

3. `mlx/backend/metal/eval.cpp` — replace every `device.queue_` reference with
   `device.get_or_create_queue(s)` (or `device.queue_for_stream(s)` where the queue already
   exists for the current stream).

4. `mlx/backend/metal/event.cpp` — any `queue_` references must be updated similarly.

**Queue-limit guard:** `get_or_create_queue` must assert (or log + return the device default queue
as fallback) when `stream_queues_.size() >= 200`. Document this cap in the PR.

**Verify:**

```bash
MLX_BUILD_METAL=ON cmake --build . -t mlx_tests
./mlx_tests "[PerStreamQueue]"
# Python smoke: two models on two streams should not block each other
python - <<'PY'
import mlx.core as mx, threading
s1 = mx.new_stream(mx.gpu)
s2 = mx.new_stream(mx.gpu)
results = []
def work(s, name):
    x = mx.ones((2048, 2048), stream=s) @ mx.ones((2048, 2048), stream=s)
    mx.eval(x)
    results.append(name)
t1 = threading.Thread(target=work, args=(s1, "s1"))
t2 = threading.Thread(target=work, args=(s2, "s2"))
t1.start(); t2.start(); t1.join(); t2.join()
assert set(results) == {"s1", "s2"}, results
print("ok")
PY
```

Expected: unit tests pass; Python smoke prints `ok` with both streams completing.

**Artifact export:**

```bash
git format-patch <B.1-commit>..HEAD --stdout -- \
  mlx/backend/metal/device.h mlx/backend/metal/device.cpp \
  mlx/backend/metal/eval.cpp mlx/backend/metal/event.cpp mlx/tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-per-stream-command-queue.patch
```

Integration: once B.2 and B.3 both pass, run the mac-mini multi-model benchmark (Task B.4) before
merging either artifact into the main llamactl branch.

---

### Task B.3 — M2: Per-stream `MTL::ResidencySet`

```yaml meta
id: "B.3"
files:
  - docs/upstream-patches/mlx-per-stream-residency-set.patch
  - docs/upstream-patches/mlx-per-stream-residency-set-pr-description.md
file_scope: new
depends_on: ["B.1"]
parallel_with: ["B.2"]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: substantial
risk_class: schema-aware
```

**Context:** `Device` currently holds one global `ResidencySet` (`mlx/backend/metal/resident.h:29`).
With per-stream queues (B.2), model weights for different models should also wire into different
residency sets so the Metal driver doesn't compete-page during inter-model context switches.

**Failing test** — extend `mlx/tests/test_per_stream_queue.cpp`:

```cpp
#ifdef MLX_METAL_ENABLED
TEST(PerStreamResidency, TwoStreamsGetDistinctResidencySets) {
  auto& dev = metal::device(Device::gpu);
  auto s1 = new_stream(Device::gpu);
  auto s2 = new_stream(Device::gpu);
  ASSERT_NE(dev.residency_set_for_stream(s1), dev.residency_set_for_stream(s2));
}

TEST(PerStreamResidency, ResidencySetReleasedOnStreamDestroy) {
  auto& dev = metal::device(Device::gpu);
  size_t before = dev.active_residency_set_count();
  {
    auto s = new_stream(Device::gpu);
    ASSERT_EQ(dev.active_residency_set_count(), before + 1);
  }
  ASSERT_EQ(dev.active_residency_set_count(), before);
}
#endif
```

**Implementation** — same shape as B.2 but for `MTL::ResidencySet`:

1. `mlx/backend/metal/device.h` — add:

   ```cpp
   std::unordered_map<int, NS::SharedPtr<MTL::ResidencySet>> stream_residency_sets_;
   ```

   Add: `get_or_create_residency_set(s)`, `release_residency_set(s)`,
   `residency_set_for_stream(s)`, `active_residency_set_count()`.

2. `mlx/backend/metal/device.cpp` — implement. Wire into `new_stream` / `delete_stream` lifecycle
   (parallel with queue lifecycle from B.2). If `MTL::ResidencySet` is only available on macOS 15+
   (Metal 3.2), guard with `#if MTL_RESIDENCY_AVAILABLE` and fall back to the global set.

3. `mlx/backend/metal/resident.h` and any allocation call sites — thread calls through
   `get_or_create_residency_set(current_stream)` instead of the device-global set.

**Verify:**

```bash
MLX_BUILD_METAL=ON cmake --build . -t mlx_tests && ./mlx_tests "[PerStreamResidency]"
```

**Artifact export:**

```bash
git format-patch <B.1-commit>..HEAD --stdout -- \
  mlx/backend/metal/device.h mlx/backend/metal/device.cpp \
  mlx/backend/metal/resident.h mlx/tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/mlx-per-stream-residency-set.patch
```

Integration: see B.4 benchmark before committing artifact to llamactl.

---

### Task B.4 — Benchmark: single-process multi-model on mac-mini

```yaml meta
id: "B.4"
files:
  - docs/notes/bench-mlx-per-stream-queue-2026-05-21.md
file_scope: new
depends_on: ["B.2", "B.3"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: small
risk_class: paste-ready
```

**Failing test (acceptance criterion):**

```bash
# One oMLX process, three models (granite-3b, granite-8b, qwen3-8b),
# --max-concurrent-requests=4. Expect 0 Metal errors across 240 rows.
llamactl matrix run \
  --models granite41-3b-mlx,granite41-8b-mlx,qwen3-8b-mlx \
  --workloads memory-recall,tool-call-grammar \
  --output /tmp/bench-b4.db
sqlite3 /tmp/bench-b4.db "SELECT COUNT(*) FROM results WHERE error IS NOT NULL"
# Expected: 0
```

This test FAILS today (per-process workaround is required at mcr=4).

**Implementation:** Build the patched MLX (with B.2 + B.3 applied), rebuild oMLX against it, restart
the oMLX process on mac-mini in single-process mode (not per-process), run the matrix bench:

```bash
ssh macmini.ai "cd /Volumes/AI-DATA/repos/personal/llamactl && \
  llamactl workload apply templates/workloads/mlx-fleet-L-single-process.yaml && \
  sleep 30"
llamactl matrix run \
  --models granite41-3b-mlx,granite41-8b-mlx,qwen3-8b-mlx \
  --workloads memory-recall,tool-call-grammar \
  --max-concurrent 4
```

**Success criterion:** 0 Metal errors, quality within ±2 pp of the per-process baseline measured in
the prior session.

**Record:** capture results in `docs/notes/bench-mlx-per-stream-queue-2026-05-21.md`. If the
single-process benchmark still fails with per-stream queues, document the failure mode and escalate
to Phase C (O1 `--isolate-models` mode) as the next mitigation.

Integration: if B.4 passes, finalize the Phase B patches and open upstream PRs to `ml-explore/mlx`
for B.1 → B.2 → B.3 in sequence. If B.4 fails, the three artifact patches are still committed to
llamactl for reference, but the upstream PR is deferred pending further diagnosis.

---

## Phase C — oMLX recovery and concurrency control

Dispatch graph: `C.1 ∥ C.2 → C.3`

> C.1 and C.2 are independent. C.3 (`--isolate-models`) is only executed if B.4 failed.

---

### Task C.1 — O3: Recovery-on-Metal-error

```yaml meta
id: "C.1"
files:
  - docs/upstream-patches/omlx-recovery-on-metal-error.patch
  - docs/upstream-patches/omlx-recovery-on-metal-error-pr-description.md
file_scope: new
depends_on: []
parallel_with: ["C.2"]
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: substantial
risk_class: schema-aware
```

**Context:** When our exception-safety patch surfaces a
`[METAL] Command buffer execution failed` error via `throw_if_stream_error`, oMLX's
`scheduler.py` / `engine/batched.py` currently fail the whole batch step. Better: mark just THAT
request failed (return a 500 with the Metal error text), retry the remaining requests in the batch
at `batch_size - 1`, and keep the process running.

**Failing test** — new `tests/test_recovery.py` in `/Volumes/WorkSSD/src/omlx`:

```python
import pytest
from unittest.mock import patch, MagicMock

def test_metal_error_fails_only_affected_request():
    """Single Metal error in a batch of 3 should fail exactly 1 request,
    not the whole batch."""
    from omlx.engine.batched import BatchedEngine
    engine = BatchedEngine.__new__(BatchedEngine)
    # Inject a mock that raises on the first call only.
    call_count = {"n": 0}
    def fake_generate(batch):
        call_count["n"] += 1
        if call_count["n"] == 1 and len(batch) == 3:
            raise RuntimeError("[METAL] Command buffer execution failed")
        return [f"response_{i}" for i in range(len(batch))]
    with patch.object(engine, "_generate_batch", side_effect=fake_generate):
        results = engine._generate_with_recovery(
            requests=[MagicMock(), MagicMock(), MagicMock()]
        )
    # Exactly 1 failure, 2 successes.
    failures = [r for r in results if r.error is not None]
    assert len(failures) == 1

def test_non_metal_error_propagates():
    """Non-Metal errors (e.g., OOM, assertion) should NOT be swallowed."""
    from omlx.engine.batched import BatchedEngine
    engine = BatchedEngine.__new__(BatchedEngine)
    with patch.object(engine, "_generate_batch",
                      side_effect=RuntimeError("out of memory")):
        with pytest.raises(RuntimeError, match="out of memory"):
            engine._generate_with_recovery(requests=[MagicMock()])
```

**Verify (red):**

```bash
cd /Volumes/WorkSSD/src/omlx && python -m pytest tests/test_recovery.py -v
```

Expected: `ImportError` or `AttributeError` because `_generate_with_recovery` doesn't exist.

**Implementation** — in `omlx/engine/batched.py`:

```python
import re

_METAL_ERROR_PATTERN = re.compile(r"\[METAL\]", re.IGNORECASE)

def _generate_with_recovery(self, requests):
    try:
        return self._generate_batch(requests)
    except RuntimeError as exc:
        if not _METAL_ERROR_PATTERN.search(str(exc)):
            raise
        # Metal error: fail the first request, retry the rest at batch_size-1.
        results = [None] * len(requests)
        results[0] = ErrorResponse(error=str(exc))
        if len(requests) > 1:
            tail = self._generate_with_recovery(requests[1:])
            results[1:] = tail
        return results
```

Replace the direct `_generate_batch` call in the `BatchedEngine` step loop with
`_generate_with_recovery`.

**Verify (green):**

```bash
python -m pytest tests/test_recovery.py -v
```

**Artifact export:**

```bash
git diff origin/main -- omlx/engine/batched.py omlx/scheduler.py tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/omlx-recovery-on-metal-error.patch
```

Integration: commit to llamactl; PR description must note the retry semantics (fail-first, retry-tail)
and the non-Metal-error passthrough invariant.

---

### Task C.2 — O2: Per-model concurrency caps

```yaml meta
id: "C.2"
files:
  - docs/upstream-patches/omlx-per-model-concurrency-caps.patch
  - docs/upstream-patches/omlx-per-model-concurrency-caps-pr-description.md
file_scope: new
depends_on: []
parallel_with: ["C.1"]
preferred_agent: gemini-acp-pro
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Context:** Lets one-process multi-model setups work in regimes where the operator accepts `mcr=1`
for the 8Bs but `mcr=4` for the 3B. `SchedulerConfig.per_model_max_concurrent: dict[str, int]`
with a CLI flag `--per-model-max-concurrent qwen3-8b=4,granite-3b=8`.

**Failing test** — new `tests/test_per_model_caps.py`:

```python
def test_per_model_max_concurrent_parse():
    from omlx.settings import SchedulerConfig
    cfg = SchedulerConfig(per_model_max_concurrent={"qwen3-8b": 4, "granite-3b": 8})
    assert cfg.per_model_max_concurrent["qwen3-8b"] == 4

def test_per_model_max_concurrent_cli_round_trip(tmp_path):
    from omlx.cli import build_config
    cfg = build_config(["serve", "--model-dir", str(tmp_path),
                        "--per-model-max-concurrent", "qwen3-8b=4,granite-3b=8"])
    assert cfg.scheduler.per_model_max_concurrent == {"qwen3-8b": 4, "granite-3b": 8}

def test_per_model_cap_limits_admission():
    from omlx.scheduler import Scheduler
    # Mock: qwen3-8b cap=1, currently 1 in-flight → admission denied.
    sched = Scheduler(per_model_max_concurrent={"qwen3-8b": 1})
    sched._inflight["qwen3-8b"] = 1
    assert not sched.can_admit("qwen3-8b")
    # granite-3b has no cap → always admitted.
    assert sched.can_admit("granite-3b")
```

**Implementation** — in `/Volumes/WorkSSD/src/omlx`:

1. `omlx/settings.py` — add `per_model_max_concurrent: dict[str, int] = {}` to `SchedulerConfig`.
2. `omlx/cli.py` — add `--per-model-max-concurrent` flag with a custom `key=value,...` parser.
3. `omlx/scheduler.py` — add `can_admit(model_name)` that checks the cap (if set) against
   `self._inflight[model_name]`.

**Verify:**

```bash
python -m pytest tests/test_per_model_caps.py -v
```

**Artifact export:**

```bash
git diff origin/main -- omlx/settings.py omlx/cli.py omlx/scheduler.py tests/ \
  > /Volumes/WorkSSD/repos/personal/llamactl/docs/upstream-patches/omlx-per-model-concurrency-caps.patch
```

Integration: commit artifact to llamactl. Dispatch C.3 only if B.4 failed.

---

### Task C.3 — O1: `--isolate-models` spawn-per-model mode (contingent)

```yaml meta
id: "C.3"
files:
  - docs/upstream-patches/omlx-isolate-models.patch
  - docs/upstream-patches/omlx-isolate-models-pr-description.md
file_scope: new
depends_on: ["C.1", "C.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: substantial
risk_class: bootstrap-touching
```

**Gate:** Only execute if Task B.4 (single-process benchmark) failed. If B.4 passed, this task is
SKIPPED — `--isolate-models` becomes a graceful-degradation option, not the primary fix.

**Failing test** — new `tests/test_router.py`:

```python
def test_isolate_models_spawns_n_children(tmp_path):
    """--isolate-models with 2 model dirs should spawn exactly 2 child processes."""
    import subprocess, time
    proc = subprocess.Popen(
        ["python", "-m", "omlx", "serve",
         "--model-dir", str(tmp_path / "m1"),
         "--model-dir", str(tmp_path / "m2"),
         "--isolate-models", "--port", "18080"],
        stderr=subprocess.PIPE,
    )
    time.sleep(3)
    # Check two child ports (18081, 18082) are listening.
    import socket
    for port in [18081, 18082]:
        s = socket.socket()
        assert s.connect_ex(("127.0.0.1", port)) == 0, f"port {port} not listening"
        s.close()
    proc.terminate()
    proc.wait()
```

**Implementation** — new `omlx/router.py`:

- `Router` class: on init, for each model dir, spawn a child `omlx serve --model-dir <dir>
--port <base+i>` subprocess.
- Readiness probe: poll each child's `/health` until 200 (max 60 s).
- Request forwarding: peek `model` field from JSON body; route to matching child port.
- Graceful shutdown: `SIGTERM` each child, wait up to 10 s, then `SIGKILL`.
- Log multiplexing: prefix each child's stderr line with `[model-N]`.

**Verify:**

```bash
python -m pytest tests/test_router.py -v
```

Integration: commit artifact to llamactl. PR description must clearly state this is a
graceful-degradation path and that per-stream queue isolation (B.2/B.3) is the preferred upstream
fix.

---

## Phase D — llamactl Fleet abstraction

Dispatch graph: `D.1`

### Task D.1 — L3: `kind: Fleet` manifest

```yaml meta
id: "D.1"
files:
  - packages/remote/src/workload/fleet-schema.ts
  - packages/remote/src/workload/fleet-schema.test.ts
  - packages/remote/src/workload/apply.ts
file_scope: new
depends_on: ["A.4"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: gemini-acp-pro
task_size: substantial
risk_class: schema-aware
```

**Gate:** Defer until three or more Fleet-style multi-model patterns exist in `templates/workloads/`
demanding the abstraction. Currently only one pattern (Fleet L three-model mac-mini) exists. Revisit
after Phase A/B/C land.

**Failing test** — `packages/remote/src/workload/fleet-schema.test.ts`:

```typescript
it("Fleet expands to N ModelHost manifests", () => {
  const raw = {
    kind: "Fleet",
    name: "fleet-L",
    family: "mlx",
    models: ["granite41-3b", "granite41-8b", "qwen3-8b"],
    env: { MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1" },
    portBase: 8190,
  };
  const manifests = expandFleet(FleetSchema.parse(raw));
  expect(manifests).toHaveLength(3);
  expect(manifests[0].kind).toBe("ModelHost");
  expect(manifests[0].env).toEqual({ MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1" });
  expect(manifests[0].port).toBe(8190);
  expect(manifests[2].port).toBe(8192);
});
```

**Implementation:**

1. `packages/remote/src/workload/fleet-schema.ts` — Zod schema for `kind: "Fleet"` with fields
   `name`, `family`, `models: string[]`, `env?: Record<string, string>`, `portBase: number`.
2. `expandFleet(fleet: Fleet): ModelHost[]` — map each model to a `ModelHost` manifest inheriting
   `env` and assigning `port = portBase + i`.
3. `packages/remote/src/workload/apply.ts` — detect `kind: "Fleet"` at apply time, call
   `expandFleet`, apply each resulting `ModelHost` manifest.

**Verify:**

```bash
cd packages/remote && bun test --filter "Fleet"
```

Integration: run full `packages/remote` suite before merging. Commit with a `templates/workloads/`
Fleet L template as a live example.

---

## Design decisions

| Question                                    | Decision                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| M4 (`generation`) struct location           | On `Stream` directly — sibling `StreamMeta` adds indirection with no benefit for a two-field struct                         |
| M3 (`tag`) as `optional<string>`            | `optional` over empty-string sentinel — call sites can distinguish "unset" from `""` without a magic value                  |
| B.2 queue-per-stream vs queue-per-process   | Queue per stream: lets two models in one process use independent GPU command lists; queue-per-process is what we have today |
| B.3 ResidencySet gating                     | Guard with `#if MTL_RESIDENCY_AVAILABLE` — ResidencySet API requires macOS 15 / Metal 3.2                                   |
| O3 recovery: fail-first or fail-matched     | Fail-first: simplest and avoids needing per-request GPU-stream attribution which we don't have yet                          |
| Phase D (Fleet) gating                      | Explicitly deferred — one live pattern doesn't justify a new top-level schema kind yet                                      |
| Phase C.3 (--isolate-models) conditionality | Conditioned on B.4 failure — per-stream queue is the right architectural fix; spawn-per-model is the fallback               |
| Patch sequencing for upstream               | M4 + M5 as one PR, M3 + M1 as a second PR (M3 is tiny but must land first), M2 as a third PR. O4 as a standalone oMLX PR.   |
