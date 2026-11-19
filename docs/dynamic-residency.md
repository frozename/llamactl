# Dynamic residency operator runbook

Automatic residency is disabled by default. Nothing in this document turns a model on or off in production for you: this runbook is not deployment approval (Part of #285). Read [dynamic fleet models](dynamic-fleet-models.md) for the control-plane model, [self-update](self-update.md) for the controller update unit, and [deployment on the Mac mini](deployment-mac-mini.md) for the host layout. Every command below targets a node you have already decided to operate on.

## Scope

On `main`:

- The residency store and its node-local SQLite state (`operations.sqlite`).
- Desired-state ownership of `ModelRun`, `ModelHost` and `NodeRun` manifests.
- The lease registry, drain and force-unload path (opt-in).
- `residency status`, `residency plan` and `residency apply-profile`.
- Profile-switch cancel and boot crash recovery.
- Request admission caps and declared-model projection with readiness gates.

Library-only (no production wiring):

- The llama.cpp sleep/wake clients and the sleep-status recorder.
- The managed oMLX residency and the oMLX cache-retention decision.
- The memory-calibration artifact-revision gate.

## Residency store and backups

The store path comes from `defaultResidencyStorePath` (`packages/remote/src/residency/store.ts`). The `LLAMACTL_RESIDENCY_STORE` override wins outright. Otherwise the path is `llamactlHome + residency/operations.sqlite`, where `llamactlHome` is `$DEV_STORAGE` or `~/.llamactl` (`packages/core/src/config/env.ts`).

The store is node-local SQLite in WAL mode: `openDb` sets `journal_mode = WAL`. Back up with `sqlite3` `.backup`, because the `-wal` and `-shm` sidecars hold uncheckpointed rows a plain file copy would drop, then verify the copy read-only with `file:<copy>?mode=ro&immutable=1`. Resolve the path the same way the agent does, in a shell that carries the agent's `LLAMACTL_RESIDENCY_STORE` and `DEV_STORAGE` (the shell `:-` fallbacks treat only an empty value as unset, while the code also trims, so a whitespace-only value counts as unset in `llamactlHome` and `defaultResidencyStorePath` but not in this snippet):

```sh
STORE="${LLAMACTL_RESIDENCY_STORE:-${DEV_STORAGE:-$HOME/.llamactl}/residency/operations.sqlite}"
sqlite3 "$STORE" ".backup $BACKUP_DIR/operations.sqlite"
sqlite3 "file:$BACKUP_DIR/operations.sqlite?mode=ro&immutable=1" "PRAGMA integrity_check;"
```

Restore only with the agent stopped, and back up the workloads dir in the same breath. The store holds profile-switch ops (`profile-switch:<node>`), fenced eviction intent (#710, `packages/remote/src/residency/eviction-operation.ts`), lease audit (#686) and the `desiredRevision` watermark (#676). `residency status` reads it read-only via `readResidencyStoreSnapshot`.

## Desired-state ownership

`ModelRun`, `ModelHost` and `NodeRun` manifests live in `defaultWorkloadsDir`: `LLAMACTL_WORKLOADS_DIR`, else `<home>/workloads` (`packages/remote/src/workload/store.ts`). The manifest store is central to the control plane: every read and write of desired state flows through it (`packages/cli/src/commands/_workload-resolve.ts`).

Writers are `llamactl apply -f`, `llamactl enable` and `llamactl disable`, and `llamactl controller serve`. The controller reconciles every manifest, so it owns `spec.enabled`. `.controller.lock` in the workloads dir (`packages/remote/src/workload/lock.ts`) blocks a second controller on the same dir; a stale lock is stolen when its pid is dead. Hosts labelled `llamactl.io/managed-by` are skipped on every pass (`MANAGED_BY_LABEL` in `packages/remote/src/workload/modelhost-schema.ts`). Without `--force`, `llamactl controller serve` refuses to start while any labelled ModelHost exists. `--force` only lets the controller start anyway; it does not override the skip, so labelled hosts stay skipped on every pass and are logged as `skipped-external` with their managing controller (`packages/cli/src/commands/controller.ts`):

```sh
llamactl controller serve --force
```

To hand a host back to this controller, delete the `llamactl.io/managed-by` label from the host's `<name>.yaml` in the workloads dir (`modelHostPath` in `packages/remote/src/workload/modelhost-store.ts`); an empty or whitespace-only value also counts as unlabelled (`externalManagerOf`). The reconciler re-reads that file before each host (`reconcileModelHost` in `packages/remote/src/workload/reconciler.ts`), so the next pass reconciles it. Pushing the manifest inline without the label does not clear it: the agent keeps the label already on disk (`mergeDiskManagedByLabel` in `packages/remote/src/server/modelhost.ts`).

The ownership guard in `residencyApplyProfile` (`packages/remote/src/router.ts`) refuses a live write with `NotServingNode` when `LLAMACTL_NODE_NAME` does not equal the target node, and with `ControllerActive` when `liveLockHolder` of the workloads dir reports a live pid.

What `apply-profile` persists matters for that guard. In `packages/remote/src/residency/apply-profile.ts` (`saveWorkload`) it writes the workload `status` section only, never `spec.enabled`. So a live controller would reconcile `spec.enabled` back and undo a manual switch on its next pass; that is why the guard rejects the write while a controller lock is live.

## Lease registry, drain and force-unload

The lease registry is opt-in via `LLAMACTL_RESIDENCY_LEASES` set to `1` or `true` (`packages/cli/src/commands/agent.ts`). `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is honored only with leases on. Unload a workload explicitly:

```sh
llamactl residency force-unload <workload> --reason <text> --yes --node <name>
```

Results are `Unavailable` when there is no registry, plus `UnknownWorkload`, `DrainInProgress` and `AlreadyUnloaded` (`packages/remote/src/residency/force-unload.ts`). An idle unload writes no audit row.

### Session affinity

Session handling (affinity and id validation) applies only when `LLAMACTL_RESIDENCY_LEASES` is on AND `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is set: `maybePublishResidencyLeases` in `packages/remote/src/server/serve.ts` installs the session registry only then, and `proxyOpenAI` acquires a session only when the header id, the session registry and the lease registry are all present. Under that condition the `x-llamactl-session` header carries a session id of at most 128 chars matching `[A-Za-z0-9._:-]`, and an invalid id gets `400` `InvalidSessionId`; otherwise the header is ignored. The first local, non-withdrawn candidate the session is already bound to wins, and that check runs ahead of the ranked hint and the #518 experimental ordering. Peers are never consulted. A bound candidate whose readiness verdict is false leaves selection unchanged, and acquisition then refuses with `409` `AffinityConflict` (not a warming `503`). The node stop fence (`packages/remote/src/residency/stop-fence.ts`) refuses a stop with live sessions as `SessionsActive`, or `SessionsUnknown` when the registry throws, and cancels the drain. Eviction never releases sessions; `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` is the override, and its result lists `releasedSessions` (#729, #722). The human output adds `Forced unload: released <n> session(s): <ids>` only when sessions were released; an agent older than #722 omits `releasedSessions`, so the line is skipped (#750).

To drop one session binding without unloading anything, run `llamactl residency release-session <sessionId> --yes --node <name>` (#755). It sends one `residencyReleaseSession` mutation (`packages/remote/src/router.ts`) to the serving process, which calls `releaseResidencySession` (`packages/remote/src/residency/force-unload.ts`); the release never drains, revokes leases or stops a workload. The id follows the same bounds as the session header: at most 128 chars matching `[A-Za-z0-9._:-]`. An idle binding (refs 0) is dropped. A binding with in-flight requests refuses as `SessionInFlight` unless `--force` is given; a forced release drops only the binding, so the DF-05 leases of its in-flight requests stay held and `LeasesActive` still fences their stop. A dropped entry is deleted from the registry (`releaseSession` in `packages/core/src/residency/sessions.ts`): the late release of a force-released request is a no-op, and the next request carrying that id binds afresh with a new generation. The other refusals are `Unavailable` when no session registry is installed ("no session registry installed; nothing to release") or the registry has no per-session release, `SessionNotFound` for an unknown or idled-out id, and `SessionsUnknown` when the registry throws. Without `--yes` the CLI refuses before contacting the node, and `--node all` is refused. Success prints `Released session <id> (workload <workload>, <n> in-flight request(s))`, with `, forced; their leases stay held` appended inside the parentheses after a forced release; a refusal prints `residency release-session: <reason>: <detail>` and exits 1. No MCP tool exposes the release.

A request whose residency lease admission refuses gets `503` (`model_draining` for `Draining`, `model_not_loaded` for `Unloaded`) and undoes its session acquire through `cancelAcquire` (`packages/core/src/residency/sessions.ts`) instead of releasing it (`prepareSessionAndLease`/`acquireProxyResidencyLease` in `packages/core/src/openaiProxy.ts`). The refused request therefore neither binds a fresh session nor extends an idle binding: a session the refused acquire created is deleted when its refs reach 0, and otherwise the pre-acquire `lastActivityMs` is restored. That makes the post-drain session re-check of a wet switch (#730) defence in depth (#740).

### Stop-before-start refusals

When core `startServer` (`packages/core/src/server.ts`) starts a workload that already has a tracked instance, it first stops that instance under the DF-05 lease drain. With no lease registry, i.e. `LLAMACTL_RESIDENCY_LEASES` off, it stops as before. With the registry installed, a held lease refuses the restart as `LeasesActive` and a foreign drain refuses it as `DrainInProgress`. When the session registry is also installed (`LLAMACTL_RESIDENCY_SESSION_IDLE_MS` set; see Session affinity), a session bound to the tracked instance refuses the restart as `SessionsActive`, and a registry check that throws refuses it as `SessionsUnknown`; both apply only while the tracked instance is live, so a crashed or recycled instance never blocks. A refusal stops nothing and starts nothing, and the error reads `<reason>: <ids> — refusing to start <name> while a session is bound to its running instance`. The start never releases sessions, so the override is `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The registries live in the `agent serve` process (`packages/remote/src/server/serve.ts`), so the refusal applies to starts that run inside it, such as the agent's `serverStart` procedure (`packages/remote/src/router.ts`); a start in another process sees no registry and stops as before (#734).

When `startModelHost` (`packages/remote/src/server/modelhost.ts`) finds a live prior host it tears that host down under the same DF-05 drain core's stop-before-start uses (#734 parity, #520). "Finds a live prior host" covers the recorded pid, whatever its spec hash, and an adopted listener whose recorded launch spec drifted from the applied spec. `LeasesActive`, `DrainInProgress`, `SessionsActive` and `SessionsUnknown` refuse the restart — nothing is torn down and nothing is spawned — with the tails "refusing to restart ModelHost <name> while a session is bound to its running instance" for the session refusals and "refusing to restart ModelHost <name> while residency leases are held" for the lease and drain refusals. With no lease registry the restart runs as before. Sessions are never released, so the override is `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The fence applies to any start that finds a live prior host inside the `agent serve` process: the agent's `modelHostStart` procedure (`packages/remote/src/router.ts`), and `llamactl apply -f` or `llamactl enable` of a ModelHost that reach it (#520).

## Status, plan and apply-profile

```sh
llamactl residency status --node <name>
llamactl residency plan --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>] --execute --yes
```

`apply-profile` is dry-run by default; `--execute --yes` runs it. `--node` and `--to` are required on both `plan` and `apply-profile` (the `USAGE` in `packages/cli/src/commands/residency.ts`); `[--from <profile>]` is optional, so drop it or fill it in. It returns `Busy` when a switch is already in flight (`inFlightBusy` in `packages/remote/src/residency/apply-profile.ts`, and `packages/remote/src/residency/profile-transition.ts`). Profile membership comes from the annotations `llamactl.io/residency-profiles` and `llamactl.io/residency-protected`; a workload with no annotation is treated as protected (`packages/remote/src/residency/coordinator.ts`).

`llamactl residency status --node <name>` also reports a lifecycle section scoped to the serving process; the `residencyStatus` procedure and the MCP tool do the same. The section holds the node-local `residency_states` rows: model, state, group, whether the state is occupying, and version. Exclusive-group violations are computed with `findExclusiveGroupViolations` over `RESIDENCY_GROUPS`. An unreadable store reports `StoreUnreadable`; a failed lifecycle-row read reports `LifecycleUnreadable`, which degrades only this section. The human output prints a `Lifecycle:` line and an `Exclusive:` line, and `Exclusive:` reads "no violations" or "violation in <group>: <members>". These rows belong to the serving process, not to the target node's coordinator state, the same as the store (`buildResidencyLifecycleSnapshot` in `packages/remote/src/residency/procedures.ts`, and `pushLifecycleLines` in `packages/cli/src/commands/residency.ts`) (#731).

`llamactl residency status --node <name>` also prints a `Sessions:` section from the serving process's session registry (`pushSessionLines` in `packages/cli/src/commands/residency.ts`, #750). The header reads `Sessions:   <n> bound (idle timeout <t>; scope: serving-process)`, followed by one `<workload>  <sessionId>  refs <n>  in flight|expires in <t>` line per session: a session with refs above 0 is `in flight` and has no expiry, while a session at refs 0 shows the rest of its idle-timeout window. Only live sessions are listed (expired ones are pruned first), most recently active first. The `residencyStatus` procedure, and the MCP tool that returns its result, carry the same data as a `sessions` section built by `buildResidencySessionSnapshot` in `packages/remote/src/residency/procedures.ts`: `status`, `scope` `serving-process`, `idleTimeoutMs`, and per session `sessionId`, `workload`, `refs`, `idleMs` and `expiresInMs` (`null` while in flight). The registry is installed only when `LLAMACTL_RESIDENCY_LEASES` is on AND `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is set (see Session affinity); without it the section reads `unavailable` with `NoRegistry` ("no session registry installed"), a snapshot that throws reports `SessionsUnknown` ("session registry unreadable"), and a registry without a snapshot reports `SnapshotUnsupported` ("session registry has no snapshot"). Unlike `idleEviction`, the section is not limited to the serving node: whatever `--node` names, it shows the serving process's registry.

With the lease registry on (`LLAMACTL_RESIDENCY_LEASES`), a wet `apply-profile` checks each victim against the installed session registry at fence time, and it checks idle victims again after the drain window, before any stop runs (`packages/remote/src/residency/profile-transition.ts`). A victim with a bound session fails the fence or drain step with detail `SessionsActive: <ids>`; if the registry throws, the detail is `SessionsUnknown`. The operation is recorded `failed`, and no stop or start runs. The switch never releases sessions, so unloading a session-bound victim needs the override `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (see Session affinity). The session registry is installed only when `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is also set; without it, no session check runs (#730).

With the lease registry on, a dry run (`apply-profile` without `--execute`) checks each victim against the installed session registry without draining. A session-bound victim's planned fence step then carries detail `SessionsActive: <ids>` (`SessionsUnknown` if the registry throws). This is advisory: the outcome stays `dry-run`, and nothing drains, stops or starts. The human output prints `<workload> (planned; <detail>)`, and a failed wet switch prints `residency apply-profile: failed: <action> <workload>: <detail>` (#520).

`plan` and `apply-profile` also refuse with `Cooldown` within `switchCooldownSeconds` of the node's last succeeded switch recorded in the residency store; see the [NodeRun residency policy knobs](#noderun-residency-policy-knobs) table (#732).

## Direct ModelHost start and stop

The agent's `modelHostStart` and `modelHostStop` procedures (`packages/remote/src/router.ts`) wrap `startModelHost`/`stopModelHost` in `runDirectResidencyStart`/`runDirectResidencyStop` (`packages/remote/src/residency/direct-lifecycle.ts`). `llamactl apply -f` and `llamactl enable` of a ModelHost reach `modelHostStart` (`startModelHostProcess` in `packages/remote/src/workload/apply.ts`), and `llamactl disable` (`disableModelHost`) or deleting a ModelHost reaches `modelHostStop`. The agent's ModelRun `serverStart` and `serverStop` procedures wrap `startServer`/`stopServer` the same way (#517), recording the group from the agent-side ModelRun `llamactl.io/residency-group` label, and deleting a ModelRun reaches `serverStop` (`stopWorkloadForDelete`). A profile switch's own `applyManifest` calls run inside `runInResidencySwitchScope`, where the wrapper neither records nor refuses, because the switch's walk owns the row.

A node with no store file runs the start or stop unrecorded and never creates the store. Otherwise the wrapper claims the shared apply-profile fence and walks the `residency_states` row through the same `withResidencyLifecycle` hops as a profile switch (`packages/remote/src/residency/lifecycle-steps.ts`). A label naming an undeclared group records no group.

A same-group `ready` peer is reconciled to downloaded only when it is proven down: a known ModelHost that reads Stopped with its identity resolved, or a known ModelRun with no recorded pid file or whose recorded pid is provably gone (`dead` or `reused`). Any other occupying same-group row refuses the start with `ExclusiveGroupOccupied`, as `residency lifecycle refused <name> <from> -> <to>: ExclusiveGroupOccupied: <detail>`, before the engine runs. A nonterminal profile switch refuses a start with `residency lifecycle refused <name>: profile switch in flight on this node; retry after it settles`. A grouped start whose store cannot be opened or claimed refuses with `store unavailable (<message>)`.

A workload already running with a `ready` row is adopted and kept ready.

A direct stop runs its stop before the row moves, so an occupying row keeps its exclusive group held for the whole stop. A confirmed stop walks the row `ready` -> `draining` -> `unloading` -> `downloaded`. An unconfirmed stop (the process may still be alive) is not recorded: the row stays occupying, so a same-group start is still refused, and the agent logs `[residency] lifecycle <name> stop not recorded: unconfirmed stop (process may be alive)`. A stop that throws is recorded `failed` and the error is rethrown. Bookkeeping never blocks a stop: a stop whose claim or walk fails still runs and logs `[residency] lifecycle <name> stop not recorded: …` on the agent's stderr.

Known limits: a `ready` ModelRun row whose recorded pid is still alive, or whose identity cannot be verified (`unknown`), is never proven down, so it fails closed and refuses same-group starts. `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` routes its `stopModelHost`/`stopServer` through `runDirectResidencyStop` after the lease drain commits, so a confirmed force-unload walks the row to `downloaded` and an unconfirmed one leaves it occupying (#517). Read rows with `llamactl residency status --node <name>`.

ModelRun proof uses `isServerProvenDown` (`packages/core/src/server.ts`), which checks the recorded pid against its pid file with the same identity check `stopServer` uses and never deletes the pid file; agent boot recovery uses the same predicate through `directWorkloadProvenDown`.

## Operator-initiated idle eviction

`idleEvictSeconds` is advisory: `residencyStatus` reports the `idleEviction` window, but the runtime never evicts or sleeps a resident on its own. The operator drives eviction (#519). A dry run routes one `residencyEvictIdle` query on the serving node, reports the window and the would-evict rows, and touches nothing:

```sh
llamactl residency evict-idle --node <name> [--json]
```

With `--yes` the CLI first stamps the durable `llamactl.io/idle-evicted-at` hold on each targeted local manifest, then re-runs the eviction so the agent re-checks each target against the live lease registry and stops it through the same fenced path `serverStop`/`modelHostStop` use (the lifecycle walk plus lease drain). The hold keeps the reconciler from starting an evicted workload back:

```sh
llamactl residency evict-idle --node <name> --yes [--json]
```

A workload that resumed activity before its stop is skipped `NoLongerIdle`; a stop the fence refuses is skipped `StopRefused` and its hold is cleared, so the running workload stays up; a stop that throws is skipped `StopFailed`. Only rows that come back `evicted` keep the hold, and workloads with no local manifest are reported `NotHeld` and never targeted.

With the session registry installed (#520), a workload bound to a session — idle within its timeout or in flight — is skipped `SessionsActive` with the session ids as detail in both the dry run and the wet run, so no idle hold is stamped and no drain starts; a registry whose session check throws is skipped `SessionsUnknown`. Eviction never releases sessions — the overrides are `residency release-session` and `residency force-unload`.

To let a held workload load again, clear the hold:

```sh
llamactl residency release-idle <workload> [--json]
```

A disabled residency, a non-serving node or an unreadable store reports `ok: false` (`Disabled`, `NotServingNode`, `LeasesUnavailable`, `StoreUnreadable`, `LifecycleUnreadable`) and stops nothing.

A resident that is idle-due but has not yet been ready for `minResidencySeconds` is skipped `MinResidency` until it has been ready for `minResidencySeconds`; the status `dueAtMs` is the later of the two windows.

## Cancel and crash recovery

```sh
llamactl residency cancel-operation <operationId> --yes --node <name>
```

Cancel is process-local and aborts at the next step boundary (`packages/remote/src/residency/apply-profile.ts` header). Boot recovery is `runProfileSwitchBootRecovery` (`packages/remote/src/residency/boot-recovery.ts`), wired into the agent start in `packages/remote/src/server/serve.ts`. It terminalizes `profile-switch` rows with no step progress for 30 minutes (`PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS`). A younger crashed row keeps the node `Busy` until a later boot. There is no opt-in flag. On a claimed pass, the same boot recovery also moves `residency_states` lifecycle rows left in `loading`, `warming`, `draining` or `unloading` to `failed` via `failInterruptedLifecycleRows`, under the profile-switch fence, which frees exclusive-group capacity. A claimed pass happens only when a stale profile-switch row exists. When the store holds no nonterminal operation row, boot recovery also sweeps lifecycle rows interrupted outside a switch (for example a direct start whose agent died in `loading`) once they have made no progress for 30 minutes and their workload is proven down by `directWorkloadProvenDown`; a younger row, a workload not proven down, or any nonterminal operation row leaves them untouched. This gate fails closed: `evict:` operation rows have no boot recovery yet, so a crashed eviction's nonterminal `evict:` row keeps the outside-a-switch sweep off on every later boot until that row is terminalized. Meanwhile clear a stuck interrupted row by hand with an operator stop or `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`, which an `evict:` row does not block. Per-row refusals and write failures are counted without stopping the sweep. When the sweep moved a row or recorded a failure, the agent logs `[residency] lifecycle boot recovery {"failed":N,"recordFailures":M}` after the profile-switch line on a claimed pass, and on its own when only the orphan sweep ran, with no profile-switch line; that line carries counts only, with no model or group names (#736); see [dynamic fleet models](dynamic-fleet-models.md).

## Request admission

`LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS` is opt-in. `LLAMACTL_CHAT_ADMISSION_MAX_QUEUED` uses the literal default 16 (`CHAT_ADMISSION_DEFAULT_MAX_QUEUED`, `packages/cli/src/commands/agent.ts`). One cap is shared by the agent's `/v1/chat/completions`, `/v1/messages`, `/v1/responses` and generic `/v1/completions` (#712), by worker RPC streams (#709), and by the router's local chat: `chatComplete`/`chatStream` on `inproc://local`, whether reached over `/trpc` or relayed through the tunnel client (#712). The in-process RAG via-forward is covered by its outer HTTP slot. Overload gets `429`/`503`.

Not counted yet: the `UNCOUNTED BY DESIGN` and `DEFERRED` blocks in `packages/remote/src/server/chat-admission.ts` name what the cap does not cover.

Uncounted by design:

- /v1/embeddings and RAG embedding, because an embedder call nested inside an admitted chat would self-deadlock.

Deferred:

- /v1/rerank and other generic /v1/\* POSTs;
- the planner local provider (router.ts resolvePlannerProvider);
- fairness between the ingresses that share the cap;
- physical per-node accounting;
- per-model keys with real load coalescing;
- per-principal shares;
- a total request deadline;
- Anthropic-shaped error bodies.

To disable, unset the vars and restart the agent (`packages/cli/src/commands/agent.ts` help):

```sh
llamactl agent serve
```

## Declared models and readiness

`LLAMACTL_DECLARED_MODELS` set to `1` turns on declared-model projection (`packages/cli/src/commands/agent.ts`). The states are `DeclaredModelStateSchema` (`packages/core/src/routing/catalog.ts`): `cold`, `loading`, `ready`, `draining`, `disabled` and `unavailable`. Ids depend on the kind (`packages/remote/src/residency/catalog.ts`): a `ModelHost` claims the `rel` of its first hosted model plus `basename(rel)` (`hostClaimIds`), and a `ModelRun` claims `spec.target.value` plus each `--alias`/`-a` value in `spec.extraArgs`, with no basename (`runClaims`, `aliasIdsFromExtraArgs`). A model is unavailable only on alias-collision.

A declared entry can also carry a stale reason from `DECLARED_STALE_REASONS` (`packages/core/src/routing/catalog.ts`, #711) when its id is live but the live route disagrees with the manifest: `stale-owner-epoch` when the id is live but the claiming workload has no live route, and `stale-artifact-revision` when the manifest model differs from the model the workload's first live route serves. Only `cold`, `ready` and `loading` claims are checked, so `draining` and `disabled` suppress the reason. A stale entry projects as `cold`, and the proxy (`packages/core/src/openaiProxy.ts`) refuses a routed pin of that id with `503` (`model_not_loaded`, carrying the `reason`) instead of forwarding it to the engine.

`spec.readiness { path, expectStatus, expectJson }` on `ModelHost` (`packages/remote/src/workload/modelhost-schema.ts`) and on `ModelRun` (#695, `packages/core/src/server.ts`) gates routes. When `apiKeyRef` is set, the readiness path is restricted to unauthenticated llama-server paths.

## Model artifact and cache identity

Artifact identity today is the manifest model name only (`packages/remote/src/residency/catalog.ts`): a `ModelHost` keys off its first hosted model's `rel` and its `basename`, and a `ModelRun` keys off `spec.target.value` and its `--alias`/`-a` values, nothing else. Since #711 declared-model projection compares that manifest model string with the model a live route reports and marks a mismatch `stale-artifact-revision`, and a live id owned by another workload `stale-owner-epoch` (both in `DECLARED_STALE_REASONS`); a routed pin of a stale id gets `503`. That comparison is still by name. Nothing hashes model files or tracks their revision at readiness or at declared-model projection, so replacing weights in place under the same `rel` is invisible; publish new weights under a new `rel`. `MemoryCalibrationKey.artifactRevision` (`packages/core/src/resources/memory.ts`) gates measured envelopes only through an injected hook, and `getCandidateCalibrationKey` has no production caller. For oMLX, the cache identity (modelId, `engineBuild`, `cacheEpoch`, the artifact `sha256` or size/mtime, and settings) lives in `packages/core/src/engines/omlx-cache-identity.ts`, and `decideOmlxCacheRetention` has no production caller. For native load/unload, `createManagedOmlxResidency` has no production caller (`packages/remote/src/residency/omlx-managed.ts`).

## llama.cpp sleep and wake

The library is in `packages/remote/src/residency/llamacpp-sleep-client.ts` and `packages/remote/src/residency/llamacpp-wake-client.ts`. `modelHostStatus` reports a recorded sleep (#706), and the reconciler leaves a sleeping host alone (#701). `setNodeLlamacppSleepController` has no production caller (`packages/remote/src/residency/llamacpp-sleep-status.ts`), so nothing puts a host to sleep in production and there is no idle trigger.

## NodeRun residency policy knobs

These keys come from `ResidencyPolicySchema` (`packages/remote/src/workload/noderun-schema.ts`) and are consumed by the admission logic in `packages/core/src/residency/admission.ts` (#690). The status column says whether a value is enforced at runtime, fed only to the planner, applied only at candidate ranking, acted on only when the operator runs `residency evict-idle` (`operator-only`), reported in `residencyStatus` but not acted on (`status-only`), validated and persisted but ignored, or reserved for future use. `ranking-only` means `rankRouteCandidates` (`packages/core/src/routing/ranking.ts`) applies the knob when the unified proxy is given its `residencyPolicy` option (`createProxy` in `packages/remote/src/proxy/create-proxy.ts`) and resident ranking signals. `dispatchProxyRequest` builds `sharedProxy` with `createSharedUnifiedProxy()` (Part of #519): it supplies the serving node's NodeRun `residencyPolicy` (the NodeRun selected by `LLAMACTL_NODE_NAME`) and resident signals built from the node-local residency store's `ready` lifecycle rows, and both only apply when `LLAMACTL_UNIFIED_PROXY` is set to `1` and the selected NodeRun has a nonzero ranking knob. Only workloads with a `ready` `residency_states` row count as resident: a local workload with no lifecycle row, and all peers, rank as non-resident. The NodeRun and store reads are cached for 5 seconds.

| Key                     | Status        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safetyMarginRatio`     | enforced      | Applied to computed headroom when admitting a load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `minResidencySeconds`   | enforced      | Refuses `residencyPlan` / `apply-profile` with `MinResidency` while a victim's residency store lifecycle row has been `ready` for fewer than this many seconds; 0 disables. It also holds an idle-due resident in `residency evict-idle` as `MinResidency` until it has been ready for this many seconds.                                                                                                                                                                                                                        |
| `switchCooldownSeconds` | enforced      | Refuses `residencyPlan` / `apply-profile` with `Cooldown` until this many seconds after the node's last succeeded profile switch recorded in the residency store; 0 disables.                                                                                                                                                                                                                                                                                                                                                    |
| `idleEvictSeconds`      | operator-only | `residencyStatus` reports an advisory `idleEviction` window from ready lifecycle rows and serving-process lease activity, only when `node` is the serving node; nothing evicts or sleeps on its own. The operator drives eviction with `residency evict-idle`, which stops a still-idle resident behind the durable `llamactl.io/idle-evicted-at` hold the reconciler honours; a workload that resumed activity before its stop is skipped `NoLongerIdle`, and `release-idle` clears the hold. Activity resets on agent restart. |
| `residentPreference`    | ranking-only  | Applied by `rankRouteCandidates` when the proxy is given `residencyPolicy` and resident signals; inert at 0.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `coldLoadPenaltyMs`     | ranking-only  | Applied by `rankRouteCandidates` when the proxy is given `residencyPolicy` and resident signals; inert at 0.                                                                                                                                                                                                                                                                                                                                                                                                                     |

When the unified ranker's pick differs from catalog order and is a local-http replica owned by this node, `gatedExecute` sets `preferredLocalWorkload`. The legacy local executor forwards it to `proxyOpenAI` as the `preferredWorkload` option (#728). `servingRouteForModel` lifts that workload to the head of the live candidates after the withdrawn filter; readiness still applies. Peers never match, and an experimental match does not lead while any non-experimental candidate is live.

A verified `--evict` victim (or one named by the `llamactl.io/evict` annotation) whose node-local `residency_states` row has been `ready` for fewer than `minResidencySeconds` is refused `EvictMinResidency` before any intent marker, stop or start; an unreadable residency store or lifecycle read refuses `EvictMinResidencyUnknown` rather than evicting blind. The serving process's own store counts when `LLAMACTL_NODE_NAME` names the victim's node; otherwise (a CLI or controller evicting on another node, or an anonymous serving process) the gate reads the victim node's `residencyStatus` `lifecycle` section through the apply's node client, bounded at 10 seconds. An unavailable `lifecycle` section, or a failed or timed-out read, refuses `EvictMinResidencyUnknown`, while a payload with no `lifecycle` section (an agent that predates lifecycle rows) reports no ready row and evicts unprotected. An explicit readiness seam still wins. `minResidencySeconds` of 0 disables the gate.

Under `createSharedUnifiedProxy` (Part of #518), `switchCooldownSeconds` also feeds the ranker's `cooldownUntil` signal. The signal is measured from the residency store's `lastSucceededAtMs` entry for `profile-switch:<node>`, where `<node>` is `LLAMACTL_NODE_NAME`: a local candidate without a `ready` lifecycle row is charged the remaining cooldown against its stage-quality score, while peers and resident candidates are not charged. An absent, errored or lifecycle-unreadable store charges nothing. The NodeRun and store reads keep the 5-second cache.

## Cleanup of conflicting legacy launchers

First run `git grep -n keepAlive packages/remote/src/workload`. It finds nothing, so the controller does not detect a keep-alive supervisor and you must inventory by hand. Inventory with `llamactl keep-alive status` and `llamactl server status`:

```sh
llamactl keep-alive status
llamactl server status
llamactl keep-alive stop
llamactl server stop
```

Inventory the default agent label `com.llamactl.agent` (and `.daemon`) in `packages/cli/src/commands/agent-install/index.ts`, any second controller (the `.controller.lock` guard only protects the same dir), and any controller unit (`self-update.md`). The supervisor tooling lives in `packages/cli/src/commands/keepAlive.ts`.

The operator removes them with `llamactl keep-alive stop` and `llamactl server stop` plus `launchctl bootout` and `systemctl disable`. Mark hosts owned elsewhere with `llamactl.io/managed-by` so the controller skips them.

## Staged enable order and rollback

### Stage 0 - inventory and dry-run

Inventory the node, then read the plan. No writes.

```sh
llamactl residency status --node <name>
llamactl residency plan --node <name> --to <profile> [--from <profile>]
```

Enable gate: the `residency plan` output is reviewed and the store is backed up. Rollback: none needed; nothing was written.

### Stage 1 - manual switch

Make a one-off switch and abort if it misbehaves. The controller lock must not be live (see the `ControllerActive` guard). Run the dry run first and read its report, then the wet run; cancel by the operation id the wet run reports.

```sh
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>] --execute --yes
llamactl residency cancel-operation <operationId> --yes --node <name>
```

Enable gate: a single profile switch succeeds and `residency status` agrees. Rollback: run cancel-operation, then `llamactl apply -f` the prior manifest from the control plane.

### Stage 2 - request-driven admission and declared models

Turn on request admission and declared models in the agent's environment, then restart the agent. Both are read once at `agent serve` startup (`packages/cli/src/commands/agent.ts`). For an agent run in the foreground:

```sh
export LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS=<n>
export LLAMACTL_DECLARED_MODELS=1
llamactl agent serve
```

For the default user LaunchAgent `com.llamactl.agent`, whose plist `agent install-launchd` writes to `~/Library/LaunchAgents/com.llamactl.agent.plist` with an `EnvironmentVariables` dict (`packages/cli/src/commands/agent-install/index.ts`), set the keys in the plist and reload it:

```sh
PLIST="$HOME/Library/LaunchAgents/com.llamactl.agent.plist"
plutil -replace EnvironmentVariables.LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS -string "<n>" "$PLIST"
plutil -replace EnvironmentVariables.LLAMACTL_DECLARED_MODELS -string 1 "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

Enable gate: 429 and 503 appear only under real overload and declared states match readiness. Rollback: unset `LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS` and `LLAMACTL_DECLARED_MODELS` (`plutil -remove EnvironmentVariables.<key> "$PLIST"` for the LaunchAgent) and restart the agent.

### Stage 3 - native unload/wake

BLOCKED: the sleep/wake controllers and managed oMLX residency have no production caller (see above), so there is nothing to enable here yet. Enable gate: blocked until a caller is wired. Rollback: blocked; nothing is on.
