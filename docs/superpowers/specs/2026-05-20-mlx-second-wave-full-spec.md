# MLX + oMLX Upstream Improvements: Plan + Open Questions

This plan extends two MLX patches already on the
`fix/exception-safe-completion-handler` branch of our local mlx-fork at
`/Volumes/WorkSSD/src/mlx-fix`:

- `8c514a1a` — exception-safe Metal command-buffer error handling (v3, validated)
- `982ef62d` — per-stream in-flight back-pressure gate (validated unit-only;
  doesn't help mac-mini Fleet L because the contention is intra-buffer)

The remaining improvements fall into three layers — MLX core, oMLX server,
llamactl harness — and the higher-impact items target MLX core. None of
these are merge-blockers for the existing two patches; this document
plans the **second wave** of work driven by the architectural picture
we built up while investigating the M4 base multi-model GPU failures
on mac-mini.

The full evidence chain for the problem the wave addresses:

1. Three hot 8B-class MLX models in one oMLX process at mcr=1 → 0 errors,
   1041 s wall.
2. Same setup at mcr=2 or mcr=4 → ~100% per-request failures with Apple
   GPU watchdog timeouts (`kIOGPUCommandBufferCallbackErrorTimeout`).
3. Per-MLX-stream back-pressure gate at limit=1 didn't help — the gate
   works (oMLX stays alive, errors are per-request) but the GPU keeps
   timing out because the work is intra-buffer, not inter-buffer.
4. oMLX `--max-completion-batch-size 1` (added as a small upstream-able
   patch in this session) didn't help either — even with batch=1 the
   inter-model context switching inside one process is the floor.
5. **Three separate oMLX processes, one per model, each at mcr=4** →
   0 errors, identical scores to the mcr=1 single-process run, four
   workloads done in parallel. Per-process Metal context isolation
   is the architectural unlock.

## Scope of this plan

Goal: pick the smallest set of changes that make multi-model coexistence
work cleanly on Apple Silicon without the user having to know about
per-process workarounds, and that compose cleanly with our existing
exception-safety patch.

Non-goals:
- Reworking mlx-lm's BatchGenerator scheduler. Out of scope; large
  refactor; mlx-lm already evolves quickly.
- Cross-process coordination (multi-host fleets, gateway-level routing).
- Hardware-specific tuning beyond watchdog awareness.

## Initiatives, ranked by impact:effort ratio

### MLX core (ml-explore/mlx)

#### M1. Per-stream `MTL::CommandQueue`
Today `mlx::core::metal::Device` holds ONE `MTL::CommandQueue`
(`mlx/backend/metal/device.cpp:269`) shared by every stream. Refactor
`Device` to maintain a `unordered_map<int, NS::SharedPtr<MTL::CommandQueue>>`
keyed by `stream.index`. Allocate on `gpu::new_stream(s)`; release on
stream teardown. The existing `CommandEncoder` already takes a `queue_`
in its constructor — wire it from the per-stream map instead of the
device-global one.

Effect: independent MLX streams get independent Apple GPU command-list
managers, so two models' workloads stop queue-blocking each other.
Combined with M2 below, this is what would let ONE oMLX process safely
serve N models on a single GPU.

Backward compat: single-stream callers see identical behavior. The
default device stream still exists; nothing depends on cross-stream
queue identity.

Risk: Metal's `MTL::CommandQueue` has driver-level resource limits
(typically ~256 concurrent queues per process). Per-stream creation has
to bound growth — couple to existing `Scheduler::clear_streams()` /
backend lifecycle hooks so dead streams release their queues.

Effort: ~1-2 days for the refactor + tests. Touch surface: `device.h`,
`device.cpp`, `eval.cpp`, possibly `event.cpp`.

#### M2. Per-stream `MTL::ResidencySet`
Same shape as M1 but for the residency set. Currently `Device` has one
global `ResidencySet` (`mlx/backend/metal/resident.h:29`). With per-stream
queues, weights for different models should also wire into different
residency sets so the Metal driver doesn't have to compete-page during
inter-model context switches.

Effort: ~1-2 days. Most of the work is mechanical (find call sites,
key by stream).

#### M3. `Stream` API: optional `tag` field
Add `optional<string> tag` to the `Stream` struct. Lets higher layers
(oMLX, mlx-lm) say "this stream belongs to model X" without inventing
their own keying. Enables M1/M2's per-stream lifecycle to be exposed
in a discoverable way.

Backward compat: opt-in field with default empty.

Effort: ~half day. Touch surface: `stream.h`, `stream.cpp`.

#### M4. `Stream` generation counter (resolves round-3 HIGH finding)
Closes the stream-index-reuse race in the exception-safety patch: a
Metal completion handler captured against a destroyed-and-recreated
stream's index could stash an error against the new incarnation.
Adding `uint64_t generation` to `Stream` and validating against it
in `notify_stream_error` / `throw_if_stream_error` closes the window.

Effort: ~half day. Couples naturally with M3 (same struct).

#### M5. GPU-watchdog awareness in command-buffer splitting
`max_ops_per_buffer_=40` / `max_mb_per_buffer_=40` are already there
(`device.cpp:445-448`) and split large fused ops into multiple buffers.
But the limit is static, and doesn't shrink under multi-stream load.

Idea: when more than one stream has recent activity, lower the per-buffer
ceiling automatically. Or expose an env var `MLX_METAL_MAX_OPS_PER_BUFFER`
so operators can dial it down on small GPUs.

Effort: ~half day. Could be done as a one-line env-var addition first
to gather data, then add adaptive logic if the manual dial proves useful.

### oMLX (jundot/omlx)

#### O1. `--isolate-models` flag (spawn-per-model mode)
oMLX manages N child processes, one per declared model, on adjacent ports.
The parent process becomes a thin router that fronts the children at
`--port` and forwards by `model` field in the request JSON. Each child
is a normal `omlx serve --model-dir <isolated-dir>` with its own Metal
context.

Effect: gives oMLX a built-in answer for users on small GPUs without
asking them to write three Compose files / three llamactl manifests.

Risk: process management is non-trivial — readiness probing, restart on
failure, graceful shutdown, log multiplexing. Easy to get wrong;
moderate-to-high effort.

Composes naturally with M1/M2 in MLX core: if MLX gains per-stream
isolation, oMLX could keep using one process AND `--isolate-models`
becomes a lower-overhead fallback for environments where one-process
mode is acceptable.

Effort: ~2-3 days. Touch surface: `omlx/cli.py`, new `omlx/router.py`,
process supervision code.

#### O2. Per-model concurrency caps
`SchedulerConfig.per_model_max_concurrent: dict[str, int]`. CLI flag
`--per-model-max-concurrent qwen3-8b=4,granite-3b=8`. Lets one-process
multi-model setups still work in regimes where the user accepts mcr=1
for the 8Bs and mcr=4 for the 3B.

Effort: ~half day. Touch surface: `omlx/settings.py`,
`omlx/scheduler.py` admission logic.

#### O3. Recovery-on-Metal-error
When mlx-lm/mlx surfaces a `[METAL] Command buffer execution failed`
via our exception-safety path, oMLX currently fails the whole batch
step. Better: mark just THAT request as failed, retry the rest of the
batch with one fewer sequence, and continue.

Effort: ~1 day. Touch surface: `omlx/scheduler.py`,
`omlx/engine/batched.py`.

#### O4. `--max-completion-batch-size` (done in this session)
Already implemented + deployed on mac-mini's oMLX checkout. Still
deserves an upstream PR to `jundot/omlx`. Patch is ~12 lines across
`omlx/settings.py` and `omlx/cli.py`.

Effort: ~half day to clean up the diff for upstream + add a unit test
on the settings round-trip + open the PR.

### llamactl (this repo)

#### L1. Per-workload isolated model dir (done in this session)
Already landed in `packages/core/src/engines/omlx.ts` + tested (18
green tests). Plus the three ModelHost manifests
(`templates/workloads/mlx-{granite-3b,granite-8b,qwen3-8b}-iso-mac-mini.yaml`).

#### L2. `env` field on ModelHost manifest schema
Lets workloads declare per-process env vars without leaning on the
agent's plist. Useful for `MLX_METAL_MAX_INFLIGHT_PER_STREAM`,
`HF_HUB_OFFLINE`, etc.

Effort: ~half day. Touch surface:
`packages/remote/src/workload/modelhost-schema.ts`, server-side
spawn logic to merge with `CHILD_ENV_ALLOWLIST`.

#### L3. `kind: Fleet` abstraction
A single Fleet spec expands to N ModelHost manifests with shared
family/binary/env. Quality-of-life for patterns like the Fleet L
three-model setup we just wired by hand.

Risk: adds a new top-level kind to the schema and changes how
operators think about composition. Probably premature without more
patterns demanding it.

Effort: ~1-2 days. Touch surface: schema, apply.ts, CLI commands.

## Suggested phasing

**Phase A — ship the small upstream-PR-able items (low risk, fast)**
- M4 (Stream generation counter; closes the known HIGH finding)
- M5 (GPU-watchdog env knob)
- O4 (`--max-completion-batch-size` PR cleanup + submission)
- L2 (env field on ModelHost manifest)

**Phase B — the real upstream MLX work (high impact)**
- M3 (Stream tag) — prerequisite for M1/M2 API ergonomics
- M1 (per-stream CommandQueue)
- M2 (per-stream ResidencySet)
- Benchmark single-process multi-model on mac-mini against the
  per-process baseline. Target: parity or better than the three-process
  workaround.

**Phase C — oMLX architectural improvements (medium-high impact)**
- O3 (recovery-on-Metal-error) — small but composes with our patches
- O2 (per-model concurrency caps)
- O1 (`--isolate-models`) — only if M1/M2 in Phase B don't fully
  solve the one-process case

**Phase D — llamactl polish (lowest priority)**
- L3 (Fleet abstraction) — defer until pattern demand justifies it

## Open design questions for the adversarial planners

1. M1/M2 risk: does Apple's Metal driver actually penalize many concurrent
   command queues per process? What's the practical cap on a 10-core M4
   base GPU vs an M-series Max? Need a small benchmark before committing.

2. Composition with mlx-lm's threading: mlx-lm currently uses one
   thread-local generation_stream per worker thread. If MLX gains
   per-stream queues, does mlx-lm's worker design need to change too,
   or does the existing single-thread serialization still buy us
   something we don't want to lose?

3. Sequencing of the upstream PRs: should M1 + M2 land as ONE PR or
   two? They depend on each other but cleanly orthogonal. zcbenz's
   review history suggests smaller diffs land faster.

4. Is O1 (oMLX `--isolate-models`) still worth doing if M1/M2 ship?
   It might become a graceful-degradation option ("if M1/M2 unavailable,
   fall back to spawn-per-model") rather than the primary fix.

5. Patch ordering for our local fork: should the back-pressure patch
   (`982ef62d`) be folded into the exception-safety patch (`8c514a1a`)
   for upstream submission, or kept as two PRs? Folding gives one
   diff to review; keeping separate makes it easy to merge the
   exception-safety win even if back-pressure faces objections.

6. Tests strategy for M1/M2: we have CPU-stream tests for the
   back-pressure gate. Per-stream MTL::CommandQueue tests need a real
   Metal device. CI implications for ml-explore/mlx (which currently
   gates Metal tests by `MLX_BUILD_METAL`).

## What we want from the adversarial planning fan-out

Each persona files a brief plan addressing:

- Whether the phasing above is right, or M1/M2 should jump ahead of
  Phase A as the load-bearing upstream value.
- Concrete API shape for the Stream tag / generation counter (M3/M4):
  do they go on `Stream` directly or on a sibling `StreamMeta`?
- Risks specific to Apple Metal that we haven't enumerated: thermal
  throttling under sustained multi-queue load, driver retry semantics,
  command-buffer encoder thread-safety.
- TDD shape: what's the smallest reproducible test that fails before
  M1 and passes after? Probably a benchmark that two concurrent streams
  shouldn't serialize at the queue level.

Synthesizer should produce one prioritized phased TDD plan with explicit
dispatch-ready task descriptions per phase.

## Predecessor patches (assumed landed)

- Exception-safe completion handler: `docs/upstream-patches/mlx-exception-safe-completion-handler-2670.patch`
- Per-stream back-pressure gate: `docs/upstream-patches/mlx-backpressure-per-stream-gate.patch`
