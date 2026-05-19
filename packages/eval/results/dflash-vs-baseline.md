# Matrix report

Run: 2026-05-19T22:38:53.776Z-df1c0bd7
Cells: 6

## Primary metric (mixed)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| qwen3-8b-llamacpp-Q4KM | 0.3608 | 0.6939 |
| qwen3-8b-mlx-dflash | 0.5544 | 0.9000 |
| qwen3-8b-mlx-vanilla | 0.5633 | 0.9000 |

## Latency (p50 / p95, ms)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| qwen3-8b-llamacpp-Q4KM | 3324 / 4056 | 1199 / 2629 |
| qwen3-8b-mlx-dflash | 3140 / 3739 | 1501 / 2970 |
| qwen3-8b-mlx-vanilla | 3400 / 3972 | 1424 / 2266 |

## Throughput (tps)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| qwen3-8b-llamacpp-Q4KM | 19.84 | 28.60 |
| qwen3-8b-mlx-dflash | 22.69 | 25.77 |
| qwen3-8b-mlx-vanilla | 20.69 | 29.57 |

## Errors

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| qwen3-8b-llamacpp-Q4KM | 0 | 1 |
| qwen3-8b-mlx-dflash | 0 | 0 |
| qwen3-8b-mlx-vanilla | 0 | 0 |

## Per-workload winner

- memory-recall: **qwen3-8b-mlx-vanilla** (0.5633)
- tool-call-grammar: **qwen3-8b-mlx-dflash** (0.9000)
