# Stress fleet C

Run ID: `stress-C-20260520-161226`

| workload | model | metric | score | throughput_tps | p50_ms | p95_ms | errors |
| -- | -- | -- | --: | --: | --: | --: | --: |
| memory-efficacy-4way | granite-4.1-8b-mlx-nvfp4 | macro_f1 | 0.9235 | 0.99 | 46831 | 69506 | 0 |
| memory-recall | granite-4.1-8b-mlx-nvfp4 | mean_ndcg5 | 0.7429 | 1.81 | 26114 | 77338 | 0 |
| task-refiner-rubric | granite-4.1-8b-mlx-nvfp4 | composite | 0.8533 | 2.81 | 74642 | 112012 | 0 |
| tool-call-grammar | qwen3-8b-mlx-4bit | mean_exact_match | 0.6667 | 2.77 | 9733 | 12942 | 47 |
| aggregate-wall-time | all | elapsed_seconds | 988 | - | - | - | - |

