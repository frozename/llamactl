# JULES.md — llamactl

Jules (Google's async coding agent) entrypoint. Defers to
[`AGENTS.md`](./AGENTS.md) as the authoritative source.

Jules runs in a cloud VM and produces a PR. Tasks arrive from GitHub
issues; output is one focused commit. Plan accordingly — you won't
iterate live.

## Before opening a PR

1. Read `AGENTS.md` at the repo root.
2. Identify the package(s) the issue touches: `core`, `cli`,
   `remote`, `app`, `mcp`, `agents`.
3. Verify the baseline is green before changing anything:
   ```bash
   bun install && bun test && bun run typecheck
   ```
   If red before your change, report and stop.

## Scope rules

- **One slice per PR.** Don't bundle a feature + an unrelated
  refactor. Reviewers reason about one coherent change at a time.
- **No shortcuts across the layer DAG.** `core` is pure logic;
  `remote` exposes it as tRPC; `cli` commands dispatch through
  `runOp`; `mcp` projects the tRPC surface; `agents` composes MCP
  tools. Never import from a higher layer into a lower one.
- **Cross-repo sync is the user's responsibility.** If your change
  requires a Nova bump, note it in the PR body; don't try to edit
  multiple repos in a single Jules run.

## Non-negotiables

- **Zod 4** (no `z.record(z.unknown())`).
- **tRPC v11** (`createTRPCClient`, not the v10 proxy).
- **`packages/core` stays adapter-free.**
- **Dispatcher for every `--node`-aware verb.**
- **Bun** only.
- **English** identifiers.
- **No `--no-verify`.**
- **No tool / AI attribution** in commit messages.

## PR body checklist

Every PR should include:

- Problem (link to issue).
- Approach (2-4 sentences).
- Test deltas: which new/changed tests and what they cover.
- Cross-repo impact: does this need a Nova bump? A sirius or
  embersynth change? List explicitly.
- Anything deferred (and why).

## Commands

```bash
bun install
bun test
bun run typecheck
bun run --cwd packages/app tsc --noEmit
zsh test/run-all.zsh
```

## Layout cheatsheet

```
packages/core/        pure business logic (no HTTP / tRPC / MCP)
packages/cli/         CLI entrypoint + commands
packages/remote/      tRPC router, kubeconfig, workloads, tunnel
packages/app/         Electron
packages/mcp/         @llamactl/mcp
packages/agents/      runbooks + healer loop
```
