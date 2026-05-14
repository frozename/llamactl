# Shared dynamic n-gram cache for `-lcd` at `-np > 1` — runbook

**Repo**: `/Volumes/WorkSSD/src/llama.cpp-atomic` (atomic fork)
**Branch**: `fix/shared-ngram-cache-dynamic`
**Commits**:
- `84ae116a2` — initial patch (per-slot lookup_stats forwarding, shared `common_ngram_cache_shared`, per-slot atomic counters, `log_speculative_counters()` on shutdown)
- `6424d29ef` — round-trip script stabilization (warmup split, send_with_retry, longer health timeout)
- `6d29d4540` — adversarial-review round-1 fix: drop shared `update_tail` (correctness + memory)

**Patched binary**: `/Volumes/WorkSSD/src/llama.cpp-atomic/build-shared-cache/bin/llama-server`

**Build**:
```bash
cd /Volumes/WorkSSD/src/llama.cpp-atomic
cmake -B build-shared-cache -DLLAMA_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-shared-cache --target llama-server -j 8
```

## What it does

Introduces a `server_context`-owned shared dynamic ngram cache. All slots query and merge into it under a `std::shared_mutex` (readers take a shared lock for draft; the writer holding accept takes a brief unique lock). Per-slot context cache is preserved. New per-slot atomic counters report context/dynamic/static lookup hits at shutdown via `log_speculative_counters()` in the clean-up path.

## Smoke evidence (2026-05-14)

Gemma 3 4B Q4_K_M on M4 Pro, `--ctx-size 4096 -np 2 --spec-type ngram-cache --lookup-cache-dynamic /tmp/cache.bin`, 6 sequential + 20 parallel identical prompts:

```
slot 0 speculative counters: n_draft_tokens_total=80, n_draft_tokens_accepted=60, n_lookup_context_hits=80, n_lookup_dynamic_hits=0, n_lookup_static_hits=0
slot 1 speculative counters: n_draft_tokens_total=128, n_draft_tokens_accepted=96, n_lookup_context_hits=128, n_lookup_dynamic_hits=0, n_lookup_static_hits=0
```

- Wiring proven: counter log line emits at shutdown.
- Context hits accumulate correctly across slots (lifetime).
- `n_lookup_dynamic_hits = 0` is **not** evidence the patch fails — the per-slot context cache satisfies every lookup before the strict-threshold dynamic check fires. The shared dynamic only helps when slots see *different* prompts where per-slot context misses.

## Production bench result (executed 2026-05-14)

**Headline: no win on this workload, do not deploy.** Patched binary tested on mac-mini :18888 (atomic-fork branch `fix/shared-ngram-cache-dynamic`, ctx=16384 to share GPU with production :8090, `--spec-type ngram-cache --lookup-cache-dynamic <file> -np 2`).

| Metric | Baseline (vanilla 32k, no -lcd) | Patched (16k, -lcd + ngram-cache) |
|---|---|---|
| total wall | 1087s | 1443s (+33%) |
| findings/sec | 0.28 | 0.21 (-25%) |
| batch p95 | 34.1s | 89.6s (+163%) |
| bucket_accuracy | 94.8% | 94.8% |

Server-side counters at shutdown:
```
slot 0: n_draft_tokens_total=9113 accepted=167   (acceptance 1.8%)
slot 1: n_draft_tokens_total=5869 accepted=9     (acceptance 0.15%)
both: n_lookup_dynamic_hits=0 (per-slot context cache wins every lookup before shared dynamic queried)
```

**Why no win:** ngram speculation only pays off when draft acceptance is high. Granite's JSON classifier output is template-driven (consistent quotes/keys/strings) which fills the per-slot context cache with structural tokens, but substantive choices (bucket value, reason text) are high-entropy. 98%+ draft rejection means compute spent on losing drafts swamps the speedup on the few accepted drafts. The original M4 Pro `-np 1` +15% reading (commit `9082548`) was a workload artifact for that specific test prompt, not a general result.

**Caveat:** patched ran at ctx=16384 to avoid Metal OOM when sharing GPU with production :8090 (32k). Smaller cache headroom contributes some of the slowdown, but does not change the 98% draft-rejection root cause.

Bench artifact: `bench-results/shared-cache-patched-470-2026-05-14.json` (commit `60878ca`).

## Original bench plan (preserved for reference)

Comparable runs to validate the full +15% claim from commit `9082548 bench(granite): dynamic lookup cache A/B — +15% throughput, -45% p95`:

### Baseline (current vanilla binary, mac-mini :8090, Granite 4.1 8B Q4_K_M)

The mac-mini production workload already runs vanilla with `--ctx-size 32768 -np 2 -ctk q8_0 -ctv q8_0 -b 2048 -ub 512`. Capture a clean bench:

```bash
bun /Volumes/WorkSSD/repos/personal/llamactl/tools/memory-efficacy-bench/run-bench.ts \
  --url http://127.0.0.1:18090 \
  --model local \
  --batch-size 10 \
  --concurrency 2 \
  --out bench-results/baseline-pre-shared-cache.json
```

### Patched (build the patched binary on mac-mini, swap in)

```bash
# On mac-mini: clone the atomic fork branch, build, and run
ssh macmini.ai bash -c '
  cd /Volumes/AI-SRC/llama.cpp-atomic
  git fetch frozename
  git checkout fix/shared-ngram-cache-dynamic
  cmake -B build-shared-cache -DLLAMA_METAL=ON -DCMAKE_BUILD_TYPE=Release
  cmake --build build-shared-cache --target llama-server -j
'
```

Stop the existing :8090 workload via llamactl, then bring up the patched binary with the SAME args plus `--lookup-cache-dynamic <cache-file>`. Run the same bench:

```bash
bun /Volumes/WorkSSD/repos/personal/llamactl/tools/memory-efficacy-bench/run-bench.ts \
  --url http://127.0.0.1:18090 \
  --model local \
  --batch-size 10 \
  --concurrency 2 \
  --out bench-results/patched-shared-cache.json
```

### Comparison signals to watch

- `findings/sec`: should be higher on patched run if the shared cache delivers.
- `batch_p50_ms` / `batch_p95_ms`: lower on patched if it works.
- Server shutdown log: compare `n_lookup_dynamic_hits` slot 0 vs slot 1. On the patched run, both should accumulate hits as the workload runs.

If hits stay 0 across both slots even at scale, the per-slot context cache is still winning every lookup. In that case the fix is to lower the context-cache's lax threshold (so it misses more often), not to widen the shared dynamic.

## Rollback

Workload reads `binary: …/llama.cpp-atomic/build-shared-cache/bin/llama-server` in its YAML. Revert to the vanilla `…/llama.cpp/build/bin/llama-server` (or whatever the prior path was) and `llamactl workload apply`.

## Known limitations (open follow-ups)

| Severity | Finding | Status |
|---|---|---|
| HIGH | Cross-slot mixing in `update_tail` | **Fixed** in `6d29d4540` (round 1) |
| HIGH | Unbounded `update_tail` growth | **Fixed** in `6d29d4540` (round 1) |
| HIGH | `-lcd <file>` persistence broken (load-only, no save on shutdown) | Deferred. Original `-lcd` saves at exit; patched does not. Acceptable for the immediate +15% goal; follow-up should add a `common_ngram_cache_save()` call in `clean_up()` |
| HIGH | Per-request and lifetime counters share one struct; intent split via reset() comment | Documented. Reviewer wanted explicit `_request` / `_lifetime` fields; can refactor in follow-up |
| HIGH | Cross-session side channel (one user's prompts prime the shared cache) | Known tradeoff. Local-dev acceptable; multi-tenant deployments would need per-tenant caches |
| MEDIUM | Lock contention (unique_lock per accept) | Held very briefly after round-1 fix (no `update_tail` insert). Re-measure if shared dynamic ever gets hot |
| MEDIUM | Hardcoded paths in `scripts/mtp-lcd-shared-cache-roundtrip.sh` | Acceptable for local probe |

## Upstream PR readiness

The change is conceptually upstream-PR-worthy — addresses a real `-np>1` regression with the `TAG_SERVER_SPEC_REWORK` TODO that upstream already acknowledged. Before opening a PR:

1. Add the save-on-shutdown path (the deferred HIGH from architect).
2. Refactor counters into separate request/lifetime structs (architect's other HIGH).
3. Rebase off `ggml-org/llama.cpp/master` (this branch is on atomic fork's frozename/master which is rebased onto upstream).
4. Strip atomic-fork-specific changes; keep only the shared-cache work.
5. Open against `ggml-org/llama.cpp`.

## Adversarial review artifacts

Full per-persona findings at:
`/Volumes/WorkSSD/src/llama.cpp-atomic/.penumbra/reviews/2026-05-14T04-22-09.812Z/`

Read `architect.md`, `data_correctness.md`, `performance.md`, `security.md` for the details behind the table above.
