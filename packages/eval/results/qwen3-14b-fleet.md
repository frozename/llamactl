# Matrix report

Run: 2026-05-20T00:46:49.287Z-9f7087cd
Cells: 3

## Primary metric (mixed)

| Model              | memory-recall | task-refiner-rubric | tool-call-grammar |
| ------------------ | ------------- | ------------------- | ----------------- |
| qwen3-14b-mlx-4bit | 0.7311        | 0.7733              | 0.9200            |

## Latency (p50 / p95, ms)

| Model              | memory-recall | task-refiner-rubric | tool-call-grammar |
| ------------------ | ------------- | ------------------- | ----------------- |
| qwen3-14b-mlx-4bit | 5383 / 7021   | 10654 / 13912       | 2538 / 4020       |

## Throughput (tps)

| Model              | memory-recall | task-refiner-rubric | tool-call-grammar |
| ------------------ | ------------- | ------------------- | ----------------- |
| qwen3-14b-mlx-4bit | 13.56         | 19.11               | 16.75             |

## Errors

| Model              | memory-recall | task-refiner-rubric | tool-call-grammar |
| ------------------ | ------------- | ------------------- | ----------------- |
| qwen3-14b-mlx-4bit | 0             | 0                   | 0                 |

## Per-workload winner

- memory-recall: **qwen3-14b-mlx-4bit** (0.7311)
- task-refiner-rubric: **qwen3-14b-mlx-4bit** (0.7733)
- tool-call-grammar: **qwen3-14b-mlx-4bit** (0.9200)
