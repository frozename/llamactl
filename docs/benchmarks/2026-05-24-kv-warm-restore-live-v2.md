# KV Warm-Restore Bench Template

- Generated at: 2026-05-24T19:02:28.383Z
- Model: granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf
- Proxy base URL: https://127.0.0.1:7944
- Machine: Alexandres-MacBook-Pro-74702.local
- OS: darwin 25.4.0
- Frontiers: 512, 1024, 2048
- Warm runs: 3

## Per-frontier results

| promptSize | t_cold_ms | t_cold_first_byte_ms | t_warm_min_ms | t_warm_p50_ms | t_warm_p95_ms | ratio_cold_over_warm | kv_warm_hit_total | kv_cold_miss_total | kv_false_hit_total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 512 | 4089.73 | 4089.59 | 347.57 | 352.43 | 353.63 | 11.60 | 0 | 0 | 0 |
| 1024 | 5804.83 | 5804.80 | 374.06 | 375.11 | 375.48 | 15.47 | 0 | 0 | 0 |
| 2048 | 16616.58 | 16616.50 | 426.22 | 429.69 | 432.23 | 38.67 | 0 | 0 | 0 |

## Raw CSV

```csv
promptSize,t_cold_ms,t_cold_first_byte_ms,t_warm_min_ms,t_warm_p50_ms,t_warm_p95_ms,ratio_cold_over_warm,kv_warm_hit_total,kv_cold_miss_total,kv_false_hit_total
512,4089.73,4089.59,347.57,352.43,353.63,11.60,0,0,0
1024,5804.83,5804.80,374.06,375.11,375.48,15.47,0,0,0
2048,16616.58,16616.50,426.22,429.69,432.23,38.67,0,0,0
```

## Decision (to fill in after running)
- [ ] 16k frontier cold/warm ratio ≥ 2.0 → Slice 2 ships, Phase 8 NOT needed
- [ ] Write cost p95 ≤ 100 ms → no cadence work needed
- [ ] False-hit rate (`kv_false_hit_total / kv_warm_hit_total`) ≤ 1% → no equivalence work needed
