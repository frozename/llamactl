# federation-tools-listTools-failed — root cause analysis 2026-05-17

## TL;DR

`penumbra@2823c11 fix(daemon/long-lived): bounded grace wait for federation cold start` does NOT silence the `federation-tools-listTools-failed` warns. The fix targets a cold-start *race*; the actual failure mode is a *no-state-at-all* condition that the fix's guard treats as a no-op. Warns continue every 3 min for `home-mgmt`, `task-refiner-primary`, and `task-refiner-escalation` after the 2026-05-17 02:40 UTC daemon restart that picked up 2823c11.

## Evidence

Daemon log slice after the 02:40:35 restart that installed the fix:

```
02:45:00.416Z agent_id="task-refiner-primary"      err="mcp_unavailable" server="penumbra"
02:45:01.119Z agent_id="task-refiner-escalation"   err="mcp_unavailable" server="penumbra"
02:50:00.598Z agent_id="home-mgmt"                 err="mcp_unavailable" server="penumbra"
…through 03:09 — every cron boundary fires the same warn for the same three agents.
```

## What the fix does

`packages/daemon/src/routes/long-lived-federation-tools.ts:waitForFederationReady`:

```ts
async function waitForFederationReady(pool: MaybeReadyMcpPool, server: string): Promise<void> {
  const state = pool._state?.(server);
  if (!state || state.initialized || !state.initPromise) return;   // <-- bails if state is undefined
  await Promise.race([state.initPromise, delay(pool._readyWaitMs ?? FEDERATION_READY_WAIT_MS)]);
}
```

If `pool._state(server)` returns `undefined`, the helper returns immediately. The caller then invokes `mcpPool.listTools(server)`:

```ts
// packages/daemon/src/long-lived/mcp-pool.ts:338
async listTools(serverName: string): Promise<McpToolDescriptor[]> {
  const state = states.get(serverName);
  if (!state) throw new Error('mcp_unavailable');     // <-- this fires
  await ensureStateRunning(state.spec);
  return [...(states.get(serverName)?.tools ?? [])];
}
```

→ `mcp_unavailable` is thrown, caught by the federation-tools route, and logged at warn level. Cron loop repeats forever.

## Why state is undefined for `penumbra`

`mcpPool.ensureRunning(spec)` is only called from `packages/daemon/src/reactors/long-lived-reactor.ts:160`, once per `agent.long_lived_config.hosted_mcp_servers` entry per agent.

`home-mgmt`'s stanza in `~/.config/agentchat/agentchat.yaml`:

```yaml
long_lived_config:
  hosted_mcp_servers:
    - name: ha          # only the Home Assistant MCP is hosted/pooled
```

`task-refiner-{primary,escalation}` similarly register only their externals (or nothing). None of them list `penumbra` under `hosted_mcp_servers` — and that's correct, because the penumbra MCP is the daemon's own builtin server, not an external stdio MCP that needs pooling.

But the allowlist *does* reference `penumbra:*` tools (`penumbra:chain_start`, `penumbra:memory_search`, `penumbra:agent_recommend`, …). When the federation-tools route iterates the allowlist's server names, it hits `penumbra` and calls `pool.listTools("penumbra")` → no state → throw.

## Real fix candidates

In `long-lived-federation-tools.ts`, the route iterates `serverNames` and calls `pool.listTools(server)` blindly. Options:

1. **Special-case `penumbra`** in the route: when `server === "penumbra"`, return the builtin tool list from the daemon's own registry (wherever the in-process MCP server keeps its `ListToolsResult` — likely `services.toolRegistry` or similar). Skip the pool entirely for that name. This is the minimal-change fix and matches the implicit contract on line 168 of `long-lived-reactor.ts` that already treats `penumbra` as a non-pooled builtin.

2. **Filter `penumbra` out of `serverNames` upstream**: same effect but cleaner — the federation tools route is for *federated* (external) MCPs by design; the allowlist's `penumbra:*` entries should be matched against the builtin registry, not pooled at all.

3. **Register a fake "penumbra-self" pool spec at daemon startup**: register-once entry that wraps the daemon's own tool registry behind the pool API. Bigger surface, more general.

Recommend (2) — single-line filter in `long-lived-federation-tools.ts:longLivedFederationToolsRoute` and a join with the builtin tool list before `return json({ tools })`. Aligns with the existing line 168 logic that already separates penumbra from pool-managed servers.

## Open question

Why didn't this fire before? It did — the original continuation note that motivated 2823c11 quoted `:00/:15/:30/:45` warns for task-refiner. The continuation note's claim that 2823c11 "silenced the warns" was based on the immediate-post-restart cron boundary, but the next cycle (3 minutes later for home-mgmt; 15 min for task-refiner) re-fires. The fix was verified too narrowly.

## Action items

- [ ] Implement special-case in `long-lived-federation-tools.ts` (or equivalent allowlist-filter) in penumbra.
- [ ] Update tests: the existing `bounded-wait-still-unhealthy` test in 2823c11's diff covers the wrong scenario. Add a test for `state=undefined → builtin path` and `state=undefined → server-not-in-builtins → mcp_unavailable`.
- [ ] Once landed, monitor a full cron cycle (15 min for task-refiner, 10 for home-mgmt) before declaring fixed.
