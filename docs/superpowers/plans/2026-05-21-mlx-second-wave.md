# MLX + oMLX upstream improvements — second wave

> **For agentic workers:** Use `penumbra:executing-plans` or `penumbra:dispatching` to run
> this plan task-by-task.

**Date:** 2026-05-21
**Predecessor:** `docs/upstream-patches/mlx-backpressure-per-stream-gate.patch` (first wave,
already committed). All MLX changes below assume that patch is applied to the atomic-fork
branch (`frozename/atomic-llama-cpp-turboquant`,
`fix/gemma4-swa-full-cache-reuse-steady-state`).

**Scope of this plan:** five follow-up items that were deferred from the first-wave patch or
identified during Fleet L validation.

| Item | Where | Size |
|---|---|---|
| 0 · `spec.env` field | llamactl TypeScript | small |
| 1 · Stream generation counter | MLX upstream (`scheduler.h`) | small |
| 2 · Per-stream `MTLCommandQueue` / `MTLResidencySet` | MLX upstream (`metal/`) | substantial |
| 3 · Watchdog env knob | MLX upstream (`scheduler.h`, `eval.cpp`) | small |
| 4 · oMLX `--max-completion-batch-size` PR + llamactl wire | oMLX + llamactl | small |

---

## Phase 0 — llamactl `spec.env` field

**Goal:** let a workload YAML declare env vars (e.g. `MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1"`)
so operators do not need to set them in the host's launchd plist.

**Dispatch graph:** `0.1 → 0.2`

### Task 0.1 — Schema + store

```yaml meta
id: "0.1"
files:
  - packages/remote/src/workload/modelhost-schema.ts
file_scope: modify-existing
depends_on: []
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing test** — `packages/remote/src/workload/__tests__/modelhost-schema.test.ts`:

```ts
// test name: "spec.env is parsed and defaults to empty object"
it('spec.env is parsed and defaults to empty object', () => {
  const raw = buildMinimalManifest(); // no env field
  const parsed = ModelHostManifestSchema.parse(raw);
  expect(parsed.spec.env).toEqual({});
});

// test name: "spec.env rejects non-string values"
it('spec.env rejects non-string values', () => {
  const raw = buildMinimalManifest({ env: { KEY: 123 } });
  expect(() => ModelHostManifestSchema.parse(raw)).toThrow();
});
```

**Expected failure:** `parsed.spec.env` is `undefined`, type error on schema.

**Implementation** — in `ModelHostSpecSchema` (after the `extraArgs` line):

```ts
env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
```

Key regex enforces POSIX env-var naming; no allowlist check in the schema — enforcement
happens at spawn time (Task 0.2).

**Verify:**
```bash
cd /Volumes/WorkSSD/repos/personal/llamactl
bun test packages/remote/src/workload/__tests__/modelhost-schema.test.ts
```

---

### Task 0.2 — Wire `spec.env` into `startModelHost` spawn

```yaml meta
id: "0.2"
files:
  - packages/remote/src/server/modelhost.ts
file_scope: modify-existing
depends_on: ["0.1"]
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing test** — `packages/remote/src/server/__tests__/modelhost.test.ts`:

```ts
// test name: "spec.env keys in allowlist are passed to child"
it('spec.env keys in allowlist are passed to child', async () => {
  const manifest = buildManifest({
    env: { MLX_METAL_MAX_INFLIGHT_PER_STREAM: '1' },
  });
  const spawned = await captureSpawnEnv(manifest);
  expect(spawned.env['MLX_METAL_MAX_INFLIGHT_PER_STREAM']).toBe('1');
});

// test name: "spec.env keys not in allowlist are silently dropped"
it('spec.env keys not in allowlist are silently dropped', async () => {
  const manifest = buildManifest({ env: { UNKNOWN_KEY: 'bad' } });
  const spawned = await captureSpawnEnv(manifest);
  expect(spawned.env['UNKNOWN_KEY']).toBeUndefined();
});
```

**Expected failure:** spawn env does not include `MLX_METAL_MAX_INFLIGHT_PER_STREAM` from spec.

**Implementation** — in `buildModelHostSpec`, add `env: manifest.spec.env`. In
`startModelHost`, before the `sanitizeChildEnv` call, filter `spec.env` to only
allowlisted keys and merge into `envOverrides`:

```ts
const specEnvOverrides: Record<string, string> = {};
for (const [k, v] of Object.entries(spec.env ?? {})) {
  if (CHILD_ENV_ALLOWLIST.includes(k)) specEnvOverrides[k] = v;
}
// merge with any existing launch.envOverrides
const merged = { ...specEnvOverrides, ...launch.envOverrides };
```

**Verify:**
```bash
bun test packages/remote/src/server/__tests__/modelhost.test.ts
tsc -p packages/remote/tsconfig.json --noEmit
```

**Integration:** commit both 0.1 and 0.2 in one llamactl commit; update
`templates/workloads/stress-fleet-L-mac-mini.yaml` to move `AGX_RELAX_CDM_CTXSTORE_TIMEOUT`
and `MLX_METAL_MAX_INFLIGHT_PER_STREAM` from host launchd plist comment into `spec.env`:

```yaml
spec:
  env:
    AGX_RELAX_CDM_CTXSTORE_TIMEOUT: "1"
    MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1"
```

---

## Phase 1 — Stream generation counter (shutdown safety)

**Goal:** completion handlers check a per-stream generation number captured at dispatch time;
stale handlers (stream reset after commit) no-op instead of decrementing the inflight counter
on a recycled stream.

**Addresses:** "Shutdown safety" limitation in `mlx-backpressure-per-stream-gate.patch`.

**Dispatch graph:** `1.1 → 1.2`

### Task 1.1 — Add `stream_generation_` to `Scheduler`

```yaml meta
id: "1.1"
files:
  - mlx/scheduler.h
file_scope: modify-existing
depends_on: []
preferred_agent: gemini-acp-flash
task_size: small
risk_class: schema-aware
```

**Failing test** — `mlx/tests/test_metal_backpressure.cpp` (extend existing file):

```cpp
// test name: "[backpressure] stale handler is a no-op after generation bump"
TEST_CASE("stale handler is a no-op after generation bump", "[backpressure]") {
  auto s = make_test_stream(99010);

  // Capture generation at dispatch time.
  uint64_t gen = current_stream_generation(s);
  acquire_stream_slot(s, /*limit=*/INT_MAX);

  // Simulate a stream reset: bump the generation.
  bump_stream_generation(s);

  // release_stream_slot called with a stale generation should be a no-op.
  release_stream_slot_if_current(s, gen);

  // Counter must still be 1 (the acquire above, un-released).
  // A fresh release with the current generation corrects it.
  release_stream_slot_if_current(s, current_stream_generation(s));
}
```

**Expected failure:** `current_stream_generation`, `bump_stream_generation`, and
`release_stream_slot_if_current` do not exist.

**Implementation** — add to `Scheduler` private state:

```cpp
std::unordered_map<int, uint64_t> stream_generation_;  // guarded by inflight_mtx_
```

New API (also expose as free-function wrappers in `scheduler` namespace):

```cpp
uint64_t current_stream_generation(const Stream& s);
void     bump_stream_generation(const Stream& s);   // called on stream reset/teardown
void     release_stream_slot_if_current(const Stream& s, uint64_t gen);
```

`release_stream_slot_if_current` is identical to `release_stream_slot` except it
first checks `stream_generation_[s.index] == gen`; if not, it skips the decrement
and notify. Keep `release_stream_slot` as a forwarding alias with
`current_stream_generation(s)` for callers that don't need stale-safety.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
```

---

### Task 1.2 — Wire generation capture into `eval.cpp` completion handlers

```yaml meta
id: "1.2"
files:
  - mlx/backend/metal/eval.cpp
file_scope: modify-existing
depends_on: ["1.1"]
preferred_agent: gemini-acp-flash
task_size: small
risk_class: schema-aware
```

**Failing test** — extend `test_metal_backpressure.cpp`:

```cpp
// test name: "[backpressure] concurrent generation reset does not corrupt counter"
TEST_CASE("concurrent generation reset does not corrupt counter", "[backpressure]") {
  // Spawns thread A: acquire + "work" + release_if_current (with old gen).
  // Main thread: bump_stream_generation immediately after A acquires.
  // Assert: inflight counter returns to 0 via main-thread
  //         release_if_current(new gen) without going negative.
  auto s = make_test_stream(99011);
  uint64_t old_gen = current_stream_generation(s);
  acquire_stream_slot(s, INT_MAX);

  bump_stream_generation(s);
  release_stream_slot_if_current(s, old_gen); // stale → no-op
  // Counter is still 1; clear it with current gen.
  release_stream_slot_if_current(s, current_stream_generation(s));
  // Verify: a subsequent acquire with limit=1 succeeds immediately.
  acquire_stream_slot(s, /*limit=*/1, /*timeout=*/1);
  release_stream_slot_if_current(s, current_stream_generation(s));
}
```

**Implementation** — in `eval.cpp`, in each `addCompletedHandler` lambda, capture the
generation at the time of commit and call `release_stream_slot_if_current` instead of
`release_stream_slot`:

```cpp
uint64_t gen = scheduler::current_stream_generation(s);
command_buffer->addCompletedHandler(
    [s, gen, buffers = std::move(buffers)](MTL::CommandBuffer* cbuf) {
      scheduler::release_stream_slot_if_current(s, gen);
      check_error(s, cbuf);
      scheduler::notify_task_completion(s);
    });
scheduler::acquire_stream_slot(s, read_inflight_limit(), read_backpressure_timeout());
encoder.commit();
```

Apply the same pattern in `finalize()`.

Also call `scheduler::bump_stream_generation(s)` inside `flush()` / the existing
stream-teardown path so a recycled stream index does not inherit stale counter state.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
python - <<'PY'
import mlx.core as mx, threading
errs = []
def work():
    try: mx.eval(mx.ones((2048,2048)) @ mx.ones((2048,2048)))
    except Exception as e: errs.append(e)
ts = [threading.Thread(target=work) for _ in range(4)]
[t.start() for t in ts]; [t.join() for t in ts]
assert not errs, errs
print("ok")
PY
```

---

## Phase 2 — Per-stream `MTLCommandQueue` / `MTLResidencySet` isolation

**Goal:** each MLX stream owns its own `MTLCommandQueue`; on Metal 3+ hardware each stream
also gets an `MTLResidencySet` that explicitly pins its active buffers. Separate queues give
the Metal driver independent wired-resource budgets per stream, eliminating cross-stream
resource contention at the driver level (complementary to the application-level gate in Phase
0-1).

**Note:** this is the most invasive upstream change; it must not regress single-stream
throughput. File it as a separate PR after Phase 1 is accepted by `zcbenz`.

**Dispatch graph:** `2.1 → 2.2 → 2.3`

### Task 2.1 — Add `StreamResources` struct and per-stream queue allocation

```yaml meta
id: "2.1"
files:
  - mlx/backend/metal/device.h
  - mlx/backend/metal/device.cpp
file_scope: modify-existing
depends_on: ["1.2"]
preferred_agent: gemini-acp-pro
task_size: substantial
risk_class: schema-aware
```

**Failing test** — `mlx/tests/test_metal_stream_resources.cpp` (new file):

```cpp
// test name: "[stream-resources] distinct streams get distinct CommandQueues"
TEST_CASE("distinct streams get distinct CommandQueues", "[stream-resources]") {
  // Requires Metal device but no GPU workload.
  auto& dev = metal::device();
  auto qa = dev.get_command_queue(/*stream_index=*/88001);
  auto qb = dev.get_command_queue(/*stream_index=*/88002);
  REQUIRE(qa != nullptr);
  REQUIRE(qb != nullptr);
  CHECK(qa != qb);
}

// test name: "[stream-resources] same stream index returns the same CommandQueue"
TEST_CASE("same stream index returns same CommandQueue", "[stream-resources]") {
  auto& dev = metal::device();
  auto q1 = dev.get_command_queue(88003);
  auto q2 = dev.get_command_queue(88003);
  CHECK(q1 == q2);
}
```

**Expected failure:** `get_command_queue(int)` does not exist.

**Implementation** — in `metal::Device` (device.h / device.cpp):

```cpp
// New internal API
MTL::CommandQueue* get_command_queue(int stream_index);
void               release_command_queue(int stream_index); // called on stream teardown
```

Back the map with `std::unordered_map<int, MTL::CommandQueue*>` guarded by a shared mutex.
Lazily create a new `device_->newCommandQueue()` on first access.

`ResidencySet` (Metal 3+ — `MTLResidencySetDescriptor` / `newResidencySet:error:`):
wrap in `#if MLX_HAS_RESIDENCY_SET` guard so the patch compiles on macOS 12/13.
When available, allocate one `MTLResidencySet` per stream at queue-creation time;
use it in `CommandEncoder` to `addResidentBuffers` before commit.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[stream-resources]"
```

---

### Task 2.2 — Switch `CommandEncoder` to use the per-stream queue

```yaml meta
id: "2.2"
files:
  - mlx/backend/metal/command_encoder.h
  - mlx/backend/metal/command_encoder.cpp
file_scope: modify-existing
depends_on: ["2.1"]
preferred_agent: gemini-acp-pro
task_size: substantial
risk_class: schema-aware
```

**Failing test** — extend `test_metal_stream_resources.cpp`:

```cpp
// test name: "[stream-resources] CommandEncoder uses stream-specific queue"
TEST_CASE("CommandEncoder uses stream-specific queue", "[stream-resources]") {
  // Encode a tiny no-op kernel and verify the command buffer's parentCommandQueue
  // matches the per-stream queue, not the global default.
  auto s = make_gpu_stream(77001);
  auto& enc = metal::get_command_encoder(s);
  auto* cb = enc.get_command_buffer();
  auto& dev = metal::device();
  CHECK(cb->commandQueue() == dev.get_command_queue(s.index));
}
```

**Implementation** — in `CommandEncoder::CommandEncoder(Stream s, ...)`, replace:

```cpp
auto* command_buffer = device_->commandQueue()->commandBuffer();
```

with:

```cpp
auto* queue = metal::device().get_command_queue(s.index);
auto* command_buffer = queue->commandBuffer();
```

Wire the residency set if available: before `end_encoding()`, call
`command_buffer->useResidencySet(dev.get_residency_set(s.index))` under the
`#if MLX_HAS_RESIDENCY_SET` guard.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[stream-resources]"
# Full regression
cmake --build . -t mlx_tests && ./mlx_tests
```

---

### Task 2.3 — Release per-stream queues on stream teardown

```yaml meta
id: "2.3"
files:
  - mlx/backend/metal/eval.cpp
  - mlx/backend/metal/device.cpp
file_scope: modify-existing
depends_on: ["2.2"]
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — extend `test_metal_stream_resources.cpp`:

```cpp
// test name: "[stream-resources] released stream queue is freed"
TEST_CASE("released stream queue is freed", "[stream-resources]") {
  auto& dev = metal::device();
  auto* q = dev.get_command_queue(88099);
  REQUIRE(q != nullptr);
  dev.release_command_queue(88099);
  // After release the slot is gone; a new get creates a fresh queue.
  auto* q2 = dev.get_command_queue(88099);
  CHECK(q2 != q);
  dev.release_command_queue(88099);
}
```

**Implementation** — call `device.release_command_queue(s.index)` (and
`bump_stream_generation(s)` from Phase 1) in the existing stream-flush / teardown path
already used by `free_stream` / `close_stream` in `eval.cpp`. `release_command_queue`
calls `queue->release()` and erases the map entry.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[stream-resources]"
cmake --build . -t mlx_tests && ./mlx_tests  # full suite, no regressions
python - <<'PY'
import mlx.core as mx
a = mx.ones((4096,4096))
for _ in range(10): mx.eval(a @ a)
print("ok")
PY
```

**Integration:** before opening the upstream PR, measure single-stream GEMM throughput
(4096×4096 matmul, 100 iterations) on M4 Pro with and without the patch. Accept ≤ 1%
regression. Record the number in the PR description.

---

## Phase 3 — Watchdog env knob

**Goal:** a background watchdog thread in `Scheduler` injects a stream error if a committed
command buffer has not completed within `MLX_METAL_STREAM_WATCHDOG_SECS` seconds. This
covers the case where Metal silently stops firing completion handlers (GPU wedge), which the
existing per-acquire timeout does not catch (that timeout fires *before* commit, not after).

**Dispatch graph:** `3.1`

### Task 3.1 — Add watchdog thread and `MLX_METAL_STREAM_WATCHDOG_SECS` env var

```yaml meta
id: "3.1"
files:
  - mlx/scheduler.h
  - mlx/backend/metal/eval.cpp
file_scope: modify-existing
depends_on: ["1.2"]
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: schema-aware
```

**Failing test** — extend `mlx/tests/test_metal_backpressure.cpp`:

```cpp
// test name: "[backpressure] watchdog fires on stalled stream"
TEST_CASE("watchdog fires on stalled stream", "[backpressure]") {
  // Override watchdog interval to 1 s for test speed.
  auto s = make_test_stream(99020);
  // Manually bump inflight counter without a matching completion handler.
  // This simulates a "committed but never completed" command buffer.
  scheduler::scheduler().record_commit_time(s);

  std::this_thread::sleep_for(std::chrono::milliseconds(1500));

  bool threw = false;
  try { throw_if_stream_error(s); }
  catch (const std::runtime_error& e) {
    threw = true;
    CHECK(std::string(e.what()).find("watchdog") != std::string::npos);
  }
  CHECK(threw);
}
```

**Expected failure:** `record_commit_time` does not exist; watchdog thread does not exist.

**Implementation** — in `Scheduler`:

New private state:
```cpp
std::unordered_map<int, std::chrono::steady_clock::time_point> stream_last_commit_;
// guarded by inflight_mtx_
std::thread watchdog_thread_;
std::atomic<bool> watchdog_stop_{false};
```

`record_commit_time(s)` — called in `eval.cpp` immediately after `encoder.commit()` (after
`acquire_stream_slot`); updates `stream_last_commit_[s.index]` under `inflight_mtx_`.

`clear_commit_time(s)` — called at the top of every completion handler (before
`release_stream_slot_if_current`); erases the entry.

Watchdog thread (started in `Scheduler::Scheduler()`, joined in `~Scheduler()`):

```cpp
void watchdog_loop(int interval_secs) {
  while (!watchdog_stop_.load(std::memory_order_acquire)) {
    std::this_thread::sleep_for(std::chrono::seconds(interval_secs));
    auto now = std::chrono::steady_clock::now();
    std::unique_lock<std::mutex> lk(inflight_mtx_);
    for (auto& [idx, tp] : stream_last_commit_) {
      auto age = std::chrono::duration_cast<std::chrono::seconds>(now - tp).count();
      if (age >= interval_secs) {
        Stream s{idx, Device::gpu};
        lk.unlock();
        notify_stream_error(s, std::make_exception_ptr(
            std::runtime_error("[MLX] watchdog: stream " +
                               std::to_string(idx) +
                               " stalled for " + std::to_string(age) + "s")));
        lk.lock();
      }
    }
  }
}
```

Env var parsing (file-scope static in `eval.cpp`):
```cpp
static int read_watchdog_secs() {
  const char* v = std::getenv("MLX_METAL_STREAM_WATCHDOG_SECS");
  if (!v || !*v) return 0; // 0 = disabled
  char* end; long n = std::strtol(v, &end, 10);
  return (*end || n <= 0) ? 0 : (int)n;
}
```

Start the watchdog thread only when `read_watchdog_secs() > 0`. Thread is created lazily
on first `new_stream()` call to avoid startup cost when the knob is unset.

Also add `MLX_METAL_STREAM_WATCHDOG_SECS` to llamactl's `CHILD_ENV_ALLOWLIST`.

**Verify:**
```bash
cmake --build . -t mlx_tests && ./mlx_tests "[backpressure]"
# Confirm watchdog is a no-op when env var is unset (throughput guard):
./mlx_tests "stream gate fast path throughput"
```

---

## Phase 4 — oMLX `--max-completion-batch-size` + llamactl integration

**Goal:** add a `--max-completion-batch-size N` flag to oMLX that caps how many output
tokens are processed in a single `generate()` call. This provides application-layer
throttling (limits Metal work per dispatch) complementary to the Metal-layer gate.

**Dispatch graph:** `4.1 ∥ 4.2`

### Task 4.1 — oMLX CLI flag and PR description

```yaml meta
id: "4.1"
files:
  - docs/upstream-patches/omlx-max-completion-batch-size-pr-description.md
file_scope: new
depends_on: []
preferred_agent: claude-acp-haiku
task_size: small
risk_class: paste-ready
```

**Failing test:**
```bash
test -f docs/upstream-patches/omlx-max-completion-batch-size-pr-description.md
```

**Implementation** — create the file with:

- **Problem:** under concurrent multi-model load each `generate()` call schedules a full
  batch of completion tokens to Metal at once; on small GPUs this saturates wired resources
  even when per-stream back-pressure is active.
- **Change:** add `--max-completion-batch-size N` (default: unlimited). In the
  `generate()` loop, after each batch split at `N` tokens, yield to the event loop so other
  streams can schedule their own command buffers.
- **Interaction with back-pressure patch:** the Metal gate fires at command-buffer commit
  time; the batch-size flag fires above that, reducing the number of tokens (and therefore
  command buffers) submitted per request.
- **Recommended value:** `32` on M4 base 3-model fleet; `128` on M4 Pro.
- **Test:** oMLX integration test: with `--max-completion-batch-size 1` and two concurrent
  requests, assert that completion events interleave (neither request starves the other for
  more than 2 seconds).

**Verify:**
```bash
test -f docs/upstream-patches/omlx-max-completion-batch-size-pr-description.md
```

---

### Task 4.2 — llamactl schema + Fleet L template

```yaml meta
id: "4.2"
files:
  - packages/remote/src/workload/modelhost-schema.ts
  - templates/workloads/stress-fleet-L-mac-mini.yaml
file_scope: modify-existing
depends_on: ["0.2"]
parallel_with: ["4.1"]
preferred_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

**Failing test** — `packages/remote/src/workload/__tests__/modelhost-schema.test.ts`:

```ts
// test name: "omlx engine accepts maxCompletionBatchSize in extraArgs"
it('stress-fleet-L template round-trips through schema', () => {
  const raw = yaml.parse(
    fs.readFileSync('templates/workloads/stress-fleet-L-mac-mini.yaml', 'utf8'),
  );
  const parsed = ModelHostManifestSchema.parse(raw);
  const args = parsed.spec.extraArgs;
  expect(args).toContain('--max-completion-batch-size');
  const idx = args.indexOf('--max-completion-batch-size');
  expect(parseInt(args[idx + 1])).toBeGreaterThan(0);
});
```

**Expected failure:** template does not include `--max-completion-batch-size`.

**Implementation** — update `templates/workloads/stress-fleet-L-mac-mini.yaml`:

```yaml
spec:
  env:
    AGX_RELAX_CDM_CTXSTORE_TIMEOUT: "1"
    MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1"
    MLX_METAL_STREAM_WATCHDOG_SECS: "60"
  extraArgs:
    - --max-concurrent-requests
    - "1"
    - --max-completion-batch-size
    - "32"
    - --max-process-memory
    - "88%"
    - --paged-ssd-cache-dir
    - /Volumes/AI-DATA/cache/omlx
```

No schema change needed — `extraArgs` is already `z.array(z.string())`.

**Verify:**
```bash
bun test packages/remote/src/workload/__tests__/modelhost-schema.test.ts
tsc -p packages/remote/tsconfig.json --noEmit
```

**Integration:** commit Phase 4 in a single llamactl commit. Run the stress-fleet-L matrix
bench after oMLX supports the flag to confirm the quality delta from the Fleet L validation
(`--max-concurrent-requests=1` baseline) is preserved.

---

## Recommended sprint order

| Phase | Blocker | Estimated size | Can dispatch? |
|---|---|---|---|
| 0 (spec.env) | none | 1 day | yes — pure TS |
| 4.2 (template) | 0.2 | 0.5 day | after Phase 0 |
| 1 (generation counter) | none | 1 day | yes — C++ only |
| 3 (watchdog) | 1.2 | 1 day | after Phase 1 |
| 2 (per-stream queue) | 1.2 | 2-3 days | after Phase 1; separate upstream PR |
| 4.1 (oMLX PR doc) | none | 0.5 day | yes — writing only |

Phases 0 and 1 can run in parallel across two dispatch lanes. Phase 2 blocks on Phase 1
only for the generation-bump call in stream teardown; the queue allocation itself is
independent.

## Design decisions

| Question | Decision |
|---|---|
| `spec.env` allowlist enforcement | At spawn time (filter against `CHILD_ENV_ALLOWLIST`); schema validates key format only |
| Generation counter data structure | `unordered_map<int, uint64_t>` guarded by existing `inflight_mtx_` — no new mutex |
| Per-stream queue: lazy vs eager | Lazy (on first `get_command_queue` call) — avoids breaking existing stream lifecycle |
| ResidencySet availability guard | `#if MLX_HAS_RESIDENCY_SET` — detected via CMake `check_symbol_exists` for `MTLResidencySetDescriptor` |
| Watchdog thread start | Lazy on first `new_stream` when env var is set — zero cost when disabled |
| Watchdog vs acquire-side timeout | Complementary: acquire timeout catches "cannot enter Metal" (pre-commit); watchdog catches "Metal completion never fires" (post-commit) |
| `--max-completion-batch-size` location | oMLX application layer — intentionally above MLX core so it doesn't affect non-oMLX callers |
