# Stress fleet B

Run ID: `stress-B-20260520-152520`

| workload             | model                    | metric           |  score | throughput_tps | p50_ms | p95_ms | errors |
| -------------------- | ------------------------ | ---------------- | -----: | -------------: | -----: | -----: | -----: |
| memory-efficacy-4way | granite-4.1-3b-mlx-4bit  | macro_f1         | 0.9235 |           5.70 |   5370 |  13670 |      0 |
| memory-recall        | granite-4.1-8b-mlx-nvfp4 | mean_ndcg5       | 0.7250 |           3.20 |  19325 |  54640 |      0 |
| task-refiner-rubric  | granite-4.1-8b-mlx-nvfp4 | composite        | 0.8311 |           4.22 |  51510 |  71778 |      0 |
| tool-call-grammar    | granite-4.1-8b-mlx-nvfp4 | mean_exact_match | 0.8400 |           1.65 |  29591 |  62683 |      0 |
| aggregate-wall-time  | all                      | elapsed_seconds  |    607 |              - |      - |      - |      - |
