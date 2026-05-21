# Stream: add generation counter to prevent stale completion-handler error attribution

## Motivation

The exception-safety patch (#2670) stashes Metal command-buffer errors by stream
index. This exposes a race when streams are short-lived: a Metal completion handler
captures `Stream` by value at the time `addCompletedHandler` is called. If the
stream is later destroyed and a new stream happens to reuse the same index (MLX
recycles indices once `clear_streams()` resets the encoder table), any in-flight
handler from the old stream will call `notify_stream_error` with the recycled index,
incorrectly attributing the error to the new stream. The new stream will then throw
on its next `eval()`/`finalize()`/`synchronize()` call for a GPU failure it had no
part in.

This scenario was noted as a "Known limitation" in the #2670 patch comment on
`clear_stream_error`. This PR closes it.

The failure is most likely to surface under multi-model concurrent load (the same
scenario that motivated #2670): streams are created and torn down at a higher rate,
increasing the probability of index reuse while old completion handlers are still
queued in `com.Metal.CompletionQueueDispatch`.

## API change

### `Stream` (mlx/stream.h)

A new `uint64_t generation{0}` member is added to `Stream`. It is default-zero for
default-constructed and existing hand-constructed Stream objects (no calling-code
breakage). `new_stream()` stamps each freshly created stream with the
pre-incremented value of a process-global atomic counter (`stream_generation_counter_`,
defined in `mlx/stream.cpp`, declared `extern` in `mlx/stream.h`), so every live
stream carries generation ≥ 1 and 0 is the uninitialized sentinel.

The `operator==` default is preserved; `operator<` is unchanged. The new field is
not part of the ordering since streams are compared by index for use as map keys.

### `Scheduler` (mlx/scheduler.h) — error stash format

`stream_errors_` changes from `unordered_map<int, exception_ptr>` to
`unordered_map<int, StreamErrorEntry>` where `StreamErrorEntry` is a private nested
struct holding `{uint64_t generation; exception_ptr eptr}`.

- **`notify_stream_error(s, eptr)`**: stores `{s.generation, eptr}` instead of bare
  `eptr`. First-error-wins logic now guards on `slot.eptr` rather than `slot`.

- **`throw_if_stream_error(s)`**: on finding an entry for `s.index`, checks
  `it->second.generation == s.generation`. On match: moves out and rethrows as
  before. On mismatch: silently erases the stale entry without throwing. In both
  cases the map slot is removed and the sentinel is lowered if the map becomes empty.

- **`clear_stream_error(s)`**: erases by index regardless of generation. This is
  correct because callers (`gpu::new_stream`, `clear_streams`) want to sweep out
  any leftover state before the slot is recycled. Late-arriving handlers from the
  old incarnation that fire after the clear will store with the old generation and
  be discarded by the new stream's `throw_if_stream_error`.

No changes to the back-pressure (`acquire_stream_slot`/`release_stream_slot`) APIs.

## Compatibility

- **Default generation = 0**: all existing code that constructs `Stream{index, device}`
  directly receives `generation = 0`. The scheduler will treat any error stashed
  against a generation-0 stream as matching only another generation-0 stream at the
  same index. In practice, generation-0 streams arise only in tests that bypass
  `new_stream()`; production paths always go through `new_stream()`.

- **ABI**: `Stream` gains one `uint64_t` member. Callers that construct `Stream`
  by aggregate initializer (`Stream{idx, dev}`) continue to compile since the new
  field has a default initializer and the constructor signature is unchanged.

- **No behavior change on the success path**: `throw_if_stream_error` on the common
  no-error case is still a single `memory_order_acquire` atomic load with no mutex
  acquisition.

- **No change to `acquire_stream_slot` / `release_stream_slot`**: the back-pressure
  inflight counter is indexed by `stream.index` only; it is reset in
  `clear_stream_error` by index as well, which remains correct.

## Tests

`tests/test_stream_generation.cpp` adds one doctest `TEST_CASE` tagged
`[stream-generation]`. It does not require a Metal device. Key steps:

1. Construct two notional stream incarnations sharing the same index but with
   consecutive generation values (`kOldGen = 7`, `kNewGen = 8`).
2. Stash an error under the old generation via `notify_stream_error`.
3. Call `throw_if_stream_error` on the new stream — must not throw (stale entry
   is discarded, generation mismatch).
4. Stash a fresh error under the new generation.
5. Call `throw_if_stream_error` on the new stream again — must throw with the
   correct message (generation match).
6. Baseline step: verify `notify_stream_error` + `throw_if_stream_error` still
   works for the old incarnation after the map is empty (guards against an
   accidental always-skip regression).

Existing `[backpressure]` tests are unaffected; the back-pressure path reads
`stream.index` only and does not touch the generation field.

The test is added to `tests/CMakeLists.txt` alongside `test_metal_backpressure.cpp`.

## References

- Predecessor: [Exception-safe Metal completion handlers (#2670)](https://github.com/ml-explore/mlx/pull/2670) — introduced `notify_stream_error` / `throw_if_stream_error` and noted the index-reuse limitation in `clear_stream_error`.
- This patch applies on top of the back-pressure commit (`982ef62d`) from the same
  branch (`fix/exception-safe-completion-handler`).
