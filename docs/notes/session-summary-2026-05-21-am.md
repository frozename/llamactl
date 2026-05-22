# Session summary — 2026-05-21 am

Project: `llamactl`. Session started: `2026-05-20T04:38:48.680Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).



## Commits this session

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
afed27a docs(notes): maestro continuation 2026-05-20 pm — MLX patch v3 + back-pressure plan
97eb65e docs(upstream-patches): MLX patch v3 + back-pressure plan artifacts
ed25eca docs(upstream-patches): MLX patch v2 — addresses adversarial-review HIGH findings
95b22c0 docs(upstream-patches): MLX exception-safe completion handler patch for review
de88c19 fix(remote/modelhost): allowlist AGX_RELAX_CDM_CTXSTORE_TIMEOUT for MLX issue #2670
5371cde chore: tidy up multi-doc fleet yamls (already split into single-doc files in 59c732e)
d3e6acd eval(matrix): Fleet A with --max-concurrent-requests=8 — net negative
5be7dbb eval(matrix): Fleet C v3 — dual-8B failure is fundamental, not config
93876e0 eval(matrix): add --paged-ssd-cache-dir to dual-8B stress fleets
fad961d eval(matrix): mac-mini stress-test sweep — Fleet B wins, dual-8B fleets fail
a00dd79 fix(eval/matrix): stress-fleet.sh uses per-workload sqlite dbs to avoid lock contention
59c732e eval(matrix): split stress-fleet multi-doc yamls — llamactl apply parses single-doc only
0f6e771 feat(eval/matrix): --concurrency flag + mac-mini fleet stress harness
85ad284 eval(matrix): Phase 1 results — penumbra workload fitting bench
f2240d1 eval(matrix): Phase 1 penumbra-workload-fitting bench spec — 4 MLX × 3 workloads
12c4cd8 workload: mlx-granite-3b-judge-mac-mini — MLX-4bit production judge candidate
dbcdf08 eval(matrix): A/B bench — constrained vs unconstrained decoding refutes regression risk
1ee8f05 eval(matrix): A/B spec — constrained vs unconstrained decoding on mac-mini
2a236a9 fix(eval/matrix): harden constrained decoding — pinned xgrammar, capability gate, typed ResponseFormat, schema strictness
505cc8d fix(eval/matrix): JSON-schema constrained decoding for classifier workloads + xgrammar install
0ca6640 eval(matrix): mac-mini Granite 3B sweep partial — MLX path corrupts label mid-decode
dd47e24 eval(matrix): mac-mini Granite 3B full quant sweep — 9 models × 3 workloads
e01c6f0 eval(matrix): mac-mini judge swap validation — 3B-Q8 and 8B-MLX-nvfp4 tied on production workload
df7421e eval(matrix): mac-mini judge swap validation spec — Q8 vs 8B-MLX-nvfp4
ed39690 eval(matrix): mac-mini Granite 4.1 3B bench — Q8 GGUF wins, nvfp4 collapses
4701231 eval(matrix): mac-mini Granite 4.1 3B head-to-head bench spec
a55f7eb eval(matrix): mac-mini MLX fleet bench — first cross-node bench result
50727d6 eval(matrix): add mac-mini MLX fleet spec — Qwen3-8B / Gemma-4-E2B / Granite-4.1-8B
c7529da fix(remote/workload): ship ModelHost manifest inline in modelHostStart RPC
60b7217 fix(remote/client): bridge inproc tRPC v11 subscriptions to handler callbacks
df72b74 fix(remote/workload): skip CLI-side fs validation for cross-node ModelHost apply
```

## Dispatch events


- 2026-05-20T04:41:23.214Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:23.626Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:24.013Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:24.428Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:28.960Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:29.172Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:29.381Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:29.591Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:29.798Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:30.012Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:30.082Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:36.871Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:37.060Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:37.276Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:37.493Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:37.697Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:37.909Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:37.956Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:44.953Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:45.144Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:45.427Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:45.569Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:45.759Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:49.052Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:49.355Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:49.473Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:49.682Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:49.894Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:50.104Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:50.153Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:56.623Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:56.839Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:57.059Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:57.268Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:41:57.367Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:04.237Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:04.456Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:04.720Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:04.883Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:05.059Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:06.082Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:06.158Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:11.431Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:11.651Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:11.865Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:11.887Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:17.365Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:17.423Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:21.333Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:21.434Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:23.848Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:23.910Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:27.754Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:27.800Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:31.351Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:31.451Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:34.970Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:35.181Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:35.395Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:35.606Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:35.759Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:39.071Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:39.224Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:39.427Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:39.531Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:44.952Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:45.161Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:45.388Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:45.601Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:45.811Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:45.864Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:47.940Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:48.053Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:53.290Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:53.557Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:53.733Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:53.936Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:54.008Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:57.761Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:57.982Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:58.193Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:58.403Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`

- 2026-05-20T04:42:58.612Z `agent.thought` handoff `192eedf8-6489-4419-a53a-44d59e6c301b`


## Pending follow-ups



## Diff against main

```

```
