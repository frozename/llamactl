# Metal: per-stream `MTL::CommandQueue` for multi-model concurrency

## Motivation

`mlx::core::metal::Device` currently holds a single shared
`MTL::CommandQueue` (`queue_`, `device.cpp:269`) that every MLX stream
draws command buffers from.  Under single-model workloads this is fine.
Under concurrent multi-model load it becomes a serialisation bottleneck.

**Observed failure mode:** three 8B-class MLX models loaded in one
process, each served on a separate MLX stream at `max_concurrent_requests ≥ 2`,
produce near-100% per-request `kIOGPUCommandBufferCallbackErrorTimeout`
errors.  The Metal GPU watchdog fires because the scheduler cannot
prioritise across models at the command-buffer level when all streams feed
the same queue.  The same three models run at `mcr=4` with *zero* errors
when each is given its own process and therefore its own `MTL::Device`
and `MTL::CommandQueue`.

Per-process isolation works but is a user-visible workaround: it requires
writing multi-service configurations, adds inter-process overhead, and
prevents models from sharing weights already resident in unified memory.
[llamactl/oMLX](https://github.com/jundot/omlx) currently ships three
separate process manifests as a stopgap specifically because this queue
serialisation exists.  This PR would eliminate the need for that
workaround by making queue isolation available at the stream level within
a single process.

---

## Architecture

### Per-stream queue allocation

`Device` gains three new public methods:

```cpp
// Safety cap: Metal's per-process queue limit is typically ~256.
// 64 leaves headroom for the Metal runtime, CoreML, and other clients.
static constexpr int kMaxStreamQueues = 64;

// Return the MTL::CommandQueue dedicated to stream_index.
// Thread-safe. Allocates on first use; caches for subsequent calls.
NS::SharedPtr<MTL::CommandQueue> queue_for_stream(int stream_index);

// Release the per-stream map entry for stream_index.
void release_stream_queue(int stream_index);

// Release all per-stream entries (called from clear_streams on shutdown).
void release_all_stream_queues();
```

And two new private members:

```cpp
std::unordered_map<int, NS::SharedPtr<MTL::CommandQueue>> stream_queues_;
std::mutex stream_queues_mtx_;
```

`CommandEncoder`'s constructor now captures `d.queue_for_stream(stream_index)`
into its own `NS::SharedPtr<MTL::CommandQueue> stream_queue_` field.  All
`commandBuffer()` calls for that encoder — including allocations in
`commit()` when a new buffer is needed after the previous one is submitted
— go through `stream_queue_` rather than the device-global `queue_`.

### Lifecycle binding to stream.index

| Event | Action |
|---|---|
| `gpu::new_stream(s)` in `eval.cpp` | `d.queue_for_stream(s.index)` pre-warms the map entry; `CommandEncoder` constructor finds it cached |
| `CommandEncoder` constructed | Captures `stream_queue_` (SharedPtr copy, +1 refcount) |
| `gpu::clear_streams()` | `encoders.clear()` then `release_all_stream_queues()` |
| `release_stream_queue(index)` called | Erases map entry; underlying queue stays alive as long as any `CommandEncoder` (and thus its in-flight command buffers) holds a SharedPtr |

### Safety cap

Once `stream_queues_.size() == kMaxStreamQueues`, `queue_for_stream` falls
back to the device-global `queue_` and emits a one-time warning to
`stderr` via `std::call_once`:

```
[MLX] Warning: per-stream MTL::CommandQueue cap (64) reached.
Subsequent new streams will share the device-global command queue and lose
per-stream GPU scheduling isolation. ...
```

Streams beyond the cap see correct behaviour; they lose isolation but do
not fail.  Metal's per-process queue limit is typically ~256 (undocumented;
empirically observed on M-series hardware); the 64 cap leaves 192 slots
for the Metal runtime, CoreML, Python's Metal buffer, etc.

---

## Backward compatibility

Single-stream callers (the vast majority of MLX users) see **identical
behaviour**: they get exactly one `MTL::CommandQueue` for their one stream,
functionally equivalent to the former device-global queue.  The only
difference is that the queue is now stored in `stream_queues_[0]` rather
than directly in `Device::queue_`.

The `queue_` member is retained as the safety-cap fallback.  No public API
changes.  No changes to the Python bindings layer.

---

## Performance

- **Hot path (no error):** `queue_for_stream` acquires `stream_queues_mtx_`
  once, does a hash lookup, and copies a `SharedPtr`.  SharedPtr copy is
  O(1) + one atomic increment.  This executes once per `CommandEncoder`
  construction, not per `eval()` call.
- **`eval()` / `finalize()` / `synchronize()`:** unchanged.  The
  `stream_queue_->commandBuffer()` call is a single Objective-C message,
  identical cost to the former `queue_->commandBuffer()`.
- **Queue creation:** `device_->newCommandQueue()` allocates a kernel-side
  slot but performs no GPU work until the first command buffer is committed.
  Amortised over the lifetime of a model loaded on the stream, this is
  negligible.
- **Multi-stream benefit:** independent queues let the Metal scheduler
  interleave command buffers from different models without one stream
  blocking the other at the queue level.  Expected to eliminate the
  watchdog-timeout failure mode seen under concurrent multi-model load.

---

## Risks

1. **Metal driver resource limits.** The ~256 concurrent command-queue
   limit per process is empirical and device-dependent.  It may be lower
   on A-series chips, under memory pressure, or with future driver
   versions.  The 64 cap is conservative but untested at its full extent.
   **Needs reviewer with Metal background to validate the cap value on
   multiple M-series SKUs.**

2. **Thermal / scheduling behaviour under many queues.** Multiple
   concurrent command queues may interact with Metal's internal power
   management or scheduling heuristics in ways that are not yet
   characterised.  Sustained multi-stream load with 64 per-stream queues
   has not been benchmarked.

3. **No end-to-end Metal hardware validation in this PR.** This patch
   has not been tested in the multi-model oMLX scenario that motivated the
   change.  The unit tests (see below) verify structural correctness; full
   integration testing against the per-process baseline requires a
   multi-model Metal workload.  **This PR should not merge without a
   reviewer who can run the integration test on Apple Silicon hardware.**

4. **`stream_queues_mtx_` contention.** `queue_for_stream` acquires the
   mutex unconditionally on every call.  For workloads that create and
   destroy streams frequently, this could be a bottleneck.  In practice
   MLX streams are long-lived (one per model/thread), so stream creation
   frequency is low.  A future optimisation could use a
   double-checked-locking pattern with a `std::atomic` sentinel (analogous
   to the `any_stream_error_` sentinel in the error-stash path from #2670).

---

## Tests

`tests/test_metal_per_stream_queue.cpp` (new file, guarded by
`#ifdef MLX_BUILD_METAL`):

| # | What it checks |
|---|---|
| 1 | Fresh stream yields a non-null queue; repeated `queue_for_stream` calls return the same pointer (idempotency) |
| 2 | Two distinct streams have distinct, non-aliasing queue pointers |
| 3 | `release_stream_queue` removes the map entry; subsequent allocation for the same index succeeds |
| 4 | Once `kMaxStreamQueues` entries exist, the next call returns a non-null queue that differs from per-stream entries (i.e., the device-global fallback) |

The full existing test suite (`MLX_BUILD_METAL=ON`) must continue to pass.

CI note: tests 1–3 are fast (sub-millisecond Metal queue creation).  Test 4
allocates up to 64 `MTL::CommandQueue` objects; these are cleaned up at the
end of the test case.  Estimated additional CI time: < 2 s on any
Metal-capable runner.

---

## Composition with #2670

[#2670](https://github.com/ml-explore/mlx/pull/2670) (exception-safe Metal
completion handler, on the same `fix/exception-safe-completion-handler`
branch) keys stream error stashes in `Scheduler` by `stream.index`.  This
patch reinforces that design: a command-buffer failure on stream A's
dedicated queue stashes its error under stream A's index in the
`Scheduler`, with no risk of it polluting stream B's error state.  The
two patches compose cleanly.

The "Known limitation" noted in #2670 — that a Metal completion handler
captured before stream teardown may stash an error against a recycled
stream index — is not addressed here.  The companion M4 patch (Stream
generation counter) closes that window by adding a `uint64_t generation`
field to `Stream`.

---

## Future work

- **Per-stream `MTL::ResidencySet` (M2).** The same refactor shape applies
  to `Device::residency_set_` (currently global, `resident.h:29`).  Once
  per-stream queues are merged, per-stream residency sets become the
  natural next step to prevent the Metal driver from competing-paging
  weights across models during context switches.  M2 is intentionally
  out of scope for this PR to keep the diff reviewable.

- **`Stream` tag field (M3).** A `std::optional<std::string> tag` on
  `Stream` would let higher layers (mlx-lm, oMLX) associate a human-
  readable model name with a stream index, making the per-stream queue map
  inspectable in tooling.  Also out of scope; proposed as a companion PR.

- **Adaptive `max_ops_per_buffer` (M5).** When more than one stream has
  recent activity, automatically lowering the per-buffer op ceiling could
  further reduce watchdog exposure on constrained GPUs.  Depends on
  per-stream accounting that becomes natural after M1/M2 land.
