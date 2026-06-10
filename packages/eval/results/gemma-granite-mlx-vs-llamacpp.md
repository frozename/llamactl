# Matrix report

Run: 2026-05-19T23:29:43.263Z-7db69658
Cells: 8

## Primary metric (mixed)

| Model                       | memory-recall | tool-call-grammar |
| --------------------------- | ------------- | ----------------- |
| gemma4-e4b-llamacpp-UDQ4KXL | 0.7171        | 0.3800            |
| gemma4-e4b-mlx-4bit         | 0.5058        | 0.6400            |
| granite41-8b-llamacpp-Q4KM  | 0.4743        | 0.6122            |
| granite41-8b-mlx-nvfp4      | 0.7315        | 0.8600            |

## Latency (p50 / p95, ms)

| Model                       | memory-recall | tool-call-grammar |
| --------------------------- | ------------- | ----------------- |
| gemma4-e4b-llamacpp-UDQ4KXL | 2609 / 2938   | 623 / 1930        |
| gemma4-e4b-mlx-4bit         | 1890 / 4685   | 581 / 1656        |
| granite41-8b-llamacpp-Q4KM  | 8475 / 9595   | 1377 / 3010       |
| granite41-8b-mlx-nvfp4      | 3526 / 7518   | 1629 / 3811       |

## Throughput (tps)

| Model                       | memory-recall | tool-call-grammar |
| --------------------------- | ------------- | ----------------- |
| gemma4-e4b-llamacpp-UDQ4KXL | 28.02         | 34.98             |
| gemma4-e4b-mlx-4bit         | 49.10         | 50.53             |
| granite41-8b-llamacpp-Q4KM  | 27.16         | 25.08             |
| granite41-8b-mlx-nvfp4      | 18.14         | 27.38             |

## Errors

| Model                       | memory-recall | tool-call-grammar |
| --------------------------- | ------------- | ----------------- |
| gemma4-e4b-llamacpp-UDQ4KXL | 0             | 0                 |
| gemma4-e4b-mlx-4bit         | 0             | 0                 |
| granite41-8b-llamacpp-Q4KM  | 0             | 1                 |
| granite41-8b-mlx-nvfp4      | 0             | 0                 |

## Per-workload winner

- memory-recall: **granite41-8b-mlx-nvfp4** (0.7315)
- tool-call-grammar: **granite41-8b-mlx-nvfp4** (0.8600)
