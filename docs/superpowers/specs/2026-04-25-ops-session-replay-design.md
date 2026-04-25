# Ops Session Replay & Timeline — Design

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-04-25
**Phase:** Beacon Phase 2 (post-P3 cleanup, paired with P4 primitive adoption)
**Replaces:** `OpsSessionDetail` stub in `packages/app/src/modules/ops/detail/ops-session-detail.tsx`

## Goal

Turn the `OpsSessionDetail` stub into a real per-session timeline that lets the operator scan an Ops Chat planner session — live or after the fact — and inspect every iteration's proposal, reasoning, tool args, and result. Add a sessions-list module so historical sessions are discoverable, and wire ops-chat to auto-pin a tab when it starts a new session.

## Background

Today the planner loop in `packages/remote/src/ops-chat/loop-executor.ts` emits streaming events (`plan_proposed`, `refusal`, `done`) over a single tRPC subscription consumed only by the active ops-chat tab. The audit log at `~/.llamactl/ops-chat/audit.jsonl` records each tool dispatch (timestamp, tool, args hash, ok, duration) but contains no session correlation, no reasoning, and no result body. When the operator closes ops-chat or restarts the app, the streaming session's record is gone — only the session-anonymous audit hashes remain. The `OpsSessionDetail` stub is reachable via the dynamic tab router (`shell/beacon/dynamic-tab-router.tsx`) but renders only the session id and a "ships post-renewal" message.

## Decisions

### D1. Persistence: hybrid audit-upgrade + per-session journal

The audit log keeps its current minimal schema with one additive field: `sessionId?: string`. Old lines still parse (field is optional); new lines stamp the session that produced the tool run. This enables future cross-session compliance queries ("which sessions ran the destructive workload.apply tool last week?") without bloating per-entry size.

Rich session events are persisted in a new per-session journal at `~/.llamactl/ops-chat/sessions/<sessionId>/journal.jsonl`. The journal is append-only JSONL of typed events:

```ts
type JournalEvent =
  | { type: 'session_started'; ts: string; sessionId: string;
      goal: string; nodeId?: string; model?: string;
      historyLen: number; toolCount: number }
  | { type: 'plan_proposed';   ts: string; stepId: string;
      iteration: number; tier: ToolTier; reasoning: string;
      step: PlanStep /* args full */ }
  | { type: 'preview_outcome'; ts: string; stepId: string;
      ok: boolean; durationMs: number;
      result?: unknown; resultRedacted?: 'omitted' | 'truncated';
      error?: { code: string; message: string } }
  | { type: 'wet_outcome';     ts: string; stepId: string;
      ok: boolean; durationMs: number;
      result?: unknown; resultRedacted?: 'omitted' | 'truncated';
      error?: { code: string; message: string } }
  | { type: 'refusal'; ts: string; reason: string }
  | { type: 'done';    ts: string; iterations: number }
  | { type: 'aborted'; ts: string; reason: 'client_abort' | 'signal' | 'timeout' };
```

`session_started` is always first; one of `done` / `refusal` / `aborted` is always last. Anything between is paired by `stepId` (one proposal + zero, one, or two outcomes).

Audit and journal serve different concerns: audit = "what tool ran" (cheap, forever), journal = "what happened in this conversation" (rich, per-session).

### D2. Liveness: live + replay + follow

The `OpsSessionDetail` tab subscribes to a unified watch RPC that begins by replaying the journal from disk and then transitions to live event streaming if the session is still in flight. The same code path handles both modes — the client never branches on "live vs. completed."

### D3. Interactivity: read-only with "Open in ops-chat"

`OpsSessionDetail` is a monitor surface. It renders the timeline and exposes a single "Open in ops-chat" affordance that switches focus to the ops-chat module so the operator can act on the next pending proposal there. Approval, preview, wet-run, and reject UI live in ops-chat only — no duplication.

The button is shown only when `status === 'live'` (an active session has a pending step waiting for an outcome). For a completed/refused/aborted session the button is hidden — there is nothing to act on. "Switching focus" means dispatching a tab-activation for the ops-chat module; the ops-chat surface, when it sees an already-active subscription for this `sessionId`, attaches to it rather than starting a new one.

### D4. Discovery: auto-pin on start + sessions-list module

When ops-chat receives the first `session_started` event from a new subscription, it dispatches a tab-open for `ops-session:<id>`, auto-pinning the detail tab. A new sidebar module, `ops-sessions`, lists every session journal on disk (paginated, recency-sorted) with goal preview, status pill, iteration count, and start time, so historical sessions are findable without remembering ids.

### D5. Persistence depth: full args, full results with per-tool redaction

The journal records tool arguments verbatim. Tool results are also recorded verbatim by default but pass through a per-tool redaction registry. Examples:

- `llamactl.secrets.read` → `resultRedacted: 'omitted'`, body dropped
- `llamactl.fs.read` → truncated at 4KB with `resultRedacted: 'truncated'` marker
- Default → full passthrough

Rules live in `packages/remote/src/ops-chat/sessions/redaction.ts` and are configurable per tool name.

### D6. Layout: iteration-grouped accordion

`OpsSessionDetail` renders one collapsible `IterationCard` per iteration. Card header shows `[#3] tool · tier · ✓/✗ · 1.2s`; card body shows reasoning, args, preview outcome, wet outcome. Default-expanded state is the latest iteration (so live sessions naturally display the current frontier); all earlier iterations start collapsed. New iterations arriving during a live session auto-expand and demote the previously-latest iteration to collapsed — *unless* the user has manually toggled any iteration during this tab session, at which point auto-expansion stops and user intent sticks. The `EditorialHero` from `@/ui` carries the session header (goal, status pill, iteration count, timestamps).

This visual language deliberately differs from ops-chat's chat-bubble style. Different surfaces for different mental modes (operating vs. reviewing); the "Open in ops-chat" button signals the context switch explicitly.

### D7. Retention: forever + UI delete actions

Journals persist until the user removes them. The sessions-list module exposes per-row delete and bulk "delete older than X" actions. No automatic cleanup. `opsSessionDelete` rejects deletion of an in-flight session (channel still open on the bus).

## Architecture

### Server (`packages/remote/src/ops-chat`)

```
ops-chat/
├── audit.ts            (existing; add optional sessionId)
├── dispatch.ts         (existing; thread sessionId through to audit)
├── loop-executor.ts    (existing; emit to journal + bus on every event)
├── loop-schema.ts      (existing)
├── paths.ts            (existing; add defaultSessionsDir)
└── sessions/           ← NEW
    ├── journal-schema.ts   Zod schemas for JournalEvent union
    ├── journal.ts          appendJournalEvent, readJournal, journalDir
    ├── event-bus.ts        in-memory Map<sessionId, EventEmitter>
    ├── redaction.ts        per-tool redaction registry
    ├── list.ts             listSessions, getSessionSummary
    └── delete.ts           deleteSession (rejects in-flight)
```

### tRPC procedures (`packages/remote/src/router.ts`)

| Proc | Kind | Input | Output |
|---|---|---|---|
| `opsSessionList` | query | `{ limit, cursor?, status? }` | `{ sessions: SessionSummary[]; nextCursor?: string }` |
| `opsSessionGet` | query | `{ sessionId }` | `{ summary: SessionSummary; recentEvents: JournalEvent[] }` |
| `opsSessionWatch` | subscription | `{ sessionId }` | yields `JournalEvent` (replay then live) |
| `opsSessionDelete` | mutation | `{ sessionId }` | `{ ok: true }` or throws `PRECONDITION_FAILED` if in-flight |

### App (`packages/app/src`)

```
modules/ops/detail/
├── ops-session-detail.tsx    REPLACE stub: orchestrator, owns subscription
├── session-header.tsx        EditorialHero + status pill + counts
├── iteration-card.tsx        collapsible iteration card
├── result-viewer.tsx         redaction-aware result body display
└── empty-state.tsx           pre-Phase-2 sessions (no journal file)

modules/ops-sessions/         ← NEW
├── index.tsx                 module entry; uses opsSessionList query
├── sessions-table.tsx        paginated, sortable table
└── delete-confirm.tsx        inline confirm row (no modal)

modules/ops-chat/index.tsx    SMALL CHANGE: dispatch tab-open on session_started
modules/registry.ts           SMALL CHANGE: register ops-sessions module
lib/use-ops-session.ts        ← NEW: subscription → view-model hook
```

### View-model derivation (`lib/use-ops-session.ts`)

```ts
type IterationView = {
  iteration: number;
  stepId: string;
  tool: string;
  tier: ToolTier;
  reasoning: string;
  args: unknown;
  preview?: { ok: boolean; durationMs: number; result?: unknown; resultRedacted?: 'omitted' | 'truncated'; error?: { code: string; message: string } };
  wet?:     { ok: boolean; durationMs: number; result?: unknown; resultRedacted?: 'omitted' | 'truncated'; error?: { code: string; message: string } };
};

type SessionView = {
  sessionId: string;
  goal: string;
  status: 'live' | 'done' | 'refused' | 'aborted';
  startedAt: string;
  endedAt?: string;
  iterations: IterationView[];
};
```

The hook is responsible for: ordering events by `iteration` then `stepId` then event-type, idempotent merging when the same event arrives via replay-then-bus, and exposing `status` so the header badge updates without re-rendering iterations.

`status` is derived as follows. If the journal contains a `done` event → `'done'`; a `refusal` event → `'refused'`; an `aborted` event → `'aborted'`. Otherwise: if the server-side bus has an active channel for `sessionId` → `'live'`; if no channel and no terminal event → `'aborted'` (synthetic, server injects an `aborted` event with `reason: 'signal'` at watch time so disk and view-model agree).

## Data flow

### Live session — start to finish

```
operator types goal in ops-chat
   └─ tRPC operatorChatStream subscription opens
        └─ runLoopExecutor:
             ├─ generates sessionId (ULID)
             ├─ sessionEventBus.create(sessionId)
             ├─ writes session_started to journal
             ├─ emits session_started on bus
             └─ ops-chat receives sessionId from first event
                 └─ dispatches tab-open for ops-session:<id>

while planner runs:
   loop-executor:
     ├─ writes plan_proposed to journal + emits on bus
     ├─ yields plan_proposed to ops-chat subscription
     ├─ ops-chat shows approval UI; operator approves
     ├─ ops-chat runs the tool via operatorRunTool
     │    └─ appendOpsChatAudit({ ..., sessionId })
     ├─ ops-chat posts outcome via operatorSubmitStepOutcome
     │    └─ loop-executor writes preview_outcome / wet_outcome
     │       to journal + emits on bus
     └─ next iteration

terminal:
   loop-executor writes done/refusal/aborted to journal,
   emits on bus, closes bus channel.
```

### `opsSessionWatch` subscriber lifecycle

```
opsSessionWatch subscription opens for sessionId:
   1. server reads journal file from disk
      → emits all persisted events as a "replay" prelude
   2. server checks event-bus:
      - if channel exists → attach listener, forward live events
      - if not → close subscription after replay
   3. terminal events (done/refusal/aborted) close the subscription;
      bus channel close also closes it.
```

A tab opened *after* a session ends executes step 1, finds no bus channel in step 2, and closes naturally. A tab opened mid-flight gets the past plus the future. The client doesn't branch on mode.

### Multi-tab consistency

Two `OpsSessionDetail` tabs and the ops-chat tab can all watch the same session simultaneously. Each opens its own subscription; the bus broadcasts to all of them. State diverges only locally (which iterations are expanded in each tab) — the underlying event stream stays in lockstep.

## Error handling

- **Server restart mid-session.** Bus loses its in-memory state. Existing subscriptions die. The journal still has events up to the last write. New subscriptions read the journal, find no bus channel, mark the session as `aborted` (synthetic event injected at watch time if no terminal event found). Resuming the planner from the journal is out of scope for Phase 2.
- **Concurrent loop-executor writes.** Only one loop-executor runs per `sessionId` (single subscription, serialized by `operatorSubmitStepOutcome`). Append-only file, no contention.
- **Disk-full / write failure.** Journal write errors propagate to the loop. The planner aborts that iteration with an internal-error wet_outcome; the next iteration cannot proceed without journal persistence, so the session terminates with `aborted` reason `signal`.
- **Malformed journal lines.** `readJournal` skips unparseable lines (matching the `readOpsChatAudit` precedent). Best-effort replay; never crash the watch RPC.
- **Pre-Phase-2 session ids.** A tab opened for an `ops-session:<id>` that has no journal file on disk renders the `empty-state.tsx` component with a "no journal — predates Phase 2" message instead of hanging.

## Testing

### Server (`packages/remote`)

| Test | Coverage |
|---|---|
| `ops-chat/sessions/journal.test.ts` | Append + read round-trip, JSONL parse-tolerant of trailing newlines, malformed-line skip, atomic append |
| `ops-chat/sessions/redaction.test.ts` | `secrets.read` → omitted, `fs.read` → truncated at 4KB with marker, default tool → full passthrough |
| `ops-chat/sessions/event-bus.test.ts` | Multiple subscribers receive same events; channel close propagates; resubscribe after close gets no events |
| `ops-chat/sessions/list.test.ts` | Lists by recency desc, paginates, derives status from terminal event, summary computed from journal |
| `ops-chat/loop-executor.test.ts` (extend) | Events written to journal in correct order; sessionId stamped on each audit entry; bus published per event |
| `router/ops-session.test.ts` | `opsSessionWatch` replay-then-tail; open mid-flight gets prelude then live; open post-terminal closes after replay; `opsSessionDelete` rejects in-flight |

All run under the existing hermetic `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` pattern — sessions land in profile tmp dir, never in `~/.llamactl`.

### App (`packages/app`)

| Test | Coverage |
|---|---|
| `modules/ops/detail/use-ops-session.test.ts` | View-model derivation: idempotent merge, replay+live overlap dedupe, status transitions |
| `modules/ops/detail/iteration-card.test.tsx` | Default-expanded latest, expand on click, tier badge, redaction markers visible |
| `modules/ops/detail/result-viewer.test.tsx` | Truncation marker, "show full" toggle, omitted-result message |
| `modules/ops-sessions/sessions-table.test.tsx` | Sort, paginate, delete-confirm flow, status pills |

### UI flow tests (`tests/ui-flows/`)

Two new flows under the existing electron-mcp driver, registered in the Tier C nightly suite:

1. `ops-session-replay-flow.ts` — open a fixture session in `OpsSessionDetail`, expand iteration #2, verify reasoning + tool name + outcome status visible. Pure replay, no live planner.
2. `ops-sessions-list-flow.ts` — open the new `ops-sessions` module, verify table renders, click a row, verify it opens the corresponding ops-session tab.

Following the SKIP-guard pattern from the recent Tier B campaign: any selector miss converts to graceful skip rather than failing the nightly run. The "live + auto-pin" flow is intentionally omitted from the smoke suite — it requires an LLM round-trip and is too flaky for nightly. That path is covered via `use-ops-session` unit tests.

## Rollout

Single PR, all-or-nothing. The audit `sessionId?` field is backwards-compatible (old lines still parse, new lines stamp it), so there's no migration phase. Pre-Phase-2 session ids hit the empty-state component cleanly. Tag the resulting commit `beacon-p4-ops-replay` to match the existing `beacon-p4-primitives` cadence.

## Out of scope (deferred to later phases)

- Recovery / resume of a session whose loop-executor died mid-run (needs journal-driven planner restart)
- Search inside session contents (sessions-list filters only)
- Side-by-side compare of two sessions
- Export to markdown
- Sharing a session URL across machines
- Cross-node session aggregation (when the gateway story lands, sessions may live on multiple nodes; for now, single-node)

## Success criteria

1. `OpsSessionDetail` renders a real timeline for any session with a journal on disk, live or completed, in either mode without the client branching.
2. Operator starts a session in ops-chat, sees the auto-pinned `ops-session:<id>` tab appear, can switch to it, watch live events stream in, and read the full transcript after the session finishes — across an Electron restart.
3. The new `ops-sessions` sidebar module lists every journal on disk; clicking a row opens its detail tab; deleting a row removes the directory and refreshes the list.
4. The audit log gains `sessionId` on new entries; old entries still parse; cross-session audit queries become possible.
5. All existing 68 app tests still pass; new tests added per the testing section all pass; one new Tier C UI flow runs under the nightly smoke suite.
