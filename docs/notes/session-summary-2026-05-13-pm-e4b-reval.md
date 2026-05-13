# Session summary — 2026-05-13 pm E4B re-eval

Project: `llamactl`. Session started: `2026-05-13T18:44:00Z`.

## Headline

Within-machine M4 Pro maestro bench:

| variant | pass rate | wall_s | decode tps | draft accept |
| --- | --- | --- | --- | --- |
| **E4B vanilla** (UD-Q4_K_XL) | **35/36 (0.972)** | 73.07 | 44.28 | n/a |
| E4B MTP (UD-Q4_K_XL + assistant.Q4_K_M head) | 22/36 (0.611) | ~260 | 28.61 | 0.785 |

MTP on E4B is a catastrophic regression on this task surface — the assistant head fails on every harder reasoning category while preserving the easy tool-use paths. Vanilla E4B is essentially as capable as the 26B (36/36) at competitive speed, in a much smaller footprint.

## What changed

- Downloaded the E4B assistant head into the production model store:
  - Path: `/Volumes/WorkSSD/ai-models/llama.cpp/models/gemma-4-E4B-it-assistant-GGUF/gemma-4-E4B-it-assistant.Q4_K_M.gguf`
  - SHA256: `6c93075cefa2902887afd7e341b32f3710fb3ecc13e3d7f31b272927cb30dacd`
  - Size: 78575008 bytes
- Two atomic-fork `llama-server` runs on M4 Pro local, same base model + same SWA/KV/cache-reuse args, differing only in MTP wiring:
  - `:18181` — MTP (`--mtp-head … --spec-type mtp --draft-block-size 3 --draft-max 8 --draft-min 0`)
  - `:18183` — vanilla (none of the above)
- Bench harness: `tools/maestro-bench/bench-maestro.py` with the v2 compacted maestro system prompt (committed in `c25ce40`).
- The previously-reported "vanilla control unreachable on /health" failure did not reproduce: the canonical vanilla arg set serves cleanly on the atomic-fork binary. The earlier worker's failure was their specific arg shape or probe timing, not an infra bug.

## Per-category comparison

```
category        MTP      vanilla   diff
arg_fidelity    3/3      3/3       —
edge            0/2      2/2       +2
handoff_mgmt    0/3      3/3       +3
memory          0/3      3/3       +3
multiturn       3/3      3/3       —
original        8/8      8/8       —
planning        0/2      2/2       +2
routing         5/5      5/5       —
safety          3/4      3/4       —  (same task fails in both)
workflow_plan   0/3      3/3       +3
TOTAL           22/36    35/36     +13
```

The 13 task-level deltas land entirely in five categories (edge, handoff_mgmt, memory, planning, workflow_plan); the other five categories are identical between runs. Hypothesis: the E4B assistant head's draft distribution diverges from the base on longer / more-tool-call paths, and the 78% accept rate is letting drafts through that the base would never have emitted. The 26B's head does not have this problem (36/36 with MTP). Not investigated further — the operational conclusion is sufficient.

## Operational conclusion

- **Do not use E4B MTP.** The 2026-05-08 verdict ("MTP gain too small to clear gate; no further E4B MTP work warranted") is sharpened: not only is MTP slower per-task than vanilla on M4 Pro, it actively destroys pass rate.
- **Vanilla E4B is a real maestro candidate.** 35/36 at 44 tps on a 5 GiB model with ~10 GiB total footprint means it can coexist with the 26B :8181 server on a 48 GiB box, or serve as the primary on memory-constrained nodes.
- A `templates/workloads/gemma4-e4b-vanilla-local.yaml` is added (disabled by default) at port 8182, so `llamactl apply` can stand it up alongside the 26B for fast-path workloads.

## Mac-mini follow-up

Ran `tools/eval/tune-gemma-e4b.sh` against vanilla llama.cpp (`/Volumes/AI-DATA/src/llama.cpp/build/bin/llama-server`) on mac-mini :18182. The script's hardcoded sweep is `ub=256` only (`ub=512` gated as "already done") so no new tuning knobs were tried this pass. Auto-generated leaderboard doc at `docs/superpowers/specs/2026-05-13-model-eval-gemma-4-E4B-it-UD-Q4_K_XL.md`.

| node | ub | tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| mac-mini | 256 | 28.65 | 7029 | **0.767** | 2026-05-13 |
| mac-mini | 256 | 28.64 | 7055 | 0.766 | 2026-05-06 (prior) |
| mac-mini | 512 | 27.74 | 7288 | 0.757 | 2026-05-06 |

Within measurement noise — agentic-eval composite is stable. Note: the maestro-bench harness on M4 Pro (35/36 vanilla = 0.972 pass-rate) and the agentic-eval composite (0.767) measure different things; the maestro-bench is the right gate for orchestrator-role suitability.

Production :8090 is currently the Granite 4.1 8B long-lived server (penumbra memory-refinement agent, task #2 subject). The `restart-gemma-e4b-server.sh` step at the end of the sweep brief was **not** run — replacing Granite with E4B on :8090 is a separate operational decision and depends on whether E4B vanilla becomes the new `local` agent or coexists. Deferred for explicit approval.

## Artifacts

- MTP bench JSON: `$DEV_STORAGE/bench/maestro-pilot/20260513T184659Z-gemma4-e4b-mtp-baseline.json`
- Vanilla bench JSON: `$DEV_STORAGE/bench/maestro-pilot/20260513T215507Z-gemma4-e4b-vanilla-control.json`
- All temporary :18181/:18183 servers torn down. Live :8181 (26B) and :8083 (Granite) untouched throughout.
