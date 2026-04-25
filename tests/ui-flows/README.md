# UI flow tests (llamactl-specific)

**Tier B suite — 5 flows post-2026-04-25 triage. See
docs/superpowers/specs/2026-04-25-ui-e2e-smoke-design.md.**

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
- `projects-tab-flow.ts` — trifold Phase 4 Projects module. Opens
  the activity-bar Projects entry, asserts the module mounts,
  exercises the empty-state branch when no projects are
  registered, and drives the "open detail + close" arc when the
  operator has at least one project registered. The rest of the
  register → index → chat arc is covered by CLI + tRPC unit
  tests from Phases 1–3.
- `pipelines-apply-run-flow.ts` — full E2E arc: wizard → apply →
  run → running-badge appears → run completes → lastRun badge →
  Remove. Proves the live agent wiring + Phase B running signal
  against a real backend. Seeds a deterministic fixture at
  `/tmp/llamactl-wizard-smoke/doc.md`, timestamps the pipeline +
  collection names so re-runs don't collide, flips the browser
  dialog policy to `accept` before Remove so the confirm doesn't
  block. Leaves a tiny `wizard_smoke_<ts>` collection in the
  targeted rag node (documented side-effect of Remove's
  "applied documents stay" semantics).
- `pipelines-wizard-flow.ts` — R3.c wizard modal. Opens the "+ New
  pipeline" wizard, advances through the stepper with an empty form,
  asserts Review shows validation errors + Apply is disabled. Then
  back-fills name / ragNode / collection / source-root, jumps to
  Review again, asserts errors clear + Apply enables + the YAML
  reflects the entered values. Closes without applying (the apply
  roundtrip is covered by router tests). Requires a profile with at
  least one rag node registered.
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

These are not wired into `bun test`, but the full pipelines sweep
can be run with one command via `scripts/smoke-ui-flows.sh` (builds
the bundle, resolves the Electron binary + `electron-mcp-server`
entrypoint, then runs every R3 / aliveness flow in order). Useful
for "I just shipped UI work — prove the whole Pipelines surface
still works":

```sh
scripts/smoke-ui-flows.sh                              # full sweep
SKIP_BUILD=1 scripts/smoke-ui-flows.sh                 # reuse existing bundle
FLOWS=pipelines-tab-flow scripts/smoke-ui-flows.sh     # just one flow
```

The script honors the same `ELECTRON_MCP_DIR` env var as individual
flows; `ELECTRON_BIN` + `APP_DIR` overrides are also available.
