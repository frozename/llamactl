# Maestro continuation — 2026-05-25 night

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (§7) immediately in efficient order, batching independent calls in parallel — don't ask permission per item.** Only pause for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. The user authorized the checklist by handing it over.

---

## 1 — Where we ended

This session shipped six tracks A–F:

- **A1 — UX hygiene smoke**: source-verified persona fuzzy-match + audit-aware land + `recalled_memories[]` field; live-verified dispatch_land sha (returned the real `df92e454`, not the `f6f4269c` placeholder).
- **A2 — chain_start cross-repo 400**: not reproducible. Both TRIVIAL and STANDARD/implement_substantial with `project_id:"penumbra"` from llamactl cwd succeed. Was almost certainly transient cost-gate composite; window has rolled.
- **B — Phase 7 KV decision**: shipped `docs/benchmarks/2026-05-25-kv-warm-restore-phase7-final.md`. Decision **skip Phase 8** (cold/warm 26.5×→34.5×, false-hit 0/65). Phase 8 is dead; Phase 9 was already shipped at `559dc34`; Phase 10 done via the omlx slot v2 series.
- **C — packages/remote tsc cleanup**: landed `df92e454`. 72 → 0 errors. 1504 pass / 0 fail.
- **D — promote canary → prod**: oMLX gains-host renamed to `mlx-qwen36-35b-a3b-local`, slot v2 enabled (`--slot-save-path /Volumes/WorkSSD/cache/omlx-qwen36-35b-slots`), `mcr=1` per the oMLX hard guard. Live and verified through proxy.
- **E — penumbra → llamactl proxy routing**: `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:7944` in both the daemon plist and the launchctl global env. Source defaults in `judge-chat.ts` and `dreaming/cycle.ts` also synced to `:7944`. Daemon and worker restarted; round-trip judge → proxy → :8096 → Qwen confirmed.
- **F — mcr=1 architectural analysis**: shipped `docs/notes/omlx-mcr-gt-1-analysis-2026-05-25.md`. Guard is over-broad — load-bearing only for `ChunkedKVCache` (Llama-4). Paged-cache models (Qwen, Gemma) can run mcr>1 + slot v2 once per-request paged-block slicing lands. 4-phase plan; Phase 1 ≈ 50 LOC recovers the 4× concurrent capacity the promotion gave up.

## 2 — Commits pushed today

| repo | sha | message |
|---|---|---|
| llamactl | `df92e454` | fix(remote): clear longstanding TypeScript errors in test files |
| llamactl | `e3fcc11` | docs(benchmarks): Phase 7 KV decision — skip Phase 8 (bundles the workload rename + slot v2 promotion) |
| llamactl | `7d54087` | chore(workloads): finish gains-host → mlx-qwen36-35b-a3b-local rename (downstream supervisor refs + mcr>1 analysis note) |
| penumbra | `b5fd7ffb` | fix(core,daemon): default local-model URLs to llamactl proxy :7944 |

All pushed to `frozename/*` `main` with branch-protection bypass auto-applied.

## 3 — Live runtime state

| process | PID | role |
|---|---|---|
| `mlx-qwen36-35b-a3b-local` :8096 | 5240 | Qwen3.6-35B-A3B-4bit, oMLX v2.6b, slot v2, mcr=1, `--slot-save-path /Volumes/WorkSSD/cache/omlx-qwen36-35b-slots` |
| `granite41-3b-long-lived-local` :8083 | 72925 | llama-server granite-3b-Q8 (long-lived t2 worker, slot save dir present) |
| llamactl proxy :7944 | 65061 | exposes `granite-4.1-3b-…Q8_0.gguf` + `Qwen3.6-35B-A3B-4bit`, routes by model |
| penumbra daemon | 18177 | `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:7944`, model `Qwen3.6-35B-A3B-4bit` |
| penumbra worker | 21003 | inherits same URL via launchctl env |
| mac-mini canary :8197 | (remote, not touched today) | v2.6b, slot v2 enabled — leftover from prior session, no harm |

M4 canary on :8198 was killed at end of session. No other oMLX processes alive on M4.

## 4 — Open follow-ups

### A) penumbra → mac-mini cross-node routing gap

The llamactl proxy at :7944 calls `workloadRuntime.listLocalRoutes(resolved)` (`packages/core/src/workloadRuntime.ts:74-115`) which scans the local-node runtime dir only. Mac-mini-hosted workloads are not in the proxy's route map. Today this is moot — no penumbra production code calls mac-mini directly (only bench scripts at `packages/agentchat/scripts/bench-{grade,fleet}.ts` which were scoped out). If a future feature uses a mac-mini-hosted model, the proxy needs to learn about remote workloads — the cleanest path is to extend `listLocalRoutes` into `listClusterRoutes` and probe peer-node mDNS records. Tracked as a latent gap; no immediate action.

### B) oMLX mcr=1 + slot — Phase 1 (architecture-aware guard)

`docs/notes/omlx-mcr-gt-1-analysis-2026-05-25.md` has the spec. Phase 1 is ~50 LOC in `omlx/settings.py:1167` + `omlx/server.py:292` — replace the unconditional `mcr=1` reject with a `_model_uses_chunked_kv_cache(model_name)` check. Recovers the 4× concurrent capacity that the prod promotion gave up. Validate live at mcr=4 on `mlx-qwen36-35b-a3b-local` before merging. Phases 2-4 are larger (per-request paged-cache slicing in save/restore) and a separate slice.

### C) Phase 7 bench-label bug

`--frontiers N` produces ~6N real tokens (each `stableToken` is ~6 BPE tokens after tokenization). Doesn't affect cold/warm ratio because the same prompt is used for both legs, but the label is misleading and caused the 32k frontier to overflow granite41's 65k ctx during today's bench. Two fixes proposed in the decision doc: (a) post-tokenise via `/v1/tokenize`, iterate `stableToken` until n_tokens matches; (b) rename to `--frontiers-words` and document the multiplier.

### D) Stale workload manifests

While debugging the apply-admission double-count, found two duplicate manifests for the same workload at `/Users/acordeiro/DevStorage/workloads/`:
- `gains-host-35b-local.yaml` (enabled:false, moved to `/tmp/`)
- `gains-host-local.yaml` (enabled:true, name conflict, moved to `/tmp/`)
Both moved to `/tmp/disabled-*.bak` / `/tmp/orphan-*.bak`. Daemon's "two files describing the same workload" admission semantics double-counted the reservation. Worth filing as a llamactl issue — `listWorkloads()` should warn on duplicate `metadata.name` collisions.

### E) `llamactl delete workload` doesn't support ModelHost

CLI command `llamactl delete workload <name>` fails Zod validation when target is a ModelHost (only accepts `kind: ModelRun`). Worked around today by killing the process + moving the manifest aside. Worth fixing — should branch on `manifest.kind` and dispatch to the right delete path.

### F) Phase 8 SKIP doesn't retire the trigger criteria

Phase 7 decision says skip Phase 8 with the current bench data, but if the workload type changes (e.g., longer prompts, different model class), the trigger conditions may re-fire. The decision doc captures this; no action needed today.

## 5 — First moves

1. Parallel: `git status --short && git log --oneline origin/main -5` (llamactl) + `cd /Volumes/WorkSSD/repos/personal/penumbra && git log --oneline -3` + `cd /Volumes/WorkSSD/src/omlx && git log --oneline -2 && git branch --show-current` + `launchctl list | grep penumbra` + `mcp__penumbra__handoff_list_pending` + `mcp__penumbra__cost_quota_status`.
2. Live state probes: `curl -s http://127.0.0.1:8096/v1/slots/capabilities` (prod), `curl -s http://127.0.0.1:7944/v1/models` (proxy), `curl -s http://127.0.0.1:8083/health` (granite41 long-lived), `pgrep -fl "omlx serve" | head`.
3. Decide direction with the user. Likely pick-ups:
   - **(B Phase 1)** Cut `feat/slot-mcr-gt-1-paged-only` in oMLX, implement architecture-aware guard, validate live at mcr=4 on `mlx-qwen36-35b-a3b-local`. Recovers the throughput from this session's promotion.
   - **(A)** Cross-node proxy routing for mac-mini workloads (issue #4A above). Useful if mac-mini-hosted models come back into the loop.
   - **(D/E)** Llamactl daemon hygiene — duplicate-manifest warning + `delete workload` ModelHost support.
   - **(C)** Fix the bench-label off-by-6 in `packages/eval/src/matrix/workloads/kv-warm-bench.ts`.

## Conventions for this session

- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot.
- Use Penumbra MCP for state (`handoff_get`, `chain_wait`, `chain_get_response`); never query the live sqlite DB directly except for forensics.
- Search memory before non-trivial work — `mcp__penumbra__memory_search`.
- Repo text (commits, PR descriptions) is neutral; no AI-tool authorship attribution.
- For oMLX work, the production server is now `mlx-qwen36-35b-a3b-local` (replaced `gains-host-35b-local`). Slot v2 active at mcr=1. `--slot-save-path /Volumes/WorkSSD/cache/omlx-qwen36-35b-slots`.
- All penumbra local-model traffic flows through `http://127.0.0.1:7944` (the llamactl proxy). Source defaults aligned in `judge-chat.ts` and `dreaming/cycle.ts`. Daemon plist and launchctl global env both set.
- The `/v1/tokenize` endpoint on oMLX gives `{token_ids, n_tokens, applied_chat_template}` for `{model, messages}` or `{model, prompt}` — use this when crafting slot-save payloads.
