# Stream: add optional tag field for per-stream affinity

## Motivation

Multi-model coexistence on Apple Silicon requires that each model's
inference work run through an independent Metal command pipeline. Two
follow-up PRs pursue this:

- **B.2 — Per-stream `MTL::CommandQueue`**: one command queue per stream
  so models do not queue-block each other at the driver level.
- **B.3 — Per-stream `MTL::ResidencySet`**: one residency set per stream
  so models' weight tensors can be evicted and re-promoted independently.

Both patches need a way to key per-model GPU state on the stream object.
Today there is no standard channel for a higher layer (oMLX, mlx-lm) to
attach model identity to a `Stream`. This patch adds that hook: an
`std::optional<std::string> tag` field that callers set once after
creating a stream. B.2 and B.3 read it when setting up per-stream
resources.

## API shape

```cpp
// mlx/stream.h  (after this patch)
struct MLX_API Stream {
  int index;
  Device device;
  // A.1 patch — per-incarnation counter for stale-handler detection
  uint64_t generation{0};
  // This patch — optional caller-supplied label
  std::optional<std::string> tag = std::nullopt;

  explicit Stream(int index, Device device) : index(index), device(device) {}

  bool operator==(const Stream&) const = default;
  bool operator<(const Stream& rhs) const {
    return device < rhs.device || index < rhs.index;
  }
};
```

Typical usage from a higher layer:

```cpp
Stream s = new_stream(Device::gpu);
s.tag = "qwen3-8b";
// pass s to the inference engine; B.2/B.3 route GPU resources by s.tag
```

## Compatibility

- `tag` defaults to `std::nullopt`. No existing call site changes.
- `Stream` retains value semantics; copy and move carry the tag correctly
  with no user-defined special members required.
- The defaulted `operator==` now includes `tag` in comparison. In
  practice this is a no-op: untagged streams (the common case) all carry
  `std::nullopt`, so pairwise equality is unaffected for existing code.
- `operator<` compares `device` and `index` only (unchanged); stream
  ordering in maps and sets is unaffected.
- The two new standard-library headers (`<optional>`, `<string>`) are
  added to `stream.h`. Both are already present transitively in most
  translation units that include MLX headers; adding them explicitly is
  correct hygiene and avoids depending on transitive inclusion order.

## Tests

`tests/test_stream_tag.cpp` — two doctest cases covering the
struct-level contract (Metal hardware not required):

| Test case | What it checks |
|-----------|----------------|
| `A fresh stream has an empty tag` | `new_stream()` result has `nullopt` tag |
| `Assigning a tag round-trips through stream copy` | Tag survives value-copy; copy is independent |

Run alongside the existing suite:

```bash
cmake --build . --target tests && ctest -R tests
```

Or filter to the new cases only:

```bash
./tests --test-case="*tag*"
```

Expected: both new cases pass; existing back-pressure, generation-counter,
and all other doctest cases remain green.

## Future work

This patch is intentionally minimal — it adds the metadata field only,
with no wiring into the scheduler or backend.

- **B.2 (per-stream `MTL::CommandQueue`)** — creates one `CommandQueue`
  per `stream.index` in `metal::Device`, allowing models to submit GPU
  work without driver-level serialisation against each other.
- **B.3 (per-stream `MTL::ResidencySet`)** — creates one
  `MTL::ResidencySet` per stream so weight-tensor residency can be
  managed per-model rather than globally.

Both follow-on PRs build directly on this patch with no further changes
to `stream.h`.
