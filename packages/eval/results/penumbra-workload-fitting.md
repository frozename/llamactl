# Matrix report

Run: 2026-05-20T16:17:45.196Z-307e142a
Cells: 12

## Primary metric (mixed)

| Model                | memory-recall | task-refiner-rubric | tool-call-grammar |
| -------------------- | ------------- | ------------------- | ----------------- |
| gemma4-e2b-mlx-4bit  | 0.6625        | 0.6978              | 0.6200            |
| granite-3b-mlx-4bit  | 0.5442        | 0.7511              | 0.6400            |
| granite-8b-mlx-nvfp4 | 0.7302        | 0.8089              | 0.8600            |
| qwen3-8b-mlx-4bit    | 0.5633        | 0.7467              | 0.9000            |

## Latency (p50 / p95, ms)

| Model                | memory-recall | task-refiner-rubric | tool-call-grammar |
| -------------------- | ------------- | ------------------- | ----------------- |
| gemma4-e2b-mlx-4bit  | 815 / 897     | 1438 / 2458         | 296 / 813         |
| granite-3b-mlx-4bit  | 1565 / 1859   | 3450 / 4476         | 810 / 1230        |
| granite-8b-mlx-nvfp4 | 3494 / 7665   | 8176 / 9405         | 1617 / 3860       |
| qwen3-8b-mlx-4bit    | 3384 / 4002   | 4629 / 7657         | 1414 / 2283       |

## Throughput (tps)

| Model                | memory-recall | task-refiner-rubric | tool-call-grammar |
| -------------------- | ------------- | ------------------- | ----------------- |
| gemma4-e2b-mlx-4bit  | 85.00         | 93.25               | 98.82             |
| granite-3b-mlx-4bit  | 30.26         | 59.58               | 49.39             |
| granite-8b-mlx-nvfp4 | 18.57         | 30.11               | 27.87             |
| qwen3-8b-mlx-4bit    | 21.42         | 29.48               | 29.88             |

## Errors

| Model                | memory-recall | task-refiner-rubric | tool-call-grammar |
| -------------------- | ------------- | ------------------- | ----------------- |
| gemma4-e2b-mlx-4bit  | 0             | 0                   | 0                 |
| granite-3b-mlx-4bit  | 0             | 0                   | 0                 |
| granite-8b-mlx-nvfp4 | 0             | 0                   | 0                 |
| qwen3-8b-mlx-4bit    | 0             | 0                   | 0                 |

## Per-workload winner

- memory-recall: **granite-8b-mlx-nvfp4** (0.7302)
- task-refiner-rubric: **granite-8b-mlx-nvfp4** (0.8089)
- tool-call-grammar: **qwen3-8b-mlx-4bit** (0.9000)
