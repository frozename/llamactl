# Session summary — 2026-05-13 pm Granite tuning

Project: `llamactl`. Picks up after the E4B re-eval thread (`session-summary-2026-05-13-pm-e4b-reval.md`).

## Headline

The penumbra memory-efficacy classifier — Granite 4.1 8B Q4_K_M on mac-mini — works (94.8% bucket accuracy, 40% F1 on the rare classes that matter), but **the production pipeline has never actually run** because the penumbra parser silently rejects every real adversarial-review synthesis (parser-format mismatch — see "Surprising data observations" below). Tuning levers tested:

| lever | result |
|---|---|
| `--lookup-cache-dynamic` (M4 Pro `-np 1`) | ✅ +15% throughput, -45% p95 latency |
| `--lookup-cache-dynamic` (mac-mini `-np 2`) | ❌ Did NOT generalize — bit-identical to baseline |
| Granite 3B in place of 8B | ❌ Blind to recall_miss regardless of quant |
| Higher 8B quants (Q5/Q6/Q8) | ❌ More verbose → more batch truncation, no per-entry quality gain |
| Atomic-fork llama.cpp swap | ❌ No Granite-specific gap vs vanilla |
| `-ub` / `-b` config knobs | ⚪ Invisible at temperature=0 (deterministic output) |
| `-ctk f16 -ctv f16 -np 1` (kvf16) | 🟡 -6% wall, +4pp recall_miss F1, +5pp drop rate (lateral) |
| Static lookup cache | ❌ Slower than no-lookup (counter-result) |
| Penumbra `parseFindings` parser fix | 🔴 BLOCKING — without this, no model tuning matters |

## Bench setup

- **Workload**: `buildMemoryEfficacyCache` from `penumbra/packages/core/src/services/memory-efficacy-classifier.ts`. 4-way classification (missed_registration / recall_miss / memory_ignored / not_memory_related) of "memory failure findings", strict JSON output, batched 10-at-a-time, zod-validated.
- **Corpus**: 481 findings parsed from 44 of 49 review syntheses at `penumbra/.penumbra/reviews/<ts>/synthesis.md`. Tools: `tools/memory-efficacy-bench/extract-corpus.ts`.
- **Gold labels**: 470 of 481 findings labeled by `codex-acp-spark` (Claude Opus 4.7 routing) using the exact classifier rubric. Tool: `tools/memory-efficacy-bench/label-corpus.ts`.
- **Bench harness**: `tools/memory-efficacy-bench/run-bench.ts` — fires real classifier prompts at any OpenAI-compatible endpoint, scores against gold.
- **Production target**: Granite 4.1 8B Q4_K_M on mac-mini :8090, vanilla llama.cpp at `/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server`. Workload spec: `templates/workloads/granite41-8b-mac-mini.yaml`.

## Surprising data observations

### Class distribution is heavily skewed

Of 470 gold-labeled findings, **456 (97%) are not_memory_related**. The classifier rubric is for memory failures specifically, but the adversarial-review corpus is dominated by architecture, performance, and security findings. Only **14 findings (3%) are actually memory-related** (8 recall_miss, 4 memory_ignored, 2 missed_registration).

**Implication**: bucket_accuracy is a misleading primary metric — a "always predict not_memory_related" classifier scores 97%. The real signal is per-bucket F1 on the 14 memory-related findings.

### The penumbra parser doesn't match the synthesis format

The finding-extraction parser at `penumbra/packages/core/src/readers/memory-efficacy.ts` (`parseFindings`) expects `[High] Title` bracketed severity. The actual adversarial-review syntheses use `**High — Title**` (em dash inside markdown bold) or `**High** — Title`. As a result the production memory-efficacy classifier has **0 jobs and 0 cache rows in `~/.penumbra/db.sqlite`** — it has never run on real data because the parser silently drops every finding.

Our bench harness includes a more permissive parser that catches both real formats. Fixing penumbra's parser is a separate follow-up — without it the production memory-efficacy pipeline is dormant regardless of model tuning.

## M4 Pro within-machine quant + size sweep

Same harness, full 470-finding gold set, `--lookup-cache-dynamic`, `-ub 2048 -b 2048 -ctk q8_0 -ctv q8_0 --ctx-size 32768 -np 1 --flash-attn on`:

| variant | acc | RM F1 | MI F1 | MR F1 | wall_s | drop% |
|---|---|---|---|---|---|---|
| 3B Q4_K_M | 93.6% | 0% | 0% | 0% | 433 | 4 |
| 3B Q5_K_M | 93.5% | 0% | 17% | 0% | 429 | 3 |
| 3B Q6_K | 92.8% | 0% | 15% | 0% | 393 | 3 |
| 3B Q8_0 | 95.5% | 0% | 15% | 0% | 475 | 1 |
| **8B Q4_K_M** | **95.0%** | **40%** | **40%** | 0% | 510 | 32 |
| 8B Q8_0 | 90.6% | 40% | 40% | 0% | 554 | 64 |

Conclusions:
1. **3B is blind to recall_miss at every quant**. Whatever signal the 8B uses to flag those 8 findings, the 3B doesn't have it. Quant scaling does not recover it.
2. **8B Q4 is the sweet spot.** Higher 8B quant produces longer `reason` strings → JSON batches truncate more often → drop rate doubles (32% → 64%) and accuracy regresses (95.0% → 90.6%). Per-entry F1 on the entries that survive is identical.
3. The 8B drop rate is ~32% even on M4 Pro hardware — confirming it's a model-output issue, not a mac-mini hardware/CPU issue.

## Lookup-cache A/B (M4 Pro 8B Q4_K_M)

Same machine, same model, same config (-ub 512 q8/q8 -np 1 ctx 32768), 100-finding subset:

| variant | wall | findings/s | p50 | p95 |
|---|---|---|---|---|
| no lookup | 104.5s | 0.48 | 15.9s | 30.3s |
| **dynamic lookup (`-lcd`)** | **90.3s** | **0.55** | 15.9s | **16.6s** |
| static lookup (`-lcs`) | 123.4s | 0.41 | 21.7s | 23.2s |

Dynamic lookup gives +15% throughput and nearly halves p95 batch latency on this repetitive-JSON workload. p50 unchanged because the cache is empty for the first batches; the gain is on later batches once the cache fills. **Static lookup was a counter-result** — built from 31 unique batch responses, the static cache adds overhead that exceeds savings on novel findings.

## Granite-specific llama.cpp investigation

Both vanilla (mac-mini) and atomic-fork (M4 Pro) llama.cpp builds have the upstream Granite/Mamba/GDN work: chunked fused GDN path, hybrid memory KV cache, `seq_rm` for hybrid models, Granite 4.0 chat template fix, Metal `keep_intermediates` GDN path. **No swap-the-binary win exists.** The atomic fork's only unique Granite commit is `7fc00698d llama: allow partial seq_rm for GDN models for speculative decoding` — would matter only if a Granite assistant head existed for spec decoding (none publicly available).

Mac-mini build is missing one trailing commit (`5755a100c model: fix model type check for granite/llama3 lite`) — affects model loading for `lite` variants, not 4.1 8B.

Other levers tested or considered:
- `--threads-batch N` (separate prefill threads) — not tested
- `--mlock` (pin model in RAM, prevent paging) — not tested; mac-mini 16 GB makes this worth trying
- M4 Pro `llama-bench` (raw speed): -ub 2048 q8/q8 → 391.9 prefill tps + 38.7 decode tps (best balance). Production granite41-8b-long-lived-local already at this config — speed-optimal.

## Mac-mini config sweep (in flight)

`tools/memory-efficacy-bench/sweep.sh` runs 8 configs on mac-mini :18190 against the same 470-finding gold set; production :8090 stays alive. Configs: baseline (current production), ub256, ub1024, batch4096, kvf16, np1, jinja, aggressive.

Final 8 configs:

| config | wall | preds | acc | RM F1 | MI F1 | observation |
|---|---|---|---|---|---|---|
| baseline (-ub 512 q8/q8 -np 2) | 1091s | 309 | 94.8% | 40% | 40% | reference |
| ub256 | 1091s | 309 | 94.8% | 40% | 40% | identical |
| ub1024 | 1089s | 309 | 94.8% | 40% | 40% | identical |
| batch4096 | 1088s | 309 | 94.8% | 40% | 40% | identical |
| **kvf16** (-ctk f16 -ctv f16 -np 1) | **1027s** (-6%) | 289 | 94.5% | **44%** | 40% | only differing config |
| np1 | 1088s | 309 | 94.8% | 40% | 40% | identical to baseline |
| jinja | 1086s | 309 | 94.8% | 40% | 40% | identical (chat template doesn't affect this prompt) |
| aggressive (ub=1024 b=4096 jinja np=2) | 1087s | 309 | 94.8% | 40% | 40% | identical |

**Verdict**: 7 of 8 configs are bit-identical at temperature=0 — only KV-quant change (q8_0 → f16, paired with -np 1 to keep memory budget) produces different output. f16 trade-off: -6% wall, +4pp recall_miss F1, but slightly higher drop rate (38% vs 33%). Net: small lateral move, not a clear win.

### Lookup-dynamic on mac-mini: did not generalize from M4 Pro

A 9th config (baseline + `--lookup-cache-dynamic`) tested separately to see if the M4 Pro +15% throughput finding holds on mac-mini hardware:

| variant | wall | preds | acc | findings/s | p50 ms | p95 ms |
|---|---|---|---|---|---|---|
| baseline | 1091s | 309 | 94.8% | 0.28 | 31766 | 34281 |
| baseline + `-lcd` | 1092s | 309 | 94.8% | 0.28 | 31609 | 34304 |

Bit-identical. The M4 Pro lookup-dynamic win does not generalize to mac-mini under the production `-np 2` config. Hypothesis: continuous batching across two parallel slots already amortizes the work that lookup speculative-decoding would have amortized, so the speculative path provides no additional win. The M4 Pro A/B that showed +15% used `-np 1` — single-slot inference is exactly where speculative decoding helps most. Hardware difference (M4 vs M1/M2 BW) may also contribute. Conclusion: **`-lcd` is not a free win for mac-mini production**.

## Recommended changes (pending user approval)

1. **Fix the penumbra `parseFindings` parser** to match the actual adversarial-review synthesis format (`**High — Title**` not `[High] Title`). Without this, the production memory-efficacy classifier remains dormant — 0 jobs, 0 cache rows. **Highest-priority follow-up**: model tuning is moot if the pipeline never runs.
2. **Investigate the 33% batch drop rate on Granite 8B** — likely a max_tokens / verbosity issue (output truncation cuts batches mid-array). Possible mitigations:
   - Reduce classifier batch size from 10 → 5 (smaller responses fit under token budget)
   - Raise max_tokens above 2048 in the bench/classifier config
   - Tighten the prompt's "reason: <short>" instruction (model ignores it)
3. **Do not use Granite 3B** for memory-efficacy classification — it is blind to recall_miss at every quant tested (Q4/Q5/Q6/Q8).
4. **Do not upgrade Granite 8B beyond Q4_K_M** for this workload — verbosity scales with precision, drop rate doubles at Q8.
5. **Consider `--cache-type-k f16 --cache-type-v f16 -np 1`** as a small lateral move (-6% wall, +4pp recall_miss F1, but +5pp drop rate). Trade-off, not a clear win.
6. **Do not add `--lookup-cache-dynamic` to mac-mini** — the M4 Pro +15% finding does not reproduce under `-np 2` continuous batching. Keep dynamic lookup as a tool for `-np 1` workloads only.
7. **Side bug**: `granite41-8b-long-lived-local` workload PID is stale — workload status reports Running PID 20376 but the process is dead and :8083 is closed. Reconciler should restart it but isn't. Independent of this thread.

## Artifacts

- Bench harness: `tools/memory-efficacy-bench/{extract-corpus,label-corpus,run-bench}.ts` + `sweep.sh`
- Corpus: `tools/memory-efficacy-bench/corpus/findings.json` (481 findings) + `gold-labels.json` (470 labels)
- Bench results: `bench-results/{baseline-prod,sweep-*,granite-3b-*,granite-8b-*,lookup-*}.json`
- Raw llama-bench: `bench-results/llama-bench-granite-m4pro-2026-05-13.{tsv,txt}`
