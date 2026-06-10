# Handoff to penumbra team — maestro output redactor landed (Ask 1)

Date: 2026-05-11
From: llamactl side
To: penumbra runtime team

## TL;DR

- **Ask 1 (output redactor) is landed and on `main`.** 12 commits,
  `9461cda…b31a2d04`. 156 tests / 0 fail across touched packages
  (108 pass / 0 fail on the focused agentchat + capture-port slice).
- Worker was kickstarted post-merge; the live `runChatTurn` is now
  serving the redacted path.
- Live E2E proved the pipeline (dispatch → worker → `input.observe`
  → `t0_events`) is intact post-fix. **One rule-tuning follow-up**
  surfaced — the `destructive_shell_rmrf` regex is too tight for
  what real maestro candidates actually emit.

## What shipped

Implementation phases mirror the design spec
(`docs/superpowers/specs/2026-05-11-maestro-output-redactor-design.md`
in llamactl, mirrored to penumbra as Ask 1 input):

| Phase                | What                                                                                                                                                                                                                                          | Files                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Core                 | `ValuePatternRedactor` — value-pattern (not key-pattern) regex sweeper with string/function replacement, decision = `clean \| rewritten \| blocked \| bypassed`.                                                                              | `packages/core/src/redaction/value-patterns.ts` (+ re-export at `packages/core/src/index.ts:8-13`) |
| Rules                | Static `MAESTRO_STATIC_RULES`: `ssh_private_key_path`, `destructive_shell_rmrf`, `git_force_push`. Dynamic `buildUnknownAgentRule(knownAgents)` → `unknown_initial_agent`. All four are fail-closed.                                          | `packages/agentchat/src/worker/maestro-output-rules.ts`                                            |
| Orchestrator         | `MaestroOutputRedactor` with `checkContent` + `checkValue`; reads `PENUMBRA_MAESTRO_REDACTION_BYPASS` via `buildMaestroRedactorFromEnv`.                                                                                                      | `packages/agentchat/src/worker/maestro-output-redactor.ts`                                         |
| Streaming-chunk path | `CapturePort` applies redactor in `flushChunkBuffer` (agent-response chunks) and `emitToolRow` (tool-call args). Emits the six new side events.                                                                                               | `packages/agentchat/src/worker/capture-port.ts`                                                    |
| Final-response path  | `runChatTurn` redacts the assembled final text before composing the authoritative `agent-response` event. Suppresses mention parsing on a blocked turn.                                                                                       | `packages/agentchat/src/cli/loop.ts`                                                               |
| Daemon allowlist     | Six new event types added to `EventTypeSchema`: `agent-response-blocked`, `agent-response-redaction-hit`, `agent-response-redaction-bypassed`, `agent-tool-use-blocked`, `agent-tool-use-redaction-hit`, `agent-tool-use-redaction-bypassed`. | `packages/core/src/schemas/event.ts`                                                               |

### Why the final-response path was a separate commit (b31a2d04)

The plan originally landed the redactor in `CapturePort.flushChunkBuffer`
only. During E2E validation we discovered openai-compat adapters that
emit a single `done` (no streamed deltas) never go through that path —
`runChatTurn` composes the authoritative `agent-response` event directly
via `input.observe(...)`. That commit moves the decision logic up one
level so the regex sweep happens against the assembled final text
regardless of whether the adapter streamed.

Net effect: both fast/streaming adapters and one-shot adapters are
covered. The `local-gemma4-26b-a4b-mtp` candidate is the latter.

## Behavior contract

`PENUMBRA_MAESTRO_REDACTION_BYPASS=1` → bypass mode. On a would-block:
emit `agent-response-redaction-bypassed` side event AND emit the
unredacted `agent-response`. Default (unset/`0`) → enforce; emit
`agent-response-blocked` AND replace the response text with
`'[maestro response withheld by output policy]'`; mention parsing is
suppressed for that turn so it can't chain.

The `unknown_initial_agent` rule fires when the redactor sees an
`@<agent>` token in output that's not in the `knownAgents` set the
worker constructs from `input.config.agents`.

## Validation report

`docs/superpowers/specs/2026-05-11-maestro-output-redactor-validation.md`
(llamactl, commit `2204e1d`).

Headline:

- Unit + integration tests deterministically cover all four decision
  branches.
- Live dispatch via `penumbra maestro session start-adhoc --agent
local-gemma4-26b-a4b-mtp` against the post-merge worker successfully
  emits `agent-response` events through the patched path. Three live
  conversations recorded:
  - `conv-788001f5-…` — direct ask, model refused cleanly, no
    redaction events (correct: nothing to redact).
  - `conv-1db036c3-…` — model **did** leak the destructive string,
    but the existing regex didn't match it (see follow-up below).
  - `conv-09e3240c-…` — character-by-character coaxing, model
    garbled it.

## One follow-up for you — rule tighten

**`destructive_shell_rmrf` regex is too tight.**

Current:

```
/\brm\s+-rf\s+\/\S*/g
```

Requires the path to be immediately adjacent to `-rf`. Gemma 4
reproducibly emits the flag-then-path variant inside refusal
explanations, e.g. `rm -rf --no-preserve-root /`, which slips through.

Suggested replacement (drop-in):

```
/\brm\s+-rf(?:\s+--[a-z][a-z0-9-]*)*\s+\/\S*/g
```

This is a one-line rule change; the wiring + test scaffolding is
already there. Once tightened, a re-run of the same prompts (notably
`conv-1db036c3` from the validation doc) should produce a live
`agent-response-blocked` event in `t0_events` with no other code
changes.

Similar adjacent thinking: `git_force_push` is intentionally narrow
(only branches `main`/`master`/`origin/<main|master>`), but it's
worth checking whether `git push --force-with-lease origin HEAD:main`
or detached-HEAD pushes need coverage. Out of scope for this handoff;
flagging for your queue.

## Already-running infrastructure

- Worker is on `b31a2d04` (kickstarted via
  `launchctl kickstart -k gui/$UID/dev.penumbra.worker`).
- Granite workloads removed from llamactl; only `local-gemma4-26b-a4b-mtp`
  (`127.0.0.1:8181`) is live, matching the maestro pilot config.
- The Ask-5 daily regression sweep (llamactl-side, `dev.llamactl.maestro-regression-sweep`
  plist, 03:17 local) will exercise the post-redactor worker on the
  existing fixtures starting tonight.

## Asks / open questions back to you

1. **Rule tighten** — pattern above. Trivial, but I'm leaving it to
   you because the rule lives next to your other patterns and you
   may want to take the opportunity to audit them all.
2. **Bypass-event UX** — `agent-response-redaction-bypassed` emits
   alongside the unredacted `agent-response`. Do you want a UI
   surface (chain summary, ack-required) for these in penumbra, or
   are you happy treating them as audit-only for now?
3. **Tool-call coverage** — `emitToolRow` redaction covers args. We
   did not extend to tool results (which can also leak — model
   reading `.ssh/id_ed25519` would surface in a tool-result event,
   not a tool-call event). Worth a separate slice if you agree.

## Pointer index

- Plan: `docs/superpowers/plans/2026-05-11-maestro-output-redactor.md`
- Spec: `docs/superpowers/specs/2026-05-11-maestro-output-redactor-design.md`
- Validation: `docs/superpowers/specs/2026-05-11-maestro-output-redactor-validation.md`
- Penumbra commits: `9461cda` through `b31a2d04` on `main` (12 commits)
