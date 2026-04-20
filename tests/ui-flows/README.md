# UI flow tests (llamactl-specific)

Scripted end-to-end flows that drive llamactl's Electron app via
`electron-mcp-server`'s MCP tools. These moved out of
electron-mcp-server during the cross-repo genericization pass because
they're llamactl-feature-specific — they hardcode selectors like
`[data-testid="plan-result"]`, `[data-testid="cost-tier"]`, and the
Operator Console transcript structure. Keeping them here localizes the
llamactl knowledge and lets the upstream driver stay library-generic.

## What's here

- `chat-compare-flow.ts` — K.2 A/B compare mode. Opens Chat, creates a
  conversation, enters compare mode, asserts both panes exist, exits,
  asserts pane B is gone.
- `ops-chat-flow.ts` — N.4 Operator Console. Plans a goal, verifies
  the tiered approval cards render, runs a read-tool step, asserts
  `ok=true`.
- `plan-chat-flow.ts` — N.4.5 planner chat. Drives two turns in stub
  mode (no LLM) and asserts the transcript grows to 4 turns with
  history preserved across the second user message.
- `pilot-driver.ts` — broad smoke + Plan + Cost module walk. Emits a
  structured findings report.

## Prerequisites

- A built llamactl Electron app at `packages/app/out/main/index.cjs`
  (run `bun run --cwd packages/app build`).
- A checkout of `electron-mcp-server` alongside this repo (or set
  `ELECTRON_MCP_DIR=<path>`); run `bun install && bun run build`
  inside it so `dist/server/index.js` exists — the flow scripts spawn
  the MCP server from there.
- Individual files may need additional env (e.g.
  `LLAMACTL_TEST_PROFILE`). See each file's header for preconditions.

## Running

```sh
# Point ELECTRON_MCP_DIR at your electron-mcp-server checkout.
export ELECTRON_MCP_DIR=/path/to/electron-mcp-server

# Build + run one flow:
bun run --cwd packages/app build
bun run tests/ui-flows/chat-compare-flow.ts \
  --executable="$(pwd)/packages/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
  --args="$(pwd)/packages/app"
```

These are not wired into `bun test` or any CI workflow — invoke them
manually when you want to exercise a specific flow end-to-end.
