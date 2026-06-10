# MLX back-pressure design spec — for adversarial planning

## Goal

Add per-stream back-pressure to MLX's Metal backend so that high client
concurrency on a multi-model `oMLX` server stops triggering Metal command
buffer errors. The first patch
(`docs/upstream-patches/mlx-exception-safe-completion-handler-2670.patch`)
already prevents the process-killing abort by catching the error
asynchronously and rethrowing on the caller's thread; this second patch
should prevent the error from happening in the first place by bounding
the number of in-flight command buffers per stream.

## Current state and evidence

- mac-mini M4 base (16 GB, 10-core GPU) is the target. Three MLX models
  (`granite-4.1-3b-mlx-4bit`, `granite-4.1-8b-mlx-nvfp4`,
  `Qwen3-8B-MLX-4bit`) all loaded in one oMLX process via
  `--model-dir`.
- Validated today: with the exception-safety patch + oMLX
  `--max-concurrent-requests=1`, all four matrix workloads run cleanly
  (0 errors, 240 rows, wall 1042s). Quality ties or exceeds the
  baseline Fleet B on every axis (notably tool-call +6 pp).
- With `--max-concurrent-requests=4`, the patch keeps the process
  alive but every request errors with Metal command-buffer failures
  (queue/wired-resource exhaustion on the M4 base GPU).
- Pre-patch (no exception safety): every variant aborted within
  seconds.

So the constraint is real: the Apple M4 base GPU's Metal command-queue /
wired-resource budget cannot serve more than ~1 in-flight command
buffer per stream at multi-8B-model load. Larger GPUs (M-series Pro/Max)
will tolerate more. The goal here is a _safe ceiling_ rather than a
fixed number.

## Constraints

- Patch must be acceptable upstream (`ml-explore/mlx`). The maintainer
  (`zcbenz`) is currently working through exception-safety improvements
  (`issue #2670`) and prefers minimal-impact additions over invasive
  refactors. Anything that changes hot-path performance for the
  common single-model case is a non-starter.
- Must be transparent on the happy path — callers should not need to
  set a flag to get correctness. Pathologic cases (multi-model
  saturation on small GPU) get throttled automatically.
- Must compose with the existing exception-safety patch — when
  back-pressure waits time out or detect a stale stream, errors should
  flow through the same `notify_stream_error` /
  `throw_if_stream_error` path so the caller experience is identical
  to other Metal failures.
- Cross-process coordination is **out of scope**. This patch covers a
  single oMLX process. Cross-process Metal contention (Fleet C/D) is a
  separate concern.

## Sketch of one possible design (use as a starting point, challenge it)

1. Add a per-stream "in-flight command buffers" counter (atomic) and a
   condition variable + mutex to either `CommandEncoder` or a new
   `StreamGate` struct keyed by stream.id in `scheduler`.
2. In the existing `addCompletedHandler` callbacks in `eval.cpp` —
   right after `scheduler::notify_task_completion` — decrement the
   counter and notify the cv.
3. Increment the counter before `encoder.commit()` (also in
   `eval.cpp`).
4. Read a threshold from an env var like
   `MLX_METAL_MAX_INFLIGHT_PER_STREAM` (default unbounded so the
   single-model fast path is untouched). When set: in `eval()` before
   committing, while counter ≥ threshold, wait on the cv (with a
   timeout fallback so a wedged GPU doesn't deadlock).
5. Document the env var and a recommended value for low-GPU machines
   in the MLX docs.

## What I want from the plan

For each planning persona, produce:

- Whether the sketch is the right shape, or a different design fits
  better (e.g., should the throttle live in `gpu::eval()` callers like
  `mlx_lm.generate`, or in `mlx::core::eval` itself; should it use a
  semaphore vs cv+mutex; should the counter live on the stream or on
  the encoder).
- Which APIs in MLX already model in-flight tracking; how to compose
  with `scheduler::notify_new_task` / `notify_task_completion` without
  doubling up.
- The interaction with concurrent multi-stream usage (PR #3348
  thread-locality changes for `CommandEncoder`).
- How to test the patch on a Mac without reliably reproducing the
  resource exhaustion — what synthetic stressor (CPU/GPU work mix or a
  small kernel hammered concurrently) actually triggers Metal queue
  saturation.
- Risks: deadlock on shutdown, behavior on `mx.synchronize()` ordering,
  performance impact on the unthrottled path (default).
- A phased TDD plan: phase 0 (failing test that reproduces multi-stream
  Metal saturation deterministically), phase 1 (smallest behavioural
  change to pass it), phase 2 (env-var config), phase 3
  (documentation/upstream-PR text).

## What to deliver

Each persona files a brief plan; the synthesizer picks the best ideas
and produces one prioritized phased TDD plan with explicit
dispatch-ready task descriptions. Reference the exception-safety patch
in `docs/upstream-patches/mlx-exception-safe-completion-handler-2670.patch`
as the assumed predecessor.
