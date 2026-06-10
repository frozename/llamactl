# Phase 10 — oMLX slot API audit (2026-05-24)

## Findings

1. **llamactl `ModelHost` control surface is lifecycle-only (start/status/stop), not cache-slot management.**  
   The tRPC surface exposes `modelHostStart`, `modelHostStatus`, and `modelHostStop` only ([packages/remote/src/router.ts:1195](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/remote/src/router.ts:1195), [packages/remote/src/router.ts:1223](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/remote/src/router.ts:1223)). No `/slots`, `/save`, `/restore`, or `/sessions` route is added by the ModelHost server wiring in this repo.

2. **ModelHost readiness is `GET /v1/models`; no slot/session probe is used.**  
   `startModelHost` waits on engine `probeReady` ([packages/remote/src/server/modelhost.ts:184](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/remote/src/server/modelhost.ts:184)), and the shared lifecycle probe polls `/v1/models` ([packages/core/src/engines/lifecycle.ts:42](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/engines/lifecycle.ts:42)). This confirms the current contract is model-serving readiness, not slot persistence capability.

3. **ModelHost launch config for oMLX is explicit about model serving, dflash, and cache knobs, but not external slot endpoints.**  
   The oMLX adapter builds `omlx serve --model-dir ... --host ... --port ...` (+ optional `--max-model-memory`, `--base-path`, and passthrough `extraArgs`) ([packages/core/src/engines/omlx.ts:166](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/engines/omlx.ts:166), [packages/core/src/engines/omlx.ts:183](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/engines/omlx.ts:183)).  
   Dflash is configured per-hosted-model via manifest schema and `model_settings.json` sidecar generation ([packages/remote/src/workload/modelhost-schema.ts:5](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/remote/src/workload/modelhost-schema.ts:5), [packages/core/src/engines/omlx.ts:130](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/engines/omlx.ts:130)). The Sub A shipped note also documents MTP as dflash/per-model settings on mainline oMLX, not a dedicated slot API ([docs/notes/maestro-continuation-2026-05-19-mlx-suba-shipped.md:49](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/docs/notes/maestro-continuation-2026-05-19-mlx-suba-shipped.md:49)).

4. **Best-effort oMLX source snapshot in-repo shows internal cache controls/stats, not a llama.cpp-style external slot save/restore HTTP API.**  
   Vendored reference files include cache settings and scheduler internals (SSD/hot cache, cache stats) ([docs/upstream-patches/reference/omlx/settings.py:257](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/docs/upstream-patches/reference/omlx/settings.py:257), [docs/upstream-patches/reference/omlx/settings.py:870](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/docs/upstream-patches/reference/omlx/settings.py:870), [docs/upstream-patches/reference/omlx/engine/batched.py:802](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/docs/upstream-patches/reference/omlx/engine/batched.py:802)). No in-repo oMLX HTTP router/server module exposing `/slots`/`/props`/`/restore` was found in the vendored snapshot.

5. **llama.cpp parity reference in current codebase is clear and slot-specific.**  
   The KV client used by Slice 2 calls `POST /slots/{slotId}?action=save|restore&filename=...` and probes `GET /props` ([packages/core/src/kvstore/upstreamSlots.ts:97](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/kvstore/upstreamSlots.ts:97), [packages/core/src/kvstore/upstreamSlots.ts:108](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/kvstore/upstreamSlots.ts:108)). Save/restore success depends on `n_saved`/`n_restored` response fields ([packages/core/src/kvstore/upstreamSlots.ts:47](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/kvstore/upstreamSlots.ts:47), [packages/core/src/kvstore/upstreamSlots.ts:79](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/kvstore/upstreamSlots.ts:79)).

6. **Current proxy behavior already treats ModelHost as KV-degraded.**  
   KV metadata extraction explicitly returns `null` unless route kind is `ModelRun` and engine is `llamacpp` ([packages/core/src/openaiProxy.ts:436](/Volumes/WorkSSD/repos/personal/llamactl-worktrees/a7f72c59-6ba0-45fa-9104-3c3dab7540e4/packages/core/src/openaiProxy.ts:436)). That means oMLX `ModelHost` requests skip KV slot lookup/save today.

## Three options

### A) If oMLX already has a native slot API, add a sibling slot client in llamactl

- Shape: add `OmlxSlotClient` as a sibling to `UpstreamSlotClient` under `packages/core/src/kvstore/upstreamSlots.ts` (or split file), selected by route engine in proxy KV path.
- Preconditions: confirm stable oMLX endpoints + payload contract equivalent to `save`, `restore`, `supports`.
- Estimated effort: **0.5-1.5 days** (mostly integration and tests) _if_ upstream API already exists and is stable.

### B) Add slot API to oMLX upstream (small PR/fork patch), then consume it

- Shape in engine: add explicit HTTP endpoints (or equivalent RPC) for slot save/restore and capability probe, wired to scheduler/cache state and file-backed export/import semantics.
- Likely touch points:
  - oMLX server/router layer (not present in this repo snapshot; would be in upstream tree).
  - cache/scheduler bridge (for deterministic export/import boundaries).
  - response schema aligned with llamactl expectations (`n_saved` / `n_restored`-like fields).
- Then add llamactl client wiring as in option A.
- Estimated effort: **3-6 days** total (upstream implementation + contract hardening + llamactl integration/tests).

### C) Keep oMLX as KV-degraded and make it explicit/observable

- Shape: preserve current behavior (ModelHost skips KV slot path), but document and surface capability state explicitly in operator UX/logging/metrics so cold-prefill behavior is intentional, not ambiguous.
- Trade-off: no warm-restore benefit for oMLX per-request; but avoids false assumptions and avoids coupling Slice 2 semantics to an unavailable upstream API.
- Estimated effort: **0.25-0.75 day** (docs + minor observability/UX follow-up).

## Recommendation

Recommend **Option C now**, with an explicit follow-up spike for **Option B**. Evidence in this worktree shows llama.cpp slot semantics are concrete and code-integrated, while oMLX in-repo references show internal cache controls but no exposed slot save/restore surface. Since the proxy already gates KV to `ModelRun`+`llamacpp`, making the KV-degraded status explicit is the lowest-risk near-term path and avoids pretending parity. If warm-restore for ModelHost is a priority, pursue an upstream oMLX API contract first, then implement Option A against that contract.

## Follow-up

1. File `Phase 10.1`: document and expose per-route KV capability (`slot_api: native|none`) in operator surfaces that display workload route metadata.
2. File `Phase 10.2`: add explicit debug log/metric when KV path is skipped due to `ModelHost`/non-llamacpp route.
3. File `Phase 10.3` (spike): audit live upstream oMLX server module (outside this repo snapshot) and draft a minimal slot API proposal (`save`, `restore`, capability probe, response schema, failure modes).
4. If Phase 10.3 confirms feasible API, file `Phase 10.4`: implement oMLX slot client in llamactl + focused integration tests.
