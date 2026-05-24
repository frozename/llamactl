# kv-warm-bench

`kv-warm-bench` is a client-side benchmark harness for KV warm-restore in the OpenAI-compatible proxy path.
It compares cold prefill latency versus warm repeat latency for the same byte-identical prompt at multiple context frontiers.

## What it measures

For each frontier (default: `2048,4096,8192,16384,32768`), the harness:

1. Builds a deterministic prompt payload (same bytes for cold + warm requests).
2. Sends one cold `POST /v1/chat/completions` request.
3. Sends `N` warm repeats (default `3`) with the exact same request payload.
4. Records:
   - cold complete latency (`t_cold_ms`)
   - cold first-byte latency (`t_cold_first_byte_ms`)
   - warm min/p50/p95 (`t_warm_*`)
   - cold/warm ratio (`ratio_cold_over_warm`)
   - KV registry counters from `<dataRoot>/kvstore/registry.db`

The run writes `docs/benchmarks/2026-05-24-kv-warm-restore-template.md` by default.

## Manual run

```bash
bun packages/eval/src/matrix/cli.ts run kv-warm-bench \
  --proxy http://127.0.0.1:8089 \
  --model <route-model-name> \
  --frontiers 2048,4096,8192,16384,32768 \
  --warm-runs 3
```

Optional flags: `--temperature`, `--max-tokens`, `--data-root`, `--out`, `--seed`.

## Phase 8 decision rules

Use the generated checklist exactly:

- 16k frontier cold/warm ratio `>= 2.0` → Slice 2 ships, Phase 8 not needed.
- write cost p95 `<= 100 ms` → no cadence work needed.
- false-hit rate (`kv_false_hit_total / kv_warm_hit_total`) `<= 1%` → no equivalence work needed.

## Known limitations

- Single prompt per frontier; this is not a concurrent-load or soak benchmark.
- No quant-by-quant matrix; run separately per model/quant route.
- Registry-only counter mode reads warm-hit and cold-miss from SQLite; `kv_false_hit_total` is not persisted there today.
