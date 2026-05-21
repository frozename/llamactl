# Recover from MLX Metal command-buffer errors without failing the whole batch step

## Motivation

MLX v3 exception-safety converts a Metal command-buffer failure from a
process abort into a per-request exception at the sync boundary. oMLX
should adapt to that contract by isolating the failure to the request
that triggered it instead of dropping the whole batch.

## Approach

Catch the `[METAL] Command buffer execution failed` RuntimeError at the
batch-step boundary in `omlx/scheduler.py`, attribute it to the active
request when mlx-lm exposes enough batch metadata, finalize that request
with the same 500-style error payload the HTTP layer already expects,
and requeue the remaining running requests for the next tick.

The recovery path also increments a `metal_error_recovered` counter so
operators can see how often this fallback is used.

## Heuristic limitation

Per-sequence attribution is only exact when mlx-lm exposes a unique
`_currently_processing` or `uids` signal. When it does not, the patch
falls back to the most recently admitted running request. That keeps the
batch alive, but it is a best-effort heuristic rather than a guarantee.

## Tests + counter

Add pytest coverage for:

1. a single-sequence batch where the Metal error fails only that request
2. a multi-sequence batch where one request fails and the surviving
   requests are requeued for a fresh step

The same patch increments `metal_error_recovered` and surfaces the count
through scheduler stats.

## Composition

This change composes with:

- https://github.com/ml-explore/mlx/pull/2670
- the upstream oMLX `--max-completion-batch-size` patch on
  `frozename/omlx feat/max-completion-batch-size`
