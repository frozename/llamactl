## Motivation

Under multi-model concurrent load on small Apple Silicon GPUs (such as the M4 base model), the OS GPU watchdog can trigger when command buffers are too large. A recent per-process Fleet L investigation demonstrated that the static limit of 40 operations and 40 MB per buffer is too high when multiple distinct models are multiplexing the GPU execution units, leading to unrecoverable watchdog timeouts. This PR makes these limits configurable without requiring a recompile.

## Change

This PR introduces two new environment variables that allow operators to dynamically scale down the maximum operations and size per Metal command buffer:
- `MLX_METAL_MAX_OPS_PER_BUFFER` (default 40, range 1-4096)
- `MLX_METAL_MAX_MB_PER_BUFFER` (default 40, range 1-65536)

The change is fully default-preserving. If the environment variables are not set or contain invalid values (non-integer, negative, or out-of-range), the system safely falls back to the original default of 40.

## Operator guidance

For deployments on small Apple Silicon GPUs (M1-M4 base variants) running concurrent workloads or multi-model applications, the empirical evidence chain tracked in `docs/upstream-patches/mlx-omlx-improvements-plan.md` points to command buffer execution times exceeding the watchdog timeout window when large fused operators pile up.

**Recommendation:** If you encounter `[METAL] Command buffer execution failed` errors under concurrent load on base-tier hardware, set a recommended starting value of `MLX_METAL_MAX_OPS_PER_BUFFER=20` to force more frequent command-buffer submissions and relieve pressure on the watchdog.

## Compatibility

This change is 100% backward compatible. Existing setups without these environment variables will continue to use the exact same limits (`40` ops, `40` MB) as before.

## Tests

Added a new dedicated unit test file (`tests/test_metal_device_knobs.cpp`) with three test cases:
1. Validates the default behavior when environment variables are unset.
2. Confirms overrides are correctly applied when valid values are provided.
3. Tests parsing resilience by asserting fallback to the default on invalid inputs (non-integers, negative numbers, and out-of-bounds values).
