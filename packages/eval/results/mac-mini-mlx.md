# Matrix report

Run: 2026-05-20T06:36:54.671Z-47404cd9
Cells: 6

## Primary metric (mixed)

| Model                           | memory-recall | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- |
| gemma4-e2b-mlx-4bit-mac-mini    | 0.6625        | 0.6200            |
| granite41-8b-mlx-nvfp4-mac-mini | 0.7445        | 0.8600            |
| qwen3-8b-mlx-4bit-mac-mini      | 0.5639        | 0.9000            |

## Latency (p50 / p95, ms)

| Model                           | memory-recall | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- |
| gemma4-e2b-mlx-4bit-mac-mini    | 1534 / 1676   | 555 / 1539        |
| granite41-8b-mlx-nvfp4-mac-mini | 7605 / 16146  | 3514 / 8512       |
| qwen3-8b-mlx-4bit-mac-mini      | 7318 / 8514   | 2971 / 4880       |

## Throughput (tps)

| Model                           | memory-recall | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- |
| gemma4-e2b-mlx-4bit-mac-mini    | 44.64         | 52.12             |
| granite41-8b-mlx-nvfp4-mac-mini | 8.27          | 12.67             |
| qwen3-8b-mlx-4bit-mac-mini      | 9.73          | 14.01             |

## Errors

| Model                           | memory-recall | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- |
| gemma4-e2b-mlx-4bit-mac-mini    | 0             | 0                 |
| granite41-8b-mlx-nvfp4-mac-mini | 0             | 0                 |
| qwen3-8b-mlx-4bit-mac-mini      | 0             | 0                 |

## Per-workload winner

- memory-recall: **granite41-8b-mlx-nvfp4-mac-mini** (0.7445)
- tool-call-grammar: **qwen3-8b-mlx-4bit-mac-mini** (0.9000)
