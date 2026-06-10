# Matrix report

Run: 2026-06-06T04:43:17.680Z-67e8400f
Cells: 12

## Primary metric (mixed)

| Model                           | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM        | 0.8493        | 0.9018            | 0.7200            |
| gemma4-12b-llamacpp-QAT-Q4_0    | 0.7952        | 0.9049            | 0.7000            |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 0.8209        | 0.9186            | 0.6400            |
| gemma4-e4b-llamacpp-UDQ4KXL     | 0.7171        | 0.9228            | 0.3800            |

## Latency (p50 / p95, ms)

| Model                           | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM        | 5979 / 10925  | 30493 / 33982     | 1474 / 6010       |
| gemma4-12b-llamacpp-QAT-Q4_0    | 5460 / 6707   | 28819 / 32093     | 1492 / 9513       |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 2753 / 3182   | 16667 / 19338     | 828 / 3340        |
| gemma4-e4b-llamacpp-UDQ4KXL     | 2599 / 2946   | 16182 / 18812     | 618 / 1925        |

## Throughput (tps)

| Model                           | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM        | 13.97         | 23.06             | 19.90             |
| gemma4-12b-llamacpp-QAT-Q4_0    | 13.75         | 24.44             | 21.43             |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 27.07         | 42.95             | 37.97             |
| gemma4-e4b-llamacpp-UDQ4KXL     | 28.02         | 44.71             | 35.87             |

## Errors

| Model                           | memory-recall | project-brief-gen | tool-call-grammar |
| ------------------------------- | ------------- | ----------------- | ----------------- |
| gemma4-12b-llamacpp-Q4KM        | 0             | 0                 | 0                 |
| gemma4-12b-llamacpp-QAT-Q4_0    | 0             | 0                 | 0                 |
| gemma4-26b-a4b-llamacpp-UDQ4KXL | 0             | 0                 | 0                 |
| gemma4-e4b-llamacpp-UDQ4KXL     | 0             | 0                 | 0                 |

## Per-workload winner

- memory-recall: **gemma4-12b-llamacpp-Q4KM** (0.8493)
- project-brief-gen: **gemma4-e4b-llamacpp-UDQ4KXL** (0.9228)
- tool-call-grammar: **gemma4-12b-llamacpp-Q4KM** (0.7200)
