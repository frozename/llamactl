# GEMINI.md — llamactl

Gemini CLI entrypoint. Defers to [`AGENTS.md`](./AGENTS.md) as the
authoritative source; this file calls out Gemini-specific nudges.

## Before any task

1. Read `AGENTS.md` (full rules, style, stack, layout).
2. Check `~/.claude/plans/` for a design doc covering the phase you're
   touching (N.3, N.4, K.7, I.3, I.5, etc.). If the task matches one,
   follow its sprint sequence.
3. Survey the relevant package — `packages/core`, `remote`, `cli`,
   `app`, `mcp`, `agents` — before coding.

## Non-negotiables

- **`packages/core` stays adapter-free.** No imports from `remote`,
  `app`, tRPC, electron-trpc, MCP, or HTTP libraries in `core`.
- **Dispatcher routing for every CLI verb.** `runOp(nodeId, ...)`
  is the only sanctioned way to reach a node; bypassing it breaks
  `--node gpu1` and `-n all` fan-out.
- **Zod 4** — `z.record(z.string(), z.unknown())`, `.partial()`,
  `z.discriminatedUnion`.
- **tRPC v11** APIs — `createTRPCClient`, not v10's proxy variant.
- **Bun** only.
- **English** identifiers.
- **No `--no-verify`.** If a hook fails, investigate + fix.

## Runtime + commands

```bash
bun install
bun test
bun run typecheck
bun run --cwd packages/remote tsc --noEmit
bun run --cwd packages/app tsc --noEmit
zsh test/run-all.zsh                 # full sweep with shell smoke
```

## Cross-repo checks

If your change touches `@nova/*`, run after Nova bumps:

```bash
bun install
bun test
(cd ../sirius-gateway && bun install && bun test)
(cd ../embersynth && bun install && bun test)
(cd ../nova && bun test)
```

Baseline: llamactl ≥ 638 tests + sirius ≥ 250 + embersynth ≥ 129 +
nova ≥ 89. Four repos green = slice shippable.

## Where to look

- `packages/core/` — pure business logic.
- `packages/remote/src/router.ts` — tRPC procedures.
- `packages/remote/src/workload/` — ModelRun + NodeRun reconcilers.
- `packages/remote/src/tunnel/` — I.3 reverse tunnel.
- `packages/cli/src/commands/` — CLI verb surface.
- `packages/mcp/src/server.ts` — MCP tool projection.
- `packages/agents/src/runbooks/` — operator runbook patterns.
- `~/.claude/plans/` — roadmap + per-phase design docs.
