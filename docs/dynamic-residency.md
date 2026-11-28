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
- Managed launch calibration for supported llama.cpp and Kapitsa inputs.

Library-only (no production wiring):

- The llama.cpp sleep/wake clients and the sleep-status recorder.
- The managed oMLX residency and the oMLX cache-retention decision.

## Residency store and backups

The store path comes from `defaultResidencyStorePath` (`packages/remote/src/residency/store.ts`). The `LLAMACTL_RESIDENCY_STORE` override wins outright. Otherwise the path is `llamactlHome + residency/operations.sqlite`, where `llamactlHome` is `$DEV_STORAGE` or `~/.llamactl` (`packages/core/src/config/env.ts`).

The store is node-local SQLite in WAL mode: `openDb` sets `journal_mode = WAL`. Back up with `sqlite3` `.backup`, because the `-wal` and `-shm` sidecars hold uncheckpointed rows a plain file copy would drop, then verify the copy read-only with `file:<copy>?mode=ro&immutable=1`. Resolve the path the same way the agent does, in a shell that carries the agent's `LLAMACTL_RESIDENCY_STORE` and `DEV_STORAGE` (the shell `:-` fallbacks treat only an empty value as unset, while the code also trims, so a whitespace-only value counts as unset in `llamactlHome` and `defaultResidencyStorePath` but not in this snippet):

```sh
STORE="${LLAMACTL_RESIDENCY_STORE:-${DEV_STORAGE:-$HOME/.llamactl}/residency/operations.sqlite}"
sqlite3 "$STORE" ".backup $BACKUP_DIR/operations.sqlite"
sqlite3 "file:$BACKUP_DIR/operations.sqlite?mode=ro&immutable=1" "PRAGMA integrity_check;"
```

Restore only with the agent stopped, and back up the workloads dir in the same breath. The store holds profile-switch ops (`profile-switch:<node>`), fenced eviction intent (#710, `packages/remote/src/residency/eviction-operation.ts`), lease audit (#686) and the `desiredRevision` watermark (#676). `residency status` reads it read-only via `readResidencyStoreSnapshot`.

A stopped agent can leave a model process running. Preserve the current store and its WAL while a switch, process generation or reservation remains unresolved. A backup is for disaster recovery after reconciling engine identities, capacity and desired state with the restored revision. A backup restore does not settle a profile switch.

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

To drop one session binding without unloading anything, run `llamactl residency release-session <sessionId> --yes --node <name>` (#755). It sends one `residencyReleaseSession` mutation (`packages/remote/src/router.ts`) to the serving process, which calls `releaseResidencySession` (`packages/remote/src/residency/force-unload.ts`); the release never drains, revokes leases or stops a workload. The id follows the same bounds as the session header: at most 128 chars matching `[A-Za-z0-9._:-]`. An idle binding (refs 0) is dropped. A binding with in-flight requests refuses as `SessionInFlight` unless `--force` is given; a forced release drops only the binding, so the DF-05 leases of its in-flight requests stay held and `LeasesActive` still fences their stop. A dropped entry is deleted from the registry (`releaseSession` in `packages/core/src/residency/sessions.ts`): the late release of a force-released request is a no-op, and the next request carrying that id binds afresh with a new generation. The other refusals are `Unavailable` when no session registry is installed ("no session registry installed; nothing to release") or the registry has no per-session release, `SessionNotFound` for an unknown or idled-out id, and `SessionsUnknown` when the registry throws. Without `--yes` the CLI refuses before contacting the node, and `--node all` is refused. Success prints `Released session <id> (workload <workload>, <n> in-flight request(s))`, with `, forced; their leases stay held` appended inside the parentheses after a forced release; a refusal prints `residency release-session: <reason>: <detail>` and exits 1. The MCP `llamactl.residency.releaseSession` tool (`packages/mcp/src/tools/residency.ts`) sends the same mutation inside the MCP server's own process: it takes `sessionId`, optional `force` and `confirm`, refuses without `confirm: true` before calling the router, returns a refusal as `isError` with the payload, audits each confirmed call, and is not in the Ops Chat dispatch.

The MCP `llamactl.residency.forceUnload` tool (`packages/mcp/src/tools/residency.ts`) sends the same `residencyForceUnload` mutation inside the MCP server's own process and returns `releasedSessions`; its dry run lists the session registry's current bindings for the workload as `wouldReleaseSessions` without releasing them (`[]` when no session registry is installed, `null` with `sessionsDetail` when the registry throws), and the real call still releases nothing when it refuses as `Unavailable`, `UnknownWorkload`, `DrainInProgress` or `AlreadyUnloaded`; `llamactl.residency.releaseSession` is the per-session alternative.

A request whose residency lease admission refuses gets `503` (`model_draining` for `Draining`, `model_not_loaded` for `Unloaded`) and undoes its session acquire through `cancelAcquire` (`packages/core/src/residency/sessions.ts`) instead of releasing it (`prepareSessionAndLease`/`acquireProxyResidencyLease` in `packages/core/src/openaiProxy.ts`). The refused request therefore neither binds a fresh session nor extends an idle binding: a session the refused acquire created is deleted when its refs reach 0, and otherwise the pre-acquire `lastActivityMs` is restored. That makes the post-drain session re-check of a wet switch (#730) defence in depth (#740).

`llamactl server stop` and `llamactl delete workload` report a node stop-fence refusal instead of a stop (#520). When the agent's `serverStop` returns `refused`, `server stop` prints `server stop: node <node> refused to stop <workload> (<reason>: <ids>); nothing was stopped` to stderr and exits 1; `--json` prints the result and also exits 1. A ModelRun `delete workload` prints `delete: node <node> refused to stop (<reason>: <ids>); manifest preserved` and keeps the manifest. `<reason>` is `LeasesActive`, `DrainInProgress`, `SessionsActive` or `SessionsUnknown`. Neither command releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`.

The agent's `keepAliveStop` procedure, which serves `llamactl keep-alive stop` on remote dispatch, now goes through the same node stop fence as `serverStop` (#520). A held lease or a bound session refuses it with `LeasesActive`, `DrainInProgress`, `SessionsActive` or `SessionsUnknown`, and the supervisor and its llama-server are left untouched. The refusal applies whether or not a supervisor is tracked, so stale tracking files are not cleaned while a session is bound; use `llamactl keep-alive status`, `llamactl residency release-session <sessionId> --yes --node <name>` or `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. A verified supervisor stop commits the unload. `llamactl keep-alive stop` prints `keep-alive stop: node <node> refused to stop <workload> (<reason>: <ids>); nothing was stopped` to stderr and exits 1; `--json` prints the result and also exits 1. It never releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The local in-process dispatch is not fenced yet.

The web console Stop dialog reports the same fence refusal (#520). `stopResultMessage` in `packages/app/src/console/actions/stop-server-model.ts` reads `refused` from the agent's `serverStop` result and shows `Stop refused by the node's stop fence (<reason>: <ids>); nothing was stopped` inline. The `: <ids>` part is dropped when the list is empty. For a session reason it names `residency release-session` and `residency force-unload`; for a lease or drain reason it names only `residency force-unload`. The dialog stays open and does not release sessions. An unconfirmed stop with no `refused` field still shows the pid-identity `Stop not confirmed` text.

`llamactl disable <workload>` reports the same refusal: it exits 1 with `disable: serverStop refused: <reason>: <ids>` for a ModelRun (the `: <ids>` part is left out when no ids are reported) or `disable: modelHostStop refused: <reason>: <ids>` for a ModelHost, nothing is stopped, and the manifest stays stored with `spec.enabled: false` (Part of #522).

`llamactl composite destroy` treats a node stop-fence refusal from `serverStop` as a component error: `destroyComposite` in `packages/remote/src/composite/apply.ts` records `serverStop on <node> refused (<reason>: <ids>); composite manifest preserved` (with the `: <ids>` part dropped when empty), leaves the workload out of `removed`, still tears down the other components, and returns `manifestPreserved` true. The `compositeDestroy` procedure then keeps the composite YAML instead of deleting it, rewrites its `status` to record the partial destroy (`phase: Degraded`, the prior `appliedAt`, and one `Failed` component per destroy error carrying its message, so a retry is explainable from `llamactl composite get`), and returns `manifestPreserved: true`; a destroy with no refusal deletes the YAML and returns `manifestPreserved: false`. The CLI prints `composite/<name> not destroyed: a workload stop was refused; manifest preserved` and exits 1. When `serverStop` returns a bare `stopped: false` without a `refused` detail (the node could not verify the pid identity, could not confirm the termination, or did not run the stop), destroy treats it as an unverified stop: `destroyComposite` records `serverStop on <node> refused (pid identity unverifiable); composite manifest preserved` and keeps the YAML, matching `workload delete`. To recover, check the engine on that node: if it is still running, stop it by hand; if it is gone, remove its stale pid record, then re-run the destroy. Destroy never releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (#520).

`llamactl composite apply` with `onFailure: rollback` (`applyComposite` in `packages/remote/src/composite/apply.ts`) reads the `serverStop` result when rollback tears down a started workload. A node stop-fence refusal (`LeasesActive`, `DrainInProgress`, `SessionsActive` or `SessionsUnknown`) emits `component-failed` with `rollback failed for workload/<node>: serverStop on <node> refused (<reason>: <ids>); workload left running`, and the `: <ids>` part is dropped when the list is empty. It also records the same text as the workload's status message, and keeps the component `Ready` because its engine is still running. When `serverStop` returns a bare `stopped: false` without a `refused` detail, rollback emits `rollback failed for workload/<node>: serverStop on <node> refused (pid identity unverifiable); workload left running` and keeps the component `Ready`. A transport error is still swallowed as before. Rollback never releases sessions. The overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`, then re-run the apply (#520).

A supervisor move's source removal treats a structured `workloadDelete` refusal (manifest preserved) as a failed removal. `llamactl supervisor serve` invokes `buildMigrationWorkloadOps` (`packages/cli/src/commands/supervisor.ts`), which wraps `workloadDelete` in `deleteFromNode` and checks the result through `workloadDeleteRefusal`: when the agent resolves `{ ok:false, error }` the move journals `remove failed: workloadDelete on <node> did not remove <workload>: <error>; will retry`, keeps the move in flight, and retries each tick until the source stops, where before it journalled the move `executed` while the source stayed loaded. The move never releases sessions. The overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (#520).

The ops-chat tool dispatch (`dispatchOpsChatTool` in `packages/remote/src/ops-chat/dispatch.ts`, served by `operatorRunTool`) reports a node stop-fence refusal as a failed run, covering three tools: `llamactl.server.stop` with code `stop_refused` and message `serverStop refused by the node stop fence (<reason>: <ids>); nothing was stopped` (the `: <ids>` part is dropped when the list is empty), `llamactl.workload.delete` with code `delete_refused` when the manifest is preserved, and `llamactl.composite.destroy` with code `destroy_refused` when `manifestPreserved` is true. The procedure payload stays in `result`, and the audit row records `ok: false` with the code. A stop with no fence reason, a delete of an already-gone manifest, and dry runs are unchanged. It never releases sessions. The overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The MCP `llamactl.server.stop` tool maps the same refusal instead of returning it raw: when the agent's result carries `refused`, the tool returns `isError` with the payload plus `code: stop_refused` and the message `serverStop refused by the node stop fence (<reason>: <ids>); nothing was stopped` (the `: <ids>` part is dropped when the list is empty), and its audit row records `ok: false` with that code instead of the raw result. A stop with no `refused` field and a dry run are unchanged. A refusal never releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. MCP `llamactl.composite.destroy` maps the same refusal: when `compositeDestroy` returns `manifestPreserved: true`, the tool returns `isError` with the payload plus `code: destroy_refused` and the message `composite/<name> not destroyed: a workload stop was refused; manifest preserved`, and the per-workload `errors` keep the fence reason and ids. Its audit row records `ok: false` with that code. A destroy with no refusal and a dry run are unchanged. A refusal never releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (#520).

A response-cache hit served for a session's bound local workload refreshes the binding through `touch` (`touchSessionOnCacheHit` in `packages/core/src/openaiProxy.ts`, #520), so a session answered from a warm cache does not idle-expire: it takes no ref and no lease, a session bound to another workload or a peer route is left untouched, and a registry that throws on `touch` still serves the cached response.

Under the unified proxy (`LLAMACTL_UNIFIED_PROXY` set to `1`), a request carrying a non-empty `x-llamactl-session` header whose ranked pick is a `worker-rpc` route runs on the legacy executor instead of the worker RPC (`gatedExecute` in `packages/remote/src/proxy/create-proxy.ts`, #520). The worker RPC is sessionless (`packages/remote/src/inference/procedures.ts` refuses a session envelope), so the request would take a lease on the owner, this node or a peer, but bind no session. On the legacy executor, `proxyOpenAI` binds the session locally or forwards the header to the owner, whose own `proxyOpenAI` binds it exactly as with the flag off. Ranking is not applied on this path: the legacy route map, with its session affinity, picks the replica. A request without the header, or with an empty one, keeps the worker RPC, and a `local-http` pick is unchanged.

The library-only oMLX native unload (`runUnloadWithLeases` in `packages/remote/src/residency/engine-client.ts`) consults the session registry the same way (#520): after a successful `beginDrain` and the `LeasesActive` check, which keeps precedence, `checkUnload` runs in the same synchronous tick; a live session refuses the unload as `SessionsActive` with the session ids in `active`, and a registry whose `checkUnload` throws refuses it as `SessionsUnknown`. Either refusal cancels the drain, sends no unload request and keeps the reservation `held`. `createAgentOmlxNativeClient` captures the installed session registry at construction, next to the lease registry. The native unload never releases sessions; like `createManagedOmlxResidency` it has no production caller yet.

### Stop-before-start refusals

When core `startServer` (`packages/core/src/server.ts`) starts a workload that already has a tracked instance, it first stops that instance under the DF-05 lease drain. With no lease registry, i.e. `LLAMACTL_RESIDENCY_LEASES` off, it stops as before. With the registry installed, a held lease refuses the restart as `LeasesActive` and a foreign drain refuses it as `DrainInProgress`. When the session registry is also installed (`LLAMACTL_RESIDENCY_SESSION_IDLE_MS` set; see Session affinity), a session bound to the tracked instance refuses the restart as `SessionsActive`, and a registry check that throws refuses it as `SessionsUnknown`; both apply only while the tracked instance is live, so a crashed or recycled instance never blocks. A refusal stops nothing and starts nothing, and the error reads `<reason>: <ids> — refusing to start <name> while a session is bound to its running instance`. The start never releases sessions, so the override is `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The registries live in the `agent serve` process (`packages/remote/src/server/serve.ts`), so the refusal applies to starts that run inside it, such as the agent's `serverStart` procedure (`packages/remote/src/router.ts`); a start in another process sees no registry and stops as before (#734).

When `startModelHost` (`packages/remote/src/server/modelhost.ts`) finds a live prior host it tears that host down under the same DF-05 drain core's stop-before-start uses (#734 parity, #520). "Finds a live prior host" covers the recorded pid, whatever its spec hash, and an adopted listener whose recorded launch spec drifted from the applied spec. `LeasesActive`, `DrainInProgress`, `SessionsActive` and `SessionsUnknown` refuse the restart — nothing is torn down and nothing is spawned — with the tails "refusing to restart ModelHost <name> while a session is bound to its running instance" for the session refusals and "refusing to restart ModelHost <name> while residency leases are held" for the lease and drain refusals. With no lease registry the restart runs as before. Sessions are never released, so the override is `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The fence applies to any start that finds a live prior host inside the `agent serve` process: the agent's `modelHostStart` procedure (`packages/remote/src/router.ts`), and `llamactl apply -f` or `llamactl enable` of a ModelHost that reach it (#520).

When `llamactl apply -f` or the controller restarts a running ModelRun whose spec changed, `convergeClaimedServer` in `packages/remote/src/workload/apply.ts` reads the agent's `serverStop` result first: a node stop-fence refusal (`LeasesActive`, `DrainInProgress`, `SessionsActive` or `SessionsUnknown`) leaves the server running its current spec, starts no workers and no replacement, and reports `serverStop refused: <reason>: <ids>` with a single `Applied=False/StopRefused` condition and phase `Running` (the `: <ids>` part is left out when no ids are reported). The restart never releases sessions; the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (#520).

### Adopting an unchanged engine

A start that finds a healthy engine already running an unchanged spec adopts it instead of stopping and respawning it (#806 phase 2). An adopted start stops nothing and spawns nothing, and its result carries `adopted: true`; a fresh or drifted start leaves `adopted` absent.

For a ModelRun, core `startServer` (`packages/core/src/server.ts`) calls `adoptTrackedServer` before the stop-before-start above. It adopts the tracked engine only when the start did not pass `restart: true`, an installed residency lease registry (if any) reports the workload's phase as `open`, the state sidecar exists and its recorded `specHash` equals the hash of the requested launch, the tracked pid verifies `alive` against its pid file through the `verifyPidFile` pid-identity check (the recorded binary and rel on argv), `/health` answers with an ok status within 3 seconds (`ADOPT_PROBE_TIMEOUT_MS`), and the pid is still alive. The adopt leaves the pid and sidecar files untouched. When any condition fails, the start falls through to the fenced stop-before-start. The hash (`computeServerSpecHash`) covers the rel, the model path, `skipTuned`, the tuned profile, the injected alias, the extra args, the host, the port and the binary; the readiness probe, env and `apiKeyRef` are outside it.

When a ModelRun start finds something else already answering on its endpoint, `handlePortConflict` adopts that listener through `tryAdoptExistingServer` only if it advertises the rel, its basename or a declared `--alias`. It records the convergence `specHash` only when the listener's command line matches the launch argv a fresh start would spawn, so a foreign engine is recorded without a hash and the next same-spec start replaces it. This port-conflict adopt reports a plain success without `adopted: true`.

`llamactl server start <target> --restart` sends `restart: true` on the agent's `serverStart` procedure (`packages/remote/src/router.ts`) and forces a fresh launch. Without it, the human output of an adopted start appends ` (adopted)` to the `llama-server up pid=<pid> endpoint=<endpoint>` line, after ` tuned=<profile>` when a tuned profile is recorded.

The keep-alive worker (`packages/core/src/keepAlive.ts`) passes `restart: forceRestart` to core `startServer`. `forceRestart` is an in-memory flag of the worker loop: it is set after the health poll gets no 200 from `/health` within 2 seconds (or finds the pid file gone) and the worker is not stopping, and it is cleared only after the next successful start, so a server whose `/health` recovers before the restart is replaced rather than adopted, and a failed start or a refused pre-start gate keeps it armed. The worker writes the current value to its state file (`llama-keep-alive.state`) as `force_restart`; nothing sends it to the engine.

For a ModelHost, `startModelHost` (`packages/remote/src/server/modelhost.ts`) considers an adopt in `reapOrAdoptPriorHost` only after the recorded pid verifies `alive` against `modelhost.pid` (`verifyPidFile`, corroborated by the engine's binary names); an `unknown` verdict defers the start with `pid identity unknown; deferring restart`. `adoptUnchangedHost` then adopts the host only when no restart was requested (`StartModelHostOptions.restart`, or `restart` on the agent's `modelHostStart` input), an installed residency lease registry (if any) reports the phase as `open`, the recorded `specHash` equals `computeModelHostSpecHash` of the applied spec, the engine's readiness probe passes within 3 seconds, an advertised model id matches the first hosted model's rel or basename once declared `--alias` values in `spec.extraArgs` are folded onto that rel, and the recorded pid is still alive. The adopt runs ahead of the stop-before-start fence, leaves `modelhost.state` byte-for-byte untouched unless refreshing its out-of-hash `readiness` and `binaryNames` fields changes the record, and never rewrites `modelhost.pid`. When any condition fails, the prior host is torn down under that fence.

When `modelhost.state` is missing, or its pid is gone and no live listener holds the endpoint, `startModelHost` checks `modelhost.starting`, the record an agent that died before readiness leaves behind. An `unknown` verdict against that record defers with `pid identity unknown; deferring restart`; for an `alive` one, `adoptOrDeferStartingHost` applies the same restart, residency-phase and spec-hash gates. If the readiness probe passes and the engine advertises the first hosted model's rel, its basename or a declared `--alias`, the record is promoted to a full `modelhost.state` and the start returns `adopted: true`. If the probe passes but the engine serves another model, the engine is torn down. If the probe does not pass, the start is deferred with `engine pid <pid> from the starting record is still loading; deferring restart` only while the record's `startedAt` is younger than the readiness budget (the start's `timeoutSeconds`, else the manifest's `spec.timeoutSeconds`); an older record is torn down, as is one that fails a gate. On Linux, a starting record whose pid still identifies only as the `systemd-run` scope wrapper (the engine has not exec'd yet) is never promoted: it is treated like an engine that is still loading, deferred within the same budget and torn down after it (#806).

## Status, plan and apply-profile

```sh
llamactl residency status --node <name>
llamactl residency plan --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --node <name> --to <profile> [--from <profile>] --execute --yes
```

`apply-profile` is dry-run by default; `--execute --yes` runs it. `--node` and `--to` are required on both `plan` and `apply-profile` (the `USAGE` in `packages/cli/src/commands/residency.ts`); `[--from <profile>]` is optional, so drop it or fill it in. It returns `Busy` when a switch is already in flight (`inFlightBusy` in `packages/remote/src/residency/apply-profile.ts`, and `packages/remote/src/residency/profile-transition.ts`). Profile membership comes from the annotations `llamactl.io/residency-profiles` and `llamactl.io/residency-protected`; a workload with no annotation is treated as protected (`packages/remote/src/residency/coordinator.ts`).

For a managed owner, use `apply-profile --managed`. This selects the authenticated `residencyApplyManagedProfile` procedure with version 1 for previews and execution. An older agent returns `ManagedProfileUnavailable` to the CLI. The legacy procedure remains available for unmanaged execution.

The MCP and Ops Chat tool `llamactl.residency.applyProfile` uses `managed: true` to select the same versioned procedure. MCP resolves the named authenticated agent through kubeconfig. Ops Chat runs on the authenticated owning agent. For execution, set `dryRun: false` and `confirm: true`.

`llamactl residency status --node <name>` also reports a lifecycle section scoped to the serving process; the `residencyStatus` procedure and the MCP tool do the same. The section holds the node-local `residency_states` rows: model, state, group, whether the state is occupying, and version. Exclusive-group violations are computed with `findExclusiveGroupViolations` over `RESIDENCY_GROUPS`. An unreadable store reports `StoreUnreadable`; a failed lifecycle-row read reports `LifecycleUnreadable`, which degrades only this section. The human output prints a `Lifecycle:` line and an `Exclusive:` line, and `Exclusive:` reads "no violations" or "violation in <group>: <members>". These rows belong to the serving process, not to the target node's coordinator state, the same as the store (`buildResidencyLifecycleSnapshot` in `packages/remote/src/residency/procedures.ts`, and `pushLifecycleLines` in `packages/cli/src/commands/residency.ts`) (#731).

`llamactl residency status --node <name>` also prints a `Sessions:` section from the serving process's session registry (`pushSessionLines` in `packages/cli/src/commands/residency.ts`, #750). The header reads `Sessions:   <n> bound (idle timeout <t>; scope: serving-process)`, followed by one `<workload>  <sessionId>  refs <n>  in flight|expires in <t>` line per session: a session with refs above 0 is `in flight` and has no expiry, while a session at refs 0 shows the rest of its idle-timeout window. Only live sessions are listed (expired ones are pruned first), most recently active first. The `residencyStatus` procedure, and the MCP tool that returns its result, carry the same data as a `sessions` section built by `buildResidencySessionSnapshot` in `packages/remote/src/residency/procedures.ts`: `status`, `scope` `serving-process`, `idleTimeoutMs`, and per session `sessionId`, `workload`, `refs`, `idleMs` and `expiresInMs` (`null` while in flight). The registry is installed only when `LLAMACTL_RESIDENCY_LEASES` is on AND `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is set (see Session affinity); without it the section reads `unavailable` with `NoRegistry` ("no session registry installed"), a snapshot that throws reports `SessionsUnknown` ("session registry unreadable"), and a registry without a snapshot reports `SnapshotUnsupported` ("session registry has no snapshot"). Unlike `idleEviction`, the section is not limited to the serving node: whatever `--node` names, it shows the serving process's registry.

With the lease registry on (`LLAMACTL_RESIDENCY_LEASES`), a wet `apply-profile` checks each victim against the installed session registry at fence time, and it checks idle victims again after the drain window, before any stop runs (`packages/remote/src/residency/profile-transition.ts`). A victim with a bound session fails the fence or drain step with detail `SessionsActive: <ids>`; if the registry throws, the detail is `SessionsUnknown`. The operation is recorded `failed`, and no stop or start runs. The switch never releases sessions, so unloading a session-bound victim needs the override `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` (see Session affinity). The session registry is installed only when `LLAMACTL_RESIDENCY_SESSION_IDLE_MS` is also set; without it, no session check runs (#730).

With the lease registry on, a dry run (`apply-profile` without `--execute`) checks each victim against the installed session registry without draining. A session-bound victim's planned fence step then carries detail `SessionsActive: <ids>` (`SessionsUnknown` if the registry throws). This is advisory: the outcome stays `dry-run`, and nothing drains, stops or starts. The human output prints `<workload> (planned; <detail>)`, and a failed wet switch prints `residency apply-profile: failed: <action> <workload>: <detail>` (#520).

`plan` and `apply-profile` also refuse with `Cooldown` within `switchCooldownSeconds` of the node's last succeeded switch recorded in the residency store; see the [NodeRun residency policy knobs](#noderun-residency-policy-knobs) table (#732).

A `Cooldown` or `MinResidency` planner refusal carries `retryAfterMs`: the remaining cooldown, or the longest remaining min-residency hold across the named victims. `llamactl residency plan --node <name> --to <profile>` prints it as a `Retry in:` line after `Workloads:`, formatted by `formatRefusalRetry`. A refusal with no retry time prints no line. `residencyApplyProfile` copies it to `refusal.retryAfterMs`, and the planner's named workloads to `refusal.workloads`, each only when present. `llamactl residency apply-profile --node <name> --to <profile>` appends `; workloads: <names>` and `; retry in <t>` to its stderr refusal line. A payload from an older agent carries neither field and prints the line unchanged. The MCP `llamactl.residency.plan` / `llamactl.residency.applyProfile` JSON carries the same fields.

## Direct ModelHost start and stop

The agent's `modelHostStart` and `modelHostStop` procedures (`packages/remote/src/router.ts`) wrap `startModelHost`/`stopModelHost` in `runDirectResidencyStart`/`runDirectResidencyStop` (`packages/remote/src/residency/direct-lifecycle.ts`). `llamactl apply -f` and `llamactl enable` of a ModelHost reach `modelHostStart` (`startModelHostProcess` in `packages/remote/src/workload/apply.ts`), and `llamactl disable` (`disableModelHost`) or deleting a ModelHost reaches `modelHostStop`. The agent's ModelRun `serverStart` and `serverStop` procedures wrap `startServer`/`stopServer` the same way (#517), recording the group from the agent-side ModelRun `llamactl.io/residency-group` label, and deleting a ModelRun reaches `serverStop` (`stopWorkloadForDelete`). A profile switch's own `applyManifest` calls run inside `runInResidencySwitchScope`, where the wrapper neither records nor refuses, because the switch's walk owns the row.

When that label is absent, `serverStart` takes the group from the catalog row of the rel `resolveTarget` returns for its `target` input, the same fallback `admit measure` uses; a label always wins, so a label naming an undeclared group opts the run out (#517). The fallback (`directModelRunStartOpts` and `catalogTargetGroup` in `packages/remote/src/router.ts`) also applies when no ModelRun is stored under the workload name, and an unresolvable target, an uncatalogued rel or a throwing `resolveTarget` records no group, as before; so `llamactl expose` and `llamactl server start` of a catalogued z13-large-gpu rel record that group and meet the same `ExclusiveGroupOccupied` refusal as a labelled run.

A node with no store file runs the start or stop unrecorded and never creates the store. Otherwise the wrapper claims the shared apply-profile fence and walks the `residency_states` row through the same `withResidencyLifecycle` hops as a profile switch (`packages/remote/src/residency/lifecycle-steps.ts`). A label naming an undeclared group records no group.

A same-group `ready` peer is reconciled to downloaded only when it is proven down: a known ModelHost that reads Stopped with its identity resolved, a known ModelRun with no recorded pid file or whose recorded pid is provably gone (`dead` or `reused`), or a keep-alive target whose supervisor is absent or provably gone and whose own server key (the target name) is proven down. Any other occupying same-group row refuses the start with `ExclusiveGroupOccupied`, as `residency lifecycle refused <name> <from> -> <to>: ExclusiveGroupOccupied: <detail>`, before the engine runs. A nonterminal profile switch refuses a start with `residency lifecycle refused <name>: profile switch in flight on this node; retry after it settles`. A grouped start whose store cannot be opened or claimed refuses with `store unavailable (<message>)`.

A workload already running with a `ready` row is adopted and kept ready.

A direct stop runs its stop before the row moves, so an occupying row keeps its exclusive group held for the whole stop. A confirmed stop walks the row `ready` -> `draining` -> `unloading` -> `downloaded`. An unconfirmed stop (the process may still be alive) is not recorded: the row stays occupying, so a same-group start is still refused, and the agent logs `[residency] lifecycle <name> stop not recorded: unconfirmed stop (process may be alive)`. A stop that throws is recorded `failed` and the error is rethrown. Bookkeeping never blocks a stop: a stop whose claim or walk fails still runs and logs `[residency] lifecycle <name> stop not recorded: …` on the agent's stderr.

Known limits: a `ready` ModelRun row whose recorded pid is still alive, or whose identity cannot be verified (`unknown`), is never proven down, so it fails closed and refuses same-group starts. `llamactl residency force-unload <workload> --reason <text> --yes --node <name>` routes its `stopModelHost`/`stopServer` through `runDirectResidencyStop` after the lease drain commits, so a confirmed force-unload walks the row to `downloaded` and an unconfirmed one leaves it occupying (#517). Read rows with `llamactl residency status --node <name>`.

ModelRun proof uses `isServerProvenDown` (`packages/core/src/server.ts`), which checks the recorded pid against its pid file with the same identity check `stopServer` uses and never deletes the pid file; agent boot recovery uses the same predicate through `directWorkloadProvenDown`.

A ModelRun that the agent started through `serverStart` with no manifest in its own workloads dir (the reconciler or `llamactl expose` stores the manifest on the host that applied it) still records its row under the workload name, and `directWorkloadProvenDown` treats that name as a ModelRun when `startServer`'s `llama-server.state` sidecar exists under it, no `modelhost.pid` or `modelhost.state` file exists under it, and the keep-alive state file does not name it (`unstoredModelRunRecorded` in `packages/remote/src/router.ts`); the same `isServerProvenDown` check then proves it down, so a crashed run's stale `ready` row reconciles before a same-group start and the boot orphan sweep can fail it, while a name with no sidecar, with ModelHost runtime files, or named by the keep-alive state still fails closed (#517).

`llamactl server start` and `llamactl server stop` against the local node dispatch through the in-process `serverStart`/`serverStop` procedures instead of calling `startServer`/`stopServer` in the CLI process, so they record the `residency_states` row and refuse an occupied exclusive group exactly as the agent procedures do (#517). When `llamactl server start` rewrites the ModelRun manifest it keeps the stored ModelRun's labels and annotations, including `llamactl.io/residency-group`.

`llamactl eval run <model>` without `--url` and `llamactl admit measure <workload>` spawn a sandbox engine in the CLI process and record no `residency_states` row, but before spawning they read the local residency store read-only through `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`) and exit 1 without spawning when the launch's declared-exclusive residency group is occupied (#517). `eval run` takes the group from the catalog row whose `rel` is `<model>`; `admit measure` takes the manifest's `llamactl.io/residency-group` label, falling back to the catalog row of its model rel. Any `loading`, `warming` or `ready` row in that group refuses, including a row for the same name, as `<command>: residency lifecycle refused <name> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`; a nonterminal profile switch refuses with `profile switch in flight on this node; retry after it settles`, and an unreadable store refuses with `store unavailable (<message>)`. A node with no store file, a model with no group, and an undeclared or non-exclusive group launch as before. The check is read-only and unfenced, and it never reconciles a proven-down peer, so a stale `ready` row refuses until it is cleared (for example by `llamactl residency force-unload <workload> --reason <text> --yes` or the boot orphan sweep).

`llamactl keep-alive start <target>` spawns a detached supervisor whose worker records its own `residency_states` row under `<target>`, but before spawning it resolves `<target>` to a catalog rel and reads the local residency store read-only through `keepAliveLaunchRefusal` (`packages/cli/src/commands/keepAlive.ts`), ignoring only that target's own row and exiting 1 without spawning when another member of the rel's declared-exclusive residency group is occupied (#517). The rel comes from `resolveTarget` (`packages/core/src/target.ts`), the resolver the worker uses, so the default target `current` and aliases such as `best` are checked under the rel they resolve to and the refusal names that rel; a target that does not resolve skips the check and spawns as before, and the worker then records `resolve-failed`. `keepAliveLaunchRefusal` takes the group from the catalog row whose `rel` is the resolved target and delegates to `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`); the refusal prints as `keep-alive start: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`, with the same profile-switch and store-unavailable forms as the sandbox launches, and a node with no store file launches as before. The detached `keep-alive worker` re-runs the same gate through the worker's `beforeStart` hook before every start or restart: a refusal records state `start-refused` and appends `start-refused rel=<rel> reason=<refusal>` to the keep-alive log instead of `start-failed`, and a throwing hook records `pre-start gate failed (<message>)` as the reason. The agent's `keepAliveStart` procedure (`packages/remote/src/router.ts`), which serves `llamactl keep-alive start` on remote dispatch, runs the same gate through `keepAliveStartRefusal` on the rel `resolveTarget` returns, after its duplicate-supervisor checks and before it spawns the detached `keep-alive worker`, so an occupied group returns `ok: false` with `error` set to the `keep-alive start: residency lifecycle refused ...` text and spawns nothing; the CLI prints that `error` and exits 1 (#517).

The detached worker records its own lifecycle row under the keep-alive target rather than the resolved rel: `keepAliveRecordedStart` wraps the engine start in `runDirectResidencyStart` and `keepAliveRecordedStop` wraps the supervisor-exit stop in `runDirectResidencyStop`, taking the group from the catalog row of the resolved rel, so a failed start leaves the target's row `failed` with that group and a confirmed cleanup stop walks it back to `downloaded`. Because that row belongs to the target rather than to a sandbox copy, `keepAliveLaunchRefusal` takes the resolved rel and the keep-alive target and passes `ignoreModel: target` to `exclusiveGroupLaunchRefusal`: the target's own stale row never refuses its restart, while every other occupying member of the group still does. `runKeepAliveWorker` carries a `stop` seam beside its `start` seam, and its cleanup invokes exactly `(stop ?? stopServer)({ key, resolved })`; core stays adapter-free while the CLI passes the recorded pair. A keep-alive target is proven down only when its state file still names that target, its recorded supervisor pid is absent or verifies `dead` or `reused`, and `isServerProvenDown({ name: target })` proves the server keyed by the keep-alive target down (the target name, not the rel the state file records); a missing or mismatched state, a live or unknown supervisor identity, a live server, or a throwing read fails closed. For a name that is neither a ModelRun nor a ModelHost, `directWorkloadProvenDown` returns `keepAliveWorkloadProvenDown(model)`, so a crashed keep-alive's stale `ready` row reconciles to `downloaded` before a same-group start and the boot orphan sweep can move it to `failed` once it is stale.

`llamactl bench preset <target>` and `llamactl bench vision <target>` spawn `llama-bench` and `llama-mtmd-cli` and record no `residency_states` row, but before spawning they resolve `<target>` to a catalog rel and read the local residency store read-only through `benchLaunchRefusal` (`packages/cli/src/commands/bench.ts`), exiting 1 without spawning when the rel's declared-exclusive residency group is occupied (#517). The rel comes from `resolveTarget` (`packages/core/src/target.ts`), so the default target `current` and aliases are checked under the rel they resolve to and the refusal names that rel; a target that does not resolve keeps core's `Unknown bench target: <target>` error, and a resolved rel with no catalog row launches as before. `benchLaunchRefusal` takes the group from the catalog row whose `rel` is the resolved target and delegates to `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`); the refusal prints as `bench preset: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>` — `bench vision: ` for the vision bench — with the same profile-switch and store-unavailable forms as the sandbox launches, and a node with no store file launches as before. The agent's `benchPresetRun` and `benchVisionRun` subscription procedures (`packages/remote/src/router.ts`), which serve `bench preset`/`bench vision` on remote dispatch and every scheduled bench, run the same gate before `bench.benchPreset`/`bench.benchVision`, so the refusal reaches remote callers as a stream error; like the other launch gates it is read-only, unfenced and never reconciles a proven-down peer.

`llamactl pull file` and `llamactl pull candidate` run the post-pull auto-tune through `maybeTuneAfterPull` (`packages/core/src/autotune.ts`): the local branch in `runAutotuneAfterPull` (`packages/cli/src/commands/pull.ts`) and the `autotuneAfterPull` subscription procedure (`packages/remote/src/router.ts`) both pass `launchRefusal: benchLaunchRefusal`, so before `benchPreset` or `benchVision` spawns `llama-bench`/`llama-mtmd-cli` the read-only gate checks the pulled rel's declared-exclusive residency group and an occupied group records the preset or vision step as skipped with kind `exclusive-group-occupied` and the refusal text instead of launching the bench (#517). `llamactl candidate test` gates its bench steps the same way: `candidateTest` (`packages/core/src/candidateTest.ts`) consults `launchRefusal` immediately before `benchPreset` in `runPresetStep` and before `benchVision` in `runVisionStep`, and both the `candidateTestRun` subscription procedure (`packages/remote/src/router.ts`) and the CLI local branch in `runTest` (`packages/cli/src/commands/candidate.ts`) pass `launchRefusal: benchLaunchRefusal`, so an occupied group surfaces as the step's `ran: false` reason — printed as `preset skipped: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>` — rather than a bench process error; a node with no store file, a rel with no group and a clear gate behave as before (#517).

The eval matrix runner (`packages/eval/src/matrix/cli.ts`) boots managed model and judge engines in the CLI process and records no `residency_states` row, but every managed boot reads the local residency store read-only through `matrixLaunchRefusal` (`packages/eval/src/matrix/launch-gate.ts`) before spawning and records the cell as an error without spawning when the launch's declared-exclusive residency group is occupied (#517). `matrixLaunchRefusal` resolves a `gguf_path` under `LLAMA_CPP_MODELS` to the catalog rel beneath that root, falling back to `ModelSpec.name` when the path is outside the root, and takes the group from that rel's catalog row before delegating to `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`); an uncatalogued model, a model with no group, an undeclared or non-exclusive group, and a node with no store file launch as before. `ensureModelServing` consults the gate only after its `/health` probe misses and before `spawn`, so an engine already serving at the model's host and port is adopted without consulting the store, while a refused boot throws `eval matrix: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`. `runMatrix` threads its `launchRefusal` callback into both the model boot in `runModelCells` and the judge boot in `runWorkloadCell`, and the matrix CLI wires `matrixLaunchRefusal`, so a refused model or judge writes the workload's error cell and logs `[matrix] failed to boot ...` or `[matrix] failed to boot judge for ...` without spawning the engine binary.

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

`llamactl residency status --node <name>` prints the `idleEviction` section as an `Idle evict:` block (`pushIdleEvictionLines` in `packages/cli/src/commands/residency.ts`, Part of #519). The header reads `Idle evict: window <n>s, <k> ready workload(s) (advisory; scope: serving-process)`, followed by one `<workload>  <state>  leases <n>` line per ready resident, where `<state>` is `due`, `held MinResidency for <t>`, `held SessionsActive: <ids>`, `held SessionsUnknown`, `not due (due in <t>)`, `not due (leased or draining)` or `not due (activity unknown)`. A disabled window prints `Idle evict: disabled (scope: serving-process)`, and an unavailable one prints `Idle evict: unavailable (<detail>; scope: serving-process)` with detail `not the serving node`, `no lease registry installed`, `store unreadable` or `lifecycle rows unreadable`. A payload without the section (an agent that predates it) prints no `Idle evict:` line. The read-out never evicts. With the session registry installed (#520), `residency status` reports a ready resident that is otherwise idle-due but bound to a session as `due: false` with `sessionHold` (`SessionsActive` with the session ids, or `SessionsUnknown` when the session check throws), matching the `residency evict-idle` skip. The status read-out never releases sessions; the overrides are `residency release-session` and `residency force-unload`.

`llamactl controller serve` logs an idle-held workload's per-pass line through `reportOutcome` (`packages/cli/src/commands/controller.ts`) as `unchanged (idle-evicted at <iso> via llamactl.io/idle-evicted-at; run llamactl residency release-idle <workload> to resume)`, and a reconcile error on that row still logs as a WARN: the error path does not read the hold, so the annotation reappears on the stdout line only once the row reports a healthy outcome. `llamactl describe workload <name>` prints an `IdleHold:` line (`formatIdleHoldLine` in `packages/cli/src/commands/workload.ts`, shared by the ModelRun and the ModelHost renderers) reading `the controller keeps it down until llamactl residency release-idle <workload>` for an enabled manifest, or `inactive while the workload is disabled` for a disabled one, because the reconciler ignores the hold on a disabled manifest. A manifest without the hold prints no line, and `describe workload --json` is unchanged because the manifest already carries the annotation (Part of #519).

## Cancel and crash recovery

```sh
llamactl residency cancel-operation <operationId> --yes --node <name>
```

Cancel is process-local and aborts at the next step boundary (`packages/remote/src/residency/apply-profile.ts` header). Boot recovery is `runProfileSwitchBootRecovery` (`packages/remote/src/residency/boot-recovery.ts`), wired into the agent start in `packages/remote/src/server/serve.ts`. A tagged pending reservation whose owner has exited can be finished before dispatch. Boot still terminalizes legacy pending rows that have made no step progress for 30 minutes (`PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS`). A nonterminal `committed` row means dispatch may have started. Boot leaves the operation, fence, and lifecycle rows intact across restarts and reports the count as `dispatchUnverified`. The hold blocks profile switches and reconciler starts until the dispatch outcome can be verified. There is no opt-in flag.

On a claimed pass for a legacy pending switch, the same boot recovery also moves `residency_states` lifecycle rows left in `loading`, `warming`, `draining` or `unloading` to `failed` via `failInterruptedLifecycleRows`, under the profile-switch fence, which frees exclusive-group capacity. A claimed pass happens only when a stale profile-switch row exists. When the store holds no nonterminal operation row, boot recovery also sweeps lifecycle rows interrupted outside a switch (for example a direct start whose agent died in `loading`) once they have made no progress for 30 minutes and their workload is proven down by `directWorkloadProvenDown`; a younger row, a workload not proven down, or any nonterminal operation row leaves them untouched. When no `profile-switch:` row is nonterminal, boot recovery first finishes a crashed eviction's `evict:` operation rows: an `evict:<victim>` row whose `targetState` reads `evicted-by:<replacement>` and that has made no progress for 30 minutes is finished `unknown` with detail `recovered: interrupted-unverified (was <phase>)` under a claim of the apply-profile fence, and the outside-a-switch sweep then runs in the same boot. A younger `evict:` row defers the whole eviction pass, and a malformed `evict:` row is never finished, so either still keeps the outside-a-switch sweep off; the victim's `llamactl.io/evicted-by` manifest marker is left in place. Meanwhile clear a stuck interrupted row by hand with an operator stop or `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`, which an `evict:` row does not block. When it finished or failed to finish at least one `evict:` row, the agent logs `[residency] eviction boot recovery {"recovered":N,"recordFailures":M}` before any lifecycle line, with counts only and no victim or replacement names (#517). Per-row refusals and write failures are counted without stopping the sweep. When the sweep moved a row or recorded a failure, the agent logs `[residency] lifecycle boot recovery {"failed":N,"recordFailures":M}` after the profile-switch line on a claimed pass, and on its own when only the orphan sweep ran, with no profile-switch line; that line carries counts only, with no model or group names (#736); see [dynamic fleet models](dynamic-fleet-models.md).

The same outside-a-switch sweep also moves a `ready` lifecycle row to `failed` once it has made no progress for 30 minutes and `directWorkloadProvenDown` proves its workload down (for example an engine that crashed, or a host that rebooted, while its row read `ready`); the claimed profile-switch pass never touches `ready` rows. A later start walks the row `failed` -> `downloaded` -> `loading` as usual (Part of #517).

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

### Shared GPU execution on the owning agent

The managed owner uses the same execution groups for dispatch. Each serving
backend port needs a group in `executionAdmission`; unmatched local
inference is refused before dialing. If the transition or admission journal
is missing or has been replaced, managed operations fail closed.

Before a dial, the owner records a durable hold for the exact workload.
Confirmed engine completion clears it. After a crash, an unresolved hold
fences that workload from inference and stop. The CLI and console show the
hold alongside its memory claim. Preserve both journals for recovery and
verify the previous engine generation before any manual intervention.

The owner checks the durable memory claim before each engine dial, including
after a request leaves the queue. A pending or uncertain claim blocks inference
even if a restarted agent has a fresh lease registry. A discounted native
parked claim needs current owner proof before new allocations are admitted.
The allocation transaction checks that proof against the locked ledger rows.
If proof is lost, restoring the full charge or verifying release makes the
ledger usable for allocation again.

For co-resident models, add `executionAdmission` to the owning node's
`agent.yaml`. Each group matches local engine ports after routing. Local
HTTP proxy traffic, local tRPC chat and the default local-model Worker
RPC backend use the same queue. Use one owning agent process per node
with this setting. The agent installs a residency lease registry when
groups are enabled. The following is an example for Kapitsa and Granite:

```yaml
executionAdmission:
  - name: macbook-metal
    foregroundPorts: [18200]
    backgroundPorts: [18210]
    foregroundConcurrency: 2
    maxQueued: 16
    maxQueuedBytes: 33554432
    maxPerPrincipal: 8
    maxQueueWaitMs: 45000
    starvationBoundMs: 45000
```

Execution groups can also set `maxCompletionTokens` and `maxContextTokens`.
An output limit requires a single explicit, positive completion cap on
generation requests. Admission forwards one normalized token-cap field and
rejects competing caps and multi-completion requests. A finite context limit
also requires a single flat token-ID prompt sent to a verified llama.cpp
completion endpoint. The request budget includes the full input sequence and
requested output. Chat templates, media and unknown prompt expansions refuse
with `ContextUnverified` when a finite context limit is configured.

The foreground can occupy up to its configured number of slots. One
background request runs alone. Setting the starvation bound below the
queue wait lets an aged background request reserve the next idle window
ahead of newer foreground arrivals. Setting the two values equal gives
strict foreground priority with a finite background wait. Background
waiters can use half the configured queue count and bytes, and leave
one request of headroom per principal. Overload
returns retry guidance to HTTP clients. Requests with a streaming
request body need a buffered format to participate in the byte limit.

A client disconnect frees its queued request immediately. Once the
request reaches the engine, the slot and any acquired workload lease
stay held through the upstream response, including when the client
disconnects. An engine transport error or timeout fences the group.
Confirm the engines are idle before restarting the agent to clear a
fence. Existing generation is allowed to finish when higher-priority
work arrives.

Disable the older `LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS` cap on this
agent when using groups, since queueing before routing can let all of
that cap's permits be held by background work. Keep engine endpoints
on loopback and direct clients to the owning agent or its relay.
Clients dialing engine ports, the planner’s direct engine provider,
custom Worker RPC backends and engine side calls such as KV slot restore bypass this policy. The group
accounts for execution of resident requests and does not enable cold
model activation.

The agent's authenticated `/metrics` exposes group active and queued
request counts, queued bytes and the fenced state under
`llamactl_execution_admission_*`. Qualify mixed-load latency before
removing a production wrapper. To disable the group, drain the
engines, remove `executionAdmission` and restart the owning agent.

## Declared models and readiness

`LLAMACTL_DECLARED_MODELS` set to `1` turns on declared-model projection (`packages/cli/src/commands/agent.ts`). The states are `DeclaredModelStateSchema` (`packages/core/src/routing/catalog.ts`): `cold`, `loading`, `ready`, `draining`, `disabled` and `unavailable`. Ids depend on the kind (`packages/remote/src/residency/catalog.ts`): a `ModelHost` claims the `rel` of its first hosted model plus `basename(rel)` (`hostClaimIds`), and a `ModelRun` claims `spec.target.value` plus each `--alias`/`-a` value in `spec.extraArgs`, with no basename (`runClaims`, `aliasIdsFromExtraArgs`). A model is unavailable only on alias-collision.

A declared entry can also carry a stale reason from `DECLARED_STALE_REASONS` (`packages/core/src/routing/catalog.ts`, #711) when its id is live but the live route disagrees with the manifest: `stale-owner-epoch` when the id is live but the claiming workload has no live route, and `stale-artifact-revision` when the manifest model differs from the model the workload's first live route serves. Only `cold`, `ready` and `loading` claims are checked, so `draining` and `disabled` suppress the reason. A stale entry projects as `cold`, and the proxy (`packages/core/src/openaiProxy.ts`) refuses a routed pin of that id with `503` (`model_not_loaded`, carrying the `reason`) instead of forwarding it to the engine.

`spec.readiness { path, expectStatus, expectJson }` on `ModelHost` (`packages/remote/src/workload/modelhost-schema.ts`) and on `ModelRun` (#695, `packages/core/src/server.ts`) gates routes. When `apiKeyRef` is set, the readiness path is restricted to unauthenticated llama-server paths.

The fleet snapshot publisher can carry an optional `declaredProvenance` companion for direct peers that request version 1. The serving process supplies authoritative declarations with its own node ID, workload, kind, model ID, artifact and policy SHA-256 digests, and a deployment epoch for a ready claim. The poller accepts the companion over direct HTTPS with a pinned certificate and bearer. It checks the configured owner and verifies that ready entries match the snapshot's workload and alias. Invalid evidence, duplicate configured peer IDs, ambiguous aliases, and failed discovery or fetches leave legacy routing available under its existing rules. Cold declarations can travel with an empty live-route list. Authorizing inference or a load requires a separate check against the owner's current declaration.

A gateway remembers exact aliases from authenticated peer declarations while it runs. During a partition or expiry, this evidence refuses default fallback and conflicting cold activation. A ready eligible route can still serve the alias. Removing the peer from the readable configuration clears its history. An authenticated managed owner can explicitly withdraw the complete inventory with `managedColdModelRuns: []` and the version 2 inventory header. A failed artifact check, missing inventory, or unreadable journal leaves the history in place.

## Model artifact and cache identity

Ordinary declared routes compare the manifest name and aliases with the serving route (`packages/remote/src/residency/catalog.ts`). A ModelHost uses its first model's `rel` and `basename`. The two `DECLARED_STALE_REASONS` are `stale-artifact-revision` and `stale-owner-epoch`. Use a new `rel` when replacing weights under ordinary routing.

For a configured managed cold ModelRun, startup verifies the selected regular-file artifact against its declared SHA-256 and byte ceiling. The admission path checks that the staged file generation remains current. A ready peer declaration also needs the live process generation and serving route. Changing the artifact, target policy or execution-group configuration withdraws that proof.

The managed owner can use fresh, matching measured envelopes for supported llama.cpp and Kapitsa launches. See [Recording a measured memory envelope](dynamic-fleet-models.md#recording-a-measured-memory-envelope) for key export, import, and valid input scopes. The standalone ModelHost adapter accepts a structured key with `artifactRevision` (defined in `packages/core/src/resources/memory.ts`). Its injected `getCandidateCalibrationKey` has no production caller. For oMLX, the cache identity (modelId, `engineBuild`, `cacheEpoch`, the artifact `sha256` or size/mtime, and settings) lives in `packages/core/src/engines/omlx-cache-identity.ts`, and `decideOmlxCacheRetention` has no production caller. For native load/unload, `createManagedOmlxResidency` has no production caller (`packages/remote/src/residency/omlx-managed.ts`).

The durable oMLX transition adapter uses one ModelHost claim for the life of the engine. It requires a pinned model and process, exclusive owner ingress, and no unresolved inference holds. Native unload records its intent with the full allocation charged. After the exact unloaded model is confirmed and the lease is closed, only a qualified residual-memory measurement reduces the charge. Reload restores the full allocation before its POST and reopens inference after exact readiness and the durable commit. A queued or ambiguous unload and a recovered owner retain the full charge. The adapter is qualified with isolated fixtures and awaits installation behind the serving owner's ingress gate.

For an oMLX ModelHost, set `spec.omlxCacheEpoch: 0` to opt into workload-local SSD cache reuse. The launcher fingerprints the installed Python environment, the discoverable model and any active local drafts using their observed file generations. It combines those generations with the effective cache settings and epoch. It rechecks the identity after managed admission and before spawn. Keep the model artifact, Python installation and effective settings immutable while the process serves. Apply settings and profile changes through a stop and start by the owner. Live changes through oMLX admin APIs can bypass launch validation.

The matching prefix path is `.omlx/managed-cache/cache-by-identity/<digest>/prefix` under the workload runtime directory. On the first managed launch, existing workload-local settings seed the managed base. oMLX writes its persisted overrides to the managed copy. Removing the epoch selects the legacy base again. Runtime profiles in `model_profiles.json` make the startup identity unavailable because they can select different model settings per request. A model or runtime update, cache format change, or epoch bump chooses a fresh path. Existing directories remain available for rollback and count toward disk use. Configure `extraArgs: ["--slot-save-path", "auto"]` to give supported slot APIs their own directory under the same identity. The launcher records that directory for process recovery. Reopening compatible files does not restore in-flight requests or running sessions.

An opaque or unsupported launcher refuses the cache opt-in. A supported launcher with an unavailable model or cache fingerprint, including an unresolved remote draft, starts with paged SSD cache and slot storage disabled. Keep model, base and cache locations owner-managed when setting the epoch. Hosts without an epoch retain their existing launch behavior. Approve native residency separately after checking the deployed build, exclusive ingress and measured capacity.

## llama.cpp sleep and wake

The library is in `packages/remote/src/residency/llamacpp-sleep-client.ts` and `packages/remote/src/residency/llamacpp-wake-client.ts`. `modelHostStatus` reports a recorded sleep (#706), and the reconciler leaves a sleeping host alone (#701). `setNodeLlamacppSleepController` has no production caller (`packages/remote/src/residency/llamacpp-sleep-status.ts`), so nothing puts a host to sleep in production and there is no idle trigger.

`createAgentLlamacppSleepDriver` consults `checkUnload` for the member before `requestSleep` (#520). A bound session (idle within its timeout or in flight) refuses the sleep as `SessionsActive` with the session ids in `active`. A registry whose `checkUnload` throws refuses it as `SessionsUnknown`. The refusal applies to both the guarded sleep and the process-stop fallback: no `POST /sleep` is sent, no stop runs, and the reservation stays `held`. The factory captures the installed session registry at construction, and `sessions: null` opts out. The driver never releases sessions. The overrides are `llamactl residency release-session <sessionId> --yes --node <name>` and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`. The driver still has no production caller.

The fleet supervisor skips completions and both slot-reading paths when an owner's read-only `modelHostStatus` attests `sleeping` or `sleep-pending` for the target. The CLI uses a deployed llama.cpp ModelHost manifest and a direct authenticated agent on the same numeric address as the explicit probe URL. The agent checks that URL against its live runtime record and the process generation captured by the controller when it adopted the workload. The controller publisher must supply that generation with its recorded state. Older agents, unbound or changed generations, DNS names, tunnels, proxy URLs and the in-process local sentinel supply no proof. ModelRun completion probes have no CLI sleep status adapter.

The supervisor keeps the measured health and model inventory, and throughput mode can still read metrics. These endpoints must be qualified as non-waking on the pinned build. Redirects are refused on protected observations. The fleet snapshot records the sleep state, marks slot data unavailable, and suppresses health-driven restart proposals for that tick.

## NodeRun residency policy knobs

These keys come from `ResidencyPolicySchema` (`packages/remote/src/workload/noderun-schema.ts`) and are consumed by the admission logic in `packages/core/src/residency/admission.ts` (#690). The status column says whether a value is enforced at runtime, fed only to the planner, applied only at candidate ranking, acted on only when the operator runs `residency evict-idle` (`operator-only`), reported in `residencyStatus` but not acted on (`status-only`), validated and persisted but ignored, or reserved for future use. `ranking-only` means `rankRouteCandidates` (`packages/core/src/routing/ranking.ts`) applies the knob when the unified proxy is given its `residencyPolicy` option (`createProxy` in `packages/remote/src/proxy/create-proxy.ts`) and resident ranking signals. `dispatchProxyRequest` builds `sharedProxy` with `createSharedUnifiedProxy()` (Part of #519): it supplies the serving node's NodeRun `residencyPolicy` (the NodeRun selected by `LLAMACTL_NODE_NAME`) and resident signals built from the node-local residency store's `ready` lifecycle rows, and both only apply when `LLAMACTL_UNIFIED_PROXY` is set to `1` and the selected NodeRun has a nonzero ranking knob. Only workloads with a `ready` `residency_states` row count as resident: a local workload with no lifecycle row ranks as non-resident, and peers have unknown residency (see below). The NodeRun and store reads are cached for 5 seconds.

| Key                     | Status        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safetyMarginRatio`     | enforced      | Applied to computed headroom when admitting a load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `minResidencySeconds`   | enforced      | Refuses `residencyPlan` / `apply-profile` with `MinResidency` while a victim's residency store lifecycle row has been `ready` for fewer than this many seconds; 0 disables. It also holds an idle-due resident in `residency evict-idle` as `MinResidency` until it has been ready for this many seconds. Also feeds the ranker's `cooldownUntil` signal through `createSharedUnifiedProxy` when nonzero (Part of #518), reported in the `residencyStatus` `ranking` section.                                                    |
| `switchCooldownSeconds` | enforced      | Refuses `residencyPlan` / `apply-profile` with `Cooldown` until this many seconds after the node's last succeeded profile switch recorded in the residency store; 0 disables. It also refuses a verified `--evict` victim with `EvictCooldown` inside the window. Feeds the ranker's `cooldownUntil` signal through `createSharedUnifiedProxy` when nonzero (Part of #518), reported in the `residencyStatus` `ranking` section.                                                                                                 |
| `idleEvictSeconds`      | operator-only | `residencyStatus` reports an advisory `idleEviction` window from ready lifecycle rows and serving-process lease activity, only when `node` is the serving node; nothing evicts or sleeps on its own. The operator drives eviction with `residency evict-idle`, which stops a still-idle resident behind the durable `llamactl.io/idle-evicted-at` hold the reconciler honours; a workload that resumed activity before its stop is skipped `NoLongerIdle`, and `release-idle` clears the hold. Activity resets on agent restart. |
| `residentPreference`    | ranking-only  | Applied by `rankRouteCandidates` when the proxy is given `residencyPolicy` and resident signals; inert at 0; reported in `residencyStatus` `ranking`.                                                                                                                                                                                                                                                                                                                                                                            |
| `coldLoadPenaltyMs`     | ranking-only  | Applied by `rankRouteCandidates` when the proxy is given `residencyPolicy` and resident signals; inert at 0; reported in `residencyStatus` `ranking`.                                                                                                                                                                                                                                                                                                                                                                            |

The `effectivePolicy` section of `residencyStatus` lists every residency knob as resolved for `node`, in policy key order, with its value and whether it came from the defaults (defaulted), whether or not a NodeRun exists; it never changes anything. It is built by `effectiveResidencyPolicy` (in `packages/remote/src/residency/procedures.ts`) using `RESIDENCY_POLICY_KNOBS` as the fixed key order and `resolveResidencyPolicy`, the same resolver the admission, planner, evict-gate and ranking paths call. The `knobs` field is an ordered list of `{ name, value, defaulted }` entries, where `defaulted` is true when the NodeRun sets no value or the resolver rejected it, so the value comes from `DEFAULT_RESIDENCY_POLICY`; a node with no NodeRun reports `safetyMarginRatio` 0.75 and every other knob 0 (today's behaviour), and unlike `policy` the section is reported whether or not a NodeRun exists. `llamactl residency status --node <name>` prints it as an `Effective:` line after `Policy:` (`pushEffectivePolicyLine` in `packages/cli/src/commands/residency.ts`): `Effective:  idleEvictSeconds <n>, minResidencySeconds <n>, switchCooldownSeconds <n>, safetyMarginRatio <r>, residentPreference <p>, coldLoadPenaltyMs <n>`, in the order the agent sends, each defaulted knob suffixed ` (default)`; a payload without the section (an older agent) prints no `Effective:` line. (Part of #519)

`llamactl describe noderun <name>` shows the NodeRun's knobs without a reachable agent. It prints a `Budget:` line: `<n> GiB (spec.budget.memoryGiB)` for an explicit budget, which overrides `safetyMarginRatio`, otherwise `computed from node memory x safetyMarginRatio`. It prints a `Residency:` line with every knob as resolved by `effectiveResidencyPolicy` and formatted by `formatResidencyKnobs`, the same formatter as the residency status `Effective:` line. Defaulted or resolver-rejected knobs are suffixed ` (default)`. `--json` adds an `effectivePolicy` field next to `manifest` and `liveInfra`. (Part of #519)

NodeRun `spec.budget` and `spec.residency` are keyed by `metadata.name`, not `spec.node`. `llamactl apply -f` refuses a NodeRun that sets either one while `metadata.name` differs from `spec.node`, printing `apply: NodeRun manifest rejected:` with the `nodeRunKnobScopeMismatch` text. An infra-only NodeRun (for example `<node>-infra`) is unaffected. `llamactl describe noderun <name>` prints a `Warning:` line, and `--json` adds `knobScopeWarning`, for a mismatched manifest already on disk. Nothing else is refused at load. (Part of #519)

`llamactl describe node <name>` reads the live rollup from the `nodeBudget` procedure and suffixes its `Budget:` line with where that budget came from. `nodeBudget` returns `budgetSource` (`noderun` or `computed`) and `safetyMarginRatio` as `{ value, defaulted }`, both resolved by `effectiveResidencyPolicy`, and `renderNodeBudget` (`packages/cli/src/commands/workload.ts`) renders them through `formatNodeBudgetSource` (`packages/cli/src/commands/noderun-helpers.ts`): `(spec.budget.memoryGiB)` when the NodeRun sets an explicit budget, otherwise `(computed from node memory x safetyMarginRatio <r>)`, where the ratio is formatted by `formatResidencyKnobs` so it matches `llamactl describe noderun`, default marker included — a resolver-supplied ratio carries ` (default)`. A computed budget is the memory of the process that answers the query times that ratio, and because `describe node` asks the named node's agent, that is the node's own RAM only while its agent answers. A payload from an older agent carries no `budgetSource`, and the line prints unchanged. The `llamactl.node.budget` MCP tool reports the same two fields (Part of #519).

With `minResidencySeconds` above 0, `residencyPlan` and `residencyApplyProfile` refuse with `LifecycleUnreadable` when the serving node's lifecycle rows cannot be read and the switch would evict a victim, because the victims' ready-since times cannot be verified (`minResidencyLifecycleRefusal` in `packages/remote/src/residency/procedures.ts`); a switch with no victims, a node the store does not serve and a `minResidencySeconds` of 0 are unaffected, and planner refusals such as `Cooldown` keep precedence (Part of #519).

When the unified ranker's pick differs from catalog order and is a local-http replica owned by this node, `gatedExecute` sets `preferredLocalWorkload`. The legacy local executor forwards it to `proxyOpenAI` as the `preferredWorkload` option (#728). `servingRouteForModel` lifts that workload to the head of the live candidates after the withdrawn filter; readiness still applies. Peers never match, and an experimental match does not lead while any non-experimental candidate is live.

A verified `--evict` victim (or one named by the `llamactl.io/evict` annotation) whose node-local `residency_states` row has been `ready` for fewer than `minResidencySeconds` is refused `EvictMinResidency` before any intent marker, stop or start; an unreadable residency store or lifecycle read refuses `EvictMinResidencyUnknown` rather than evicting blind. The serving process's own store counts when `LLAMACTL_NODE_NAME` names the victim's node; otherwise (a CLI or controller evicting on another node, or an anonymous serving process) the gate reads the victim node's `residencyStatus` `lifecycle` section through the apply's node client, bounded at 10 seconds. An unavailable `lifecycle` section, or a failed or timed-out read, refuses `EvictMinResidencyUnknown`, while a payload with no `lifecycle` section (an agent that predates lifecycle rows) reports no ready row and evicts unprotected. An explicit readiness seam still wins. `minResidencySeconds` of 0 disables the gate. A `llamactl.io/evict` annotation the controller acts on is gated the same way: the controller reconcile pass forwards each NodeRun's `spec.residency` to both its ModelRun and ModelHost applies (`reconcileModelRun` and `reconcileModelHost` in `packages/remote/src/workload/reconciler.ts`) (Part of #519).

Inside `switchCooldownSeconds` of the node's last succeeded `profile-switch:<node>` operation, a verified `--evict` victim, or one named by `llamactl.io/evict` (also through the controller), is refused `EvictCooldown` before any marker, stop or start. This process's own residency store counts when `LLAMACTL_NODE_NAME` names the victim's node, and also when `LLAMACTL_NODE_NAME` is unset and the victim is on `local` (the in-process node client, whose `switchGates` reports `NotServingNode`); in that second case no `residencyStatus` read is made for the cooldown. Otherwise the gate reads the victim node's `residencyStatus` `switchGates` section in the same bounded read as the readiness gate. A missing or `disabled` section, or `unavailable` with `NotServingNode` (an agent not serving that node records no profile switch for it, because `residencyApplyProfile` refuses `NotServingNode` first), means no recorded switch. Any other `unavailable` reason (`StoreUnreadable`, `LifecycleUnreadable`), an unreadable own store, or a failed or timed-out read refuses `EvictCooldownUnknown`. `switchCooldownSeconds` of 0 disables the gate, and `EvictMinResidency` takes precedence. The eviction itself records no profile switch, so it does not restart the cooldown.

A composite workload is charged the same NodeRun admission budget: the `compositeApply` procedure (`packages/remote/src/router.ts`) passes the NodeRun `spec.budget.memoryGiB` and `spec.residency` lookups to `applyComposite`, and `applyWorkloadComponent` in `packages/remote/src/composite/apply.ts` forwards them to `applyOne`, so an explicit budget wins and otherwise the NodeRun `safetyMarginRatio` sizes the computed budget (Part of #519).

`llamactl expose` is charged the same NodeRun admission budget, because `applyExposeManifest` (`packages/cli/src/commands/expose.ts`) passes the NodeRun `spec.budget.memoryGiB` and `spec.residency` lookups to `applyOne`, so an explicit budget wins and otherwise the NodeRun `safetyMarginRatio` sizes the computed budget (Part of #519).

Under `createSharedUnifiedProxy` (Part of #518), `switchCooldownSeconds` and `minResidencySeconds` also feed the ranker's `cooldownUntil` signal. The signal is measured from the residency store's `lastSucceededAtMs` entry for `profile-switch:<node>`, where `<node>` is `LLAMACTL_NODE_NAME`: a local candidate without a `ready` lifecycle row is charged the remaining cooldown against its stage-quality score, while peers and resident candidates are not charged. An absent, errored or lifecycle-unreadable store charges nothing. The NodeRun and store reads keep the 5-second cache.

Under `createSharedUnifiedProxy` (Part of #518), the residency store's lifecycle rows also feed the ranker's `operationalState` signal: a local candidate whose row is `draining` or `unloading` ranks in the drain tier, and one whose row is `failed` ranks in the degraded tier with zero quality points, mirroring the `effectiveStage` health overlay. Ranking only orders candidates; eligibility and experimental exclusion are unchanged and no candidate is dropped. Peers are never marked, an absent or errored store marks nothing, and the signal is emitted only when a ranking knob is nonzero (the store is not read otherwise).

The `switchGates` section of `residencyStatus` is a status-only read-out of the enforced switch gates against the serving node's store, scoped identically to `residencyPlan`: it reports only when `node` is the serving node, reads the last succeeded `profile-switch:<node>` operation for the cooldown and the `ready` lifecycle rows for min-residency, is `disabled` when both `switchCooldownSeconds` and `minResidencySeconds` are 0, and is `unavailable` with `NotServingNode`, `StoreUnreadable` or `LifecycleUnreadable` (the last only when min-residency reads the rows; a cooldown-only report reads none). `held` is advisory for each resident and is not a prediction for a specific profile: the resident blocks a switch only if the target profile would evict it. When lifecycle rows are unreadable and `minResidencySeconds` is above 0, `residencyPlan` refuses a switch that has victims with `LifecycleUnreadable`, matching the status report. `llamactl residency status --node <name>` renders the section as a `Switch gates:` block (`pushSwitchGateLines` in `packages/cli/src/commands/residency.ts`): the header `Switch gates: cooldown <c>s, min residency <m>s (advisory; scope: serving-process)`, then one cooldown line — `cooldown: off` at 0, `cooldown: active for <t>` while in cooldown, `cooldown: clear (no recorded switch)` with no recorded switch, or `cooldown: clear` otherwise — then one line per ready resident, prefixed by the workload name, reading `held MinResidency for <t>` or `min residency met`. A disabled section prints `Switch gates: disabled (scope: serving-process)` and an unavailable one `Switch gates: unavailable (<detail>; scope: serving-process)`; a payload without the section (an older agent) prints no `Switch gates:` line.

The `ranking` section of `residencyStatus` is a status-only read-out of the ranking signals the unified proxy applies on the serving node against that node's lifecycle rows: it reports only when `node` is the serving node, is `disabled` when every ranking knob is 0 (`residentPreference`, `coldLoadPenaltyMs`, `switchCooldownSeconds` and `minResidencySeconds`) or there is no policy, and is `unavailable` with `NotServingNode`, `UnifiedProxyOff` (`LLAMACTL_UNIFIED_PROXY` not `1`), `StoreAbsent` (no node-local residency store), `StoreUnreadable` or `LifecycleUnreadable` (lifecycle rows unreadable). `resident` and `drainCharged` are empty when `residentPreference` and `coldLoadPenaltyMs` are both 0, because the ranker then emits no resident set and charges no load or drain cost. `resident` lists the ready lifecycle rows, and a local workload with no lifecycle row is not listed but is still charged as non-resident; `drainCharged` lists the candidates charged the drain budget. `cooldownCharged` lists, per non-ready lifecycle-row model, the still-active composed switch-cooldown/min-residency instant (`cooldownCharged[].model` and `cooldownCharged[].untilMs`) the ranker prices with `cooldownUntil`; a local workload with no lifecycle row is not listed there but is still charged the switch cooldown, which the `switchGates` section reports. `drainTier` lists the models whose lifecycle row is `draining` or `unloading` and `degradedTier` the models whose row is `failed`, the same `operationalState` marks the ranker applies. `loadCredited` lists the models whose in-flight load the ranker's `expectedLoadMs` signal still credits at status time — one `{ model, expectedReadyAtMs }` entry per `loading`/`warming` lifecycle row inside its credit window, sorted by model — and is empty when both resident knobs are 0 because the ranker then emits no `expectedLoadMs`. `residencyStatus` computes all of this through `residencyRankingReadout` (`packages/remote/src/proxy/residency-ranking.ts`), the same derivation the live ranking signals use, so the read-out cannot diverge from the ranker. `llamactl residency status --node <name>` renders the section as a `Ranking:` block (`pushRankingLines` in `packages/cli/src/commands/residency.ts`): the header `Ranking: resident preference <p>, cold-load penalty <c>ms (advisory; scope: serving-process)`, then `resident: <workloads>` (`resident: none` when empty), then `drain charged: <workloads>`, `load credited: <workload> ready in <t>` (one entry per credited in-flight load), `cooldown charged: <workload> for <t>` (one entry per active charge), `drain tier: <workloads>` and `degraded tier: <workloads>`, each of those last five printed only when non-empty. A disabled section prints `Ranking: disabled (scope: serving-process)` and an unavailable one `Ranking: unavailable (<detail>; scope: serving-process)`; a payload without the section (an older agent) prints no `Ranking:` line, and one that predates the cooldown and tier fields renders without them.

Under `createSharedUnifiedProxy` (Part of #518), the residency store's lifecycle rows also feed the ranker's `drainMs` signal: a local candidate without a `ready` lifecycle row whose exclusive residency group is held by another member in `loading`, `warming` or `ready` is charged the profile-switch drain budget `DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs` (30 seconds) once, the declared-exclusive groups coming from `RESIDENCY_GROUPS`. The drain charge applies only to a candidate with a lifecycle row tagged with the group; a candidate with no lifecycle row is never charged. The signal is emitted only when `residentPreference` or `coldLoadPenaltyMs` is nonzero (the ranker's `drainCostMs` is inert without the resident set), peers are never charged, and an absent or errored store charges nothing. Ranking only orders candidates: eligibility and experimental exclusion are unchanged and no candidate is dropped.

Under `createSharedUnifiedProxy` (Part of #518), the residency store's lifecycle rows also feed the ranker's `expectedLoadMs` signal: a local candidate whose lifecycle row is `loading` or `warming` is charged only the remaining expected load, the default expected load (`DEFAULT_RANKING_WEIGHTS.defaultExpectedLoadMs`, 60 seconds) minus the time since the row's `updatedAtMs`, and a row whose elapsed time has reached that default keeps the full default. Elapsed time is measured from the row's last transition (`updatedAtMs`), so a freshly entered `warming` row is measured from that transition and charged up to the full default; a row stuck in `loading`, for example after a crash, is never cheaper than a cold candidate, and a future timestamp is capped at the default. The credit is emitted only when `residentPreference` or `coldLoadPenaltyMs` is nonzero (the ranker's `loadCostMs` is inert without the resident set), peers are never credited, every other state keeps the default, and an absent or errored store credits nothing; `coldLoadPenaltyMs` still applies on top of the credited load. The clock is read at rank time, not when the snapshot is built, so the 5s cache cannot freeze the credit. The `residencyStatus` `ranking` section lists the credit as `loadCredited`: one `{ model, expectedReadyAtMs }` entry per `loading`/`warming` lifecycle row still inside its credit window at status time, where `expectedReadyAtMs` is the row's `updatedAtMs` plus the default expected load — the instant the remaining credit reaches zero. `loadCredited` is empty when `residentPreference` and `coldLoadPenaltyMs` are both 0, because the ranker then emits no `expectedLoadMs` signal, and `llamactl residency status --node <name>` renders the entries on the `load credited: <workload> ready in <t>` line. Ranking only orders candidates: eligibility and experimental exclusion are unchanged and no candidate is dropped.

Under `createSharedUnifiedProxy` (Part of #518), `minResidencySeconds` also feeds the ranker's `cooldownUntil` signal — a local candidate without a `ready` lifecycle row whose exclusive residency group is held by another member in `ready` is charged until that member has been `ready` for `minResidencySeconds`, the later of the switch cooldown and the min-residency hold. Its limits: peers are never charged (only ads owned by `nodeId` qualify); only `ready` occupants of a declared-exclusive group hold (`state === "ready"`, not `isOccupyingResidencyState`); only a candidate with a lifecycle row tagged with the group is charged; a candidate with no lifecycle row is never charged; the latest-ready occupant sets the hold (max `updatedAtMs` per model within the group); an expired hold still reports its past instant (not clamped to now); when `minResidencySeconds` is 0, the hold is absent and the switch cooldown value stands alone; an absent or errored store charges nothing; the signal is emitted only when a ranking knob is nonzero (the store is not read otherwise). Ranking only orders candidates: eligibility and experimental exclusion are unchanged and no candidate is dropped.

Under `createSharedUnifiedProxy` (Part of #519), the resident set speaks only for candidates this node owns. The ranking signals carry `residencyKnown`, which is true only for ads whose `ownerNodeId` is this node, so a peer candidate has unknown residency. `coldLoadPenaltyMs` and the default expected-load cost never charge a peer and `residentPreference` never rewards one. A local candidate without a `ready` lifecycle row still ranks as non-resident, so a peer candidate outranks a local candidate that has no `ready` lifecycle row (for example one started by a plain apply) by that candidate's expected-load cost plus `coldLoadPenaltyMs`. This trade-off holds until local residency without a lifecycle row is known. A caller that passes `resident` without `residencyKnown` keeps the old behaviour, where the set speaks for every candidate.

## Node policy examples

Three `NodeRun` manifests for a three-node layout: one control-only 16 GiB node and two inference nodes, 48 GiB and 128 GiB. `control-16g`, `infer-48g` and `infer-128g` are placeholders: set `metadata.name` and `spec.node` to your own node names. The examples carry no credentials, no `env`, no `tarballUrl` and no addresses. They are policy examples, not hardware qualification: no measured TTFT, memory or swap evidence backs these values, and that evidence stays BLOCKED on opt-in hardware runs (Part of #285). Apply with `llamactl apply -f <file>` and inspect with `llamactl describe noderun <name>`.

```yaml
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: control-16g
spec:
  node: control-16g
  budget:
    memoryGiB: 1
```

That node runs the agent and the controller and no inference. The explicit budget wins over the computed one (`defaultNodeBudgetGiB` in `packages/remote/src/workload/admission.ts`), so `computeNodeBudget` refuses as `over-budget` any ModelRun whose `spec.resources.expectedMemoryGiB` would push the node above 1 GiB. A ModelRun that declares no `spec.resources.expectedMemoryGiB` reserves nothing and is admitted, and the `llamactl.io/force-admit` annotation bypasses the budget. The budget is therefore only a backstop: keep inference manifests off this node.

```yaml
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: infer-48g
spec:
  node: infer-48g
  residency:
    safetyMarginRatio: 0.75
    minResidencySeconds: 600
    switchCooldownSeconds: 300
```

```yaml
apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: infer-128g
spec:
  node: infer-128g
  residency:
    safetyMarginRatio: 0.8
    minResidencySeconds: 1800
    switchCooldownSeconds: 600
    coldLoadPenaltyMs: 30000
```

`minResidencySeconds` and `switchCooldownSeconds` are enforced, as the knob table above says. `coldLoadPenaltyMs` is ranking-only and applies only under `LLAMACTL_UNIFIED_PROXY=1` on the node that `LLAMACTL_NODE_NAME` names. Every value here is a starting point to tune from measured evidence, not a qualified profile.

| Node          | Memory  | Budget    | Source                            |
| ------------- | ------- | --------- | --------------------------------- |
| `control-16g` | 16 GiB  | 1 GiB     | `spec.budget.memoryGiB`           |
| `infer-48g`   | 48 GiB  | 36 GiB    | 48 GiB x `safetyMarginRatio` 0.75 |
| `infer-128g`  | 128 GiB | 102.4 GiB | 128 GiB x `safetyMarginRatio` 0.8 |

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

Approve each stage for one named canary at a time. Record the approved stage and window, exact controller and agent builds and negotiated capabilities, engine build, artifact revision, cache epoch, desired manifest revision, and prior configuration. Keep automatic residency disabled outside that approval. A missing capability or unresolved earlier operation blocks activation. Each report records the rollback trigger and verifies recovery of the prior routes and required services.

### Stage 0 - inventory and dry-run

Inventory the node, the authoritative manifest writer, and launchers that could restart the same workloads. Check the worker's reported capabilities and compare the expected build and artifact identities. Review the proposed plan against protected workloads and the node's finite budget.

```sh
llamactl residency status --node <name>
llamactl residency plan --node <name> --to <profile> [--from <profile>]
```

**Enable gate.** The plan has been reviewed, the manifest revision and prior service configuration have been captured, and the node-local store has a verified backup. Validate that the 16 GiB control-only example has no dedicated model placement and the 48/128 GiB examples leave room for protected services and host reserve.

**Rollback.** End the assessment and retain the inventory and dry-run report. Inventory and planning leave the deployed configuration intact.

### Stage 1 - manual switch

Use a one-off switch with a single desired-state writer and no conflicting launcher. The `ControllerActive` guard refuses a wet request while the controller lock is live. Review the dry run before the wet run. Use the operation ID to request cancellation while the owning process is still running. Cancellation is process-local and takes effect at a step boundary.

On the approved target, start its authenticated agent with `LLAMACTL_MANAGED_RESIDENCY=1`. The agent checks its named NodeRun budget against fresh local capacity, verifies the recorded processes, and binds the two journals to their file identities. Use `llamactl apply -f` with `--managed` to send desired workload changes to that owner. Capture the admission ledger and transition journal together for recovery.

Managed workloads require a loopback engine listener so fleet requests enter through the admitting agent. The owner checks the effective bind, including engine arguments and the ModelRun fallback endpoint. Route fleet traffic through the agent's authenticated proxy.

Use `llamactl residency load <workload> --node <name>` and `llamactl residency unload <workload> --node <name>` to preview a whole-process action on one exact managed workload. Add `--execute --yes` to run the previewed action. The owner checks the current profile, its leases and the transition journal. Unload refuses an active or protected workload and leaves the desired manifest enabled, so later authorized activation can load it again. Disable the workload through managed apply to remove that eligibility.

Use `llamactl enable <workload> --managed --node <owner>` and `llamactl disable <workload> --managed --node <owner>` to change eligibility. The authenticated owner reads and edits its current desired manifest under the same lock as managed apply. Enable uses the owner's finite budget. Disable waits for a verified stop before saving the disabled state. An older agent without this procedure refuses the command.

On an authorized unload, `--wait-seconds` gives active requests up to 60 seconds to finish. The owner blocks new leases for that workload while it waits and holds the same drain through the verified stop. A timeout or cancellation before teardown reopens admission. Protected workloads, active sessions, and unverified inference holds still refuse the stop.

```sh
llamactl residency apply-profile --managed --node <name> --to <profile> [--from <profile>]
llamactl residency apply-profile --managed --node <name> --to <profile> [--from <profile>] --execute --yes
llamactl residency cancel-operation <operationId> --yes --node <name>
```

**Enable gate.** Require the accepted finite-admission, lease, verified-release and restart-recovery builds. Drain existing pre-marker profile switches before upgrading. Prove that an overlapping request holds its lease through teardown, protected services keep serving, and a replacement enters the ready route only after a serving probe verifies the intended artifact. Verify the canary's `residency status` and restart outcome. A build that can release an unresolved switch's reservation or start a victim when its store is unreadable is blocked.

**Rollback.** Fence new canary traffic and drain active requests. If a committed switch has an unknown outcome, stop rollout and preserve the operation ID, fence, replacement process identity and reservation evidence. Keep the committed reservation, fence and lifecycle rows intact. Keep the node out of the canary while the claim, process or release is uncertain. Cancellation, a missing PID file, an agent restart, and elapsed time are insufficient release evidence. Before restoring the prior profile, prove the exact replacement generation is down and its capacity is released. Then reconcile the durable claim through a supported operation and obtain a fresh finite reservation before restoring any victim. If the build has no supported resolution path, leave the hold in place and record the blocker. Verify the restored profile's readiness, protected routes, and remaining budget before restoring traffic.

Managed profile execution consumes the plan's deadline across the drain, stops and starts. A plan that expires before actuation settles without starting or stopping an engine. A timed-out dispatched stop keeps the affected workload fenced, and uncertain dispatch retains the durable charge for recovery.

A programmatic managed owner can opt in to admission quiescence by supplying an exclusive-ingress verifier. Acquisition checks the warm queue, cold activation and handoff, active leases and durable inference holds. New demand invalidates the pause. Admission stays closed until its owning handle releases it. The capability requires authenticated managed cold ingress and declines Worker RPC configurations.

An opted-in managed host can call `RunningAgent.tryApplyIdleProfile({ from, to, signal })` once for an explicit maintenance window. The host supplies the verified current source profile and aborts the signal when the window ends. The coordinator uses the same profile planner, cooldown, release checks, and operation journal as the authenticated manual command. Inference demand invalidates the pause. The switch rechecks authorization before teardown, at actuator boundaries, and before publishing the selected profile. If authorization disappears after teardown or launch, the owner keeps the existing durable recovery hold. If an actuator outlives the plan deadline, admission stays paused until that actuator settles.

The window entry point is available only on a programmatic managed owner with a qualifying exclusive-ingress verifier. A deployment needs its own authorized scheduling policy and qualified exclusive ingress before it can invoke this entry point automatically.

### Stage 2 - request-driven admission and declared models

The following startup settings enable chat execution limits and declared-model projection. Enable only on the approved canary. Set `MAX_EXECUTIONS` and `MAX_QUEUED` to the reviewed positive integer execution and queue limits before restarting the agent. `agent serve` reads the settings once (`packages/cli/src/commands/agent.ts`).

```sh
export LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS="$MAX_EXECUTIONS"
export LLAMACTL_CHAT_ADMISSION_MAX_QUEUED="$MAX_QUEUED"
export LLAMACTL_DECLARED_MODELS=1
llamactl agent serve
```

For the default user LaunchAgent `com.llamactl.agent`, whose plist `agent install-launchd` writes to `~/Library/LaunchAgents/com.llamactl.agent.plist` with an `EnvironmentVariables` dict (`packages/cli/src/commands/agent-install/index.ts`), set the keys in the plist and reload it:

```sh
PLIST="$HOME/Library/LaunchAgents/com.llamactl.agent.plist"
plutil -replace EnvironmentVariables.LLAMACTL_CHAT_ADMISSION_MAX_EXECUTIONS -string "$MAX_EXECUTIONS" "$PLIST"
plutil -replace EnvironmentVariables.LLAMACTL_CHAT_ADMISSION_MAX_QUEUED -string "$MAX_QUEUED" "$PLIST"
plutil -replace EnvironmentVariables.LLAMACTL_DECLARED_MODELS -string 1 "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

**Enable gate.** The local cold ModelRun canary needs the managed owner, an authenticated TLS listener, declared models, and an `executionAdmission` group with explicit context and completion limits for the engine port. List each approved workload in `managedColdModelRuns` in the owning agent's `agent.yaml`. Each entry has `workload`, a lowercase hex `sha256` of the artifact, and a positive `maxArtifactBytes` sized for that exact artifact. Allow startup time for the digest verification. The supported cold request body uses a token-ID prompt and explicit `max_tokens` on `/v1/completions`.

Before allowing production canary traffic, test exact alias ownership, bounded coalescing, fair wait, cancellation, overload and warming responses under contention. Verify older and unmanaged peers keep their documented routing behavior. Peer declarations remain discovery evidence and are checked against a live owner receipt.

A programmatic gateway can opt in with `managedPeerColdGateway` and the unified proxy flag. Supply the complete peer set excluding the gateway itself, the exact model IDs and a resolver for dedicated per-owner service credentials. Treat that peer set as an activation input and refresh it before membership changes. A snapshot from an unexpected owner fences cold dispatch. A participating owner enables `managedPeerColdCredentials` on its authenticated TLS agent and scopes each credential to explicit model IDs. Cold dispatch currently covers exact OpenAI completions for managed ModelRuns over direct, certificate-pinned HTTPS. Every other peer must provide a fresh, complete empty declaration inventory. An ambiguous alias, stale or missing inventory, incompatible owner, or missing credential refuses the cold request.

The owner issues a short-lived, single-use receipt scoped to the gateway, request, exact completion body, model and current compiled deployment. The gateway rechecks ownership before submission. The owner revalidates the deployment through the existing cold queue and execution gate. If transport fails after submission, the gateway reports an unknown outcome for a non-streaming request and leaves settlement to the owner. An interrupted stream stays interrupted and the gateway does not replay it. Exercise this path in a qualified isolated deployment before enabling it for production traffic.

**Rollback.** Remove the canary from new request routing, then drain queued and active requests, leases and accepted launches under the current build. Resolve all resulting claims and verify available capacity before reverting canary settings or restarting the agent. Restore previous values or remove only the keys added for this canary (`plutil -remove EnvironmentVariables.<key> "$PLIST"` for the LaunchAgent). Verify contract behavior and ready routes against the baseline before returning the node to service. Carry any unknown transition forward using the Stage 1 hold.

### Stage 3 - native unload/wake

**Enable gate.** BLOCKED pending an approved production caller. Require an owner-mounted capability tied to the executable digest, effective launch configuration, model artifact and cache identity. Prove that only the owner can reach a load- or wake-capable endpoint, including from the same host. Demonstrate absence of probe-induced wake during health and inventory polls, an exact serving-readiness check, and a conservative measured residual-memory bound. Run the lease and capacity contention cases on each qualified build. Whole-process control is available until these requirements are met.

The hermetic llama.cpp adapter keeps a durable residual charge only after verifying the parked process and endpoint. Its wake reserves full capacity before dispatch and reopens leases only after verified readiness. The hermetic oMLX adapter commits the charge for the exact model generation before reopening leases. Both native integrations require an approved serving adapter before production activation. Upstream llama.cpp's idle timer can wake on inference and does not establish the explicit guarded sleep/wake contract. [Upstream sleep behavior](https://github.com/ggml-org/llama.cpp/blob/8e23278c7c36f4429fb237467d50e2935a91e655/tools/server/README.md#sleeping-on-idle)

**Rollback.** Fence and drain requests under the current build. Reconcile each native claim and verify the exact model generation and released capacity before returning to the qualified whole-process path. Preserve the artifact/cache identity and verify serving readiness under the prior profile. Use the Stage 1 hold for any unresolved outcome.

## Qualification evidence

- **Hermetic PASS** requires assertion-level evidence from the final build on macOS and Ubuntu with the workflow's pinned Bun version. Use temporary runtimes, loopback fake engine HTTP endpoints and real small fake executables. Inject restart before dispatch, during drain, after stop before release, after launch before PID recording, and after readiness before route publication. Cover stale ownership, partitions, stop refusal, delayed release and failed readiness. Under repeated overlap, assert reservations stay within budget and active and protected services remain available. Each restart must complete once, roll back within budget, or report a stable actionable unknown or unavailable state. Include unmanaged and older-peer controls.
- **Hardware PASS** requires a separately approved host, engine build, artifact and test window for each of oMLX, supported llama.cpp builds and the opaque-process backend. Compare baseline → canary → restored baseline with the same artifact, workload mix, arrival schedule and correctness rules. Record cold and warm cache state separately. Set acceptable thresholds and comparison sample counts before starting. Default CI uses fake engines and temporary state. Hardware qualification has not been run for this rollout.
- **FAIL** records a failed assertion or a measured result outside its predeclared threshold. Preserve the failed witness and the result of restoring the baseline.
- **BLOCKED** records missing evidence or an unresolved dependency with the next verification needed. Keep approvals separate from test status. A passing hermetic suite, skipped hardware run, or issue closure does not authorize activation.

The process fixture in `packages/remote/test/residency/fleet-e2e.test.ts` starts two managed owners with separate runtime roots and loopback engines. It keeps one peer request open during the other owner's forced exit, confirms that a second process cannot take the live owner's authority, and verifies that the restarted owner refuses the unresolved workload without dialing again. The peer completes normally. Separate cases kill the owner at five boundaries: after reservation before dispatch, after spawn before PID recording, after readiness commit before route publication, during a drain with an admitted stream, and after verified engine stop before durable release. The restarted owner keeps each unresolved allocation charged, refuses completion and an oversized replacement, and preserves the prior streaming hold during the drain case. The mixed-engine fixture in `packages/remote/test/residency/stop-fence.test.ts` separately checks the verified forward switch and reverse profile rollback on one owner. Both fixtures use synthetic capacity samples and make no hardware or throughput claim.

Capture a private `llamactl residency status --node <name> --json` snapshot at the start and end of each approved window and at each fenced transition. Record operation IDs and capacity observations alongside the workload-run timestamps. The Workloads console and `llamactl_execution_admission_oldest_wait_seconds` metric show the current oldest wait per execution group. Use per-request wait observations for percentiles and workload-run outcomes for successful tasks/hour.

Use the following comparison units for each scenario and window. Record sample counts, aborts, timeouts, refusals, in-flight requests and measurement sources alongside the aggregates. Missing sources are reported as unavailable.

| Measure                 | Unit and evidence                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Warm and cold TTFT      | Milliseconds from request submission to the first output token, p50 and p95 for each cache state.                                 |
| Inference latency       | Milliseconds from submission through terminal response, p50 and p95.                                                              |
| Correct completed tasks | Tasks accepted by the fixture's correctness oracle per hour of the full observed wall-clock window.                               |
| Load and switch time    | Milliseconds from load start to serving readiness and from accepted switch to settled outcome.                                    |
| Queue fairness          | Queue wait p50/p95 in milliseconds and counts of admitted, refused, cancelled and expired requests per class.                     |
| Memory                  | Peak unified memory in bytes, pressure readings with platform source, and swap-in and swap-out deltas in bytes over each window.  |
| Engine telemetry        | Decode and prefill tokens/second, slot occupancy and deferral from the #249 collector, with counter resets identified per window. |

Validate the Book interactive and maintenance scenarios against the consumer's existing quorum rules. Check the required role sets, the protected large-node executor, the fixed embedding identity and deferred background judging under request overlap and failure. Record consumer-visible completed tasks and the observed state of each required role. Preserve the configured models, embedding space and consumer policy.

### Isolated process preflight and smoke probe

Use the source checkout at the candidate revision. Run the preflight in the
approved window. It evaluates managed physical capacity and host
reserve before opening or hashing either artifact. This isolated probe does
not read the deployed owner's reservation ledger. Exit 2 reports a blocked
or invalid plan. A successful preflight reports `NOT_RUN` and opens no
engine socket.

By default the probe requires zero occupied swap. A private plan can set
`maxSwapUsedGiB` to an approved finite ceiling for already-occupied swap.
With that option, preflight and execution require a fresh one-second window
with no swap I/O. The run settles and fails if occupied swap increases above
its initial reading, swap I/O resumes, or the monitor loses its evidence.
The option applies only to this isolated process probe. The physical
headroom, pressure, and host reserve checks still apply.

```sh
umask 077
PROBE=packages/remote/src/residency/hardware-process-probe.ts
bun "$PROBE" --preflight private-plan.json > preflight.json
bun "$PROBE" --execute private-plan.json > process-smoke.json
```

Use absolute paths and lowercase SHA-256 hex digests in the private plan. A
llama.cpp example uses a small, pinned standalone GGUF.

```json
{
  "backend": "llamacpp",
  "binary": "/absolute/path/to/llama-server",
  "binarySha256": "REPLACE_WITH_ENGINE_SHA256",
  "artifact": "/absolute/path/to/model.gguf",
  "artifactSha256": "REPLACE_WITH_MODEL_SHA256",
  "model": "qualification-fixture",
  "contextTokens": 4096,
  "requiredHeadroomGiB": 6,
  "readinessTimeoutMs": 60000,
  "requestTimeoutMs": 30000
}
```

The probe builds the supported engine arguments itself. It binds an ephemeral
loopback listener, provides the pinned model path, limits concurrency to one
and puts engine state in a private temporary directory. Use `llamacpp` with
a standalone GGUF or a whole GGUF directory plus `ggufFile` naming the first
shard. Use `omlx` with a directory containing one model subdirectory named
by `model`. Use `kapitsa` with the exact preconverted model directory.
The probe uses the oMLX build's default context. Set
`requiredHeadroomGiB` to a conservative bound for the approved model and
settings. Pin the interpreter and installed dependency manifest separately
when the executable is a launcher. Use trusted staged assets that operators
keep immutable during the run. The probe verifies contents and file
generations, and the engine opens the verified paths at launch. The JSON
report omits file paths, process arguments, request text and returned content.

A directory artifact is pinned by the SHA-256 of the UTF-8 JSON array of
`[relativePath, sha256Hex]` pairs. Files are visited in lexical order within
each directory, depth first. Relative paths use forward slashes. Use regular
files and directories, and materialize symlinked snapshots in a separate
staging directory. Hashing may warm the filesystem cache. The first request
sample measures a fresh process. Measure cache-hit behavior separately.

Execution rechecks capacity and the staged file generations just before
launch. It requires `lsof` to match the isolated listener to the child PID
and uses direct loopback HTTP for inventory and chat. It records the first
visible content time and terminal latency for one request and three repeats,
alongside output matches, host capacity and available swap counters.
Unsafe pressure, swap outside the plan's limits, or unavailable capacity
aborts the smoke.
The capacity check requires exclusive use of the hardware smoke probe on the
host and an operator-approved window for other workloads.

The result includes process group and listener release evidence. Exit 1
records a failed assertion or cleanup. Exit 0 records a passing process
smoke. If runtime release is unresolved after a normal interruption or an
abnormal exit, the directory `/tmp/llamactl-residency-hardware-smoke.lock`
blocks another run. Its private `run.json` records the supervisor PID and
adds the listener, workspace and process group as they become known. An
early crash can leave a partial or empty receipt. Verify exact process
identity from current observations before signaling anything. Remove the
lock and workspace only after proving the supervisor and engine group are
gone and the listener is free. Keep the lock if release remains uncertain.
Native unload and wake, sustained pressure, workload correctness and
activation use the broader qualification gates above.

### Evidence manifest example

Copy this JSON template for one candidate build, stage and backend. Record test status as `NOT_RUN`, `PASS`, `FAIL` or `BLOCKED`. Each completed window references a redacted measurement record using the units above. Record approved scope separately. Evidence references identify immutable artifacts or logs without publishing credentials, private addresses, model paths, or request contents.

```json
{
  "schemaVersion": 1,
  "sourceCommit": null,
  "stage": 0,
  "activationApproved": false,
  "builds": { "controller": null, "agent": null, "engine": null },
  "workerCapabilities": [],
  "identity": { "artifactRevision": null, "cacheEpoch": null, "manifestRevision": null },
  "hermetic": { "status": "NOT_RUN", "evidence": [] },
  "hardware": {
    "status": "NOT_RUN",
    "backend": null,
    "cases": [],
    "windows": { "baseline": null, "canary": null, "restoredBaseline": null }
  },
  "rollback": { "trigger": null, "restorationEvidence": null },
  "blockers": ["No hardware qualification has been run"]
}
```
