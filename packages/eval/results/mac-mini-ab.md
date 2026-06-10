# Matrix report

Run: 2026-05-20T15:47:13.041Z-0f82f9cc
Cells: 6

## Primary metric (macro_f1)

| Model                     | memory-efficacy-4way |
| ------------------------- | -------------------- |
| mlx-4bit-constrained      | 0.9235               |
| mlx-4bit-unconstrained    | 0.6869               |
| mlx-8bit-constrained      | 0.8931               |
| mlx-8bit-unconstrained    | 0.6593               |
| Q8-llamacpp-constrained   | 0.9235               |
| Q8-llamacpp-unconstrained | 0.9235               |

## Latency (p50 / p95, ms)

| Model                     | memory-efficacy-4way |
| ------------------------- | -------------------- |
| mlx-4bit-constrained      | 1210 / 1419          |
| mlx-4bit-unconstrained    | 1215 / 1369          |
| mlx-8bit-constrained      | 1939 / 2254          |
| mlx-8bit-unconstrained    | 1846 / 2178          |
| Q8-llamacpp-constrained   | 1410 / 1850          |
| Q8-llamacpp-unconstrained | 1428 / 1870          |

## Throughput (tps)

| Model                     | memory-efficacy-4way |
| ------------------------- | -------------------- |
| mlx-4bit-constrained      | 27.49                |
| mlx-4bit-unconstrained    | 28.64                |
| mlx-8bit-constrained      | 18.74                |
| mlx-8bit-unconstrained    | 19.41                |
| Q8-llamacpp-constrained   | 24.92                |
| Q8-llamacpp-unconstrained | 24.63                |

## Errors

| Model                     | memory-efficacy-4way |
| ------------------------- | -------------------- |
| mlx-4bit-constrained      | 0                    |
| mlx-4bit-unconstrained    | 0                    |
| mlx-8bit-constrained      | 0                    |
| mlx-8bit-unconstrained    | 0                    |
| Q8-llamacpp-constrained   | 0                    |
| Q8-llamacpp-unconstrained | 0                    |

## Per-workload winner

- memory-efficacy-4way: **mlx-4bit-constrained** (0.9235)
