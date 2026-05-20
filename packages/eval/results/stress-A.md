# Stress fleet A

Run ID: `stress-A-20260520-150815`

| workload | model | metric | score | throughput_tps | p50_ms | p95_ms | errors |
| -- | -- | -- | --: | --: | --: | --: | --: |
| memory-efficacy-4way | granite-4.1-8b-mlx-nvfp4 | macro_f1 | 0.9235 | 1.24 | 34895 | 47775 | 0 |
| memory-recall | granite-4.1-8b-mlx-nvfp4 | mean_ndcg5 | 0.7360 | 2.27 | 24735 | 64596 | 0 |
| task-refiner-rubric | granite-4.1-8b-mlx-nvfp4 | composite | 0.8311 | 3.92 | 58647 | 68860 | 0 |
| tool-call-grammar | granite-4.1-8b-mlx-nvfp4 | mean_exact_match | 0.8600 | 1.38 | 37178 | 52221 | 0 |
| aggregate-wall-time | all | elapsed_seconds | 814 | - | - | - | - |

