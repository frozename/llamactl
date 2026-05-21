## Motivation

Under multi-model concurrent load on small Apple Silicon GPUs (M4 base and
similar 'g'-tier chips), the OS GPU watchdog fires when a single Metal
command buffer accumulates too many operations.  The per-architecture
defaults set in `Device::Device()` (20 ops on phone, 40 on base/pro, 50 on
max/ultra) are calibrated for single-model workloads.  When two or more
models share the GPU simultaneously the effective per-model budget halves or
thirds, and 40 ops/buffer crosses the watchdog threshold.

A Fleet L investigation with `oMLX` running two 8B models on M4 base (16 GB)
confirmed that reducing `max_ops_per_buffer` to 20 eliminates watchdog
timeouts with no measurable throughput regression at typical inference batch
sizes.  This PR makes both limits tunable at runtime without recompiling.

## Change

Two new functions are added to `mlx::core::metal::env` in `device.cpp`:

```cpp
int max_ops_per_buffer(int dflt);   // reads MLX_METAL_MAX_OPS_PER_BUFFER
int max_mb_per_buffer(int dflt);    // reads MLX_METAL_MAX_MB_PER_BUFFER
```

Both are called at the end of `Device::Device()`, after the switch statement
sets the architecture-derived default, and receive that default as `dflt`.
If the environment variable is absent, non-numeric, zero, or out of range,
the function returns `dflt` unchanged.  Valid ranges: ops 1–4096, mb 1–65536.

The helper `get_env_int(name, dflt, lo, hi)` in the anonymous namespace uses
`std::strtol` (no exceptions, no extra headers) for safe parsing.

## Operator guidance

On M-series base GPUs running concurrent workloads, start with:

```
MLX_METAL_MAX_OPS_PER_BUFFER=20
```

This halves the accumulated work per submission relative to the 'g'-tier
default and has eliminated watchdog timeouts in observed Fleet L deployments.
Max/ultra GPUs (default 50) are unlikely to need tuning for typical workloads.

`MLX_METAL_MAX_MB_PER_BUFFER` targets memory-bandwidth pressure rather than
op count; leave it at the architecture default unless profiling shows
buffer-size is the binding constraint.

## Compatibility

Fully backward-compatible.  With neither variable set, `Device::Device()`
produces identical values to the pre-patch code at every architecture tier.

## Tests

`tests/test_metal_device_knobs.cpp` — three doctest cases:

1. **Default behaviour** — verifies that with both variables unset,
   `max_ops_per_buffer(dflt)` and `max_mb_per_buffer(dflt)` return `dflt`
   for multiple representative default values (20, 40, 50).

2. **Env-var override** — sets `MLX_METAL_MAX_OPS_PER_BUFFER=20` and
   `MLX_METAL_MAX_MB_PER_BUFFER=16`; confirms the overrides are applied.

3. **Invalid-env fallback** — exercises non-integer input, value below lo
   (0 < 1), value above hi for ops (4097 > 4096), and value above hi for mb
   (65537 > 65536); all four cases must return `dflt`.
