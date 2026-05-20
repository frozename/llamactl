# Maestro continuation prompt — 2026-05-20 am

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
4a23f56 feat(eval/matrix): extend MLX vs llama.cpp bench — dflash knobs, 35B-A3B, Gemma 4 E4B, Granite 4.1 8B
d3c9426 feat(eval/matrix): dflash-aware matrix bench + 3-way Qwen3-8B comparison
0698256 fix(remote/server): optional-chain child.unref for spawn mocks
8d8fe42 chore(remote): TS cleanup + sidecar specHash for ModelHost reconcile
66ade02 fix(remote): D2 — child.unref + reconciler idempotency + correct dflash pair
088374c fix(cli): persist ModelHost manifest before dispatching modelHostStart
c03fee3 feat(mlx): dflash D2 live-smoke template + script
7b2ddbb test(remote/workload): read ModelHost phase from sidecar after M7
3b5e762 fix(remote/workload): decouple ModelHost desired vs observed state
051f42d chore(core): clear pre-existing TypeScript errors
b49b651 Revert "chore: clear pre-existing TypeScript errors across core, remote, cli"
610a91b chore: clear pre-existing TypeScript errors across core, remote, cli
9ee82a7 fix(remote/workload): reconcile completeness - restart on spec drift + stable disabled
432c363 fix(remote/workload): single-scan admission + drop reconciler double-read + truthful disable
71e7429 fix(remote): close ModelHost RCE/SSRF + invoke prepareLaunch + teardown on probe fail + sanitize child env
c875e1c fix(remote/workload): make ModelHost reconcile idempotent
1e5bb75 fix(remote/workload): real ModelHost admission + skip redundant status query
3012622 fix(remote): implement ModelHost dispatch handler (engine spawn + lifecycle)
a1a304a fix(engines): split dflash sidecar write into engine.prepareLaunch hook
9455f57 fix(cli): wire dispatcher client into ModelHost apply path
a31b948 fix(remote/workload): persist ModelHost status from reconciler outcome
274a895 fix(remote/workload): align ApplyManifestOutcome pid with nullable status
ec21188 fix(remote/workload): drop synthetic ModelHost pid + cleanup on timeout
e8391c0 fix(remote/workload): tighten ModelHost name validation + path containment
7268e12 feat(mlx): complete ModelHost control-plane smoke coverage
099ed64 feat(cli): make enable and disable kind-aware
9f3160a feat(engines/omlx): per-model dflash settings via sidecar model_settings.json
d646ad4 feat(cli): surface ModelHost in workload list and apply persistence
c234393 feat(remote/workload): reconcile ModelHost alongside ModelRun
8643737 feat(remote/router): add ModelHost lifecycle procedures
c679897 feat(remote/workload): split ModelHost apply into its own converger
39298a7 feat(remote/workload): add kind-aware workload listing
6d7df2f feat(remote/workload): add ModelHost shared-store helpers
cdd392a docs(notes): maestro continuation 2026-05-19 evening — Sub B ready
f8dcfdd docs(plans): MLX Sub B — executable phased TDD plan
1bb5a74 feat(eval/matrix): MLX fleet bench n=3 — Qwen3-8B/14B + Qwen3.6-35B-A3B vs llama.cpp baseline
ef5b281 docs(specs): MLX engine support — Sub B design (ModelHost workload-store integration)
f5896cc feat(eval/matrix): rolling DB default + diff CLI
9d4069c feat(eval/matrix): oMLX bench integration — disable_thinking + probeInference modelId + fallback hostedModels
2b918de fix(eval+tools): Phase 6.4 smoke integration — oMLX main HEAD, real model ids, validator engine-aware
61c1d9f fix(workloads): pilot model rel — mlx-community → lmstudio-community
b7f50d2 fix(cli/apply): dispatch ModelHost manifests through applyManifest
8abbce5 feat(tools): pin oMLX to feat/speculative-decoding branch (MTP support)
2ae1b3d fix(core): harden unified persistence routing
d189667 feat(core/proxy): cross-engine route table — Wave 4+5 unified (Phase B)
675bb4b feat(core): persist ModelHost runtime state
```

### Commit context (bodies)


**`4a23f56321c2eff43a401c6458c5bddd73419f05`** — feat(eval/matrix): extend MLX vs llama.cpp bench — dflash knobs, 35B-A3B, Gemma 4 E4B, Granite 4.1 8B

Two new spec files + 12 new bench cells appended to dflash-vs-baseline.db:

## dflash knob sweep (Qwen3-8B, memory-recall n=105)

  variant                          score   tps
  vanilla (no dflash)              0.5633  20.69
  dflash default (w=1024, adaptive) 0.5544 22.69  (+9.7%, the winner)
  dflash window=64                 0.5544  19.12  (-7.6% vs default)
  dflash verify=tree               0.5633  18.28  (-11.6% vs default)

Smaller window and tree-verify both hurt — the default window=1024 +
adaptive verify is the right config for this workload.

## Qwen3.6-35B-A3B (memory-recall n=105)

  variant     score   tps
  vanilla     0.6433  44.85    (highest quality on memory-recall in fleet)
  dflash      0.6404  46.25    (+3.1% — gain shrinks at 35B-A3B because
                                MoE only activates 3B params/token, less
                                to amortize, and the model is already fast)

A3B is the speed king of the fleet at 44-46 tps (vs 8B at 19-22 tps).

## Gemma 4 E4B (memory-recall n=105 + tool-call-grammar n=50)

  variant               memory-recall      tool-call
                        score   tps        score  tps
  mlx-community 4bit    0.5058  49.1       0.64   50.53
  llama.cpp UD-Q4_K_XL  0.7171  28.02      0.38   34.98

INVERTED pattern from Qwen and Granite: llama.cpp wins memory-recall
quality (+21 pp), MLX wins tool-call quality (+26 pp). MLX still wins
throughput by ~75% on both. Hypothesis: unsloth's UD imatrix calibration
helps retrieval but hurts structured output; the plain mlx-community 4-bit
is the inverse. To test, the next round will AWQ-quantize the bf16 source
ourselves so the MLX variant gets imatrix-equivalent calibration.

## Granite 4.1 8B (memory-recall n=105 + tool-call-grammar n=50)

  variant               memory-recall      tool-call
                        score   tps        score  tps
  mlx-community nvfp4   0.7315  18.14      0.86   27.38
  llama.cpp Q4_K_M      0.4743  27.16      0.6122 25.08

Same p
[…truncated]



**`d3c94263ea30b792a0850eddbd08a40cfc3317ce`** — feat(eval/matrix): dflash-aware matrix bench + 3-way Qwen3-8B comparison

- types.ts: ModelSpec gains optional `dflash` block (Record<string, unknown>),
  forwarded into hostedModels[0].dflash on omlx so prepareLaunch writes
  the per-workload model_settings.json sidecar with dflash settings.
- lifecycle.ts: thread model.dflash into the spawned spec in both
  buildBootCommandForModelSpec and ensureModelServing.
- specs/qwen3-8b-dflash-vs-baseline.json: 3-way comparison spec
  (vanilla MLX :8094, dflash MLX :8095, llama.cpp Q4_K_M :8087).

Live results (M4 Pro 64GB, runId 2026-05-19T22:38:53...df1c0bd7):

  memory-recall (n=105, NDCG@5):
    mlx-vanilla  0.5633  tps=20.69  p50=3400ms
    mlx-dflash   0.5544  tps=22.69  p50=3140ms   (+9.7% tps vs vanilla)
    llamacpp     0.3608  tps=19.84  p50=3324ms   (-19.4 pp quality)

  tool-call-grammar (n=50, exact match):
    mlx-vanilla  0.9000  tps=29.57  p50=1424ms
    mlx-dflash   0.9000  tps=25.77  p50=1501ms   (-12.8% tps vs vanilla)
    llamacpp     0.6939  tps=28.60  p50=1199ms   (-20.6 pp quality)

Headlines:
- MLX > llama.cpp by ~20 pp on both quality axes at same effective quant.
- dflash is workload-shaped: helps long generation (+10% memory-recall),
  hurts short structured output (-13% tool-call) because draft load +
  verify overhead doesn't amortize. Quality-neutral throughout.



**`069825621164d94253f9a5cd104f1637541d0c70`** — fix(remote/server): optional-chain child.unref for spawn mocks

Test fixtures mock spawn to return a plain {pid} stub without an
.unref() method. Unconditional child.unref() then threw on every
startModelHost test path, failing 6 server/modelhost tests after the
D2 fix landed. Optional-chain the call so production (where the real
ChildProcess always has .unref) is unaffected.



**`8d8fe426bb3199c38df1530ed362a3d03b579c39`** — chore(remote): TS cleanup + sidecar specHash for ModelHost reconcile

Two parallel cleanups landed together:

TS / type-soundness fixes (packages/remote production code now clean):
- apply.ts: declare workloadsDir/getNodeBudgetGiB/onEvent on
  ApplyManifestOptions; drop the leftover `& {status:{phase}}` on the
  ModelHost outcome (M7 made status sidecar-only); widen the
  modelHostStart subscribe done-payload to a discriminated StartResult
  union so the post-narrowing path can read pid/state cleanly;
  ApplyManifestOptions becomes Omit<...,'manifest'> at the
  applyModelHostManifest entry point.
- router.ts: drop the dead target/extraArgs/endpoint/binary fields on
  the modelHostStart RPC call site (Wave E stripped them from the
  schema but left the call site).
- composite/apply.ts + serve.ts: add allowExternalBind: false to the
  synthetic ModelRun admission specs (required after the admission
  type tightened).
- setEnabled.ts: import ModelHostManifest from its canonical
  modelhost-schema, narrow the dual-path result to a simple error
  string rather than overconstraining the local return shape.

Reconcile idempotency via sidecar specHash:
- state.ts: ModelHostState gains an optional `specHash` field and a
  computeModelHostSpecHash helper covering the launch-affecting
  manifest fields (engine, binary, endpoint, hostedModels, extraArgs,
  resources, restartPolicy, timeoutSeconds).
- apply.ts + server/modelhost.ts: every sidecar write now records the
  current specHash.
- reconciler.ts: ModelHost branch compares the desired manifest hash
  against the sidecar specHash. Running + matching hash → unchanged;
  missing or diverging hash → applyOneModelHost (which writes a
  fresh sidecar). Restores Wave G's spec-drift detection that
  previously regressed because hostSpecsEqual was comparing the
  manifest against the modelHostStatus response (which only carries
  state+pid, no launch args).
- reconciler.test.ts: pre-seed the sidecar in the "unchanged" tests
  via a new seedRunningSidecar helper.



**`66ade0272b345892192dc849cb5a8f441bd04aa4`** — fix(remote): D2 — child.unref + reconciler idempotency + correct dflash pair

Three fixes unblocking the live dflash D2 smoke on M4 Pro:

- modelhost.ts: spawn with detached: true but missing child.unref(); the
  parent retained a reference, so subscription / generator cleanup
  propagated a SIGTERM/SIGINT to the engine ~1ms after init. Mirror the
  detached+unref pattern from core/src/server.ts (ModelRun's startServer).

- reconciler.ts: hostSpecsEqual compared the manifest's spec against the
  modelHostStatus response, which only carries {state, pid}. Every field
  in the snapshot was undefined, so equality was always false and the
  reconcile tick "restarted" the host every 15s, killing the engine.
  Replace with a pragmatic "if state === Running, leave it alone";
  spec drift is detected via the explicit `llamactl apply -f` path,
  not the reconcile loop.

- templates/workloads/mlx-host-dflash.yaml: dflash_draft_model was
  z-lab/Qwen3.5-4B-DFlash, which is for the Qwen3.5 family. The
  Qwen3-8B target needs z-lab/Qwen3-8B-DFlash-b16 (per the upstream
  README: "must be used in conjunction with Qwen/Qwen3-8B").

Measured: warm dflash inference 29.99 tps (200 tokens in 6.67s) on
M4 Pro 64GB. Cold-start dominated by 22s draft + target load.



**`088374c517991c2bc55f0c0eda98114d21726528`** — fix(cli): persist ModelHost manifest before dispatching modelHostStart

The agent's startModelHost loads the manifest by name from the workloads
dir; for a fresh `llamactl apply -f` that file did not exist yet because
applyModelHostFromRaw only saved AFTER applyManifest returned. Surface
schema validation up-front, persist via saveModelHost, then dispatch.
If applyManifest fails the desired-state manifest is still on disk and
the reconciler can retry — that is the right semantics for declarative
apply.



**`c03fee35bdad2a548c3758a443030d9c5219a963`** — feat(mlx): dflash D2 live-smoke template + script

Adds a ModelHost manifest pairing Qwen3-8B-MLX-4bit with the
z-lab/Qwen3.5-4B-DFlash draft, plus an end-to-end smoke that:
- applies the manifest
- verifies llamactl materialized the dflash sidecar
  (${LLAMACTL_RUNTIME_DIR}/workloads/dflash-host-local/.omlx/model_settings.json)
- waits for /v1/models on :8095
- runs a 200-token chat completion and reports wall time + tps
- tails the oMLX log for dflash acceptance markers

Pre-reqs are documented at the top of the manifest. Schema validation
confirmed; live throughput vs the vanilla MLX-4bit run on :8094 is the
D2 measurement the next M4 Pro session will capture.



**`7b2ddbb4400829b8c9f15aa6971ea8e292c19b75`** — test(remote/workload): read ModelHost phase from sidecar after M7

Two pre-existing assertions read result.manifest.status.phase, which
was removed when status was decoupled from the desired-state manifest
in 3b5e762. Read the runtime sidecar via readModelHostState instead;
for the disable case assert the sidecar was cleared.



**`3b5e762bb50088a86425a1f8962b9a30517f3f21`** — fix(remote/workload): decouple ModelHost desired vs observed state

The ModelHost manifest YAML was carrying observed status fields, which
risked stale-state contamination across crashes/restarts. The runtime
sidecar (writeModelHostState / readModelHostState) is the canonical
observed-state store. Strip status from the saved manifest, drive
reconciler idempotency off modelHostStatus + the sidecar, and surface
parse failures from list helpers via an onSkip callback instead of
swallowing them silently.



**`051f42dc9b7766dad70fe57cc18800558a83d630`** — chore(core): clear pre-existing TypeScript errors

Mechanical type-only fixes — runtime behavior unchanged:
- catalog.ts: add format: 'gguf' to all 12 curated entries
- catalogWriter.ts: narrow `format` to CuratedModel['format'] in the
  constructed CuratedModel
- openaiProxy.ts: remove the default parameter on the overload
  signature; the implementation already carries the default
- test/engines/{llamacpp,omlx}.test.ts: cast the mocked fetch shim
  through `unknown` since the lambda signature doesn't match
  typeof fetch exactly
- test/engines/types.test.ts: cast Object.entries(ENGINES) keys
  back to EngineName for toBe()
- test/{engines,openaiProxy}: replace RequestInfo with Request|URL|string



**`b49b6516cb5780f189714b224549e11b39a58922`** — Revert "chore: clear pre-existing TypeScript errors across core, remote, cli"

This reverts commit 610a91bc1cd39b21d28e7a0d22b51591b3988a6e.



**`610a91bc1cd39b21d28e7a0d22b51591b3988a6e`** — chore: clear pre-existing TypeScript errors across core, remote, cli

Mechanical type-only fixes accumulated across packages:
- catalog.ts: add the format field to all existing curated entries
- apply.ts: declare getNodeBudgetGiB, onEvent on ApplyManifestOptions
  and add allowExternalBind to the synthetic admission spec
- setEnabled.ts: import ModelHostManifest from its canonical module
  and narrow the local return shape to match ApplyResult union
- openaiProxy.ts: fix the misplaced parameter initializer
- eval/matrix: guard string|undefined inferences at the call sites
- core/test: fix RequestInfo typing and EngineAdapter test fixtures



**`9ee82a73e811162f48f8062b70691b44a383f5ad`** — fix(remote/workload): reconcile completeness - restart on spec drift + stable disabled

- reconciler.ts change-detection now considers restartPolicy and
  timeoutSeconds; previously they could change without triggering a
  restart on the next tick.
- Disabled ModelHosts reach a real steady state: if the manifest is
  disabled and the host is already Stopped, reconcileOnce reports
  'unchanged' instead of re-issuing modelHostStop every tick.
- Canonicalize phase casing to 'Running'/'Stopped' across apply +
  reconciler + modelhost.statusModelHost so equality checks line up.



**`432c363949115fa5677397009e66be5c48b593b6`** — fix(remote/workload): single-scan admission + drop reconciler double-read + truthful disable

Three correctness/perf fixes from the third adversarial review:
- reconciler.ts: ModelHost branch was re-reading each manifest via
  loadModelHostByName when the listed manifest already carries status.
- apply.ts: admission was scanning the workloads dir twice (once for
  ModelRun, once for ModelHost). Merge into a single readdirSync pass.
- apply.ts: disable branch was swallowing modelHostStop errors and
  reporting success regardless. Surface the error so reconcile can
  retry instead of pretending stop succeeded.



**`71e742945cc05c463a1ed561bc09d2c36b3dc311`** — fix(remote): close ModelHost RCE/SSRF + invoke prepareLaunch + teardown on probe fail + sanitize child env

The modelHostStart RPC accepted caller-controlled binary/extraArgs/
endpoint without re-validating them, opening RCE and SSRF on any
authenticated client. Strip those fields from the public input —
manifests are the only source of truth. Also: invoke the new
engine.prepareLaunch hook so dflash sidecar writes happen on the
production path, kill the detached child on readiness failure to
avoid orphan processes, and restrict the spawned process env to the
same allowlist ModelRun uses to avoid leaking host secrets.



**`c875e1ce25308758cab865e9c28ed79041125609`** — fix(remote/workload): make ModelHost reconcile idempotent

reconcileOnce was issuing modelHostStart on every pass for ModelHost
manifests, restarting the engine without inspecting current state.
Query modelHostStatus first; only re-apply when state is not Running
or the persisted spec diverges from the desired spec.



**`1e5bb75e7c57bd5971667d690b35fc21146fdbd3`** — fix(remote/workload): real ModelHost admission + skip redundant status query

applyModelHostManifest was passing livingManifests: [] into the budget
computation, ignoring all incumbents on the target node. Project both
incumbent ModelRuns and ModelHosts (excluding the incoming workload)
into the admission shape so co-location is correctly accounted for.
Also read pid from the modelHostStart subscribe done payload directly,
only falling back to modelHostStatus.query when the payload is silent.



**`3012622345dfdcef93fe0336dacfc05cca8d4130`** — fix(remote): implement ModelHost dispatch handler (engine spawn + lifecycle)

The Wave-3 split removed the controller-local ModelHost spawn but left
the router's modelHostStart/Stop/Status procedures forwarding into a
ctx.nodeClient implementation that did not exist, breaking end-to-end
ModelHost apply in production. Implement startModelHost/stopModelHost/
statusModelHost on the node side (engine adapter spawn + readiness
probe + sidecar state), mirroring the ModelRun serverStart pattern.



**`a1a304ab954a00a76d53a8a455f18d7ebcd31767`** — fix(engines): split dflash sidecar write into engine.prepareLaunch hook

buildBootCommand was performing filesystem writes when a dflash
block was present on the manifest, leaking side effects into
introspection and dry-run paths. Add an optional prepareLaunch
method on EngineAdapter for explicit pre-spawn materialization
and move the model_settings.json write there.



**`9455f574ea91d04358fdea9b8c9b9ca6107af383`** — fix(cli): wire dispatcher client into ModelHost apply path

applyModelHostFromRaw was calling applyManifest without a getClient,
so the Wave-3 converger always failed with "missing modelHostStart".
Pass the same per-node client resolver the ModelRun path uses, and
stop reading the non-existent outcome.statusSection — the converger
now embeds status.phase directly in outcome.manifest.




### Diff against main

```

```

### Dispatch summaries this session


- `cc311100-3137-498e-a0b8-443092c6e413` → **home-mgmt** [ok, 31s]

- `015b4397-08be-4b1c-901a-52e9fae18749` → **task-refiner-primary** [ok, 31s]

- `f5408c8c-1375-4e01-9999-2823840ce28d` → **task-refiner-escalation** [ok, 62s]


### Pending handoffs



## Session focus — MLX vs llama.cpp + dflash bench across the full fleet

This session went deep on a single thread: bench every reasonable Qwen3, Gemma 4, and Granite variant across MLX (oMLX) and llama.cpp engines, with and without dflash speculative decoding, and surface concrete production swap candidates.

Results DB: `packages/eval/results/dflash-vs-baseline.db`. Specs in `packages/eval/specs/`. Reports in `packages/eval/results/*.md`.

### Bench coverage shipped

Across **3 workloads** (memory-recall n=105, tool-call-grammar n=50, task-refiner-rubric n=50) and **18+ model variants**:

- Qwen3-8B: MLX vanilla, MLX+dflash (window/verify sweep), MLX+AWQ-sparse, llama.cpp Q4_K_M
- Qwen3-14B: MLX (text + tool-call + task-refiner)
- Qwen3.6-35B-A3B: MLX vanilla + MLX+dflash
- Granite-4.1-8B: MLX-nvfp4, llama.cpp Q4_K_M
- Gemma-4-E2B / E4B / 26B-A4B / 31B: MLX (vanilla + some dflash) and llama.cpp UD-Q4_K_XL

### Top quality leaders (memory-recall NDCG@5)

  gemma4-31b-llamacpp-UDQ4KXL      0.8226   5.11 tps
  gemma4-31b-mlx-vanilla           0.8217   5.05 tps   ← MLX matches llama.cpp at 31B
  gemma4-26b-a4b-llamacpp-UDQ4KXL  0.8209  26.97 tps
  gemma4-26b-a4b-mlx-dflash        0.7738  30.72 tps
  gemma4-26b-a4b-mlx-vanilla       0.7692  30.89 tps
  granite41-8b-mlx-nvfp4           0.7315  18.14 tps
  qwen3-14b-mlx-4bit               0.7311  13.56 tps
  gemma4-e4b-llamacpp-UDQ4KXL      0.7171  28.02 tps
  gemma4-e2b-mlx-4bit              0.6625  81.70 tps   ← speed champion
  qwen36-35b-a3b-mlx-vanilla       0.6433  44.85 tps   ← best speed/quality Pareto

### Top quality leaders (tool-call-grammar exact)

  qwen3-14b-mlx-4bit               0.92    16.75 tps   ← tool-call king
  qwen3-8b-mlx (vanilla/dflash/awq) 0.90   25-29 tps
  granite41-8b-mlx-nvfp4           0.86    27.38 tps
  gemma4-26b-a4b-mlx-vanilla       0.84    41.03 tps
  gemma4-31b-mlx-vanilla           0.84     7.26 tps

### Cross-cutting findings

1. **MLX dominates tool-call by +20-26 pp vs llama.cpp** at every size from 8B to 31B.
2. **dflash is workload-shaped**: +3-10% throughput on memory-recall (long-form) but -10 to -30% on tool-call (short structured). Quality is neutral throughout.
3. **MLX vs llama.cpp calibration gap closes at scale**: E4B llama.cpp wins memory-recall by +18.9 pp; 26B by +5 pp; 31B ≈ 0 pp; E2B reverses (MLX wins).
4. **AWQ-calibrated MLX (sparse, 16 samples)** regressed -15 pp vs plain mlx-community 4-bit on Qwen3-8B memory-recall. Hypothesis falsified; calibration alone doesn't explain MLX-vs-llama.cpp gaps. Sparse calibration may have been the confound — full AWQ (128+ samples) is a deferred test.

## Improvement opportunities (concrete, prioritized)

### 1. Production model swaps
- **Long-lived granite slot**: swap `granite-3b-Q8` → `granite-4.1-8b-MLX-nvfp4` (+17 pp memory-recall, +25 pp tool-call vs llama.cpp Q4_K_M; -50% tps tradeoff at ~18 tps).
- **Maestro / coding slot**: swap `gemma4-26b-a4b MTP llama.cpp` → `gemma4-26b-a4b MLX vanilla` (+20 pp tool-call, faster than llama.cpp at 41 tps tool-call / 31 tps memory-recall).
- **Speed-critical slot**: new `gemma4-e2b-MLX-4bit` slot (82 tps, fastest in fleet).

Updates the "MTP-first" feedback memory (`feedback_model_selection_mtp_first.md`) → recommended new rule: **"MLX-first for Gemma 4 + Qwen3 families; fall back to llama.cpp UD-Q4 only for Gemma E4B retrieval workloads."**

### 2. Per-workload dflash policy
- Enable dflash for memory-recall / RAG / long-form generation.
- Disable dflash for tool-call / short-structured output.
- Wire as a per-workload override in workload templates (currently a per-model spec flag).

### 3. Bench infrastructure follow-ups
Landed this session: `probeInference` accepts `reasoning_content`, runner concats reasoning+content, dflash boot-probe timeout 30s→180s, mlx_lm.gemma4_text sanitize drops orphan KV layers, `disable_thinking` honored on Gemma 4.

Still to do:
- **Per-workload `max_tokens` override** in `ModelSpec` — currently runner hardcodes 256, which is too tight for any thinking model without disable_thinking
- **Auto-set disable_thinking based on family** (Gemma 4 + Qwen 3.x always benefit)
- **Upstream the mlx_lm.gemma4_text sanitize patch** — fixes a real bug affecting all Gemma 4 IT conversions; currently patched in the local venv only

### 4. Catalog refresh
The curated catalog should gain rows for:
- `granite-4.1-8b-MLX-nvfp4` (4.4 GB, format: 'mlx')
- `gemma-4-e2b-MLX-4bit` (1.5 GB)
- `gemma-4-e4b-MLX-4bit` (3.9 GB)
- `gemma-4-26b-a4b-MLX-4bit` (13 GB, local-convert path)
- `gemma-4-31b-MLX-4bit` (16 GB, local-convert path)
- `Qwen3-14B-MLX-4bit` (8 GB)

### 5. Open deferred threads
- **31B MLX dflash bench** paused after the probe-timeout fix landed; the spec file is at `packages/eval/specs/gemma4-31b-dflash-retry.json`. Re-run when ready.
- **Full AWQ (128+ samples × 1024 seq)** on Qwen3-8B to rule out sparse-calibration as the AWQ confound (~50 min wall on M4 Pro).
- **GPTQ as alternative calibrator** — `mlx_lm.gptq` is available; never tried.
- **Gemma-4-E4B re-converted ourselves** + dflash bench (no z-lab E4B-DFlash exists, so vanilla-only).

### 6. Anomaly worth investigating
- **Gemma 4 E4B llama.cpp-beats-MLX inversion** on memory-recall (+18.9 pp). Unique to that size. Disable_thinking helped +1.7 pp but didn't close the gap. Doesn't repeat at E2B (MLX wins), 26B (close), 31B (tied). Likely E4B's per-layer KV gating + small size makes 4-bit affine quant lossy for retrieval specifically.

## Files / artifacts you'll want to know about

- `packages/eval/results/dflash-vs-baseline.db` — sqlite with all matrix_runs + cell_row_details
- `packages/eval/specs/{qwen3-8b-dflash-vs-baseline,dflash-sweep-and-35b,gemma-granite-mlx-vs-llamacpp,qwen3-8b-awq-vs-vanilla-vs-llamacpp,qwen3-14b-and-task-refiner-fleet,gemma4-full-family,gemma4-26b-a4b-mlx-vs-llamacpp,gemma4-e4b-rerun-no-thinking,gemma4-31b-mlx-vs-llamacpp,gemma4-31b-dflash-retry}.json` — the 10 spec files written this session
- `packages/eval/results/*.md` — per-spec markdown reports
- `templates/workloads/mlx-host-dflash.yaml` — the dflash D2 live workload template
- `tools/smoke-modelhost-dflash.sh` — end-to-end dflash smoke script
- `/Volumes/WorkSSD/ai-models/llama.cpp/models/local-convert/{gemma-4-e4b-it-4bit,gemma-4-26b-a4b-it-4bit,gemma-4-31b-it-4bit}` — our own MLX conversions (13-16 GB each)
- `/Volumes/WorkSSD/ai-models/llama.cpp/models/z-lab/{Qwen3-8B-DFlash-b16,gemma-4-26B-A4B-it-DFlash,gemma-4-31B-it-DFlash,Qwen3.6-35B-A3B-DFlash}` — dflash draft models on disk
- Memory entries written this session:
  - `reference_dflash_draft_target_pairing.md`
  - `project_dflash_3way_bench_2026-05-19.md`
  - `project_mlx_calibration_falsified_2026-05-19.md`

## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Pick the next thread from the improvement-opportunities list (model swaps → catalog refresh → bench infra fixes → deferred runs).
