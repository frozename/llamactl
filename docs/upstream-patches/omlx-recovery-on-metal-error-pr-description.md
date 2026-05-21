# Recover from MLX Metal command-buffer errors without failing the whole batch step

## Motivation

The MLX exception-safety patch changes a Metal command-buffer failure from a process abort into a normal exception at the sync boundary. oMLX still treats that exception as a batch-step failure, which is too broad: one request failed, but every other request in the batch is still valid. This change adapts oMLX to the new contract by isolating the failure to a single request.

## Approach

Catch the `[METAL] Command buffer execution failed` error class in the batched engine, determine the request that most likely triggered the failure, remove only that request from the active batch, finalize it with a 500-style error response, and continue the remaining requests on the next tick.

If mlx-lm provides per-sequence attribution, use it directly. If not, fall back to the defensive heuristic of failing the longest-running or most recently admitted request in the batch. That keeps the batch moving without pretending to know more than the runtime exposes.

## Heuristic Limitation

Per-sequence attribution may not be perfect without cooperation from mlx-lm. The fallback heuristic is intentionally conservative, but it can misidentify the request when multiple sequences are at similar stages. The patch should call that out clearly so downstream operators know the recovery path is best-effort, not exact.

## Tests + Observability Counter

Add pytest coverage for both cases:

1. single-sequence batch plus Metal error results in exactly that request failing with a 500-style response
2. multi-sequence batch plus Metal error fails one request and allows the rest to continue

Also add a counter and log line for "recovered from Metal error" so operators can see how often the recovery path fires in practice.

## Composition

This PR composes with:

- https://github.com/ml-explore/mlx/pull/2670
- the upstream oMLX `--max-completion-batch-size` change on `frozename/omlx feat/max-completion-batch-size`

Validation still needs an end-to-end run against MLX with the v3 exception-safety patch installed. This patch has not been runtime-tested here.
