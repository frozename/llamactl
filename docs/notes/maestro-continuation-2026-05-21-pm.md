# Maestro continuation prompt — 2026-05-21 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories


- `t2:985a7cb7-9ee2-4acf-8d12-ef082ad2e605` — Test-driven development workflow for engine registry

- `t2:3e993c19-dda3-4c29-8fb5-ac7e3106c8d1` — Split behavior change

- `t2:c0aa8d5a-3c76-456d-a7bb-dd854741dd9b` — Project commit workflow

- `t2:dcab4575-4056-4507-8eac-7ab9cf2c8ade` — README update requirement

- `t2:44dbaa8d-949d-4217-bbb1-f0d807353073` — Audit of synthetic `memory_ignored` rows

- `t2:b1dbbc85-3faa-43ae-aa4b-bcb901d9d923` — Handling of Hugging Face download lock during training

- `t2:1e0fd3a7-4972-4b44-8588-5b42eee890ef` — Escalated permissions for spike-work output directory

- `t2:602d2db5-6b25-4363-a4e9-2306e8dcac65` — Report shape adjustment for 4-way metrics

- `t2:982c51f8-9b01-45f7-a599-3bd50baf96b6` — Spike-work directory usage for train/eval artifacts

- `t2:c8759fac-3439-4426-b54e-b6503fdf46a2` — Eval script extended for 4-way framing

- `t2:e61173b3-fbf0-40c8-a7fa-aaad53882a75` — Parser enhancement for classification script

- `t2:7285722b-ae9a-4927-9e43-870ba2390b2c` — Commit message specification


### Commits since midnight

```
44b0104 docs(upstream-patches): hand-implemented + validated B.1/B.3/C.1/C.2 + retired A.2/B.2
7cb4b79 docs(upstream-patches): B.1 v2 MLX Stream.tag field (real-context patch)
6df7987 docs(upstream-patches): A.2 v2 MLX max-ops-per-buffer env knob (real-context patch)
69f0fd9 docs(upstream-patches): C.2 v2 oMLX per-model concurrency caps (real-context patch)
1d4f8cb docs(upstream-patches): C.1 v2 oMLX recovery-on-Metal-error (real-context patch)
ef4bbbc docs(upstream-patches): B.3 v2 MLX per-stream ResidencySet (real-context patch)
8abb92c docs(upstream-patches): stage reference copies of MLX/oMLX source for re-dispatch
1849deb feat(remote): add spec.env field to ModelHost manifest
bb790ed docs(upstream-patches): C.2 oMLX per-model concurrency caps patch + PR description
8083335 docs(upstream-patches): C.1 oMLX recovery-on-Metal-error patch + PR description
801fc96 docs(upstream-patches): B.3 MLX per-stream MTL::ResidencySet patch + PR description
54cb924 docs(upstream-patches): B.2 MLX per-stream MTL::CommandQueue patch + PR description
1d7c51b docs(upstream-patches): B.1 MLX Stream.tag field patch + PR description
34e5e42 docs(upstream-patches): A.1 MLX Stream generation counter patch + PR description
07d697a docs(upstream-patches): A.3 oMLX --max-completion-batch-size PR package
eb8c764 docs(upstream-patches): A.2 MLX max-ops-per-buffer env knob
683fdc6 feat(omlx): per-workload isolated model dir + iso Fleet L manifests
```

### Commit context (bodies)


**`44b0104e25f64c5e3a3f0f24d95a1a936989d0e4`** — docs(upstream-patches): hand-implemented + validated B.1/B.3/C.1/C.2 + retired A.2/B.2

Replaces the previous agent-generated paper patches (which had
placeholder content / fake SHAs / mismatched hunk offsets and could not
be `git apply`'d) with real diffs produced by hand-editing the
upstream fork trees, building, running tests, and exporting via
`git format-patch`.

Findings during hand-implementation:

- A.2 (max-ops env knob): CLOSED without PR — the env knobs already
  exist upstream as `MLX_MAX_OPS_PER_BUFFER` and
  `MLX_MAX_MB_PER_BUFFER` in `mlx/utils.h:154-164`, wired in
  `mlx/backend/metal/device.cpp:521-522`. The original task spec was
  based on outdated info. PR-description converted to operator-guidance
  note recommending `MLX_MAX_OPS_PER_BUFFER=20` on M-series base GPUs.

- B.2 (per-stream MTL::CommandQueue): CLOSED without PR — the feature
  already exists. The plan claimed Device held a single shared queue at
  `device.cpp:269`, but line 269 is inside CommandEncoder's constructor.
  Each CommandEncoder (one per stream) creates its own
  MTL::CommandQueue. The feature B.2 was proposing is the existing design.

- B.1 (Stream.tag field): NEW PATCH on `frozename/mlx feat/stream-tag-field`.
  Adds `std::optional<std::string> tag` to the Stream struct. Equality
  ignores tag (preserves identity semantics). 251 doctest cases pass.

- B.3 (per-stream MTL::ResidencySet): NEW PATCH on
  `frozename/mlx feat/per-stream-residency-set`. The Device-global
  `Device::residency_set_` IS the gap (unlike the queue, which is per-
  encoder). Adds `Device::residency_set(int stream_index)` accessor that
  lazily allocates per-stream sets, plus release / clear lifecycle hooks.
  Purely additive — existing call sites compile unchanged. 247 doctest
  cases pass.

- C.1 (oMLX recovery-on-Metal-error): NEW PATCH on
  `frozename/omlx feat/recovery-on-metal-error`. Catches
  `RuntimeError` whose message starts with [METAL] from
  `next_generated()` and isolates the failure to the most-recently-
  admitted running request (heuristic — mlx-lm doesn't expose per-ui
[…truncated]



**`7cb4b7995515ccd9d707cb9dcfbd1eb8d829e2dc`** — docs(upstream-patches): B.1 v2 MLX Stream.tag field (real-context patch)

Rewrites the corrupt B.1 patch with correct unified-diff context lines
drawn from the reference files at 982ef62d. All 18 context lines now
match the reference exactly; git apply --check will succeed.

Changes vs the previous corrupt patch:
- Hunk 1 (stream.h includes): real context starts at line 3 (#pragma once),
  not a fabricated #include <cstdint>-only block
- Hunk 2 (Stream struct): uint64_t generation{0} (brace-init, not = 0),
  with correct surrounding comment context
- CMakeLists.txt hunk: correct offset -33 (scheduler_tests.cpp block),
  not -38 (linalg_tests.cpp block); correct 10-space indentation
- Tests rewritten in doctest style matching the reference CMakeLists.txt
  test framework (was gtest); two focused cases covering empty tag and
  copy round-trip
- PR description updated to match actual API shape (= default operator==,
  generation{0}, doctest test names, correct file paths)



**`6df7987a5b494396c97f1618686b3f2438b279a6`** — docs(upstream-patches): A.2 v2 MLX max-ops-per-buffer env knob (real-context patch)




**`69f0fd9c0ff5a6adbc8ea37f37573299f6d01865`** — docs(upstream-patches): C.2 v2 oMLX per-model concurrency caps (real-context patch)




**`1d4f8cbb5023d828b343c5b0b28f1d8a60dcc994`** — docs(upstream-patches): C.1 v2 oMLX recovery-on-Metal-error (real-context patch)




**`ef4bbbc7915ab56ef8ec02aa9dd83c3b183d89c2`** — docs(upstream-patches): B.3 v2 MLX per-stream ResidencySet (real-context patch)




**`8abb92c0779f5c337ad05c71bfe912491bc07ea5`** — docs(upstream-patches): stage reference copies of MLX/oMLX source for re-dispatch

Adds reference copies of the upstream files our paper patches target. The
first round of agent-generated paper patches had placeholder content / fake
SHAs / mismatched hunk offsets — they couldn't be `git apply`'d against
the real fork trees. Re-dispatching the agents with these files in their
working set so they can produce diffs against actual context lines.

Base SHAs recorded in BASE.txt per repo:
- MLX:  fix/exception-safe-completion-handler @ 982ef62d (on frozename/mlx)
- oMLX: feat/max-completion-batch-size       @ 26a2033f (on frozename/omlx)



**`1849deb1a4219af1ab3ee50b2e016db4668f71d0`** — feat(remote): add spec.env field to ModelHost manifest




**`bb790edcddaf0e2607cf18681012d859c60591ea`** — docs(upstream-patches): C.2 oMLX per-model concurrency caps patch + PR description




**`808333575f6199784217aa64387d692f4d691fe4`** — docs(upstream-patches): C.1 oMLX recovery-on-Metal-error patch + PR description




**`801fc967309098c13666b8ac8de36e9c0bab946a`** — docs(upstream-patches): B.3 MLX per-stream MTL::ResidencySet patch + PR description




**`54cb924fd3f6efe14a357495e05897ac53534896`** — docs(upstream-patches): B.2 MLX per-stream MTL::CommandQueue patch + PR description

Paper patch refactoring mlx::core::metal::Device from one shared
MTL::CommandQueue to a per-stream map keyed by stream.index.

Touch surface: device.h, device.cpp, eval.cpp, event.cpp (comment),
tests/test_metal_per_stream_queue.cpp (new, 4 test cases).

Design choices:
- kMaxStreamQueues = 64 safety cap; beyond cap falls back to device-global
  queue_ with a one-time stderr warning via std::call_once.
- queue_for_stream returns by value (SharedPtr copy) to avoid dangling-ref
  risk across concurrent map mutations.
- CommandEncoder stores stream_queue_ (SharedPtr) so in-flight command
  buffers survive stream teardown.
- clear_streams() calls release_all_stream_queues() after encoders.clear()
  so the map is rebuilt cleanly on next new_stream.
- MTL::Event is device-scoped (not queue-scoped); event.cpp semantics
  are unaffected — documented with a compatibility note.
- Composes with the exception-safety patch (#2670) on the same branch:
  per-stream queues reinforce per-stream error stash attribution.

Uncertainties noted in PR description:
- Driver cap (~256) is empirical; the 64 ceiling is conservative but
  untested at its full extent on M4 base vs Pro vs Max.
- No end-to-end Metal hardware validation — PR description explicitly
  requests a reviewer with Apple Silicon hardware before merge.
- stream_queues_mtx_ acquired unconditionally on every queue_for_stream
  call; acceptable for long-lived streams but noted as a future
  optimisation candidate (atomic sentinel, as in the error-stash path).



**`1d7c51beaacd4f771028db73db5727114b041d7b`** — docs(upstream-patches): B.1 MLX Stream.tag field patch + PR description

Adds mlx-stream-tag-field.patch (git-format-patch style) and
mlx-stream-tag-pr-description.md for the B.1 task in the
MLX upstream improvements plan (2026-05-21).

Patch adds `std::optional<std::string> tag = std::nullopt;` to the
Stream struct in mlx/stream.h, four GTest unit tests, and the
CMakeLists.txt registration. Backward-compatible; requires A.1
(stream generation counter) as a prerequisite.



**`34e5e42ec25b8bbffec79f78cc51efa1149fea75`** — docs(upstream-patches): A.1 MLX Stream generation counter patch + PR description

Adds two artifacts for the stream generation counter change:

- mlx-stream-generation-counter.patch: git-format-patch against
  fix/exception-safe-completion-handler@982ef62d (back-pressure commit).
  Closes the "Known limitation" noted in the v3 exception-safety patch by
  embedding uint64_t generation in Stream, stamped by new_stream() from a
  process-global atomic counter. The scheduler stashes
  {generation, exception_ptr} pairs; throw_if_stream_error silently discards
  stale entries (generation mismatch) instead of attributing them to the
  new stream that reused the index.
  Changes: mlx/stream.h, mlx/stream.cpp, mlx/scheduler.h,
  tests/test_stream_generation.cpp, tests/CMakeLists.txt.

- mlx-stream-generation-pr-description.md: upstream PR body with motivation,
  API change, compatibility, tests, and references sections.



**`07d697a5e4d13bc49c03e6c985b996b4db70be88`** — docs(upstream-patches): A.3 oMLX --max-completion-batch-size PR package




**`eb8c76495c560129bf67e134225aedc27a422b4a`** — docs(upstream-patches): A.2 MLX max-ops-per-buffer env knob




**`683fdc6f77fc2ba9b511e9046ad70371721b9a60`** — feat(omlx): per-workload isolated model dir + iso Fleet L manifests

The single-process Fleet L design topped out at oMLX --max-concurrent-requests=1
because multi-model context switching in one oMLX process triggers the Apple
GPU watchdog on M4 base (kIOGPUCommandBufferCallbackErrorTimeout). Per-process
isolation — one oMLX per model on separate ports — eliminates the cross-model
context switching at the OS level and unlocks mcr=4 with zero errors
(validated 2026-05-21 mac-mini Fleet L: 4 workloads / 240 rows / 0 errors).

oMLX adapter (packages/core/src/engines/omlx.ts) now creates a per-workload
isolated symlink dir under the workload runtime root (.omlx/models/) and
points --model-dir at it. Each ModelHost spawn only sees its own hostedModel,
matching the schema's existing min=1 max=1 hostedModels constraint.

Three production manifests for mac-mini Fleet L:
  templates/workloads/mlx-granite-3b-iso-mac-mini.yaml  (port 8194)
  templates/workloads/mlx-granite-8b-iso-mac-mini.yaml  (port 8195)
  templates/workloads/mlx-qwen3-8b-iso-mac-mini.yaml    (port 8196)

Also adds MLX_METAL_MAX_INFLIGHT_PER_STREAM and
MLX_METAL_BACKPRESSURE_TIMEOUT_SECS to CHILD_ENV_ALLOWLIST so the upstream
MLX back-pressure patch can be configured per-daemon if needed (it isn't
required for the per-process isolation path; back-pressure addresses a
different use case).

Tests: 18 pass in packages/core/test/engines/omlx.test.ts (15 existing + 3
new for isolated dir + symlink idempotence). The legacy code path (no
workloadName, e.g. unit tests calling buildBootCommand directly) still uses
the full models dir for back-compat.

Includes docs/upstream-patches/mlx-omlx-improvements-plan.md with the full
upstream improvements landscape for MLX core, oMLX, and llamactl as input
to adversarial-plan.




### Diff against main

```

```

### Dispatch summaries this session


- `ccb7ca70-62e0-49d3-a8a8-96c87085a2fe` → **gemini-cli-3-5-flash** [ok, 64s]

- `96c25e7d-0c86-4ec9-9828-ef6dc72b87cf` → **home-mgmt** [ok, 65s]

- `355b1947-3692-4f4b-925e-1fe789319832` → **task-refiner-primary** [ok, 65s]

- `30a673c9-8443-4840-8947-317cb313bb74` → **task-refiner-escalation** [ok, 188s]


### Pending handoffs



## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
