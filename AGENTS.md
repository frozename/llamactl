# AGENTS.md — llamactl

Agent instructions for any AI coding tool (Claude Code, Cursor,
Codex, Copilot) working in this repo. See `README.md` for the
user-facing overview.

## What this repo is

Local-first control plane for llama.cpp fleets. `kubectl`-style
verbs (apply / get / describe / delete) over `ModelRun` and `NodeRun`
manifests, plus imperative escape hatches, plus infra-deploy
(`kubeadm`-like agent install), plus an MCP surface and agentic
harnesses.

## Tech stack

- **Runtime**: Bun 1.3+. No node, no npm, no yarn, no pnpm.
- **TS**: 5.9+, NodeNext ESM, `.js` on import specifiers.
- **RPC**: tRPC v11 (shared router across Electron + agent HTTPS +
  in-proc `createCaller`). React Query v5.
- **Validation**: Zod 4.3+.
- **UI**: Electron + electron-trpc 1.0.0-alpha, React 19, Vite 7.
- **MCP SDK**: 1.29.0.
- **WebSocket**: Bun native (for the reverse tunnel in I.3).
- **Cross-repo dep**: `@nova/contracts`, `@nova/mcp-shared`, `@nova/mcp`
  via `file:../../../nova/packages/*`.

## Layout (what lives where)

```
packages/
├── core/       tRPC-adapter-free business logic. No HTTP, no tRPC
│               imports, no electron imports. Pure functions over
│               ResolvedEnv + process spawns.
├── cli/        Bun CLI entrypoint (`bin.ts`). Commands under
│               src/commands/. Every verb routes through
│               dispatcher.ts (local → createCaller, remote → NodeClient).
├── remote/     tRPC router + agent HTTPS mount + kubeconfig +
│               workload reconcilers + infra + tunnel. Shared by
│               cli + app + the agent.
├── app/        Electron. electron-trpc IPC; reads @llamactl/remote
│               for the router; renders with React 19. Ships the
│               Operator Console (N.4) which plans *and* executes
│               MCP tools with tiered approval cards, the N.4.5
│               Planner chat, A/B compare chat (K.2), Cost dashboard
│               (N.3.7), and the Pipelines builder + "Save as MCP
│               tool" exporter (K.6).
├── mcp/        @llamactl/mcp. Projects tRPC procedures as MCP tools.
│               18 native tools today across read + mutation (dry-run
│               + wet) tiers: catalog, node, bench (compare + history),
│               server, workload, promotions, env, cost.snapshot,
│               embersynth, operator.plan (multi-turn history, stub +
│               LLM modes). M.1 also auto-registers any
│               `~/.llamactl/mcp/pipelines/*.json` stub as
│               `llamactl.pipeline.<slug>` (emitted by the app's
│               Pipelines module via `pipelineExportMcp`).
└── agents/     Runbooks + self-healing loop + cost guardian + N.5
                demos. Multi-MCP harness boots @llamactl/mcp +
                @nova/mcp in-proc and routes by tool-name prefix.
                `demos/` holds four scripted narrated runs:
                demo-audit, demo-onboard, demo-failover, demo-cost-clamp.
```

**Hard rule**: `packages/core` stays adapter-free. If you need a new
feature, write the pure logic in core, then expose it through the
tRPC router in remote, then project through MCP in `packages/mcp` if
it's an operator surface.

## Commands

```bash
bun install
bun test                      # per-package bun:test suites
bun run typecheck             # core + cli; also run remote + app per-package
bun run --cwd packages/remote tsc --noEmit
bun run --cwd packages/app tsc --noEmit

bun packages/cli/src/bin.ts <verb> --help
zsh test/run-all.zsh          # full sweep with shell smoke tests

# Electron dev
cd packages/app && bun run dev
```

Never skip hooks. If a pre-commit hook fails, investigate — don't
`--no-verify`.

## Code style

- **No comments explaining WHAT.** The name says it. Comments are
  for WHY — workarounds, constraints, subtle invariants.
- **Short module headers** are fine and encouraged on non-obvious
  files.
- **No backwards-compat shims** when removing things. Delete
  entirely — the consumer is the same repo.
- **No new error-handling for things that can't happen**. Trust
  framework guarantees; validate at boundaries (CLI args, HTTP,
  manifest files), not in internal code.
- **Don't design for hypothetical future requirements.** Three
  similar lines beat a premature abstraction.

### Zod 4

- `z.record(z.string(), z.unknown())` — NOT `z.record(z.unknown())`.
- `z.object({...}).partial()` for forward-compat shapes; strict
  `z.record(EnumSchema, X)` forces all keys present (usually wrong).
- `z.discriminatedUnion` with explicit `z.literal` discriminators.

### tRPC v11

- `createTRPCClient` (not `createTRPCProxyClient` — that was v10).
- Subscriptions over SSE via `unstable_httpSubscriptionLink` +
  `splitLink` keyed on `op.type === 'subscription'`.
- `electron-trpc 1.0.0-alpha` — `exposeElectronTRPC` in preload,
  `ipcLink` in renderer.
- Bun lacks `EventSource` globally — subscribe paths need the
  `eventsource` ponyfill (`4.1.0`) with `{ withCredentials: false }`.

### Dispatcher pattern

Every CLI command that targets a node routes through
`packages/cli/src/dispatcher.ts`:

```ts
await runOp(nodeId, 'catalog.list', {});
await subscribeRemote(nodeId, 'pullFile', input, onEvent);
```

`local` is an in-proc `createCaller` shortcut; remote uses an HTTPS
`NodeClient` with pinned TLS + bearer auth.

**Never** bypass the dispatcher by importing `@llamactl/core`
directly from a CLI command. It breaks `--node gpu1` fan-out and
the `all` target.

## Workloads

- `ModelRun` — a model on a node with args. `apply`-able.
- `NodeRun` — desired infra stack on an agent (llama.cpp build
  pinned to a commit, optional sidecars).
- Gateway handlers (`packages/remote/src/workload/gateway-handlers/`)
  route `spec.gateway: true` by provider kind. Agent-gateway is a
  sentinel that falls through to regular `serverStart`; sirius +
  embersynth handlers each POST their respective `/reload` endpoint
  after confirming llamactl-side YAML state is coherent. Response
  translation: 2xx → Running, non-2xx → Failed with
  `*ReloadFailed`, upstream absent → Pending with an actionable
  reason. See handler JSDoc for the wire contract.

## Ops Chat dispatch (N.4)

`packages/remote/src/ops-chat/` maps 16 llamactl.* MCP tools onto
the matching tRPC procedures. The Operator Console renderer calls
`trpc.operatorRunTool({name, arguments, dryRun})` and the server
routes via `createCaller` — no secondary MCP server boot, no
duplicate surface. Adding a new MCP tool without wiring a dispatch
handler fails the
`packages/mcp/test/smoke.test.ts:ops-chat-coverage` assertion. Every
call (dry + wet, success + failure) appends one line to
`~/.llamactl/ops-chat/audit.jsonl`.

## Self-healing loop (`llamactl heal`, N.2)

Base usage:

```bash
llamactl heal [--interval <seconds>] [--once] [--quiet] [--journal <path>]
```

Observes fleet health on an interval (default 30s), journals every
tick + every healthy↔unhealthy transition, and — as of N.2 —
plans + optionally executes remediation.

N.2 flags:

- `--use-facade` / `--no-use-facade` (default on) — health signal
  source. On: call `nova.ops.healthcheck` through an in-proc MCP
  client (same pattern runbooks use). Off: raw HTTP probes against
  gateway + provider baseUrls. Facade is the canonical path; the
  raw probe is retained as a fallback when nova-mcp can't boot, and
  fires automatically for the current tick if a facade call rejects
  or returns `isError`.
- `--auto` — enable auto-execution of remediation plans. Default is
  propose-only: on a healthy→unhealthy flip the loop asks
  `nova.operator.plan` for a remediation plan and appends a
  `proposal` entry to the journal. An operator applies it later via
  `--execute`.
- `--severity-threshold <1|2|3>` — max tier allowed in `--auto`
  mode (default 2). Tier 1 is read-only, tier 2 is mutation-safe,
  tier 3 is destructive. **Tier 3 is always refused regardless of
  threshold** — destructive remediation requires manual approval.
  Plans with `requiresConfirmation: true` are also refused.
- `--execute <proposal-id>` — one-shot: look up a previously
  journaled proposal by id, execute its plan through the N.1
  runbook harness, journal an `executed` entry, exit. Does not
  start a loop.

Remediation behavior: on a healthy→unhealthy transition the loop
calls `nova.operator.plan({goal})`, journals a `proposal` with a
content-hash id, and in `--auto` mode passes the plan through the
severity gate. If the gate allows, steps execute sequentially via
`runRunbook` (for known runbook names) or the raw in-proc tool
client (for raw MCP tool names), stopping at first failure. Every
outcome — proposal, refused, plan-failed, executed, step failure —
is journaled.

The journal at `~/.llamactl/healer/journal.jsonl` (override with
`--journal` or `LLAMACTL_HEALER_JOURNAL`) is the audit trail. Keep
it rotated; the loop appends, never truncates.

## Testing

- `bun:test` everywhere.
- Use `makeTempRuntime` + `envForTemp` in
  `packages/core/test/helpers.ts` for any test that writes state
  under `$DEV_STORAGE`.
- Multi-node integration tests use `makeCluster({ nodes: N })` in
  `packages/remote/test/helpers.ts` — real Bun agents on random
  127.0.0.1 ports.
- Fake `llama-server` binary pattern (see
  `packages/core/test/server.test.ts`): a shell script on `$PATH`
  that mimics just enough of the real binary's behaviour. Reuse
  that; don't mock `Bun.spawn`.
- Use `InMemoryTransport.createLinkedPair()` for MCP smoke tests.
  No subprocess needed.

## Cross-repo discipline

**After a non-trivial slice, verify four repos still green:**

```bash
# llamactl
bun test

# nova
(cd ../nova && bun test)

# sirius-gateway
(cd ../sirius-gateway && bun test)

# embersynth
(cd ../embersynth && bun test)
```

If the slice touched `@nova/*`, also run `bun install` in every
consumer before their test run.

Test counts we expect as a baseline (bump as features ship):

- nova ≥ 157, llamactl ≥ 736, sirius ≥ 262, embersynth ≥ 152.

Four repos green = slice shippable.

## Phase M status (MCP surface across the fleet)

- **M.1 `@llamactl/mcp`** — shipped. 18 tools + M.1 pipeline pickup
  (`~/.llamactl/mcp/pipelines/*.json` → `llamactl.pipeline.<slug>`).
- **M.2 `@sirius/mcp`** — shipped. `sirius.providers.list`,
  `.models.list`, `.providers.deregister` (dry-run), `.health.all`.
- **M.3 `@embersynth/mcp`** — shipped. 10 tools: `config.show`,
  `nodes.list`, `nodes.inspect`, `profiles.list`, `profiles.inspect`,
  `synthetic.list`, `route.simulate`, `health.all`, `evidence.tail`,
  `reload` (dry-run previews a diff; wet-run appends one audit
  entry). Source: `embersynth/src/mcp/server.ts`.
- **M.4 `@nova/mcp` facade** — shipped. The facade loads
  `~/.llamactl/nova-mcp.yaml` (override via `NOVA_MCP_CONFIG`), boots
  an MCP `Client` per downstream (stdio or HTTP), and re-exposes the
  flat union of every downstream tool under its original namespace
  (`llamactl.*` / `sirius.*` / `embersynth.*`). On top of that, five
  native tools live on the facade: `nova.ops.overview`,
  `nova.ops.healthcheck`, `nova.ops.cost.snapshot`,
  `nova.operator.plan`, and `nova.models.list` (merged catalog across
  the three downstreams, first-wins dedupe with
  `alsoAvailableIn`/`provenance`). Boot-time snapshot only — a
  downstream restart needs a facade restart. Full config shape and
  facade patterns live in `/Volumes/WorkSSD/repos/personal/nova/AGENTS.md`.

## Commit discipline

- One slice per commit — don't bundle a feature + an unrelated
  refactor.
- Never include "Co-Authored-By" lines or tool attribution. Write
  commits as if authored by a careful human.
- Never `git commit --amend` on a pushed commit.
- Never `--no-verify` unless the user asks.
- Run full test sweep before committing.

## Planning a slice

For anything non-trivial, write a plan first. Plans live under
`~/.claude/plans/<slug>.md`. A plan describes:

- The problem in one paragraph.
- Decision table (question / options / recommendation).
- Architecture diagram (text).
- Schema / interface definitions.
- Test surface.
- Risks + mitigations.
- Recommended sprint sequence (the slice cuts).

Then ship one sprint slice at a time, each ending in a passing
cross-repo test sweep + a commit.

## What to avoid

- Committing to `packages/core` anything that imports from
  `packages/remote`, `packages/app`, `tRPC`, `electron-trpc`, or
  MCP. Core is the base of the dependency DAG.
- Rewriting Nova schemas in llamactl. Bump Nova, `bun install` here.
- Force-pushes to `main`.
- `z.record(z.unknown())` (Zod 3 idiom — compile error in Zod 4).
- Adding long docstrings to every function. Write one-line module
  headers where context earns it; skip the rest.
- Creating `.md` files the user didn't ask for (plan docs, status
  reports, etc. stay in conversation or in `~/.claude/plans/`).

## CLI skeleton (when adding a new verb)

1. Add logic in `packages/core/src/`.
2. Expose as a tRPC procedure in `packages/remote/src/router.ts`.
3. Add a CLI command in `packages/cli/src/commands/<verb>.ts`
   routing through `dispatcher.runOp`.
4. Register in `packages/cli/src/bin.ts`.
5. Optional: project to MCP in `packages/mcp/src/server.ts`.
6. Optional: a runbook or healer hook in `packages/agents/`.
7. Tests at every layer (core, remote, cli, mcp).

## Design docs

`~/.claude/plans/` holds the roadmap + per-phase design docs:

- `radiant-converging-knuth.md` — overall roadmap.
- `infra-deployment-kubeadm.md` — I-α / I-β / I.4.
- `infra-reverse-tunnel.md` — I.3.
- `infra-supply-chain.md` — I.5 (release + cosign).
- `cost-guardian.md` — N.3.
- `operator-plan-llm.md` — N.4.
- `gateway-workload-substantive.md` — K.7.
