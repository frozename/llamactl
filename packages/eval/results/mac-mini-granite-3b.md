# Matrix report

Run: 2026-05-20T07:35:03.784Z-645fe8a3
Cells: 6

## Primary metric (mixed)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| granite41-3b-llamacpp-Q8-mac-mini | 0.6250 | 0.8571 |
| granite41-3b-mlx-8bit-mac-mini | 0.6020 | 0.7400 |
| granite41-3b-mlx-nvfp4-mac-mini | 0.1230 | 0.7800 |

## Latency (p50 / p95, ms)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| granite41-3b-llamacpp-Q8-mac-mini | 3497 / 4024 | 2017 / 3190 |
| granite41-3b-mlx-8bit-mac-mini | 4088 / 4680 | 2344 / 3315 |
| granite41-3b-mlx-nvfp4-mac-mini | 2795 / 3449 | 1512 / 2461 |

## Throughput (tps)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| granite41-3b-llamacpp-Q8-mac-mini | 14.69 | 20.76 |
| granite41-3b-mlx-8bit-mac-mini | 11.88 | 17.63 |
| granite41-3b-mlx-nvfp4-mac-mini | 13.19 | 28.03 |

## Errors

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| granite41-3b-llamacpp-Q8-mac-mini | 0 | 1 |
| granite41-3b-mlx-8bit-mac-mini | 0 | 0 |
| granite41-3b-mlx-nvfp4-mac-mini | 0 | 0 |

## Per-workload winner

- memory-recall: **granite41-3b-llamacpp-Q8-mac-mini** (0.6250)
- tool-call-grammar: **granite41-3b-llamacpp-Q8-mac-mini** (0.8571)
