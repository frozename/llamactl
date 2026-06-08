
# Session summary — 2026-06-07 am

Project: `llamactl`. Session started: `2026-06-06T16:46:21.091Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).



- **L4 build progress 2026-06-07: Phase 1 DONE (omlx 9e2e56e4) + PLAN CORRECTION — coder is BatchedEngine not VLMBatchedEngi** — Building L4 [[l4-design-a-adversarial-plan-2026-06-06]]. Branches: omlx feat/save-handle (off dev@55792d95), llamactl feat/l4-omlx-kv-save-handle (off main@4576456). Both baselines clean.

PLAN CORRECTION (decision #2 — the plan + adversari
  

- **SWAP DONE 2026-06-07: gemma4-26ba4b-qat-mxfp4-local ModelHost created + validated (disabled by default) — canonical maes** — Acted on the confirmed Gemma swap [[maestro-confirm-qat-mxfp4-34of36-2026-06-06]] / [[gemma-qat-mxfp4-beats-llamacpp-2026-06-06]]. Created workload /Users/acordeiro/DevStorage/workloads/gemma4-26ba4b-qat-mxfp4-local.yaml: kind ModelHost, en
  

- **Maestro confirmation 2026-06-06: oMLX qat-mxfp4 = 34/36 on the maestro bench — Gemma swap CONFIRMED (llama.cpp re-baseli** — Confirmation of the qat-mxfp4 swap [[gemma-qat-mxfp4-beats-llamacpp-2026-06-06]]. Ran tools/maestro-bench/bench-maestro.py (36-task orchestrator suite) standalone, coder 80B disabled for the window.

RESULT: oMLX gemma-4-26B-A4B-it-qat-mxfp
  

- **QAT win 2026-06-06: oMLX gemma-4-26B-A4B-it-qat-mxfp4 BEATS our llama.cpp UD-Q4_K_M Gemma on quality+speed+latency — mae** — Eval-matrix quality+speed bench (packages/eval, workloads tool-call-grammar + memory-recall, M4 Pro, granite-3b judge :8083, coder 80B disabled for the window). Spec: packages/eval/specs/gemma4-26ba4b-qat-cmp-2026-06-06.json; results: packa
  

- **DFlash bench 2026-06-06: only ~1.17x decode on M4 Pro (NOT the 3-4x hype) — Gemma 4 26B-A4B QAT-4bit baseline 70 tps/14.** — First DFlash bench in our stack (dflash CLI `benchmark`, baseline MLX vs DFlash, smoke suite, 256 tok, repeat 2) on M4 Pro. Target mlx-community/gemma-4-26B-A4B-it-qat-4bit + draft z-lab/gemma-4-26B-A4B-it-DFlash (820MB). Coder 80B disabled
  

- **L4 Design A — adversarial plan (2026-06-06): 10-phase TDD, double env-gate dark-launch, 7 pre-coding decisions (mostly p** — Adversarial planning (5 lenses + synth) refined L4 Design A [[d36e9175]]. Full plan in workflow output (run wf_a3d2d1e5-b01). Key reconciliations + 10 phases:

CORE CALLS: (1) Carrier = reuse the EXACT prompt ids vlm.chat() already feeds ge
  

- **DIRECTION 2026-06-06: explore Gemma 4 family with QAT quant + DFlash spec-decode (already in our oMLX stack)** — User direction (from an r/oMLX thread): explore the Gemma 4 family more with QAT quantization + DFlash. Downloads authorized ("we can download any models"). This is a NEW eval/perf thread alongside the maestro model work; ties to our heavy 
  

- **L4 Design A — executable plan (save-handle table, 2026-06-06): engine-touching 2-repo feature; needs 80B restart to veri** — Chosen design for L4 oMLX KV save-side ("best long term"): a save-handle table. Supersedes the broken recipe (see [[e26d0465]]). Fully mapped; NOT yet implemented. Touches the oMLX inference engine hot path → verification needs a coder-oMLX
  

- **L4 verify-first 2026-06-06 (part 2): the note's recipe is BROKEN — injecting x_omlx_request_handle on a chat 409s (resto** — Live verify-first on the running coder oMLX (:8086, omlx fork dev@55792d95) for L4 (oMLX KV save-side). REFUTES the recipe in [[6b616be5]]/[[567687fc]] ("inject x_omlx_request_handle on every oMLX chat so the server binds the cache for save
  

- **RESOLVED 2026-06-06: ModelHost dead-pid route-drop FIXED (4576456) — root cause was liveness-blind statusModelHost + no ** — Fix for the "ModelHost route silently vanishes" bug (second finding in [[6b616be5]]) landed on main at 4576456 (+ acd3eed) and DEPLOYED (kickstart -k com.llamactl.node-agent + com.llamactl.controller). Verified live: coder oMLX :8086 still 
  

## Commits this session

```
4576456 fix(modelhost): harden dead-pid self-heal per adversarial review
acd3eed fix(modelhost): self-heal a ModelHost whose recorded pid died out-of-band
```

## Dispatch events



- 2026-06-06T16:51:58.105Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.105Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.105Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.105Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.105Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.105Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.105Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.105Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.112Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.112Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.112Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.112Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.112Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.112Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.112Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.112Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.124Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.124Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.124Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.124Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.124Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.124Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.124Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.124Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.145Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.145Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.145Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.145Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.145Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.145Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.145Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.145Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.156Z `cancel.received` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.156Z `cancel.dispatched` handoff `e68502dc-b499-48d2-9c98-681f9660eb83`
  

- 2026-06-06T16:51:58.156Z `cancel.received` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.156Z `cancel.dispatched` handoff `1a2f8388-63e9-46c8-a861-e87a71c94c29`
  

- 2026-06-06T16:51:58.156Z `cancel.received` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.156Z `cancel.dispatched` handoff `c745845f-1672-4b7e-98a9-6419c18391b9`
  

- 2026-06-06T16:51:58.156Z `cancel.received` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T16:51:58.156Z `cancel.dispatched` handoff `99abdaa8-360d-4a11-b215-a5c9fd923f56`
  

- 2026-06-06T17:23:39.006Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T17:53:27.124Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T18:23:48.491Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T18:54:41.016Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T19:24:50.863Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T19:54:49.024Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T20:25:34.142Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T20:55:42.109Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T21:25:55.810Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T21:56:04.674Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T22:26:35.782Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T22:57:09.909Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T23:28:39.496Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-06T23:49:32.958Z `extra_worker_wedge_evicted` handoff ``
  

- 2026-06-06T23:58:51.191Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T00:28:52.285Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T00:59:40.919Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T01:29:34.975Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T02:02:52.525Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T02:31:03.558Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T03:02:41.841Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T03:32:29.813Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T04:02:26.946Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T04:32:30.834Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T05:02:54.946Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T05:32:55.433Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T06:03:48.976Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T06:33:48.643Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T07:03:52.030Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T07:33:52.208Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T08:04:48.366Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T08:34:26.333Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T09:04:55.927Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T09:34:48.387Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T10:04:57.308Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T10:35:55.343Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T11:05:48.282Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

- 2026-06-07T11:36:13.730Z `reconciler.sweep.tick` handoff `reconciler.sweep`
  

## Pending follow-ups



## Diff against main

```

```
