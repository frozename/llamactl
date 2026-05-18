# MLX engine support — Sub A: engine abstraction + oMLX adapter (local, single model)

Status: design, awaiting plan
Date: 2026-05-18
Predecessor decisions: AskUserQuestion answers from the brainstorm session
on 2026-05-18 — engine pick (oMLX), architectural shape (Shape 2: ModelHost),
yaml schema (new `kind: ModelHost`), pull-path (extend `llamactl pull`),
first-slice scope (Sub A only, full scope decomposed into A-D).

## 1. Goal and scope

llamactl gains an engine abstraction so it can orchestrate MLX inference
on Apple Silicon alongside the existing llama.cpp default. The new engine
is **oMLX** ([github.com/jundot/omlx](https://github.com/jundot/omlx),
Apache 2.0), chosen because it ships continuous batching, SSD-tiered KV
cache persistence (TTFT 30-90s → 1-3s on stable agent prefixes),
multi-model serving in one process, and OpenAI + Anthropic + embeddings
+ rerank endpoints in a single binary.

Sub A's deliverable:

- A new manifest kind `ModelHost` (alongside existing `ModelRun`).
- An `EngineAdapter` registry with two entries: `llamacpp` (rehoused
  existing logic, no behavior change) and `omlx` (new).
- `llamactl pull` learns to fetch MLX-format repos from HuggingFace.
- `openaiProxy` routes `/v1/chat/completions` to either engine
  transparently, both kinds participating in the same route table.
- The matrix bench (`packages/eval/src/matrix/`) accepts MLX models in
  its specs and benches them through the same runner.
- One pilot manifest lands: `mlx-host-local` hosting
  `mlx-community/Qwen3-8B-MLX-4bit` on `127.0.0.1:8094`, coexisting with
  the live `granite41-3b-long-lived-local` on `:8083`.
- AGENTS.md gains a short MLX section under model selection preferences.

Out of scope for Sub A (deferred to follow-on sub-projects, each with
its own spec + plan):

- **Sub B** — multi-model hosting (hostedModels length > 1), hot-load
  / unload / pin via oMLX REST, CLI verbs.
- **Sub C** — mac-mini deployment of MLX workloads.
- **Sub D** — train-loop adapter integration (load `packages/train/`
  LoRA adapters into oMLX-hosted base models without a GGUF roundtrip).

## 2. Architecture

Three pieces.

### 2.1 Engine registry — `packages/core/src/engines/`

New module. Strategy-registry pattern: each engine is a record of pure
functions, dispatched on the `engine` string. Matches the codebase's
existing functional + zod style; no class hierarchy.

```ts
// packages/core/src/engines/types.ts
export type EngineName = 'llamacpp' | 'omlx';

export interface EngineAdapter {
  name: EngineName;
  validateSpec(spec: ModelHostSpec): { ok: true } | { ok: false; error: string };
  buildBootCommand(
    spec: ModelHostSpec,
    env: ResolvedEnv,
  ): { binary: string; args: string[]; envOverrides?: Record<string, string> };
  probeReady(
    endpoint: { host: string; port: number },
    timeoutMs: number,
  ): Promise<{ ready: boolean; modelIds: string[] }>;
  teardown(pid: number): Promise<void>;
}

export const ENGINES: Record<EngineName, EngineAdapter> = { llamacpp, omlx };
```

`llamacpp.ts` is a thin wrapper around the existing `server.ts`
arg-building and boot logic — no behavior change, but the implicit
"the engine is llama.cpp" assumption now lives behind an explicit
adapter. `omlx.ts` is new code. Tests for `llamacpp.ts` guard that
rehousing didn't move behavior.

### 2.2 New manifest kind — `ModelHost`

New schema file `packages/remote/src/workload/modelhost-schema.ts`.
Separate zod schema, separate reconciler path, separate CLI surface.
`ModelRun` is unchanged. The top-level `kind` field discriminates;
`apply.ts` dispatches on it:

```
manifest.kind === 'ModelRun'  → existing path (engine: llamacpp implicit)
manifest.kind === 'ModelHost' → ENGINES[spec.engine].buildBootCommand(...)
```

Nothing in `ModelRun` learns about `engine`. The engine concept lives
entirely in `ModelHost`. This keeps the surface area minimal and makes
"what kind of process am I starting?" answerable from kind alone.

### 2.3 openaiProxy cross-engine routing

`openaiProxy` already peeks `model` from the request body and routes
via `workloadRuntime.listLocalWorkloads()` to a `state.host:state.port`
(per commit c2ee627). Extending it: `listLocalWorkloads()` learns to
enumerate `ModelHost` runs too. For each running ModelHost, it yields
one entry per `hostedModels[*].rel` — all pointing at the same
`host:port`. Sub A's invariant `hostedModels.length === 1` keeps this
1:1; Sub B widens it.

The existing `listLocalWorkloads()` is extended to return a unified
route shape that includes both kinds:

```ts
interface LocalRoute {
  model: string;       // matches what the request body's `model` field can be
  host: string;
  port: number;
  engine: EngineName;
  kind: 'ModelRun' | 'ModelHost';
}
function listLocalWorkloads(): LocalRoute[];
```

The forwarding logic (`fetch`, header/body streaming) is unchanged —
both engines speak the same `/v1/chat/completions` wire format. Only
the route table changes.

## 3. Yaml schema — `ModelHost`

```yaml
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: mlx-host-local
  labels:
    family: mlx
    role: inference-host
spec:
  engine: omlx                # required; enum: 'omlx' for Sub A
  node: local                 # same node concept as ModelRun
  enabled: true
  binary: /Volumes/WorkSSD/src/omlx/.venv/bin/omlx  # required (no PATH fallback)
  resources:
    expectedMemoryGiB: 12
  endpoint:
    host: 127.0.0.1
    port: 8094               # required, no default
  hostedModels:               # min 1, max 1 in Sub A
    - rel: mlx-community/Qwen3-8B-MLX-4bit
  extraArgs:                  # passed verbatim after engine-built defaults
    - --max-concurrent-requests
    - "4"
    - --paged-ssd-cache-dir
    - /Volumes/WorkSSD/cache/omlx
  restartPolicy: Always
  timeoutSeconds: 60
```

Schema-level invariants (zod):

- `spec.engine` required; Sub A enum is `'omlx'` (extensible).
- `spec.binary` required (no PATH fallback for ModelHost — see §4.1).
- `spec.hostedModels` length `[1, 1]` (Sub A); Sub B widens to `[1, N]`.
- `spec.endpoint.port` required (no default — port collisions on a
  multi-workload node make implicit ports a recurring footgun).
- `target` field from ModelRun is **not** present on ModelHost; the
  hosted model's HF rel path lives in `hostedModels[].rel`.
- `workers` field from ModelRun is not present; oMLX has no RPC fan-out.

Naming: the hosted model's `rel` follows the same convention as
ModelRun's `target.value` — an HF-relative path like
`mlx-community/Qwen3-8B-MLX-4bit`. Pull places it at
`$LLAMA_CPP_MODELS/mlx-community/Qwen3-8B-MLX-4bit/`. oMLX launches
with `--model-dir $LLAMA_CPP_MODELS` and auto-discovers it. Sub B will
tighten this to a per-host scratch directory for cleaner isolation.

## 4. oMLX engine adapter

### 4.1 Install — built from source

Pattern mirrors the atomic llama.cpp fork at
`/Volumes/WorkSSD/src/llama.cpp-atomic/`:

- Clone target: `/Volumes/WorkSSD/src/omlx/` on M4 Pro,
  `/Volumes/AI-DATA/src/omlx/` on mac-mini (deferred to Sub C).
- Build (Python venv, editable install):
  ```bash
  git clone https://github.com/jundot/omlx $OMLX_SRC
  cd $OMLX_SRC && uv venv && uv pip install -e .
  # entrypoint: $OMLX_SRC/.venv/bin/omlx
  ```
- Bootstrap script `tools/install-omlx-from-source.sh` runs the
  clone + venv + install idempotently.
- `spec.binary` is **required** — no PATH fallback. Stricter than
  llama.cpp's permissive PATH lookup, because the source venv path is
  the only supported install for ModelHost. Homebrew + pip + venv
  installs would create multiple paths to maintain; we explicitly
  refuse the choice.
- Lockfile `tools/omlx.lock` records the upstream commit hash +
  verified-working date, mirroring `reference_fork_branches_correct_2026-05-17`
  for llama.cpp.

Tradeoff: every machine needs to run the bootstrap script once.
Onboarding tax paid in exchange for never debugging "which omlx is on
PATH today?" and preserving the patch-if-needed option upstream.

### 4.2 Boot command

```
{binary} serve
  --model-dir   $LLAMA_CPP_MODELS
  --host        {endpoint.host}
  --port        {endpoint.port}
  --max-model-memory   {resources.expectedMemoryGiB}GB     # if set
  ...{spec.extraArgs verbatim}
```

No flag conflict-checking in Sub A — `extraArgs` wins on collision.
`filterEngineArgs` helpers can land in Sub B once we know which flags
users override commonly. oMLX loads on first request (not at boot), so
no model name is passed to `omlx serve`.

### 4.3 Probe ready

Poll `GET http://{host}:{port}/v1/models` every 250 ms for up to
`spec.timeoutSeconds`. Ready = HTTP 200 with at least one model in
`data[]` whose `id` matches `hostedModels[0].rel` or its basename
(`Qwen3-8B-MLX-4bit`). Returns `{ ready: true, modelIds: [...] }`.

### 4.4 Teardown

SIGTERM, 10 s grace, then SIGKILL. No special drain. oMLX persists its
KV cache to `--paged-ssd-cache-dir` on disk, so restarts retain the
agent-prefix cache.

### 4.5 OpenAI compatibility surface

oMLX exposes `/v1/chat/completions`, `/v1/completions`, `/v1/messages`,
`/v1/embeddings`, `/v1/rerank`, `/v1/models`. Sub A's openaiProxy only
routes `/v1/chat/completions` and `/v1/models` — matches what we route
today. Other endpoints become routable in Sub B / follow-up when
consumers exist.

## 5. Pull-path extension

`packages/core/src/pull.ts` is GGUF-specific today. Extension:

### 5.1 Detection at file-listing step

Before quant-ladder filtering, classify the repo:

- File set contains any `.gguf` → **GGUF repo** (existing path).
- Else file set contains `config.json` + (`tokenizer.json` or
  `tokenizer.model`) + at least one of `model.safetensors` /
  `model.safetensors.index.json` → **MLX repo** (new path).
- Else → existing error path ("no gguf files found in repo").

Repo-namespace shortcut: if the repo starts with `mlx-community/`,
skip classification and go straight to MLX path. Optimization, not
truth source — file fingerprint remains authoritative.

### 5.2 Override

`llamactl pull <repo> --format mlx` / `--format gguf` forces the
decision when both file types exist. Default: GGUF wins (back-compat).

### 5.3 Download shape

Pull every file in the repo whose path is not in an ignore-list
(`.gitattributes`, `README.md`, `*.png`, large preview videos).
Destination: `$LLAMA_CPP_MODELS/<repo>/` —
`$LLAMA_CPP_MODELS/mlx-community/Qwen3-8B-MLX-4bit/`. Matches oMLX's
`--model-dir` parent expectation.

### 5.4 Catalog tracking

The TSV catalog gets a `format: gguf|mlx` column. `llamactl catalog
list mlx` filters to MLX entries. `llamactl uninstall <repo>` already
removes the directory recursively; only the catalog-row deletion path
needs a small addition for the new column.

### 5.5 No quant ladder

MLX repos are pre-quantized at a single bit-width per repo
(`Qwen3-8B-MLX-4bit` vs `Qwen3-8B-MLX-8bit` are different repos).
"Best quant for profile" logic doesn't apply. `llamactl discover`
surfaces MLX repos as a flat list, sorted by recency + downloads.

## 6. openaiProxy cross-engine routing

Today (commit c2ee627): `/v1/*` requests peek `model` from the body
and route via `workloadRuntime.listLocalWorkloads()`. Extension (see
§2.3 for the unified `LocalRoute` shape): `listLocalWorkloads()` also
enumerates ModelHost runs and yields one route entry per
`hostedModels[i].rel` (always one in Sub A).

Edge case — **model-ID mismatch**. oMLX may return model IDs from
`/v1/models` that differ from the HF rel path (e.g. stripped of the
`mlx-community/` prefix). The proxy needs to match either form.
Approach: at ModelHost startup, `probeReady` fetches `/v1/models`,
records the actual IDs returned by oMLX, and the proxy registers
**both** `hostedModels[i].rel` AND each returned ID as routable
aliases. The body-peeked `model` field matches either.

`listOpenAIModels()` is extended to return all ModelRun + ModelHost
models. ModelHost entries get `owned_by: 'llamactl-host'`; ModelRun
entries keep `owned_by: 'llamactl-agent'`.

The existing `LLAMA_CPP_PORT` env fallback remains as-is; it only
fires when no model matches in the body, same as today.

## 7. Matrix bench compatibility

The matrix bench specs (`packages/eval/specs/*.json`) get two
optional fields on `ModelSpec`:

- `engine?: 'llamacpp' | 'omlx'` (default `'llamacpp'` — every existing
  spec preserved).
- `mlx_model_dir?: string` (oMLX's `--model-dir`; absent for llama.cpp).

When `engine === 'omlx'`, `lifecycle.ts` dispatches to
`ENGINES.omlx.buildBootCommand(...)` instead of inline arg-building.
Probe also dispatches. Everything downstream — workload loop, scoring,
per-cell DB write — is engine-agnostic.

`gguf_path` field name is left as-is (made optional when `engine ===
'omlx'`). Renaming to `model_path` would touch every existing spec; not
worth it for one new engine. Clean up if/when a third engine arrives.

Pilot bench spec — `packages/eval/specs/mlx-pilot.json`:

```json
[
  {
    "name": "qwen3-8b-mlx-4bit",
    "engine": "omlx",
    "family": "qwen-3",
    "quant": "MLX-4bit",
    "size_params": "8B",
    "host": "127.0.0.1",
    "port": 8094,
    "binary": "/Volumes/WorkSSD/src/omlx/.venv/bin/omlx",
    "mlx_model_dir": "/Volumes/WorkSSD/ai-models/llama.cpp/models",
    "managed": true,
    "extra_args": ["--max-concurrent-requests", "1"],
    "start_args": []
  }
]
```

## 8. Testing strategy

### 8.1 Unit (heavy) — `packages/core/test/engines/`

- `omlx.test.ts`: `validateSpec` happy path + 4 error paths (missing
  binary, missing port, length-0 hostedModels, unknown engine name);
  `buildBootCommand` snapshot against a fixture spec; `probeReady`
  against a stub HTTP server returning expected + unexpected payloads.
- `llamacpp.test.ts`: identical-shape tests for the rehoused llama.cpp
  adapter. Guards that wrapping the existing logic in `EngineAdapter`
  didn't change observable behavior.
- Schema tests: zod parse of valid + 6 invalid ModelHost yamls (wrong
  engine string, missing endpoint.port, `target` field present,
  `workers` field present, hostedModels length 0, hostedModels length 2).

### 8.2 Integration (light, fast) — `packages/remote/test/workload/`

- `modelhost.test.ts`: `applyManifest` of a ModelHost yaml dispatches
  to the omlx engine path and produces the expected boot command
  (mocked `spawn`). Verifies kind-discriminator dispatch.
- `listLocalRoutes()` returns ModelHost models in the same route
  table as ModelRun models.

### 8.3 Live smoke (manual) — `tools/smoke-modelhost-omlx.sh`

Apply the pilot yaml, wait for `/v1/models` to show
`Qwen3-8B-MLX-4bit`, send `/v1/chat/completions` with
`model: "Qwen3-8B-MLX-4bit"`, assert reply parses. Tear down at end.
Not a CI test — runs once at PR review time on M4 Pro.

### 8.4 Out of scope for Sub A tests

- Multi-model routing (Sub B).
- Mac-mini smoke (Sub C).
- Adapter loading (Sub D).
- SSD KV cache validation under load (Sub B once multiple models
  actually compete for cache space).

## 9. Migration and back-compat

- Every existing `ModelRun` yaml stays valid and behaves identically.
  The `engine` field lives on `ModelHost`, not `ModelRun`.
- The rehoused `llamacpp.ts` adapter is invoked transparently from the
  existing apply path. ModelRun manifests do not gain an `engine` field.
- Existing matrix bench specs unaffected — `engine?` defaults to
  `'llamacpp'`.
- Live workloads (`granite41-3b-long-lived-local`,
  `granite41-3b-judge-mac-mini`, etc.) keep running across the slice
  with zero touchpoint.
- AGENTS.md addition: short MLX section under "Model selection
  preferences" — when to reach for MLX (Apple Silicon-native,
  agent-prefix-stable workloads benefit from SSD KV cache;
  classification still favors llama.cpp Q8-small until re-benched).
- Rollback: `llamactl disable mlx-host-local` + leave the source clone
  in place. ModelHost manifest can be deleted. No catalog schema
  migration — MLX entries are additive new rows.

## 10. Open questions deferred to Subs B / C / D

- **Multi-model hosting (B)**: how `hostedModels` length > 1 interacts
  with `expectedMemoryGiB` admission. Per-process admission may need a
  live-RSS probe via oMLX admin endpoints.
- **REST hot-load / unload (B)**: oMLX has `/admin` and per-model TTL.
  We expose `llamactl host load / unload / pin` as CLI verbs POSTing
  to those endpoints. Auth via `--api-key` if we ever leave localhost.
- **Mac-mini (C)**: source build needs a separate atomic-fork-style
  binary at `/Volumes/AI-DATA/src/omlx/.venv/bin/omlx`. mDNS
  advertisement + RAM-admission tuning are mac-mini-specific.
- **Train-loop adapter (D)**: oMLX adapter loading is the unknown.
  Worst case we serve base via oMLX and apply adapter via
  `mlx_lm.generate` sidecar; best case oMLX has a
  `/admin/models/{id}/adapter` endpoint we can target.
- **vllm-mlx as second engine**: if a workload genuinely needs
  per-process-per-model with vLLM-style continuous batching, vllm-mlx
  slots in as a third entry in `ENGINES`. Out of scope until a
  concrete need.

## 11. File touch list (informational, not the plan)

- `packages/core/src/engines/{types,llamacpp,omlx,index}.ts` — new.
- `packages/core/src/pull.ts` — MLX detection branch.
- `packages/core/src/catalog.ts` / `catalogWriter.ts` — `format` column.
- `packages/core/src/openaiProxy.ts` — cross-kind route table.
- `packages/core/src/workloadRuntime.ts` — list ModelHost runs.
- `packages/remote/src/workload/modelhost-schema.ts` — new.
- `packages/remote/src/workload/apply.ts` — kind dispatch.
- `packages/eval/src/matrix/lifecycle.ts` — engine dispatch.
- `packages/eval/src/matrix/types.ts` — `engine?`, `mlx_model_dir?`.
- `templates/workloads/mlx-host-local.yaml` — pilot.
- `packages/eval/specs/mlx-pilot.json` — bench pilot.
- `tools/install-omlx-from-source.sh` — bootstrap.
- `tools/omlx.lock` — pinned commit + date.
- `tools/smoke-modelhost-omlx.sh` — manual smoke.
- `AGENTS.md` — MLX section under model selection preferences.

Test files: `packages/core/test/engines/{omlx,llamacpp}.test.ts`,
`packages/remote/test/workload/modelhost.test.ts`, plus zod-parse
fixtures.
