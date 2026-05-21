# Recover from MLX Metal command-buffer errors without failing the whole batch step

## Motivation

MLX v3 exception-safety (`mlx-explore/mlx#2670`) converts a Metal
command-buffer failure from a process abort into a `[METAL]`-prefixed
`RuntimeError` at the next sync waitpoint. oMLX should adapt to that
contract by isolating the failure to the request that triggered it
instead of dropping the whole batch or 500-ing every in-flight request
on the process.

The waitpoint can be reached on either of two paths inside oMLX:

1. **Decode path** — `BatchGenerator.next_generated()`.
2. **Prefill path** — `mx.eval([c.state for c in prompt_cache])` inside
   `_do_external_prefill`. This is the cold-start failure mode under
   multi-model memory pressure (multiple iso oMLX processes loading
   models simultaneously, tight Metal allocator headroom, long prefill
   triggers `kIOGPUCommandBufferCallbackErrorOutOfMemory`).

Without recovery on either path, the entire `step()` call raises, the
engine loop logs an unhandled error, and every pending `/v1/*` request
on the process gets a 500 — the failing request and every innocent
sibling.

## Approach

Catch only the `[METAL]`-prefixed `RuntimeError` at both batch-step
boundaries in `omlx/scheduler.py`, finalize the affected request with
the same 500-style error payload the HTTP layer already expects, and
let the next tick proceed with the remaining sequences.

A `Scheduler._metal_errors_recovered` counter increments on each
successful recovery (both paths) so operators can see how often the
fallback fires.

## Decode-path victim heuristic

Per-sequence attribution is only exact when mlx-lm exposes a unique
`_currently_processing` or `uids` signal. When it does not, the patch
falls back to the most-recently-admitted running request. That keeps
the batch alive but is a best-effort heuristic rather than a guarantee.

Trade-off vs. failing the whole batch:

* fail-the-whole-batch loses N - 1 innocent requests per error
* fail-one-victim occasionally blames an innocent late-arrival when the
  actual culprit was an older sibling

The latter is strictly better when error rates inside a batch are
bursty. A future mlx-lm change exposing per-uid Metal attribution
would close the heuristic gap.

## Prefill-path attribution is exact

The prefill catch runs inside `_schedule_waiting`'s per-request loop,
after the request has been popped from `self.waiting` and its temp UID
assigned. The failing request is unambiguous — no heuristic is
required. The catch cleans up the temp UID mapping, removes the
prefill-tracker entry, drops the request from `self.requests`, and
emits a `RequestOutput` with `finish_reason='error'` into the same
`rejected_outputs` list the preflight memory guard already uses.

## Cascade-safe cleanup

The decode-path recovery finalizes the victim before calling
`_cleanup_finished([victim_id])`. If that cleanup itself hits a
`[METAL]` cascade from `_safe_sync_generation_stream`, the recovery now
logs a warning and defers the cleanup to the next step instead of
letting the exception escape and kill the engine loop. The victim is
already finalized at that point, so the safety goal is preserving the
batch and keeping the process alive.

## Tests + counter

`tests/test_metal_error_recovery.py` covers the predicate
(`[METAL]`-prefix detection) and counter initialisation. End-to-end
scheduler construction needs a model checkpoint; the integration test
is documented here and is the natural follow-up once a fixture lands in
the oMLX test harness:

1. single-sequence batch where the Metal error fails only that request
2. multi-sequence batch where one request fails and the surviving
   requests advance on the next step
3. cold-start prefill OOM where the failing prefill is isolated and the
   process keeps serving subsequent waiters

## Validation

Three-process Fleet L stress on a 16 GB M4-base mac mini reproduces the
prior failure mode (mcr=4 per iso proc, cold-load all three models
under concurrent matrix bench). Pre-patch: five `[METAL]` OOMs on the
prefill path, then stall (engine loop unhandled). Post-patch: 12/12
cells (3 models × 4 workloads, n=240 total rows), zero process-level
errors, zero stalls, zero `[METAL]` log warnings under steady-state
load. Identical primary-metric values to the loaded-warm baseline.

## Composition

This change composes with:

- https://github.com/ml-explore/mlx/pull/2670 (exception-safety).
  Without that patch in MLX, Metal errors abort the process and neither
  oMLX recovery path is reached.
- the upstream oMLX `--max-completion-batch-size` patch on
  `frozename/omlx feat/max-completion-batch-size`. When batch=1 the
  decode-path recovery surface is simpler (always fail the lone
  request); when batch>1 the heuristic above applies. Prefill-path
  attribution is exact regardless of batch size.
