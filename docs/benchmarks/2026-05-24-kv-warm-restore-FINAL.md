# KV Warm-Restore Bench Template

- Generated at: 2026-05-24T19:21:12.234Z
- Model: granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf
- Proxy base URL: https://127.0.0.1:7944
- Machine: Alexandres-MacBook-Pro-74702.local
- OS: darwin 25.4.0
- Frontiers: 512, 1024
- Warm runs: 3

## Per-frontier results

| promptSize | t_cold_ms | t_cold_first_byte_ms | t_warm_min_ms | t_warm_p50_ms | t_warm_p95_ms | ratio_cold_over_warm | kv_warm_hit_total | kv_cold_miss_total | kv_false_hit_total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 512 | 248.36 | 248.00 | 184.89 | 188.45 | 203.01 | 1.32 | 3 | 2 | 0 |
| 1024 | 5644.81 | 5644.77 | 212.76 | 213.37 | 213.42 | 26.46 | 6 | 3 | 0 |

## Raw CSV

```csv
promptSize,t_cold_ms,t_cold_first_byte_ms,t_warm_min_ms,t_warm_p50_ms,t_warm_p95_ms,ratio_cold_over_warm,kv_warm_hit_total,kv_cold_miss_total,kv_false_hit_total
512,248.36,248.00,184.89,188.45,203.01,1.32,3,2,0
1024,5644.81,5644.77,212.76,213.37,213.42,26.46,6,3,0
```

## Decision (to fill in after running)
- [ ] 16k frontier cold/warm ratio ≥ 2.0 → Slice 2 ships, Phase 8 NOT needed
- [ ] Write cost p95 ≤ 100 ms → no cadence work needed
- [ ] False-hit rate (`kv_false_hit_total / kv_warm_hit_total`) ≤ 1% → no equivalence work needed
