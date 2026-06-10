# Stress fleet A

Run ID: `stress-A-20260520-163057`

| workload             | model                    | metric           |  score | throughput_tps | p50_ms | p95_ms | errors |
| -------------------- | ------------------------ | ---------------- | -----: | -------------: | -----: | -----: | -----: |
| memory-efficacy-4way | granite-4.1-8b-mlx-nvfp4 | macro_f1         | 0.9235 |           1.33 |  31325 |  46679 |      0 |
| memory-recall        | granite-4.1-8b-mlx-nvfp4 | mean_ndcg5       | 0.7387 |           2.57 |  19403 |  83513 |      0 |
| task-refiner-rubric  | granite-4.1-8b-mlx-nvfp4 | composite        | 0.8267 |           2.88 |  75753 |  91514 |      0 |
| tool-call-grammar    | granite-4.1-8b-mlx-nvfp4 | mean_exact_match | 0.8600 |           1.46 |  33596 |  61842 |      0 |
| aggregate-wall-time  | all                      | elapsed_seconds  |    738 |              - |      - |      - |      - |
