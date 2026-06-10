# Matrix report

Run: 2026-05-20T12:11:05.258Z-e96c8b6f
Cells: 2

## Primary metric (macro_f1)

| Model                             | memory-efficacy-4way |
| --------------------------------- | -------------------- |
| granite41-3b-llamacpp-Q8-mac-mini | 0.9235               |
| granite41-8b-mlx-nvfp4-mac-mini   | 0.9235               |

## Latency (p50 / p95, ms)

| Model                             | memory-efficacy-4way |
| --------------------------------- | -------------------- |
| granite41-3b-llamacpp-Q8-mac-mini | 1427 / 1870          |
| granite41-8b-mlx-nvfp4-mac-mini   | 2878 / 3790          |

## Throughput (tps)

| Model                             | memory-efficacy-4way |
| --------------------------------- | -------------------- |
| granite41-3b-llamacpp-Q8-mac-mini | 24.71                |
| granite41-8b-mlx-nvfp4-mac-mini   | 14.37                |

## Errors

| Model                             | memory-efficacy-4way |
| --------------------------------- | -------------------- |
| granite41-3b-llamacpp-Q8-mac-mini | 0                    |
| granite41-8b-mlx-nvfp4-mac-mini   | 0                    |

## Per-workload winner

- memory-efficacy-4way: **granite41-8b-mlx-nvfp4-mac-mini** (0.9235)
