# B.2 — Closed: per-stream MTL::CommandQueue already exists

**Status: closed without PR.**

The original task spec claimed `mlx::core::metal::Device` held a single
`MTL::CommandQueue` shared across all streams (at `mlx/backend/metal/device.cpp:269`).
That was a misread of the code. Line 269 is inside the
`CommandEncoder::CommandEncoder()` constructor, not `Device::Device()`.

Each `CommandEncoder` (one per stream via `metal::get_command_encoders()`)
creates its own `MTL::CommandQueue` in its constructor:

```cpp
// mlx/backend/metal/device.cpp:263-279
CommandEncoder::CommandEncoder(
    Device& d,
    int index,
    ResidencySet& residency_set)
    : device_(d) {
  auto pool = new_scoped_memory_pool();
  queue_ = NS::TransferPtr(device_.mtl_device()->newCommandQueue());
  ...
}
```

The pre-existing architecture already gives each stream its own command
queue. The feature B.2 was proposing is the current implementation.

The legitimate remaining gap is in residency sets — see B.3. The
device-global `Device::residency_set_` is shared across all streams'
queues (added via `queue_->addResidencySet(residency_set.mtl_residency_set())`
inside each `CommandEncoder` constructor).

No upstream PR needed for B.2.
