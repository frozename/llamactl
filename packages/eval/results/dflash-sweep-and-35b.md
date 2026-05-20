# Matrix report

Run: 2026-05-19T23:06:35.084Z-01ced723
Cells: 4

## Primary metric (mean_ndcg5)

| Model | memory-recall |
| -- | -- |
| qwen3-8b-mlx-dflash-verify-tree | 0.5633 |
| qwen3-8b-mlx-dflash-window-64 | 0.5544 |
| qwen36-35b-a3b-mlx-dflash | 0.6404 |
| qwen36-35b-a3b-mlx-vanilla | 0.6433 |

## Latency (p50 / p95, ms)

| Model | memory-recall |
| -- | -- |
| qwen3-8b-mlx-dflash-verify-tree | 3889 / 4503 |
| qwen3-8b-mlx-dflash-window-64 | 3773 / 4459 |
| qwen36-35b-a3b-mlx-dflash | 2119 / 2467 |
| qwen36-35b-a3b-mlx-vanilla | 2202 / 2425 |

## Throughput (tps)

| Model | memory-recall |
| -- | -- |
| qwen3-8b-mlx-dflash-verify-tree | 18.28 |
| qwen3-8b-mlx-dflash-window-64 | 19.12 |
| qwen36-35b-a3b-mlx-dflash | 46.25 |
| qwen36-35b-a3b-mlx-vanilla | 44.85 |

## Errors

| Model | memory-recall |
| -- | -- |
| qwen3-8b-mlx-dflash-verify-tree | 0 |
| qwen3-8b-mlx-dflash-window-64 | 0 |
| qwen36-35b-a3b-mlx-dflash | 0 |
| qwen36-35b-a3b-mlx-vanilla | 0 |

## Per-workload winner

- memory-recall: **qwen36-35b-a3b-mlx-vanilla** (0.6433)
