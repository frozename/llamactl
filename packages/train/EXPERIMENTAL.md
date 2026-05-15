# EXPERIMENTAL — `packages/train`

This package is experimental. It scaffolds the fine-tuning capability llamactl
plans to grow into (local SFT on Apple Silicon via MLX-LM, served by the
existing `llama-server` Metal backend via `--lora`). The current state is
**Day-1 spike**: `scripts/spike-mlx-to-llamacpp.sh` validates the
MLX→PEFT→GGUF→`llama-server` toolchain end-to-end on a tiny model and 20
training rows of synthetic data.

## Stability

- **No API stability guarantees.** Scripts, file layouts, and function
  signatures will change without notice as this surface matures.
- The bridge (`src/bridge/mlx_to_peft.py`) is correct for the MLX-LM 0.31.x
  adapter format. Other versions are not exercised.
- The spike pins `llama.cpp` to a specific SHA and the model fallback chain
  to specific HF revisions. Update the pins intentionally; don't float them.

## What this package is NOT (yet)

- Not a llamactl workload type. There is no `kind: ModelTraining` in the
  daemon. Training runs are launched manually via the spike script.
- Not the home for the production memory-efficacy or home-mgmt LoRA training.
  Those land here once this scaffolding is hardened.
- Not the place for RunPod / cloud training plumbing. Future work; out of
  scope for the spike.

## Status

| Item | State |
|---|---|
| MLX-LM → llama.cpp toolchain validation | done (spike PASS) |
| Pinned deps + reproducibility | done |
| `kind: ModelTraining` workload type | not started |
| Real-corpus training (memory-efficacy classifier) | blocked on this |
| Real-corpus training (home-mgmt protocol) | blocked on this |
| RunPod / cloud compute integration | not started |

If you're tempted to depend on this package from another workspace, don't.
Talk to the owner first.
