# Handoff to penumbra team — memory-efficacy classifier needs parser fix + verbosity guard

Date: 2026-05-13
From: llamactl side
To: penumbra core/daemon team
Status: model side validated; **production pipeline blocked on penumbra-side parser bug**

## TL;DR

We benchmarked Granite 4.1 8B Q4_K_M on mac-mini :8090 against the production memory-efficacy classifier prompt and it works (94.8% accuracy, 40% F1 on the rare classes that matter). But the production pipeline has **never actually run** because `parseFindings` doesn't match the real adversarial-review synthesis format — `~/.penumbra/db.sqlite` has 0 rows in `memory_efficacy_jobs` and `memory_efficacy_cache`.

Three penumbra-side changes unblock production + give a free throughput win:

1. **`parseFindings` parser format mismatch** — does not match real synthesis output. Highest priority; nothing else matters until this lands.
2. **Granite 8B drops ~33% of batch entries** because `reason` strings exceed the per-batch token budget. Three options inside `classifyFindings`.
3. **NEW: parallel-batch dispatch in the job runner** → +34% throughput, zero quality cost. Mac-mini Granite is configured with `-np 2` (two parallel slots) but `buildMemoryEfficacyCache` walks batches sequentially. Wrapping the inner loop in `Promise.all` with concurrency=2 cuts wall from 1091s → 816s on the full corpus.

Plus one memo: 4. **Class distribution is heavily skewed** (97% `not_memory_related`). Worth knowing for any future eval / threshold work.

Full numbers and methodology in `docs/notes/session-summary-2026-05-13-pm-granite-tuning.md` (this repo). Bench harness is at `tools/memory-efficacy-bench/` (corpus extractor, gold labeler, run-bench, sweep.sh).

## 1. Parser format mismatch — BLOCKING

`packages/core/src/readers/memory-efficacy.ts:127`:

```ts
const match = line.match(/^(\d+)[.)\]]\s+(?:\[(High|Medium|Low)\]\s*)?(.+)$/);
```

This expects `[High] Title` (bracketed severity). Real adversarial-review synthesis files use **two formats**, neither of which match:

```
1. **High — Untyped cross-layer args contract** (architect)
2. **High** — Shell command injection risk via untrusted git refs
```

(em dash inside markdown bold; or em dash outside bold). The `Severity-ranked findings` heading is also wrapped in `**...**`, which makes the section regex (line 117) fail too — the `\s*\n` after `findings?` doesn't match the trailing `**`.

**Reproducible**: 49 synthesis dirs at `/Volumes/WorkSSD/repos/personal/penumbra/.penumbra/reviews/<ts>/synthesis.md`. Penumbra's parser extracts findings from **0 of 49**. Our permissive parser at `tools/memory-efficacy-bench/extract-corpus.ts` extracts 481 findings from **44 of 49** (the 5 skipped dirs have no Severity-ranked section at all).

Suggested fix: relax both regexes:

```ts
// Section heading — allow optional ** around the heading and don't require
// newline immediately after.
const sectionRe =
  /(?:\*\*)?severity[- ]ranked\s+findings?(?:\*\*)?\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*\*[A-Z]|$)/i;

// Per-finding line — try `**Sev — Title**`, `**Sev** — Title`, `[Sev] Title`,
// in that order. Mirror what extract-corpus.ts does.
```

We haven't opened a PR — this is your domain (parser is sensitive and you may want different normalization). Mirror or borrow from `extract-corpus.ts` if useful.

**Effect**: once this lands, `buildMemoryEfficacyCache` will start consuming the existing 49 syntheses and producing real classification rows. The classifier itself works fine on real input — we verified.

## 2. ~33% batch-drop rate from Granite 8B verbosity

Granite 8B Q4_K_M produces verbose `reason` strings. With `batchSize=10` and the default `siriusChat` token budget, batches truncate mid-array and we lose the trailing 3-4 entries on roughly 33% of batches. **Confirmed reproducible** on both mac-mini :8090 (vanilla llama.cpp) and M4 Pro :18193 (atomic fork) — it's a model-output issue, not infra. Higher quants make it worse (Q8 doubles the drop rate to 64%; surviving entries are unchanged in quality).

Options inside `packages/core/src/services/memory-efficacy-classifier.ts`:

- **Reduce `batchSize` from 10 → 5** in `classifyFindings` (line 56). Smaller responses fit comfortably under any reasonable token budget. Cost: 2× as many round-trips.
- **Tighten the prompt** (line 42): `"reason": "<short>"` is currently ignored; replace with `"reason": "<one sentence, max 20 words>"` or similar.
- **Raise the per-call max_tokens** in `siriusChat` for this model. Simplest if the call site supports a model-scoped cap.

We didn't pick one — the trade-off depends on whether you'd rather pay round-trip latency or risk dropped classifications. For background efficacy classification, we'd lean **batchSize=5** since the job is async and dropped findings are silently lost.

3B variants don't have this drop problem (1-4% drops) but are blind to recall_miss entirely (0% F1 across Q4/Q5/Q6/Q8 vs 8B's 40%) — not a viable swap. **Stay on Granite 8B Q4_K_M.**

## 3. Parallel-batch dispatch — free +34% throughput

`buildMemoryEfficacyCache` walks the `toClassify` list sequentially:

```ts
// packages/core/src/readers/memory-efficacy.ts:222
const batchSize = 10;
for (let i = 0; i < toClassify.length; i += batchSize) {
  const batch = toClassify.slice(i, i + batchSize);
  const classifications = await classifyFindings(batchFindings, ...);
  // ... write rows
}
```

Mac-mini Granite is configured with `-np 2` (two parallel slots). The job runner only ever uses one. Dispatching pairs of batches concurrently is a one-line change that **doesn't touch model, prompt, classifier, or schema**:

```ts
const CONCURRENCY = 2; // match -np on the workload
for (let i = 0; i < toClassify.length; i += batchSize * CONCURRENCY) {
  const windowBatches: ToClassifyEntry[][] = [];
  for (let k = 0; k < CONCURRENCY; k++) {
    const b = toClassify.slice(i + k * batchSize, i + (k + 1) * batchSize);
    if (b.length > 0) windowBatches.push(b);
  }
  const results = await Promise.all(
    windowBatches.map((batch) =>
      classifyFindings(
        batch.map((e) => ({ ...e.finding, findingId: e.findingId })),
        {
          siriusChat: opts.siriusChat,
          model: opts.model,
        },
      ).then((cls) => ({ batch, cls })),
    ),
  );
  // sequential write to SQLite (insertStmt is not concurrency-safe per-statement
  // in bun:sqlite without WAL; the bench-side write was after-the-fact)
  for (const { batch, cls } of results) {
    // ... existing per-batch write loop
  }
}
```

Measured on the same mac-mini :8090 production server, full 470-finding corpus, identical Granite output:

| metric          | sequential c=1 | parallel c=2 | delta                       |
| --------------- | -------------- | ------------ | --------------------------- |
| wall_s          | 1091           | **816**      | **-25%**                    |
| findings/s      | 0.28           | **0.38**     | **+34%**                    |
| p50 batch ms    | 31766          | 32222        | +1.4% (same)                |
| p95 batch ms    | 34281          | 44646        | +30% (slot contention tail) |
| preds           | 309            | 309          | identical                   |
| bucket_accuracy | 94.8%          | 94.8%        | identical                   |
| per-bucket F1   | 40 / 40 / 0    | 40 / 40 / 0  | identical                   |

**Output is bit-identical** — Granite is deterministic at temperature=0; the only thing that changes is dispatch wall. The p95 tail is wider (slot contention) but p50 is flat, so most batches are unaffected.

**Generalizes** to any classifier workload hitting a multi-slot llama-server. Set `CONCURRENCY` to match the workload's `-np`. Read this off the workload manifest if you want a fully dynamic implementation, but a fixed `2` would already cover the current production config.

Bench reference: `tools/memory-efficacy-bench/run-bench.ts` (this repo) — `--concurrency N` flag was added precisely to verify this. Per-run JSON: `bench-results/sweep-parallel-batch.json`.

## 4. Class distribution is 97% `not_memory_related`

Of 470 gold-labeled findings (labeled by codex-acp-spark / Claude Opus 4.7):

| bucket              | count | %     |
| ------------------- | ----- | ----- |
| not_memory_related  | 456   | 97.0% |
| recall_miss         | 8     | 1.7%  |
| memory_ignored      | 4     | 0.9%  |
| missed_registration | 2     | 0.4%  |

**Implication**: bucket accuracy is a misleading metric — a "always predict not_memory_related" classifier scores 97%. The real signal is per-bucket F1 on the 14 memory-related findings. Your `getMemoryEfficacyRecent` reader returns counts grouped by classification, which is fine for the dashboard, but if you ever build alerting on top of it, key on the rare classes (`recall_miss`, `memory_ignored`, `missed_registration` totals) not the aggregate.

Some of this is corpus-specific — adversarial-review syntheses are dominated by architecture/perf/security findings, not memory-failure findings. As more memory-related findings accumulate (the rare classes), the absolute counts in those buckets become more actionable.

## What we're NOT asking you to do

- We're **not** asking you to swap the production model. Granite 8B Q4_K_M on mac-mini :8090 is the right choice based on our 8-config sweep + 3B/8B quant matrix + lookup A/B. Numbers in the writeup.
- We're **not** asking you to change `siriusChat` plumbing. The classifier prompt itself is fine.
- We're **not** asking you to add `--lookup-cache-dynamic` to mac-mini's llama-server. We tested it; it doesn't help under `-np 2` continuous batching.

## References

- Bench harness + corpus + gold labels: `tools/memory-efficacy-bench/` (this repo)
- Full writeup: `docs/notes/session-summary-2026-05-13-pm-granite-tuning.md`
- Per-bench-run JSON artifacts: `bench-results/sweep-*.json`, `bench-results/granite-3b-*.json`, `bench-results/granite-8b-*.json`, `bench-results/lookup-*.json`
- Penumbra files referenced:
  - `packages/core/src/readers/memory-efficacy.ts:103-140` (parser)
  - `packages/core/src/services/memory-efficacy-classifier.ts:31-87` (prompt + batch loop)
  - `packages/daemon/src/workers/memory-efficacy-job-runner.ts:23-100` (job runner)
- Llamactl-side commits: `5ac8992`, `771ecb8`, `9082548`, `b162cbd`, `0afa156`, `e6f23a0`
