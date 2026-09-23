# Unified AI router registrar and ledger

Snapshot: 2026-09-23T11:22:30.080Z. Repository: frozename/llamactl. This is an evidence-backed tracking snapshot, not an automatically synchronized dashboard.

- [Roadmap #127](https://github.com/frozename/llamactl/issues/127)
- [Architecture and design decisions](./specs/2026-09-23-unified-ai-router-architecture.md)
- [Publication and fleet manifest](./specs/2026-09-23-unified-ai-router-publication.json), including machine-readable `tracking` and per-issue execution contracts
- [Documentation PR #147](https://github.com/frozename/llamactl/pull/147), open and unmerged at this snapshot

Penumbra entry: **llamactl-unified-ai-router**, ID **2c2a7cbb-048c-45e5-8663-f15187b9e85b**, home project **llamactl**, source document **docs/unified-ai-router-registrar.md**, status **draft**. Registrar state was read back: one completed research phase, seven pending implementation phases, 18 owed follow-ups, one open acceptance blocker. The entry and follow-ups exist in Penumbra; no executable task has been filed or dispatched.

## State and evidence rules

Git/GitHub are authoritative for repository commits, PR merges, issue state and checks. Penumbra is the durable event record; this file and the manifest are its reviewable repository projection. Refresh all three before acting. A repository ledger snapshot can age; record its observation time and append corrections instead of silently rewriting history.

Stable work-package IDs are R0 and P0.1-P6.2. Never renumber, delete or reuse an ID. `ready_for_preflight` means dependencies permit planning the next worktree; it does not mean gates passed or execution was authorized. Work progresses through ready → executing → in review → accepted/merged → complete, or blocked, with separate rollout status. Penumbra's phase vocabulary is pending/active/blocked/complete/abandoned; map explicitly and never invent unsupported task.file fields. Keep draft until implementation is separately authorized. A partially landed phase is active; complete requires every child accepted. R0 is completed research and is never dispatched as implementation.

Every implementation row starts with owner, task ID, handoff, PR, implementation SHA and test evidence unset. Fill these from actual returned identities and verified artifacts, never guessed IDs. A merged implementation can still have rollout disabled. Documentation publication, merge and runtime activation are distinct facts. The schema-valid fleet payloads remain in the manifest; these ledger records do not create a task queue.

## Penumbra phase mapping

| Registrar phase | Roadmap scope                              | Current state |
| --------------- | ------------------------------------------ | ------------- |
| 1               | R0 — Completed reference research          | complete      |
| 2               | P0 — Characterization and shared contracts | pending       |
| 3               | P1 — Cloud and protocol convergence        | pending       |
| 4               | P2 — Worker-owned CLI                      | pending       |
| 5               | P3 — Semantic cache                        | pending       |
| 6               | P4 — Independent proxy and cache services  | pending       |
| 7               | P5 — Fleet coordination and cache sharding | pending       |
| 8               | P6 — ACP execution and sessions            | pending       |

## Work-package ledger

All implementation evidence remains unproven. Follow-up event numbers below are the exact events to reference when recording completion or dropping work. Dependencies are stable IDs linked through the roadmap and manifest; their 24 native GitHub edges remain authoritative.

| ID / GitHub issue                                        | Tracking state      | Depends on       | Registrar phase / event | Execution and evidence                                                       |
| -------------------------------------------------------- | ------------------- | ---------------- | ----------------------- | ---------------------------------------------------------------------------- |
| [R0](https://github.com/frozename/llamactl/issues/128)   | complete            | —                | 1 / 1685                | [Pinned research accepted](https://github.com/frozename/llamactl/issues/128) |
| [P0.1](https://github.com/frozename/llamactl/issues/129) | ready for preflight | —                | 2 / 1691                | Unassigned; not dispatched; no implementation PR or review                   |
| [P0.2](https://github.com/frozename/llamactl/issues/130) | blocked             | P0.1             | 2 / 1692                | Unassigned; not dispatched; no implementation PR or review                   |
| [P1.1](https://github.com/frozename/llamactl/issues/131) | blocked             | P0.2             | 3 / 1693                | Unassigned; not dispatched; no implementation PR or review                   |
| [P1.2](https://github.com/frozename/llamactl/issues/132) | blocked             | P1.1             | 3 / 1694                | Unassigned; not dispatched; no implementation PR or review                   |
| [P1.3](https://github.com/frozename/llamactl/issues/133) | blocked             | P1.2             | 3 / 1695                | Unassigned; not dispatched; no implementation PR or review                   |
| [P2.1](https://github.com/frozename/llamactl/issues/134) | blocked             | P1.3, R0         | 4 / 1696                | Unassigned; not dispatched; no implementation PR or review                   |
| [P2.2](https://github.com/frozename/llamactl/issues/135) | blocked             | P2.1             | 4 / 1697                | Unassigned; not dispatched; no implementation PR or review                   |
| [P3.1](https://github.com/frozename/llamactl/issues/136) | blocked             | P1.3             | 5 / 1698                | Unassigned; not dispatched; no implementation PR or review                   |
| [P3.2](https://github.com/frozename/llamactl/issues/137) | blocked             | P3.1             | 5 / 1699                | Unassigned; not dispatched; no implementation PR or review                   |
| [P3.3](https://github.com/frozename/llamactl/issues/138) | blocked             | P3.2             | 5 / 1700                | Unassigned; not dispatched; no implementation PR or review                   |
| [P4.1](https://github.com/frozename/llamactl/issues/139) | blocked             | P2.2, P3.3       | 6 / 1701                | Unassigned; not dispatched; no implementation PR or review                   |
| [P4.2](https://github.com/frozename/llamactl/issues/140) | blocked             | P4.1             | 6 / 1702                | Unassigned; not dispatched; no implementation PR or review                   |
| [P4.3](https://github.com/frozename/llamactl/issues/141) | blocked             | P4.1             | 6 / 1703                | Unassigned; not dispatched; no implementation PR or review                   |
| [P5.1](https://github.com/frozename/llamactl/issues/142) | blocked             | P4.1             | 7 / 1704                | Unassigned; not dispatched; no implementation PR or review                   |
| [P5.2](https://github.com/frozename/llamactl/issues/143) | blocked             | P5.1, P4.2, P4.3 | 7 / 1705                | Unassigned; not dispatched; no implementation PR or review                   |
| [P5.3](https://github.com/frozename/llamactl/issues/144) | blocked             | P5.2             | 7 / 1706                | Unassigned; not dispatched; no implementation PR or review                   |
| [P6.1](https://github.com/frozename/llamactl/issues/145) | blocked             | R0, P2.2, P4.2   | 8 / 1707                | Unassigned; not dispatched; no implementation PR or review                   |
| [P6.2](https://github.com/frozename/llamactl/issues/146) | blocked             | P6.1, P5.2       | 8 / 1708                | Unassigned; not dispatched; no implementation PR or review                   |

First candidate: **P0.1 / #129**, after explicit implementation authorization and preflight. All 17 other implementation items wait on their declared dependencies. There are no current implementation owners, review verdicts, commits or rollout approvals. Shared-file writers must be serialized even when the dependency graph allows parallel work. P0.2 requires coordinated Nova and consumer changes in separately isolated sibling worktrees.

## Gates, risks and open decisions

| ID      | Status / affected work                                                   | Evidence and next action                                                                                                                                                                                                                                                                                                                                                                               | Owner role                              |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| GATE-01 | Open; blocks green acceptance and rollout, not baseline characterization | At baseline 7443403912ab3976d18bc288de3009e2c23b7afb, root bun test exited 1: 3,881 pass, 9 skip, 231 fail, 19 errors. Prescribed sweep reached core 698/0 and CLI 517 pass/3 skip/0 fail, then shell smoke 28/3; later tier not reached. Reproduce, classify and obtain fresh required gates at implementation SHA. Penumbra blocker 1686; [details](https://github.com/frozename/llamactl/pull/147). | P0.1 implementer + independent reviewer |
| GATE-02 | Open; documentation not on main                                          | PR #147 is published and unmerged. Verify any later authorized merge; never infer it from a published branch.                                                                                                                                                                                                                                                                                          | Repository maintainer                   |
| CAP-01  | Open capability gap; optional organization only                          | Token lacks Project scopes; no board created. Parent, milestones and native issue relationships remain usable. Penumbra caveat 1687.                                                                                                                                                                                                                                                                   | Repository maintainer                   |
| DEC-01  | Accepted design default                                                  | Strict Penumbra payloads, registrar-enforced dependencies and actual chain/worktree branch policy; no queue-wide automatic dispatch. Event 1688.                                                                                                                                                                                                                                                       | Future dispatcher                       |
| DEC-02  | Accepted design default, implementation unproven                         | Native same-protocol passthrough; canonical Nova contracts; exact-first scoped semantic cache; distinct execution/cache affinity; fenced worker ownership. Event 1689; see architecture decision tables.                                                                                                                                                                                               | Relevant phase implementer + reviewer   |
| Q-01    | Owed before semantic serve                                               | Choose and evaluate safe text profiles, embedder revisions, similarity thresholds and explicit false-hit/latency/cost gates; no threshold invented by this ledger. P3.1/P3.3.                                                                                                                                                                                                                          | Cache profile owner                     |
| Q-02    | Owed before real ACP enablement                                          | Select pinned executable/protocol versions and sandbox/auth profiles; qualify model acknowledgement, cancellation, usage and agent-owned tools. P6.1/P6.2.                                                                                                                                                                                                                                             | Worker/runtime owner                    |
| Q-03    | Owed before managed fleet enablement                                     | Confirm tenant identity, credential namespaces, immutable cloud revisions, PostgreSQL HA/restore owner and rolling-upgrade window. P0.2/P4.3/P5.1.                                                                                                                                                                                                                                                     | Fleet operator + contract owner         |
| RSK-01  | Open until boundary tests pass                                           | Lossy protocol/usage translation, double tool execution, uncertain retries and tenant/session leakage. Producer-consumer tests and independent review are required by the linked issues.                                                                                                                                                                                                               | Protocol/runtime reviewer               |
| RSK-02  | Open until distributed gates pass                                        | Missing revisions, stale owners, partitions, TTL extension and partial rebalances can serve incorrect cache entries. Preserve epochs and test fencing, source completion and absolute expiry.                                                                                                                                                                                                          | Cache/fleet reviewer                    |

No time estimates or production seat/account configuration are stored here. Private reference links require access. Baseline failures are observed facts, not implemented fixes or automatic exceptions to future gates.

## Update protocol

1. **Before dispatch:** the future authorized dispatcher reads this ledger, current issue body/native dependencies, current main and Penumbra status. Reconcile drift. Verify dependency PR merges and accepted SHA evidence (R0 uses completed research). Deduplicate any existing task-to-issue association. Bind local project and creator identities; retain default feature flags and cost policy.
2. **When work starts:** record actual task/handoff IDs, owner, branch and base SHA; append a progress event linked to the issue. Serialize overlapping fences. Registrar registration alone is not work start; do not turn all phases active.
3. **At review:** the implementer supplies exact changed-file fence, focused/full command exits and counts, assertion RED/GREEN/mutation/restoration proof, compatibility/migration and rollback evidence. An independent reviewer records PASS/FAIL against the exact head. Failed/missing gates retain blocked or in-review state, never complete.
4. **After an authorized merge:** verify the merged SHA and PR, then close that task's owed follow-up via `registrar_append` with `kind: follow_up`, `state: done`, its original `ref_event_id`, phase number and evidence. Update GitHub checklist/labels, manifest item and this ledger in the same work session. Do not treat closing an issue or opening a PR as merge proof.
5. **For blockers and phases:** resolve GATE-01 using `kind: blocker`, `state: resolved`, `ref_event_id: 1686` only with its evidence. Phase transitions require a freshly read `from_status`; complete only when every child is accepted, required follow-ups are resolved and rollout limitations are explicit. Record later activation as separate evidence.
6. **Corrections:** append a journal entry naming the prior event and corrected claim. Preserve history. Refresh `tracking.snapshot_at`, rows, registrar event IDs and evidence in the manifest. Do not copy credentials, operational transcripts or private source into public records. If one system update fails, record the mismatch and retry that update without duplicating events.

Read Penumbra using `registrar_status({registrar_id: "2c2a7cbb-048c-45e5-8663-f15187b9e85b"})`; inspect the current result before any mutation. Neither this ledger nor its update protocol schedules a monitor or authorizes implementation, landing, deployment or external messages.

## Append-only journal

| Entry      | Observed at              | Fact / evidence                                                                                                                                        |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LEDGER-001 | 2026-09-23T11:15:31.660Z | Publication readback: roadmap #127, 19 children, 24 dependency edges, seven milestones; R0 closed and 18 implementation issues open; PR #147 unmerged. |
| LEDGER-002 | 2026-09-23T11:18:34.798Z | Duplicate sweep found no matching initiative. Created Penumbra entry 2c2a7cbb-048c-45e5-8663-f15187b9e85b as draft.                                    |
| LEDGER-003 | 2026-09-23T11:19:57.546Z | Verified events 1683–1708: completed R0, 18 owed follow-ups, baseline acceptance blocker and design/dispatch caveats. No implementation dispatched.    |
