# Matrix report

Run: 2026-05-20T03:20:08.904Z-8291085c
Cells: 4

## Primary metric (mixed)

| Model                      | memory-recall | tool-call-grammar |
| -------------------------- | ------------- | ----------------- |
| gemma4-26b-a4b-mlx-dflash  | 0.7738        | 0.8400            |
| gemma4-26b-a4b-mlx-vanilla | 0.7692        | 0.8400            |

## Latency (p50 / p95, ms)

| Model                      | memory-recall | tool-call-grammar |
| -------------------------- | ------------- | ----------------- |
| gemma4-26b-a4b-mlx-dflash  | 2478 / 2927   | 1381 / 4385       |
| gemma4-26b-a4b-mlx-vanilla | 2482 / 2963   | 1001 / 3446       |

## Throughput (tps)

| Model                      | memory-recall | tool-call-grammar |
| -------------------------- | ------------- | ----------------- |
| gemma4-26b-a4b-mlx-dflash  | 30.72         | 30.03             |
| gemma4-26b-a4b-mlx-vanilla | 30.89         | 41.03             |

## Errors

| Model                      | memory-recall | tool-call-grammar |
| -------------------------- | ------------- | ----------------- |
| gemma4-26b-a4b-mlx-dflash  | 0             | 0                 |
| gemma4-26b-a4b-mlx-vanilla | 0             | 0                 |

## Per-workload winner

- memory-recall: **gemma4-26b-a4b-mlx-dflash** (0.7738)
- tool-call-grammar: **gemma4-26b-a4b-mlx-dflash** (0.8400)
