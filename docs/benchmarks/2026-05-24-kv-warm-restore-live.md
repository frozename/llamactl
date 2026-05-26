# KV Warm-Restore Bench Template

- Generated at: 2026-05-24T18:27:13.694Z
- Model: granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf
- Proxy base URL: https://127.0.0.1:7944
- Machine: Alexandres-MacBook-Pro-74702.local
- OS: darwin 25.4.0
- Frontiers: 512, 1024, 2048
- Warm runs: 2

## Per-frontier results

| promptSize | t_cold_ms | t_cold_first_byte_ms | t_warm_min_ms | t_warm_p50_ms | t_warm_p95_ms | ratio_cold_over_warm | kv_warm_hit_total | kv_cold_miss_total | kv_false_hit_total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 512 | 4104.55 | 4104.24 | 344.34 | 344.34 | 344.64 | 11.92 | 0 | 0 | 0 |
| 1024 | 5801.36 | 5801.33 | 373.44 | 373.44 | 377.66 | 15.53 | 0 | 0 | 0 |
| 2048 | 16596.63 | 16596.53 | 436.15 | 436.15 | 437.22 | 38.05 | 0 | 0 | 0 |

## Raw CSV

```csv
promptSize,t_cold_ms,t_cold_first_byte_ms,t_warm_min_ms,t_warm_p50_ms,t_warm_p95_ms,ratio_cold_over_warm,kv_warm_hit_total,kv_cold_miss_total,kv_false_hit_total
512,4104.55,4104.24,344.34,344.34,344.64,11.92,0,0,0
1024,5801.36,5801.33,373.44,373.44,377.66,15.53,0,0,0
2048,16596.63,16596.53,436.15,436.15,437.22,38.05,0,0,0
```

## Decision (to fill in after running)
- [ ] 16k frontier cold/warm ratio ≥ 2.0 → Slice 2 ships, Phase 8 NOT needed
- [ ] Write cost p95 ≤ 100 ms → no cadence work needed
- [ ] False-hit rate (`kv_false_hit_total / kv_warm_hit_total`) ≤ 1% → no equivalence work needed
