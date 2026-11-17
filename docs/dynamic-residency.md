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

The `x-llamactl-session` header carries a session id of at most 128 chars matching `[A-Za-z0-9._:-]`; an invalid id gets `400` `InvalidSessionId`. Affinity applies only when `LLAMACTL_RESIDENCY_LEASES` is on AND `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is set: `maybePublishResidencyLeases` in `packages/remote/src/server/serve.ts` installs the session registry only then. The first local, non-withdrawn candidate the session is already bound to wins, and that check runs ahead of the ranked hint and the #518 experimental ordering. Peers are never consulted. A bound candidate whose readiness verdict is false leaves selection unchanged, and acquisition then refuses with `409` `AffinityConflict` (not a warming `503`). The node stop fence (`packages/remote/src/residency/stop-fence.ts`) refuses a stop with live sessions as `SessionsActive`, or `SessionsUnknown` when the registry throws, and cancels the drain. Eviction never releases sessions; `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` is the override, and its result lists `releasedSessions` (#729, #722).

## Status, plan and apply-profile

```sh
llamactl residency status --node <name>
llamactl residency plan --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>] --execute --yes
```

`apply-profile` is dry-run by default; `--execute --yes` runs it. `--node` and `--to` are required on both `plan` and `apply-profile` (the `USAGE` in `packages/cli/src/commands/residency.ts`); `[--from <profile>]` is optional, so drop it or fill it in. It returns `Busy` when a switch is already in flight (`inFlightBusy` in `packages/remote/src/residency/apply-profile.ts`, and `packages/remote/src/residency/profile-transition.ts`). Profile membership comes from the annotations `llamactl.io/residency-profiles` and `llamactl.io/residency-protected`; a workload with no annotation is treated as protected (`packages/remote/src/residency/coordinator.ts`).

## Cancel and crash recovery

```sh
llamactl residency cancel-operation <operationId> --yes --node <name>
```

Cancel is process-local and aborts at the next step boundary (`packages/remote/src/residency/apply-profile.ts` header). Boot recovery is `runProfileSwitchBootRecovery` (`packages/remote/src/residency/boot-recovery.ts`), wired into the agent start in `packages/remote/src/server/serve.ts`. It terminalizes `profile-switch` rows with no step progress for 30 minutes (`PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS`). A younger crashed row keeps the node `Busy` until a later boot. There is no opt-in flag.

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

These keys come from `ResidencyPolicySchema` (`packages/remote/src/workload/noderun-schema.ts`) and are consumed by the admission logic in `packages/core/src/residency/admission.ts` (#690). The status column says whether a value is enforced at runtime, fed only to the planner, applied only at candidate ranking, validated and persisted but ignored, or reserved for future use. `ranking-only` means `rankRouteCandidates` (`packages/core/src/routing/ranking.ts`) applies the knob when the unified proxy is given its `residencyPolicy` option (`createProxy` in `packages/remote/src/proxy/create-proxy.ts`) and resident ranking signals. No production caller supplies `residencyPolicy` or resident signals yet: `dispatchProxyRequest` in `packages/remote/src/proxy/create-proxy.ts` builds `sharedProxy` with `createProxy()` only when `LLAMACTL_UNIFIED_PROXY` is set to `1`, and passes no `residencyPolicy`, so NodeRun values for these two keys have no runtime effect until that wiring lands.

| Key                     | Status       | Meaning                                                                                                      |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `safetyMarginRatio`     | enforced     | Applied to computed headroom when admitting a load.                                                          |
| `minResidencySeconds`   | planner-only | Passed to the profile-switch planner only.                                                                   |
| `switchCooldownSeconds` | planner-only | Passed to the profile-switch planner only.                                                                   |
| `idleEvictSeconds`      | parse-only   | Validated and persisted, but there is no idle trigger to enforce it.                                         |
| `residentPreference`    | ranking-only | Applied by `rankRouteCandidates` when the proxy is given `residencyPolicy` and resident signals; inert at 0. |
| `coldLoadPenaltyMs`     | ranking-only | Applied by `rankRouteCandidates` when the proxy is given `residencyPolicy` and resident signals; inert at 0. |

When the unified ranker's pick differs from catalog order and is a local-http replica owned by this node, `gatedExecute` sets `preferredLocalWorkload`. The legacy local executor forwards it to `proxyOpenAI` as the `preferredWorkload` option (#728). `servingRouteForModel` lifts that workload to the head of the live candidates after the withdrawn filter; readiness still applies. Peers never match, and an experimental match does not lead while any non-experimental candidate is live.

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
