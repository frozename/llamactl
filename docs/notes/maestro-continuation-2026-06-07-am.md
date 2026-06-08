
# Maestro continuation prompt — 2026-06-07 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories



- `t2:d36e9175-2937-4a65-a4ac-988dd3ae543d` — L4 Design A — executable plan (save-handle table, 2026-06-06): engine-touching 2-repo feature; needs 80B restart to veri
  

- `t2:e26d0465-b2ca-43ea-99d5-478ffce8a69c` — L4 verify-first 2026-06-06 (part 2): the note's recipe is BROKEN — injecting x_omlx_request_handle on a chat 409s (resto
  

- `t2:27f021be-d858-4418-ab41-18b10f25845a` — RESOLVED 2026-06-06: ModelHost dead-pid route-drop FIXED (4576456) — root cause was liveness-blind statusModelHost + no 
  

- `t2:6b616be5-6084-42c0-bf46-742c0e715d08` — L4 verify-first 2026-06-06: oMLX KV re-enable is necessary-but-NOT-sufficient — save fails slot_serialize_failed; do NOT
  

- `t2:9f2f544b-a6bd-41ac-933a-84cd7e594526` — Gemma 4 12B MLX-4bit (oMLX) beats llama.cpp Q4_K_M on quality (tool-calling 0.90 vs 0.72); needs mlx-vlm>=0.6.0
  

- `t2:567687fc-b05e-4334-a1af-2ecc97484399` — L4 oMLX-KV re-enable: design validated + live oMLX is v2-capable, but ripples into 5 routing tests — completion recipe
  

- `t2:bfc206d8-ddd2-4c6a-8f32-580cb302f1e4` — L5 verified 2026-06-06: title_plus_concise recall fix surfaced 18 previously-buried t2 (positive signal, small window)
  

- `t2:91b2f13e-62e1-44af-9a4c-495aadaf003a` — Gemma 4 12B workload bench 2026-06-06: 12B Q4_K_M wins recall + tool-calling vs 26B-A4B; QAT does NOT beat PTQ
  

- `t2:34400a96-bd35-422a-9dae-62c8b39653ff` — Session 2026-06-06: Gemma 4 12B bench running + user 80B (coder-next) DISABLED — must re-enable
  

- `t2:b88d73e8-dea0-42fa-825b-a722a26f353b` — FEATURE IDEA (deferred, 2026-06-01): llamactl embedder nodes — pool penumbra embedding across network nodes
  

- `t2:7cf7df26-8189-4378-8f02-41d179c0e952` — Brief: llamactl (de520aea)
  

- `t2:f2f54348-b448-4b6d-be34-8de088d09a70` — RESOLVED: dreaming stall fixed (fb296518 + PENUMBRA_DREAMING_ENABLED=1 + daemon restart 54354) — supersedes 5cef3f1f; t2
  

### Commits since midnight

```
4576456 fix(modelhost): harden dead-pid self-heal per adversarial review
acd3eed fix(modelhost): self-heal a ModelHost whose recorded pid died out-of-band
f7169b1 docs(notes): 2026-06-06 pm continuation (part 2) — mlx-vlm 0.6.2, MLX>llamacpp 12B, L4 verify-first verdict
d39ab9e docs(eval): Gemma 4 12B bench specs, results, and 2026-06-06 continuation note
eab693a fix(remote,mcp): count + list ModelHost workloads in nodeBudget and workloadList
```

### Commit context (bodies)


**`45764563ea3b865b93f425920ccfe108f53508ac`** — fix(modelhost): harden dead-pid self-heal per adversarial review

Follow-up to the prior commit, addressing review findings — the two blocking
ones are production-only and hit this exact deployment target:

- lsof PATH (blocking): macOS lsof lives only in /usr/sbin, which is NOT on the
  controller's launchd PATH — a bare 'lsof' would ENOENT there, silently
  disabling adoption in production and turning the fix into a spawn-fail loop.
  Resolve lsof by absolute path (/usr/sbin/lsof -> /usr/bin/lsof -> bare).
- lsof timeout (blocking): the listener lookup had no timeout; the reconcile
  host loop is serial, so a wedged lsof would hang the whole pass. Cap it at
  2s (kill the child) and honor the abort signal.
- adopt-vs-spawn on listener PRESENCE, not the readiness window: if a live
  process already owns the port, a spawn cannot bind it — so when the recorded
  pid is dead and a live listener exists but isn't yet confirmable as ours
  (still loading, or unrelated), DEFER to the next tick instead of spawning a
  doomed competitor. Only spawn when the port is genuinely free.
- constrain lsof to the exact bind address (-iTCP@host:port) so a 0.0.0.0/::1
  process on the same port isn't matched.
- empty modelIds now refuses adoption (cannot confirm ownership) instead of
  adopting blindly; re-check liveness immediately before writing state (TOCTOU).
- reconciler: sweep a disabled, non-running ModelHost's stale sidecar — with
  liveness-aware status it now short-circuits before the apply path that used
  to remove it, so the sidecar would otherwise leak.

Two non-blocking findings are left as fast-follows: crash-loop backoff for a
genuinely-broken host (port-free spawn that keeps failing), and not stamping the
desired specHash onto an adopted (possibly spec-drifted) process.

Adds regression tests: defer-not-spawn when a live listener holds the port;
disabled-host stale-sidecar sweep.



**`acd3eedd578e845ec6d60a7807fe4969a9b62b11`** — fix(modelhost): self-heal a ModelHost whose recorded pid died out-of-band

statusModelHost reported Running whenever the .state sidecar existed, never
checking process liveness. So when a ModelHost process was replaced
out-of-band (a manual restart, or a crash + external respawn) the recorded
pid went stale-dead, yet the reconciler kept treating the host as Running
(state==='Running' && hash match -> skip) and never re-acted. Meanwhile the
proxy's listLocalRoutes drops a ModelHost whose recorded pid is dead, so the
route silently vanished and could not self-heal.

- statusModelHost: a dead recorded pid now reports Stopped, so the reconciler
  re-acts on the host instead of trusting a stale pid forever. The two other
  consumers (workloadList / nodeBudget) use .state only for a display phase,
  so they just become more accurate; reserved-memory accounting keys off
  spec.enabled and is unchanged.
- startModelHost: when the recorded pid is dead but a live process is already
  serving the endpoint, ADOPT it (re-record the live listener pid via an
  injectable lsof lookup, gated on a readiness probe + model-id match) rather
  than spawn a competitor that would fail to bind the held port — which the
  post-probe guard would then refuse to record, leaving the route dropped.
  A clean crash (port free) still falls through to a normal spawn.

Adds three regression tests: dead-pid -> Stopped; adopt-not-spawn when a live
listener owns the endpoint; spawn-not-adopt when the port is free.



**`f7169b1b082b432cabb606460b5c2cd805911ca7`** — docs(notes): 2026-06-06 pm continuation (part 2) — mlx-vlm 0.6.2, MLX>llamacpp 12B, L4 verify-first verdict




**`d39ab9ed5b91a0bd137e9950376b84d11f5829b9`** — docs(eval): Gemma 4 12B bench specs, results, and 2026-06-06 continuation note

Specs: gemma4-12b-vs-family (llama.cpp Q4_K_M / QAT-Q4_0 vs 26B-A4B / E4B)
and gemma4-12b-engine-cmp (llama.cpp Q4_K_M vs MLX-4bit via oMLX).

Results: Q4_K_M wins the llama.cpp family bench (beats 26B-A4B on
memory-recall + tool-call); MLX-4bit (oMLX) beats Q4_K_M on quality
(tool-call 0.90 vs 0.72, recall 0.872 vs 0.849) at ~25% lower throughput.



**`eab693a29afd58bd0bf38c150459532fcb66c2bc`** — fix(remote,mcp): count + list ModelHost workloads in nodeBudget and workloadList

nodeBudget and workloadList read only ModelRun manifests
(workloadStore.listWorkloads), while admission charges ModelHosts
against the same node budget (listAnyWorkloadsForAdmission). So
reserved under-reported and every ModelHost was hidden from the
listing — the budget view silently disagreed with what apply enforces.

- router.nodeBudget: include ModelHost reservations via
  estimateModelHostMemoryGiB; tag each row with kind ModelRun|ModelHost.
- router.workloadList: append ModelHost rows (kind, rel, endpoint,
  phase via statusModelHost).
- mcp llamactl.workload.list: same inclusion in the tool's own impl.
- export modelHostStore from the remote barrel.
- add tests for both procedures.




### Diff against main

```

```

### Dispatch summaries this session



- `99abdaa8-360d-4a11-b215-a5c9fd923f56` → **claude-acp-sonnet** [failed] — failures: ["cancel.dispatched","cancel.received"]
  

- `c745845f-1672-4b7e-98a9-6419c18391b9` → **codex-acp-fast** [failed] — failures: ["cancel.dispatched","cancel.received"]
  

- `1a2f8388-63e9-46c8-a861-e87a71c94c29` → **home-mgmt** [failed] — failures: ["cancel.dispatched","cancel.received"]
  

- `e68502dc-b499-48d2-9c98-681f9660eb83` → **gemini-acp-pro** [failed] — failures: ["cancel.dispatched","cancel.received"]
  

### Pending handoffs



## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
