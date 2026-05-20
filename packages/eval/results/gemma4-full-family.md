# Matrix report

Run: 2026-05-20T01:06:24.297Z-358ca8b3
Cells: 8

## Primary metric (mixed)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 0.8209 | 0.6400 |
| gemma4-31b-llamacpp-UDQ4KXL | 0.8226 | 0.6200 |
| gemma4-e2b-llamacpp-UDQ4KXL | 0.5734 | 0.3800 |
| gemma4-e2b-mlx-4bit | 0.6625 | 0.6200 |

## Latency (p50 / p95, ms)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 2761 / 3206 | 837 / 3383 |
| gemma4-31b-llamacpp-UDQ4KXL | 15073 / 17956 | 4086 / 8624 |
| gemma4-e2b-llamacpp-UDQ4KXL | 1224 / 1655 | 388 / 960 |
| gemma4-e2b-mlx-4bit | 841 / 924 | 297 / 809 |

## Throughput (tps)

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 26.97 | 37.62 |
| gemma4-31b-llamacpp-UDQ4KXL | 5.11 | 8.00 |
| gemma4-e2b-llamacpp-UDQ4KXL | 42.81 | 59.24 |
| gemma4-e2b-mlx-4bit | 81.70 | 98.85 |

## Errors

| Model | memory-recall | tool-call-grammar |
| -- | -- | -- |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 0 | 0 |
| gemma4-31b-llamacpp-UDQ4KXL | 0 | 0 |
| gemma4-e2b-llamacpp-UDQ4KXL | 0 | 0 |
| gemma4-e2b-mlx-4bit | 0 | 0 |

## Per-workload winner

- memory-recall: **gemma4-31b-llamacpp-UDQ4KXL** (0.8226)
- tool-call-grammar: **gemma4-26b-a4b-llamacpp-UDQ4KXL** (0.6400)
