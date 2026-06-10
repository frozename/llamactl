# Metal: per-stream MTL::ResidencySet

## Motivation

Addresses page-fault thrashing during inter-model context switches by maintaining a per-stream `MTL::ResidencySet`. When multiple models execute concurrently on different streams, they currently compete for the device-global residency set, leading to excessive page faults as allocations are wired and unwired globally. This ensures that each model's weights wire into their own residency set instead.

Pairs with the per-stream `MTL::CommandQueue` improvements (B.2).

## Architecture

- Adds a `std::unordered_map<int, std::unique_ptr<ResidencySet>> residency_sets_by_stream_` to the `Device` class alongside the global `residency_set_`.
- Introduces an inline `Device::residency_set(int stream_index)` accessor that lazily allocates a per-stream residency set.
- Wires the stream-specific residency set into the `CommandEncoder` construction path when `new_stream` is called in the GPU backend.
- Implements proper cleanup of the stream's residency set during both per-stream teardown and full backend `clear_streams()` calls.

## Backward compatibility

The global `residency_set_` and the parameterless `Device::residency_set()` remain intact. Legacy paths and default stream operations continue to work without modification, ensuring backward compatibility.

## Composition with B.2

This patch is fully independent of the B.2 per-stream command queue patch, applying cleanly against the baseline `Device` struct. However, structurally they compose perfectly: B.2 binds each stream to a unique queue, and this B.3 patch ensures that each queue is provided with its own distinct `ResidencySet`.

## Tests

Added unit tests in `tests/test_metal_per_stream_residency.cpp` to verify:

- Distinct residency sets are allocated for distinct streams.
- Allocator-level visibility into per-stream sets.
- Proper teardown and reclamation of sets via `Device::clear_residency_set`.

## Risks

As this introduces dynamic `MTL::ResidencySet` instantiation beyond the singleton pattern, it requires Metal hardware validation on Apple Silicon (M-series). There is a low risk of driver-level limits on the total number of simultaneous residency sets, so stress testing across multiple active streams is recommended.

## Future work

Future enhancements could consider a pool of residency sets rather than tying them strictly 1:1 to streams, or integrating eviction heuristics to drop idle stream residency sets without waiting for explicit stream teardown.
