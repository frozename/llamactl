KV cache storage dir is `<dataRoot>/kvstore/` — a sibling of the workload runtime dir, intentionally placed OUTSIDE `workloadRuntimeRoot` so KV metadata writes do not bump `workloadRuntimeRoot.mtimeNs` and do not invalidate `routeMapCache` or `modelsResponseCache` in `openaiProxy.ts`. This is a load-bearing layering decision — do not move KV state under the workload runtime tree.

## Configuration

Two environment variables bound the KV store. Effective values are logged at `kvstore_opened` on the first `openKvStorage` call for a `dataRoot`.

- `LLAMACTL_KV_WORKLOAD_BUDGET_MB` — per-workload slot payload budget. When the running total for a workload exceeds this, `runEvictionIfOverBudget` deletes idle entries in eviction-score order until the budget is met. Defaults to **8192 MiB**.
- `LLAMACTL_KV_QUARANTINE_PURGE_HOURS` — grace period before a quarantined row (its `upstream_slot_file` is missing) is purged from the catalog. Defaults to **24 hours**.

Malformed or non-positive values fall back to the defaults. Set these explicitly when the conservative defaults are too tight for the workload.
