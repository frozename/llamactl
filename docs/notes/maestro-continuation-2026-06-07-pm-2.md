# Maestro continuation prompt — 2026-06-07 pm (part 2)

> Paste this whole block into the next session. Supersedes the hook-generated `-pm.md` (which predates the L4 build/breakthrough). Big session: b shipped, Gemma QAT swap done, DFlash myth-busted, L4 (oMLX KV save-by-handle) built + PROVEN + landed.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

Follow `AGENTS.md`. Penumbra MCP for chain state. Neutral repo text (no AI attribution). Delegate via `chain_start`; hand-code for correctness-critical / live-debug work (this session did a lot of the latter).

## State at handoff (verified)

- local `main` is **ahead of origin** at `63af768` (L4 proxy P5-6 landed; `4576456`/`acd3eed` = fix-b). NOT pushed.
- oMLX fork `/Volumes/WorkSSD/src/omlx` on branch **`dev` @ `0a9565cd`** (L4 oMLX P1-4 ff-merged to dev). NOT pushed.
- **Coder 80B (`mlx-qwen3-coder-next-local`, qwen3_next) serving `:8086`** (restored). granite judge `:8083`. proxy `:7944`. controller/node-agent/fleet-supervisor up.
- L4 is **dark by default** (gates `OMLX_SAVE_HANDLE_ENABLED` + `LLAMACTL_OMLX_KV_SAVE_ENABLED` both off) → running services unaffected; they load L4 (gated off) on next restart.

## Shipped / done this session

- **(b)** supervisor pid/route self-heal — `main@4576456`, deployed + live-verified. Adversarial review caught a deployment-fatal `lsof`-PATH bug pre-land.
- **(c/swap)** Promoted **oMLX `gemma-4-26B-A4B-it-qat-mxfp4`** as the canonical maestro Gemma — beats our llama.cpp UD-Q4_K_M on quality+speed+latency (matrix) AND 34/36 on the maestro bench. Workload `gemma4-26ba4b-qat-mxfp4-local.yaml`.
- **(d)** Gemma QAT + DFlash: **DFlash busted on M4 Pro (1.17×, not 3-4×)**; the QAT win above is the real payoff.
- **(a)/L4** oMLX KV **save-by-handle BUILT + PROVEN + LANDED** (both repos, dark). Live proof `SAVE 200, n_saved=2048`. The long-standing "oMLX save never works" fix = the **`--hot-cache-max-size`** flag (`hot_cache_max_size=0` disabled the in-memory hot cache the slot serialize reads). The "spec.env strip" was a reconciler RACE, not a code bug (`saveModelHost` preserves env — verified). gemma maestro workload now configured L4-ready (hot-cache + slot path + server gate, still disabled).

## NEXT FOCUS (user-directed)

1. **QAT + MTP on llama.cpp** with the user-provided **`google/gemma-4-31B-it-qat-q4_0-unquantized-assistant`** (the MTP *assistant/draft* for QAT gemma-4-31B). Serve QAT gemma-4-31B on the **atomic-fork llama.cpp** (`/Volumes/WorkSSD/src/llama.cpp-atomic/build/bin/llama-server`) with the assistant as the MTP draft; bench tps + quality vs QAT-plain. **QAT+MTP is untested** (prior MTP/DFlash findings were PTQ). See `[[idea-qat-gemma-mtp-2026-06-07]]`.
2. **Evaluate MoQ (Mixture of Quants)** — mixed-precision per-layer quants, e.g. `mlx-community/gemma-4-26B-A4B-it-OptiQ-4bit` (KL-sensitivity per-layer bits) and llama.cpp **UD** quants; compare vs the qat-mxfp4 winner. Harness: `packages/eval` matrix (spec `packages/eval/specs/gemma4-26ba4b-qat-cmp-2026-06-06.json`) + `dflash benchmark`.

## Open / optional (L4)

- L4 is shipped but **inert**. To ACTIVATE: (1) enable `gemma4-26ba4b-qat-mxfp4-local` (evict coder — budget); (2) `LLAMACTL_OMLX_KV_SAVE_ENABLED=1` on the proxy plist + restart; (3) 2 identical temp:0 chats **>1024 tokens** → cold save then restore. Recipe in `[[l4-shipped-2026-06-07]]`.
- L4 fast-follows (in commits): crash-loop backoff; don't-stamp-desired-specHash-on-adopt (fix-b #4/#7).

## First moves

1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -3 && git -C /Volumes/WorkSSD/src/omlx log --oneline -3` (confirm `63af768` / `0a9565cd`).
2. `mcp__penumbra__handoff_list_pending` → confirm clean; `launchctl list | grep llamactl`; `curl -s :8086/v1/models`.
3. QAT+MTP: locate/download `google/gemma-4-31B-it-qat-q4_0-unquantized-assistant`; find/convert the QAT gemma-4-31B GGUF; wire atomic-fork llama.cpp MTP draft args; bench.
4. MoQ: pick scope with the user (which mixed-precision quants to pull).

## Key memories

`[[l4-shipped-2026-06-07]]` · `[[l4-works-hot-cache-fix-2026-06-07]]` · `[[idea-qat-gemma-mtp-2026-06-07]]` · `[[gemma-qat-mxfp4-beats-llamacpp-2026-06-06]]` · `[[maestro-confirm-qat-mxfp4-34of36-2026-06-06]]` · `[[dflash-bench-m4pro-1.17x-2026-06-06]]` · `[[modelhost-deadpid-route-drop-fixed-2026-06-06]]`
