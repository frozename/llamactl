# Stress fleet D

Run ID: `stress-D-20260520-154024`

| workload | model | metric | score | throughput_tps | p50_ms | p95_ms | errors |
| -- | -- | -- | --: | --: | --: | --: | --: |
| memory-efficacy-4way | granite-4.1-3b-mlx-4bit | macro_f1 | 0.9235 | 5.31 | 5326 | 16008 | 0 |
| memory-recall | granite-4.1-8b-mlx-nvfp4 | mean_ndcg5 | 0.7312 | 3.56 | 15769 | 49213 | 0 |
| task-refiner-rubric | granite-4.1-8b-mlx-nvfp4 | composite | 0.8178 | 5.16 | 38212 | 69390 | 0 |
| tool-call-grammar | qwen3-8b-mlx-4bit | mean_exact_match | 0.0000 | 0.00 | 0 | 0 | 50 |
| aggregate-wall-time | all | elapsed_seconds | 532 | - | - | - | - |

