# Matrix report

Run: 2026-06-06T11:51:37.850Z-2d292dcc
Cells: 6

## Primary metric (mixed)

| Model                    | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------ | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM | 0.8493        | 0.9001            | 0.7200            |
| gemma4-12b-omlx-MLX-4bit | 0.8715        | 0.8885            | 0.9000            |

## Latency (p50 / p95, ms)

| Model                    | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------ | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM | 5981 / 10957  | 29716 / 34656     | 1478 / 6041       |
| gemma4-12b-omlx-MLX-4bit | 6949 / 8206   | 35241 / 40859     | 2340 / 9321       |

## Throughput (tps)

| Model                    | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------ | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM | 13.97         | 22.99             | 19.78             |
| gemma4-12b-omlx-MLX-4bit | 10.40         | 18.00             | 14.88             |

## Errors

| Model                    | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------ | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM | 0             | 0                 | 0                 |
| gemma4-12b-omlx-MLX-4bit | 0             | 0                 | 0                 |

## Per-workload winner

- memory-recall: **gemma4-12b-omlx-MLX-4bit** (0.8715)
- project-brief-gen: **gemma4-12b-llamacpp-Q4KM** (0.9001)
- tool-call-grammar: **gemma4-12b-omlx-MLX-4bit** (0.9000)
