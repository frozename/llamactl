# Maestro continuation prompt — 2026-06-06 pm (part 2)

> Paste this whole block into the next session. Supersedes `maestro-continuation-2026-06-06-pm.md` (part 1 is landed at d39ab9e but predates the mlx-vlm upgrade + L4 verify-first).

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

Follow `AGENTS.md`. Penumbra MCP for chain state. Neutral repo text (no AI attribution). Delegate via `chain_start`; hand-code for correctness-critical changes or when the worker stalls (it did this session — see L4).

## State at handoff (verified)

- `main` == `origin/main` == `d39ab9e` (clean). Earlier this session main briefly held `7c64e8b` ("fix: re-enable omlx slot cache participation") — the fleet worker's landed output — but it's the **broken-as-is** L4 (see below); I reset main back to origin. `7c64e8b` is in reflog only.
- Branches: `fix/modelhost-visibility-in-budget-and-list` (`eab693a`) — LANDED (in d39ab9e history). `fix/omlx-kv-reenable` (`2c845f4`) — the L4 attempt, unit-green but **functionally broken, DO NOT land** (see L4).
- **mlx-vlm upgraded 0.5.0 → 0.6.2** in the oMLX venv (`/Volumes/WorkSSD/src/omlx/.venv`, uv-managed: `VIRTUAL_ENV=... uv pip install -U mlx-vlm --python <venv>/bin/python3`). Also bumped transformers 5.8.1→5.10.2 (+ starlette/uvicorn/tqdm/yarl). Rollback snapshot: `/tmp/omlx-venv-freeze-pre-mlxvlm-2026-06-06.txt`. The 80B (`qwen3_next`) verified working on the new stack.
- User's **80B `mlx-qwen3-coder-next-local`** serving on `:8086`. Proxy `com.llamactl.internal-proxy` on `:7944` (launchd, runs main code). granite-3b judge on `:8083`.

## Shipped this session (all on origin/main)

- **L6** (`eab693a`): nodeBudget + workloadList + MCP workload.list now count/list ModelHost workloads (kind discriminator). Fixes the visibility gap that hid the 45-GiB admission reality.
- **Gemma 4 12B — full eval** (specs+results committed in d39ab9e):
  - llama.cpp family: `Q4_K_M` wins (beats 26B-A4B on recall + tool-call); QAT-Q4_0 ≉ better than PTQ on Metal. (mem `91b2f13e`)
  - **Engine comparison: MLX-4bit (oMLX) > llama.cpp Q4_K_M on quality** — tool-call 0.90 vs 0.72, recall 0.872 vs 0.849; ~25-30% slower. Enabled by the mlx-vlm 0.6.2 upgrade. (mem `9f2f544b`)
- **L5** (verified, read-only): title_plus_concise recall fix surfaced 18 previously-buried t2; all-time never-retrieved still 63% (small window). (mem `bfc206d8`)

## Open work + findings

- **L4 — oMLX KV re-enable is NOT functional. DO NOT land `2c845f4`/`7c64e8b`.** Verify-first (live round-trip vs the v2-capable coder oMLX) proved the eligibility-flip approach engages (KV path + capability gate + epoch all work) but the oMLX **save fails HTTP 500 `slot_serialize_failed`** — cold request has no bound request_handle to serialize; v2 `/v1/slots/save` is 404 on this oMLX build (jundot/omlx HEAD 2026-05-27). REAL FIX = the **save-side request_handle protocol**: proxy must inject `x_omlx_request_handle` on the chat request (always, for oMLX) so the oMLX server tracks/binds the cache and can serialize it on save — currently the handle is injected only on RESTORE. Likely also needs the oMLX-side v2 save endpoint. Full detail: mem `6b616be5` (supersedes the simpler recipe `567687fc`).
- **Bug — supervisor leaves `modelhost.pid` stale on ModelHost relaunch.** The supervisor relaunched the coder oMLX (live pid 18772) but left `modelhost.pid`/`modelhost.state` recording the dead pid 31050 (at `/Volumes/WorkSSD/ai-models/local-ai/workloads/mlx-qwen3-coder-next-local/`). The `bc05a4f` "drop ModelHost on dead recorded pid" then correctly removes the route → **ModelHost routes silently vanish from the proxy after a supervisor relaunch.** I manually fixed both to 18772 (route's back). Supervisor relaunch path should rewrite the pid. (mem `6b616be5`)
- mlx-vlm 0.6.2: `mlx_vlm.speculative.drafters.gemma4_unified` still absent (non-fatal — 12B served as text-only LLM).
- Idea: promote MLX-4bit 12B to a production oMLX ModelHost workload (wins quality). Mind node budget (36 GiB; 80B reserves 28).

## First moves

1. `git status --short && git rev-parse --short HEAD origin/main && launchctl list | grep llamactl`
2. `mcp__penumbra__handoff_list_pending` → confirm clean.
3. `curl -s 127.0.0.1:8086/v1/models` (80B) + `/Volumes/WorkSSD/src/omlx/.venv/bin/python3 -c "import mlx_vlm;print(mlx_vlm.__version__)"` (expect 0.6.2).
4. Pick with the user: (a) L4 save-side request_handle protocol (the real fix; start from `2c845f4` + mem `6b616be5`); (b) supervisor `modelhost.pid`-refresh bug; (c) promote MLX-4bit 12B workload.

## Memories
`9f2f544b` MLX engine cmp · `6b616be5` L4 verify + supervisor pid bug · `bfc206d8` L5 recall · `91b2f13e` llama family bench · `567687fc` L4 recipe (superseded) · `34400a96` session state.
