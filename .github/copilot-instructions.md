# GitHub Copilot Instructions — llamactl

Condensed digest. Authoritative rules live in [`AGENTS.md`](../AGENTS.md).

## What this repo is

Local-first `kubectl`-style control plane for llama.cpp fleets.
Imperative CLI (`llamactl catalog list`, `server start`, etc.) +
declarative workloads (`ModelRun`, `NodeRun` manifests) + MCP
surface + agentic harnesses. Single-operator focus; multi-node via
a self-hosted agent on every machine.

## Stack

- **Runtime**: Bun 1.3+.
- **Language**: TypeScript 5.9+, NodeNext ESM.
- **RPC**: tRPC v11 (`createTRPCClient`). React Query v5.
- **Validation**: Zod 4.3+.
- **UI**: Electron + electron-trpc 1.0.0-alpha + React 19 + Vite 7.
- **MCP**: `@modelcontextprotocol/sdk` 1.29.
- **Nova** via `file:` deps.

## Layout

```
packages/
├── core/       adapter-free business logic (no HTTP, no tRPC)
├── cli/        Bun CLI + commands + dispatcher
├── remote/     tRPC router, kubeconfig, workloads, tunnel, infra
├── app/        Electron dashboard
├── mcp/        @llamactl/mcp
└── agents/     runbooks + healer loop
```

## Hard rules

- **`packages/core` is adapter-free.** No tRPC, electron, HTTP, MCP
  imports in core.
- **Every `--node`-aware CLI verb routes through the dispatcher**
  (`packages/cli/src/dispatcher.ts`).
- **Zod 4** — `z.record(z.string(), z.unknown())`, `.partial()`,
  `z.discriminatedUnion`.
- **tRPC v11** APIs only (`createTRPCClient`, not v10 proxy).
- **Bun** (no npm / yarn / pnpm).
- **English** identifiers.
- **No comments for WHAT** — only WHY (workarounds, constraints).
- **No `--no-verify`** on commits.
- **No AI / tool attribution** in commit messages.

## Tests

- `bun:test` everywhere.
- `makeTempRuntime` + `envForTemp` for file-I/O tests.
- `makeCluster({ nodes: N })` for multi-node integration.
- Fake `llama-server` shell-script pattern (see
  `packages/core/test/server.test.ts`) — don't mock `Bun.spawn`.
- MCP smoke tests via `InMemoryTransport.createLinkedPair()`.

## Workloads

- `ModelRun` — model on node + args. `apply`-able.
- `NodeRun` — desired infra stack on an agent.
- Gateway-kind workloads route through
  `packages/remote/src/workload/gateway-handlers/`.

## Cross-repo

Nova changes propagate:
```bash
(cd ../nova && bun test)
bun install && bun test
(cd ../sirius-gateway && bun install && bun test)
(cd ../embersynth && bun install && bun test)
```

Four repos green = slice shippable.

## Key references

- `AGENTS.md` — full rules.
- `README.md` — user overview.
- `docs/releases.md`, `docs/tsv-schemas.md` — format details.
- `~/.claude/plans/` — roadmap + design docs per phase.
