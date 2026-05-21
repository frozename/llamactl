# Metal: per-stream MTL::ResidencySet

## Motivation
During inter-model context switches (e.g. running multiple LLMs concurrently via `llamactl` dispatching to `mlx`), we observed significant page-fault thrashing. Currently, MLX uses a single, device-global `MTL::ResidencySet` (in `Device::residency_set_`). When models share this residency set, their wired allocations compete, causing continuous unwiring and rewiring on every stream activation.

This patch addresses the thrashing by giving each stream its own `MTL::ResidencySet`. Models scheduled on different streams map their weights into isolated sets, drastically reducing Metal page faults and improving overall concurrent throughput.

This change pairs synergistically with **B.2 (per-stream `MTL::CommandQueue`)**.

## Architecture
- **Per-Stream Map:** Adds `std::unordered_map<int, MTL::ResidencySet*> residency_sets_by_stream_` to `metal::Device`, guarded by `residency_mutex_`.
- **Lazy Allocation:** `Device::residency_set(int stream_index)` creates and caches the `MTL::ResidencySet` on first access.
- **Lifecycle Binding:** Integrates with `Scheduler::clear_streams()` to properly `release()` the residency set and erase it from the map when a stream is destroyed.

## Backward Compatibility
The device-global `residency_set_` is retained. `CommandEncoder` is updated to accept an optional `stream_index`. When the index is `>= 0`, it uses the stream-specific set, and otherwise falls back to the legacy device-global set. This ensures existing workflows are unaffected and the new per-stream behavior is purely opt-in via stream configuration.

## Composition with B.2
This patch is designed to compose cleanly with the proposed `Metal: per-stream MTL::CommandQueue` patch (B.2).
- They touch the same area in `mlx/backend/metal/device.h` but add disjoint fields (`residency_sets_by_stream_` vs `command_queues_by_stream_`).
- In `CommandEncoder`, this patch alters the residency set assignment on the buffer, while B.2 configures the underlying queue for the buffer.
- `Scheduler::clear_streams()` orchestrates teardown for both sequentially.

## Tests & Validation
- **Unit Tests Added:** `tests/test_metal_per_stream_residency.cpp` covers:
  - Distinct `MTL::ResidencySet` allocation for distinct streams.
  - Verification that the legacy global set remains un-aliased.
  - Proper teardown and cleanup upon `clear_residency_set`.
- **Risks:** Validating the behavior requires Metal 3.0+ capable hardware. The tests skip gracefully if the device lacks residency set support.
- **Future Work:** Further optimization will tie model loaders directly to these stream-specific sets, letting us pin active working sets ahead of the first inference pass.