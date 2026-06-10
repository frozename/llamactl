# KV Warm-Restore Bench Template

- Generated at: 2026-05-24T19:12:32.109Z
- Model: granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf
- Proxy base URL: https://127.0.0.1:7944
- Machine: Alexandres-MacBook-Pro-74702.local
- OS: darwin 25.4.0
- Frontiers: 256, 512
- Warm runs: 2

## Per-frontier results

| promptSize | t_cold_ms | t_cold_first_byte_ms | t_warm_min_ms | t_warm_p50_ms | t_warm_p95_ms | ratio_cold_over_warm | kv_warm_hit_total | kv_cold_miss_total | kv_false_hit_total |
| ---------- | --------- | -------------------- | ------------- | ------------- | ------------- | -------------------- | ----------------- | ------------------ | ------------------ |
| 256        | 1875.21   | 1874.91              | 169.33        | 169.33        | 169.41        | 11.07                | 0                 | 0                  | 0                  |
| 512        | 2229.26   | 2229.25              | 172.64        | 172.64        | 173.93        | 12.91                | 0                 | 0                  | 0                  |

## Raw CSV

```csv
promptSize,t_cold_ms,t_cold_first_byte_ms,t_warm_min_ms,t_warm_p50_ms,t_warm_p95_ms,ratio_cold_over_warm,kv_warm_hit_total,kv_cold_miss_total,kv_false_hit_total
256,1875.21,1874.91,169.33,169.33,169.41,11.07,0,0,0
512,2229.26,2229.25,172.64,172.64,173.93,12.91,0,0,0
```

## Decision (to fill in after running)

- [ ] 16k frontier cold/warm ratio ≥ 2.0 → Slice 2 ships, Phase 8 NOT needed
- [ ] Write cost p95 ≤ 100 ms → no cadence work needed
- [ ] False-hit rate (`kv_false_hit_total / kv_warm_hit_total`) ≤ 1% → no equivalence work needed
