# Per-row persistence validation — 2026-05-18

Proves the new `matrix_cell_row_details` table (commit `038f4ee`)
eliminates the need to re-bench when slicing a workload corpus into
tiers / families / row subsets.

## Method

1. Re-ran the 4-model tool-call-grammar bench on the same n=50 corpus
   used in the gold-tier diagnostic (`82377ce`). Aggregate cells
   reproduce the previous run exactly (gemma4-26b 0.6400, gemma4-e4b
   0.3800, granite-3b-Q8 0.6327, qwen3.5 0.6600 — same as
   `2026-05-18-tool-call-full.db`).
2. Built `row_index → tier` map from `test.jsonl` by counting
   `messages[-1].tool_calls`:
   - `nocall` (n=5): indices `4, 10, 29, 30, 31`
   - `single` (n=34): 34 indices, complement of the others
   - `multi` (n=11): `0, 1, 8, 12, 13, 14, 15, 16, 17, 40, 48`
3. Aggregated `exact_match` per tier per model directly from
   `matrix_cell_row_details` in SQL, no bench re-run.

## SQL recipe

```sql
SELECT model_name,
       ROUND(AVG(json_extract(metrics_json, '$.exact_match')), 4) AS em,
       COUNT(*) AS n
FROM matrix_cell_row_details
WHERE row_index IN (<tier indices>)
  AND run_id = '<run>'
GROUP BY model_name
ORDER BY model_name;
```

## Result

| Tier   | Model              |        SQL EM |        tier-bench EM | match |
| ------ | ------------------ | ------------: | -------------------: | :---: |
| nocall | gemma4-26b-a4b-mtp |        0.8000 |               0.8000 |   ✓   |
| nocall | gemma4-e4b-vanilla |        0.8000 |               0.8000 |   ✓   |
| nocall | granite-3b-Q8      |        0.6000 |               0.6000 |   ✓   |
| nocall | qwen3.5-9b-mtp     |        1.0000 |               1.0000 |   ✓   |
| single | gemma4-26b-a4b-mtp |        0.8235 |               0.8235 |   ✓   |
| single | gemma4-e4b-vanilla |        0.4412 |               0.4412 |   ✓   |
| single | granite-3b-Q8      | 0.8485 (n=33) | 0.8485 (n=34, 1 err) |   ✓   |
| single | qwen3.5-9b-mtp     |        0.8235 |               0.8235 |   ✓   |
| multi  | gemma4-26b-a4b-mtp |        0.0000 |               0.0000 |   ✓   |
| multi  | gemma4-e4b-vanilla |        0.0000 |               0.0000 |   ✓   |
| multi  | granite-3b-Q8      |        0.0000 |               0.0000 |   ✓   |
| multi  | qwen3.5-9b-mtp     |        0.0000 |               0.0000 |   ✓   |

Detail-row counts per model: 50/50 for three, 49/50 for granite-3b-Q8
(the row-44 grammar-parse 500 hits the `errors` counter but doesn't
emit a detail row — by design).

## Consequence

The "split corpus + re-bench per tier" pattern (used twice this
session, once for memory-recall and once for tool-call) is now
strictly unnecessary for any workload whose primary metric is
row-decomposable. Save `runId` from the headline bench, then any
future family / tier / outlier analysis runs in SQL:

```sql
-- per-model, per-tier composite from a single bench
WITH tier_map AS (SELECT row_index, '<tier>' AS tier FROM ...)
SELECT model_name, tier,
       AVG(json_extract(metrics_json, '$.exact_match'))
FROM matrix_cell_row_details d
JOIN tier_map t USING (row_index)
WHERE run_id = '<run>'
GROUP BY model_name, tier;
```

Backwards compatibility: pre-`038f4ee` runs have no detail rows, only
aggregates. Tier analysis on historical benches still needs a re-bench
(or an explicit backfill, out of scope here).
