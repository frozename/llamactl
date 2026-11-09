# Target-owned pending admission implementation plan (v3)

Status: revised design proposal v3, not an implementation approval. Supersedes
`implementation-plan.md` (v2) where they differ. Re-verified against main
`fec4f3ca` (post-#364/#365/#371). The conditional re-review gave GO for the
first slice subject to eight edits; all eight are incorporated below and
mapped in the changelog. Every file:line anchor in this document was checked
against `fec4f3ca` and corrected where it had drifted.

Goal: when independent callers use different aliases to reach one target
authority, only allocations that fit its pending-plus-resident ledger may
reach either model loader. This slice proves that property through both
ModelRun and ModelHost start boundaries. It does not enable production
managed residency or claim that every host spawn path is covered.

Architecture: a pure core decision over explicit allocations; one durable
target-owned SQLite authority; a short synchronous check/insert transaction
before launch; wrappers on the two existing start procedures. All uncertain
attempts remain charged. No TTL releases memory. No additional controller,
service, dependency or public operator tool is introduced.

Tech stack: existing Bun 1.4.3 CI pin, TypeScript/Zod, `bun:sqlite`, tRPC
subscriptions, existing core PID identity helpers and owned
temporary-process fixtures.

## Changelog: v2 → v3

The eight conditional edits, and where each landed:

| # | Conditional edit | Addressed in |
| --- | --- | --- |
| 1 | `ctx` required on `clientForNode`/`localCallerProxy`; enumerate every call site | "Context and caller coverage" — full enumeration at `fec4f3ca` added `router.ts:1846` (workloadApply's own `getClient`, absent from the conditional list) and the rag `createCaller({})` sites `:3579`/`:3803` |
| 2 | Generation capture for ADOPTED results (`server.ts:1142-1154`, `modelhost.ts:413-425`, `:596-600`): record the terminal pid, verify it against the runtime-dir pid record | "Generation evidence and the ADOPTED result path" |
| 3 | Orphan pending claim becomes `uncertain` and is terminal in this slice; no uncertain→resident repromotion; recovery only via verified absence or manual teardown | "Atomic claim and lifecycle contract" — `commitReady` is now pending-only; `uncertain` is absorbing |
| 4 | Gateway-provider loads (sirius/embersynth, `apply.ts:1596-1608`) join the unqualified list; agent-gateway fallthrough ModelRuns require inline manifest + declared allocation | "Coverage boundary" |
| 5 | Allocation source is `spec.resources.expectedMemoryGiB` only; `admission.ts:242-259` heuristics never feed the ledger | "Chosen APIs and trusted data" + "Allocation source" |
| 6 | Module-scope `bun:sqlite` import tolerated; `Database` construction only inside the opt-in factory (Electron shim `packages/app/electron/shims/bun-sqlite.ts` throws on construction) | "Exact boundary and file fence" + "bun:sqlite construction boundary" |
| 7 | Observed status → done envelope for resident same-digest return; pending-outcome wire shape (`ApplyAction` already has `"pending"`, `apply.ts:165`) | "Resident same-digest return and the pending-outcome wire shape" |
| 8 | Wrappers inject the frozen env/runtimeDir into loaders so ambient `process.env` drift cannot diverge loader root from ledger root | "Atomic claim and lifecycle contract" (frozen-env injection) + "Chosen APIs and trusted data" |

Carried-forward scoped/deferred items, and where each sits:

| Item | Addressed in |
| --- | --- |
| `keepAliveStart` bypass (`router.ts:2544-2591`, detached spawn `:2573`; worker calls core `startServer` at `keepAlive.ts:487`) | "Coverage boundary" — deferred-unmanaged |
| Standalone CLI local start (`packages/cli/src/commands/server.ts:226`, `isLocalDispatch` branch) | "Coverage boundary" — deferred-unmanaged |
| `rpcServerStart` (`router.ts:2501`) model shards | "Coverage boundary" — deferred-unmanaged |
| NodeRun budget at the target is capacity-only until NodeRun transport exists (`saveNodeRun` is controller-side only, `cli/commands/workload.ts:441`) | "Chosen APIs and trusted data" — budget source |
| ModelHost failure-path spawned-pid reporting | "Generation evidence and the ADOPTED result path" — the `opts.spawn` seam reports `child.pid` on every outcome, not only success |
| `specDigest` = normalized post-placement manifest + effective launch args | "Digest and wire binding" |

Anchor corrections applied during re-verification (conditional-review citation
→ verified location on `fec4f3ca`): `serverStop` → `router.ts:2375-2388`;
"cli server.ts:226" → `packages/cli/src/commands/server.ts:226`; heuristic
estimate → `packages/remote/src/workload/admission.ts:242-259`;
`computeModelHostSpecHash` → `packages/core/src/engines/state.ts:42`;
inline-manifest persist → `modelhost.ts:718-720`; mmproj-retry second
generation → `server.ts:1044-1094`.

## Evidence and dependencies

- Existing counterexample executed against `b5c2e393`: two aliases resolve
  to the same inert target; each 16 GiB launch passes a 24 GiB controller
  budget while both loads are pending. Expected one loader, observed two;
  0 pass/1 fail/1 assertion, exit 1. `pending-alias-counterexample.test.ts`
  and its receipt are independent artifacts, not candidate edits. This is an
  alias/pending proof in one process, not a cross-process authority proof.
  `b5c2e393` is not an ancestor of `fec4f3ca`; the artifact stays external.
- Source reviewed at integration pin
  `339df61672306cf3e982915edfa318d08fb2c75f`; all anchors re-verified on
  `fec4f3ca` for this revision. `resources/memory.ts:deriveHostHeadroom`
  (`:90`) is an observation/headroom calculation, not a load grant or a
  committed-claim ledger. Do not reinterpret its configured reserve as
  workload allocations or subtract resident usage twice.
- One actual Mini-origin free Devin review completed 373.53 seconds, 58
  native read/search calls, no execute/edit/delete calls; verdict
  REVIEW_CHANGES_REQUIRED. Its findings are dispositioned in v2 and carried
  here. A conditional re-review of v2 gave GO with the eight edits above.
  Neither review ran tests.

## Invariants (verbatim from v2)

The following statements are quoted verbatim from v2 and remain binding.
Section references note where v3 refines behavior without relaxing them.

- "All uncertain attempts remain charged. No TTL releases memory. No
  additional controller, service, dependency or public operator tool is
  introduced."
- "Managed incoming allocation must be explicit, finite and positive; null,
  zero-as-unknown, negative, NaN and infinity refuse."
- "Budget0 is a known closed budget."
- "No force parameter exists." (A force annotation is never an override.)
- "All pending/resident/uncertain rows count."
- "Store-unavailable totals are null, never invented zero."
- "The canonical database path belongs to this object; no RPC input chooses
  it."
- "All mutating operations compare claimId, ownerEpoch and
  generationVersion."
- "No await, process probe or spawn occurs under that transaction."
- "Busy/corrupt/unavailable stores refuse before effects; busy handling has
  a bounded deadline."
- "Opening another store connection never rotates ownerEpoch."
- "An obsolete proof cannot free a newer launch or replacement."
- "An event with PID0 or a crash before the event leaves unprovable state
  charged."
- "Owner abort may stop the existing loader, but it never releases a claim
  merely because the request ended."
- "A stale claim/epoch/version transition is rejected without mutation."
- "No TTL, heartbeat timeout, disconnected controller, disabled YAML or
  missing PID record frees a charge."
- "`isRecordedPidGone` permits reaping a PID tracking record. It is not
  alone proof that a multi-process runtime has released its memory."
- "Do not charge one manifest while launching different raw arguments."

The v2 state-decision table, also verbatim. Refinement under v3: `uncertain`
is absorbing for every cause (see "Atomic claim and lifecycle contract") —
the "Pending after reopen" row's terminal outcome is unchanged, and no
transition out of `uncertain` exists in this slice.

| Stored state and evidence | Same digest | Different digest |
| --- | --- | --- |
| Absent, initialized authority | Atomically claim and invoke once if it fits | Same |
| Pending with live same-epoch loader promise | Join its actual terminal result | WorkloadBusy; no second loader |
| Pending after reopen/no owning promise | Convert to uncertain; OutcomeUnknown | WorkloadBusy/OutcomeUnknown; charge retained |
| Uncertain with no live owner | OutcomeUnknown; never fabricate a join or rerun | WorkloadBusy/OutcomeUnknown |
| Resident, verified live observation | Return its actual observed status | WorkloadBusy; no restart |
| Any row, unknown identity or incomplete release proof | OutcomeUnknown; retain charge | Same |
| Any row with fresh verified whole-runtime absence and quiesced loader | Fenced release, then new admission | Same |

## Exact boundary and file fence

The authority facility is inactive by default. Production `agent serve` does
not construct or activate it in this slice. Existing legacy targets retain
their current behavior. Tests explicitly supply an authority binding to an
isolated real agent/router. An attempted-but-failed authority is represented
as degraded and must never disappear into legacy behavior.

Create:

- `packages/core/src/residency/managed-admission.ts`: pure policy, digest
  inputs and state/refusal contracts. (`packages/core/src/residency/`
  already exists; the legacy `admission.ts` with `admitAgainstFiniteBudget`
  and `capacityBudgetGiB` stays untouched.)
- `packages/core/test/managed-admission.test.ts`: arithmetic, invalid
  inputs, state and digest tests (alongside the existing
  `residency-admission.test.ts`).
- `packages/remote/src/residency/admission-store.ts`: bounded active-row
  SQLite store, transactions and fenced compare/update. (New directory.)
- `packages/remote/src/residency/admission-authority.ts`: owned runtime
  root/budget/observer, loader coordination, bounded joins and lifecycle.
- `packages/remote/test/residency/admission-store.test.ts`,
  `admission-authority.test.ts`, `admission-entrypoints.test.ts`: actual
  store/loader/router fixtures.

Modify only:

- `packages/core/package.json`, `packages/core/src/index.ts`: export new
  pure module; retain the separate memory policy and legacy admission
  exports.
- `packages/remote/src/router.ts`: `AgentRouterContext` binding,
  required-ctx signatures and every enumerated call site (see "Context and
  caller coverage"), both start wrappers, optional normalized inline
  ModelRun input on `serverStart`, refusal result types.
- `packages/remote/src/server/serve.ts`: optional binding passed through
  the existing direct (`:638`) and tunnel (`:758-772`) `requestContext`
  (`:593-598`); no activation configuration or default construction.
- `packages/remote/src/workload/apply.ts`: carry inline ModelRun and typed
  refusal details through its structural `WorkloadClient` (`:103-116`),
  `startCoordinator` (`:1382-1439`), `startModelHostProcess` (`:500-548`)
  and ApplyResult/conditions; retain existing controller-side finite
  preflight (`admitServerBudget` `:1311-1358`, `admitModelHostBudget`
  `:457-469`).
- `packages/remote/src/client/node-client.ts`: `createNodeClient`/
  `proxyFromCaller` (`:85`, `:108-117`) take a required context; the
  standalone-local path supplies the explicit unconfigured context (legacy,
  deferred-unmanaged).

No need to modify `server/modelhost.ts` or `core/src/server.ts`: the
ModelHost `opts.spawn` seam (`modelhost.ts:614`), the ModelRun `launch`
event (`server.ts:1440`), the `StartServerOptions.resolved` injection point
(`server.ts:518`, consumed at `:1216`) and the ModelHost
`env`/`runtimeDir` injection points (`modelhost.ts:135`, `:200`, consumed
at `:682-684`) give the wrapper every seam it needs — including adopted-pid
generation capture (see below). If re-verification at implementation time
invalidates either fact, revise this fence before implementation. No
module-global published authority; two isolated test agents must remain
independent.

## bun:sqlite construction boundary

Module-scope `import { Database } from "bun:sqlite"` inside the remote
residency modules is tolerated — bundled workspace code already imports
`bun:sqlite` at module scope and the Electron build aliases it to
`packages/app/electron/shims/bun-sqlite.ts`, whose `Database` constructor
throws `bun:sqlite is unavailable in the Electron process`. Construction
(`new Database(...)`) happens only inside the opt-in authority factory
(`openAdmissionAuthority`), never at import time and never inside the
router module graph's evaluated paths. The Electron main process never
calls the factory; if a future bundle accidentally does, the shim throws
loudly at construction rather than silently degrading to legacy behavior.

## Chosen APIs and trusted data

Proposed core values (unchanged from v2):

```ts
type ClaimState = "pending" | "resident" | "uncertain";
type RuntimeKey = { kind: "ModelRun" | "ModelHost"; name: string };
type ManagedClaim = {
  claimId: string;
  ownerEpoch: string;
  key: RuntimeKey;
  specDigest: string;
  allocationGiB: number;
  state: ClaimState;
  generationVersion: number;
};
type AuthorityBinding =
  | { kind: "live"; authority: AdmissionAuthority }
  | { kind: "degraded"; authorityId: string | null; reason: string };
```

`AuthorityBinding` and the runtime authority interface live in remote, not
core; the pure core module contains no process object, SQLite, files,
callbacks or tRPC imports. No binding in an unconfigured target is the only
legacy case. A factory that attempts to open the store returns a live or
degraded binding; it must not turn a thrown open/recovery failure into
undefined.

`evaluateManagedAdmission({budgetGiB, claims, incoming})` is pure. Managed
incoming allocation must be explicit, finite and positive; null,
zero-as-unknown, negative, NaN and infinity refuse. Budget0 is a known
closed budget. No force parameter exists. Existing legacy
`admitAgainstFiniteBudget` (`core/src/residency/admission.ts`) remains
unchanged. All pending/resident/uncertain rows count. A hard internal cap
of 128 charged claims refuses ClaimLimitExceeded before loading; this
bounds rows materialized per decision without introducing an operator
setting or future queue.

Budget source in this slice is only `target-capacity` or `unavailable`. The
target owner snapshots its own physical capacity and applies the existing
capacity budget ratio (`capacityBudgetGiB`,
`core/src/residency/admission.ts:21`, 0.75 headroom). `saveNodeRun` is
invoked only by the controller CLI (`cli/commands/workload.ts:441`); no
transport delivers a NodeRun manifest to the agent's store, so
`target-NodeRun` does not exist as a source here and a controller's numeric
budget is never trusted at the target. Delivering and reconciling an
explicit target policy is a later dependency before full #274 acceptance.

Runtime uniqueness follows actual storage: `workloadRuntimeDir`
(`core/src/workloadRuntime.ts:150-151`) uses root/name, not root/kind/name.
The ledger has a unique workload name within its frozen runtime root; kind
is an attribute, and a cross-kind same-name request refuses WorkloadBusy
before touching the shared directory.

The authority constructor freezes a canonical target runtime root and
resolved environment. Handlers use that environment explicitly and refuse
RootMismatch rather than opening another ledger based on per-call env or
alias text (see "frozen-env injection" below). The canonical database path
belongs to this object; no RPC input chooses it. Its persisted authority ID
is telemetry, not physical-host identity or an authorization token.

Refusal codes: LaunchMismatch, BudgetUnknown, AllocationUnknown,
InvalidReservation, BudgetExceeded, WorkloadBusy, OutcomeUnknown,
AuthorityUnavailable, ManagedManifestRequired, RootMismatch,
ClaimLimitExceeded and JoinLimitExceeded. The structured result carries
authorityId:string|null, budgetGiB:number|null, budgetSource,
requestedGiB:number|null, chargedGiB:number|null, pendingGiB:number|null
and claims:ManagedClaim[]|null. Store-unavailable totals are null, never
invented zero. Ordinary error text remains for existing consumers.

### Allocation source

The ledger's `allocationGiB` is `spec.resources.expectedMemoryGiB` only —
for both kinds. For ModelRun this is the same field the controller
preflight reads (`apply.ts:1336`). For ModelHost, only the declared branch
of `estimateModelHostMemoryGiB` (`workload/admission.ts:246-247`) qualifies;
its heuristic branch (`:248-258`, models-dir size × multiplier) is a
controller-preflight estimate and never feeds the ledger. A managed request
with absent/zero declared allocation refuses AllocationUnknown — the
authority never substitutes a filesystem-derived guess for a declared
reservation. The controller-side `admitModelHostBudget` (`apply.ts:457-469`)
keeps using the heuristic for its advisory preflight; the two are
deliberately different quantities.

## Digest and wire binding

`specDigest` = the normalized post-placement manifest plus effective launch
args, hashed over an explicit stable field order with SHA256.

Add pure `computeModelRunSpecHash` over a post-parse structural launch
descriptor: runtime kind/name, target kind/value, ordered extraArgs **as
executed** (including the composed `--rpc` flag `applyOne` appends for
worker manifests, `apply.ts:1626-1634`), effective endpoint host/port,
effective binary, timeoutSeconds, allowExternalBind, gateway flag, skipTuned
and allocationGiB. "Post-placement" means the values after defaults and
composition are resolved — the descriptor the wrapper verifies equals the
wire request is the same descriptor that is hashed. Since skipTuned has no
ModelRun manifest field (it exists only on the `serverStart` wire input,
`router.ts:2405`, forwarded at `:2427`), this slice fixes it to false in
managed mode and rejects an incompatible raw override; do not add a
manifest tuning field. Ignore controller identity, spec.node alias and
metadata labels/annotations; a force annotation is never an override.
Define omitted/default-equivalent values before hashing. Reuse ModelHost's
existing `computeModelHostSpecHash` (`core/src/engines/state.ts:42`) over
its normalized spec plus the managed allocation. Different model-target
alias strings need not coalesce in this slice; do not claim a
model-content/calibration identity guarantee.

Authority-enabled ModelRun `serverStart` requires an inline normalized
ModelRun (new optional `manifest` field on the wire input and on
`WorkloadClient.serverStart.subscribe`'s structural input,
`apply.ts:103-116`); ModelHost requires its existing inline manifest
(`modelHostStartInput` `router.ts:556-561`, consumed at `:1906`). Verify
workload name, target, ordered args, endpoint, binary, timeout and
external-bind fields equal the descriptor actually executed. Do not charge
one manifest while launching different raw arguments. No inline manifest or
unknown allocation refuses before desired-state/runtime writes. A wrapper
invokes ModelHost's current inline-manifest persistence
(`modelhost.ts:718-720`) only after claim success.

Use the existing done-result envelope with `ok:false`, error text and an
added structured `admission` field on the result object.
`startCoordinator` and `startModelHostProcess` must preserve that field
into ApplyResult/conditions instead of discarding it. Test actual
subscription encoding and consumption, not only an internal object.
Preserve the optional structured field in internal ApplyResult and
ApplyManifestOutcome failure arms. Existing top-level workloadApply
exception transport remains textual in this slice; do not introduce a
global tRPC error formatter or claim full all-entrypoint structured
diagnostics.

## Atomic claim and lifecycle contract

The target store owns `claimIfFits`, `recordLaunch`, `commitReady`,
`markUncertain`, `releaseVerified` and `snapshot`. All mutating operations
compare claimId, ownerEpoch and generationVersion. One synchronous
`BEGIN IMMEDIATE` reads rows, validates quantities and target budget,
checks same-key state/cap, inserts pending and commits. No await, process
probe or spawn occurs under that transaction. Busy/corrupt/unavailable
stores refuse before effects; busy handling has a bounded deadline.

Opening another store connection never rotates ownerEpoch. Only explicit
authority recovery after the previous owner is verified gone may rotate the
epoch and mark orphan pending rows uncertain. A second active authority for
the same canonical root must return degraded rather than steal ownership on
a timeout; keep this owner check in the existing store/authority fence.

Process observations happen outside the DB transaction. A
release/transition commits only if the row's claimId, epoch and latest
generationVersion still match the observation. An obsolete proof cannot
free a newer launch or replacement.

The public internal wrapper is `authority.runStart(request, loader)`, not a
claim token clients can spend. It owns the single loader promise per new
claim.

**Frozen-env injection (conditional edit 8).** The wrapper invokes each
loader with the authority's frozen resolved environment, not ambient
`process.env`: for ModelRun via `StartServerOptions.resolved`
(`server.ts:518`, consumed at `:1216`); for ModelHost via `opts.env` +
`opts.runtimeDir` such that `toRuntimeEnv`/`withRuntimeDir`/`resolveEnv`
(`modelhost.ts:135`, `:200`, `:682-684`) yield the frozen root. Before
claiming, the wrapper asserts the loader's resolved
`LOCAL_AI_RUNTIME_DIR` equals the authority's canonical runtime root
(canonicalized paths) and refuses RootMismatch otherwise — the same
assertion the ledger's root uniqueness depends on. Ambient `process.env`
drift after authority construction can therefore never point the loader at
a different root than the ledger's. The frozen env also backs every status
re-observation and pid-record read the wrapper performs.

**Uncertain is absorbing (conditional edit 3).** In this slice `uncertain`
is terminal for every cause: a pending row orphaned by reopen/owner loss
converts to uncertain at claim-decision time and stays charged; an
ambiguous disconnect, incomplete cleanup or unprovable generation marks
uncertain and stays charged. There is no uncertain→resident repromotion —
`commitReady` promotes only `pending` with matching claim/epoch/latest-
generation ready evidence, and reopening changes epoch so an old owner
cannot commit. This tightens v2, which permitted same-epoch uncertain→
resident commit; the simpler absorbing rule removes the need to
distinguish "still-live loader" uncertainty from orphaned uncertainty.
Recovery from `uncertain` is exactly two paths: a fenced `releaseVerified`
on fresh verified whole-runtime absence (the pre-decision sweep below), or
explicit manual teardown outside this slice's API (an operator kills the
process group and removes the row — a #275-scoped operation, not an RPC
added here).

`markUncertain` changes pending to uncertain; late cancellation cannot
demote a verified resident or touch another claim. A stale
claim/epoch/version transition is rejected without mutation. A loader
failure with incomplete cleanup remains uncertain.

State decisions: the verbatim invariant table above governs. Join semantics
preserve existing ModelHost behavior (`inFlightModelHostStarts`,
`modelhost.ts:565-580`): duplicates of an active same-digest start receive
the owning loader's actual result, not a synthetic pending error. The
authority supplies the equivalent single-keyed join for ModelRun, which
today has no in-flight dedup — that also closes the pre-existing hole where
two concurrent `serverStart` calls each run `stopServer` then spawn
(`server.ts:1228-1267`) and the second kills the first's loading child.
Keep at most 16 live join subscribers per claim; the 17th gets
JoinLimitExceeded. Detach aborted waiters and delete the in-flight promise
and waiter state on settlement. Retain only bounded status metadata for
resident rows, not completion payloads or a per-request history.

Keep existing owner-request cancellation semantics for the first loader;
this slice does not introduce another controller or detached load service.
A duplicate waiter's disconnect only detaches that waiter. Owner abort may
stop the existing loader, but it never releases a claim merely because the
request ended. Remaining waiters observe the actual terminal outcome.

No TTL, heartbeat timeout, disconnected controller, disabled YAML or
missing PID record frees a charge. Steady-state release is attempted by the
authority wrapper over its bounded charged rows before each new claim
decision, using its target-owned observer; apply only fresh matching
claim/epoch/generation proofs inside the final transaction, then evaluate
the new claim. This can reclaim a proved-absent old key even when the new
request names another key; no background sweeper or new release RPC is
added. Unknown evidence remains visible as OutcomeUnknown until a verified
observation is possible.

`isRecordedPidGone` (`core/src/pidIdentity.ts:314`) permits reaping a PID
tracking record. It is not alone proof that a multi-process runtime has
released its memory. `VerifiedRuntimeAbsence` must also establish loader
quiescence and absence of every owned generation/process group relevant to
that runtime. PID reuse, missing sidecars or a dead parent with surviving
children are insufficient. The first implementation may conservatively
return unknown for engines whose whole-runtime absence cannot be
established; that blocks release/activation, not capacity accounting.
Owned single-process fixtures can exercise the positive release path. #275
supplies broader verified stop/runtime completion.

## Generation evidence and the ADOPTED result path

`recordLaunch` durably captures every generation before later readiness
handling. Evidence sources, in order:

1. ModelRun `launch` events (`server.ts:1440`; `child.pid ?? 0` at `:1439`)
   cover the first pid and the mmproj-retry pid (retry relaunches through
   `launchBackground` at `:1070` and rewrites the record at `:1082` — both
   generations arrive on the same `onEvent` stream). An event with PID0 or
   a crash before the event leaves unprovable state charged.
2. ModelHost's existing real `opts.spawn` seam (`modelhost.ts:614`) hands
   the wrapper the `ChildProcess` itself: `child.pid` is captured as
   generation evidence on every outcome — success, readiness failure, and
   spawn-then-crash — not only on success. The pid sidecar is written only
   after readiness (`writeModelHostState` at `:654`), so the seam capture
   is the only failure-path pid source; a spawned-then-failed ModelHost
   whose pid was never captured would be unverifiable and stays uncertain.
3. ADOPTED results emit no `launch` event and invoke no spawn seam. Core
   `handlePortConflict` → `tryAdoptExistingServer` (`server.ts:1142-1154`)
   writes the pid record (`writeServerPid` at `:656` inside `:624-656`) and
   returns `startServerSuccess` carrying `adoptedPid`. ModelHost
   `reapOrAdoptPriorHost` → `tryAdoptLiveHost` (`modelhost.ts:413-425`)
   writes `writeModelHostState` (`:337-346`) and returns through
   `launchModelHost`'s early-done path (`:596-600`) carrying the adopted
   pid. For either kind: when the done envelope reports `ok:true` with a
   pid but no launch event/spawn handle covered that pid during this
   invocation, the wrapper reads the runtime-dir pid record under the
   frozen root and requires it to equal the result's terminal pid before
   `recordLaunch`/`commitReady`. Equal → the adopted pid is the generation
   evidence. Mismatch or absent → the adoption is unprovable:
   `markUncertain`, charge retained — never released on the strength of a
   result object alone.

`releaseVerified` must check the latest observed generation and refuse if
any newer generation was seen; an aborted ModelRun start deletes both
tracking files (`StartServerOptions.signal` doc, `server.ts:520-526`), so
generation capture must happen at event/seam time, not by later re-read —
the ADOPTED-rule record read above is the sole exception, and it exists
precisely because the adoption path wrote the record itself.

## Resident same-digest return and the pending-outcome wire shape

Resident, verified live observation, same digest: the wrapper returns a
done envelope whose `result` is the freshly observed status read under the
frozen env — not a replayed stale loader result. ModelRun: the
`serverStatus` readout (`router.ts:2351-2353` → `serverMod.serverStatus`)
mapped into the start-result shape `{ok:true, pid, endpoint, ...}` carrying
the re-observed live pid. ModelHost: `statusModelHost`
(`modelhost.ts:771-799`) mapped into `{ok:true, pid, specHash, ...}` — its
verdict already corroborates recorded-pid identity, so `state:"Running"`
there is the verified-live observation. The envelope's `admission` field
reads `{decision:"resident", claimId, authorityId}`.

Pending outcomes on the wire:

- Duplicate same-digest while pending with a live same-epoch owner → join:
  the waiter's subscription stays open and completes with the owning
  loader's actual terminal done envelope plus `admission`
  `{decision:"joined", claimId, authorityId}`; no synthetic "still pending"
  envelope is emitted, matching the existing ModelHost in-flight contract.
- Pending after reopen/no owning promise, or uncertain of any provenance →
  done envelope `{ok:false, error}` with `admission`
  `{code:"OutcomeUnknown"|"WorkloadBusy", ...}` — terminal in this slice.
- Any managed refusal → same envelope shape; `startCoordinator`/
  `startModelHostProcess` translate it into the existing apply-side
  non-terminal convention: `ApplyResult.action = "pending"`
  (`apply.ts:165`; the convention `admissionFailureResult`
  `:1259-1276` and the port-collision arm `:955-971` already use —
  `phase:"Failed"` + `BudgetRefused`-family condition + error text), now
  also carrying the structured `admission` object through ApplyResult/
  ApplyManifestOutcome failure arms. A managed refusal is never reported
  as `"unchanged"`/`"started"`/`"restarted"`.

## Context and caller coverage

`AgentRouterContext` (`router.ts:532-534`) gains an optional authority
binding field (live/degraded `AuthorityBinding`). `ctx` becomes a required
parameter on the two internal forwarding helpers; dropping it is a type
error, not a silent default:

- `localCallerProxy(ctx: AgentRouterContext)` (`router.ts:139-168`):
  `getCaller` forwards `router.createCaller(ctx, signal ? { signal } :
  undefined)` at `:144` — ctx flows in both `createCaller` arities, the
  plain call and the `{signal}` form `subscribeViaCaller` uses
  (`client/caller-subscribe.ts:28`).
- `clientForNode(cfg, nodeName, ctx)` (`router.ts:263-273`): the
  `inproc://` branch returns `localCallerProxy(ctx)`; remote branches are
  untouched (the remote agent applies its own context server-side).

Every `clientForNode` call site on `fec4f3ca` passes its own procedure ctx:

- `router.ts:294`, `:314` — `stopWorkloadForDelete` (workloadDelete
  helper): serverStatus/serverStop + per-worker rpcServerStop. Helper gains
  a `ctx` parameter; `workloadDelete` forwards.
- `router.ts:335` — `stopModelHostForDelete`: modelHostStop. Same
  treatment.
- `router.ts:1655` — `workloadList` per-node status fan-out.
- `router.ts:1761` — `workloadDescribe` per-node query.
- `router.ts:1846` — `workloadApply`'s `getClient` closure (inside
  `withWorkloadsMutex`, `:1843-1848`). Added relative to the conditional
  list: this is the site that reaches `serverStart`/`modelHostStart`
  through `applyOne`/`applyOneModelHost`; the mutation at `:1819` must
  destructure `{ input, ctx }`.
- `router.ts:2000`, `:2021` — reconciler start/kick `getClient` closures.
- `router.ts:2094`, `:2106` — `benchSchedulerStart` `getClient` and the
  `kickBenchScheduler` callback.
- `router.ts:3962`, `:4013` — composite apply/destroy `getWorkloadClient`.

The nested dispatch path is also covered: `operatorRunTool`'s
`router.createCaller({})` at `router.ts:3095` becomes
`createCaller(ctx)` (mutation destructures `{ input, ctx }`), so
`llamactl.workload.apply` → `caller.workloadApply` (`ops-chat/
dispatch.ts:532-540`) → `getClient` → `localCallerProxy` → wrapped
`serverStart` carries the same binding end to end. The two remaining
`createCaller({})` sites — `router.ts:3579` (ragBench → ragSearch) and
`:3803` (ragPipelineDraft → ragPipelineApply) — do not reach the wrapped
handlers today; they forward ctx anyway under the same "no bare
`createCaller({})` survives" rule so a future rag tool cannot silently
drop it.

`packages/remote/src/client/node-client.ts:85,:108-117`:
`createNodeClient`/`proxyFromCaller` take a required context and forward it
in both `createCaller` arities (`:109`, `:113-114`). The standalone CLI
`local` path supplies the explicit unconfigured context — that remains
deferred-unmanaged (see Coverage boundary); the point of the required
parameter is that the choice is visible at the call site, not inherited by
accident.

`workloadApply` and every router procedure building such clients forward
ctx. Direct and tunnel `requestContext` (`serve.ts:593-598`; mounted at
`:638` and `:758-772`) receive the same binding. A degraded binding
survives every hop and always refuses AuthorityUnavailable; no fallback
when the store failed to open.

## Coverage boundary

Coverage is exactly `serverStart` (`router.ts:2390-2433`) and
`modelHostStart` (`router.ts:1898-1911`) and internal calls that reach
those handlers — including `workloadApply`-driven apply (ModelRun via
`convergeServerUnderLock`→`startCoordinator` `:1483-1552`; ModelHost via
`applyOneModelHost`→`startModelHostProcess`), reconciler starts, bench
scheduler starts that ride `serverStart`, composite runtimes that delegate
to `serverStart` via `getWorkloadClient`, and ops-chat `workload.apply`.
Agent-gateway fallthrough ModelRuns (`spec.gateway:true` on an agent-kind
node — the `null` sentinel at `apply.ts:1603-1606`, `agent-gateway.ts:32`)
reach `serverStart` and therefore require the inline manifest plus declared
allocation in managed mode.

The following remain unqualified/bypass surfaces — deferred-unmanaged for
this slice, enumerated so activation review cannot mistake the ledger for a
whole-machine authority:

- `keepAliveStart` (`router.ts:2544-2591`): spawns a detached
  `bun ... keep-alive worker` child (`:2573`) whose loop calls core
  `startServer` directly (`keepAlive.ts:487`) — a child-process spawn path
  the ledger never sees. Deferred-unmanaged.
- `rpcServerStart` (`router.ts:2501+`): rpc-server model-shard loads;
  real RAM on that node. Deferred-unmanaged.
- `candidateTestRun` (`router.ts:2593-2613`): candidate launches.
- Standalone CLI local dispatch: `isLocalDispatch()` branch calls core
  `server.startServer` directly (`packages/cli/src/commands/
  server.ts:225-234`); `createNodeClient`'s inproc path
  (`node-client.ts:85`) with the explicit unconfigured context; and any
  direct `@llamactl/core` import. Deferred-unmanaged — before production
  activation these must discover the qualified target authority or refuse.
- Gateway-provider loads routed by `spec.gateway` dispatch
  (`apply.ts:1596-1608`): sirius (`gateway-handlers/sirius.ts`,
  `POST /providers/reload`) and embersynth (`gateway-handlers/
  embersynth.ts`, `POST /config/reload`) cause the provider to load models
  upstream — outside this target's process tree and ledger entirely.
  `gatewayPendingResult` (`apply.ts:867-886`) when no dispatcher is
  configured. Unqualified.
- Bench/candidate paths that spawn ad-hoc processes rather than riding
  `serverStart`; composite/container runtimes' own container spawns;
  separately installed agents on the same host (two runtime roots = two
  ledgers = unproved, activation checklist item).
- `serverStop`/`modelHostStop` (`router.ts:2375-2388`, `:1890-1896`):
  ungated mutations by design — a stop kills a charged resident; the row
  stays charged until verified whole-runtime absence (see lifecycle).
- Standalone-local and duplicate-authority deployment questions are
  activation prerequisites, not slice defects.

Do not call this a complete machine-memory authority or all-entrypoint
managed gate.

Existing controller apply can stop an old workload or evict victims before
reaching the target start gate: `convergeServerUnderLock` runs
`serverStop.mutate` at `apply.ts:1525` before `startCoordinator` at
`:1546`, and `stopEvictTargets` at `:1501` runs even earlier. This first
facility supports fresh, non-destructive starts only. It does not make
managed replacement apply safe — a different-digest manifest whose stop
already ran hits `WorkloadBusy` with the old charge intact, a designed-in
outage this slice accepts and documents rather than hides. A production
activation PR must first refuse those operations before controller
teardown or move prepare/claim before teardown under an explicitly
reviewed protocol. A read-only probe is not itself a durable claim. No
production activation is permitted by this slice.

## Ordered RED/GREEN work packages

- [x] Re-pin to `fec4f3ca`; verify exact source API anchors, canonical
  root/identity helpers and the start call graph (done for this revision —
  corrections listed in the changelog). Keep the independent artifact
  counterexample outside the candidate.
- [ ] Core policy: write table tests with resident16+pending8+incoming8
  against24; unknown/invalid allocation and budget; uncertain charged;
  force ignored; 128-row cap; stable digest across node aliases/default
  forms and changed digest for each listed launch field (including
  composed `--rpc` args and the fixed skipTuned=false); cross-kind
  same-name requests conflict because they share a runtime directory. Use
  the existing artifact-only behavioral RED as the initial counterexample.
  New API fixtures must load/typecheck before a behavior assertion is
  counted as RED; missing imports or undefined functions are not
  acceptable evidence. Observe the intended assertion RED, implement
  minimal policy, remove-pending mutation must fail intended arithmetic
  assertion, restore and rerun.
- [ ] Store: two independent SQLite connections to one target DB, blocked
  load, budget24 with12+16 incoming; deterministic barrier before
  transaction demonstrates only one new claim, total<=24. Test CAS/
  fencing, store busy/corruption, stable persisted authority ID, changed
  epoch on reopen. Mutation splits read/insert outside transaction;
  intended over-admission assertion must fail. No fake Bun.spawn.
- [ ] Authority lifecycle: owned fake processes and blocked readiness;
  record first/retry generations; adopted-result pid captured from the
  done envelope and verified against the runtime-dir pid record (equal →
  generation evidence; mismatch/absent → uncertain); join same-spec actual
  result once; refuse different-spec; waiter17 refuses; timeout/disconnect
  retains uncertain; orphan pending converts to uncertain and refuses
  instead of spawning/joining forever — and stays uncertain (terminal) even
  when live evidence later appears; stale ready/absence proof does not
  mutate newer row; dead parent+living owned child retains charge.
  Positive verified absence releases only exact claim after loader
  quiescence; a new different-key claim can reuse that proved-released
  capacity. Snapshot outputs are detached records; mutating a returned
  snapshot cannot change stored charges. Mutate release-in-finally,
  stale-token acceptance, missing-sidecar-as-absence and adopted-pid-
  without-record-verification separately; restore each.
- [ ] ModelHost boundary first: existing inline manifest and spawn seam —
  spawn-seam pid capture on success AND on post-spawn failure; declared-
  only allocation (heuristic manifest without `expectedMemoryGiB` refuses
  AllocationUnknown). Both16GiB/12GiB mixed-kind orders against24 refuse
  second load while first is pending. Test exactly one loader and no
  desired-state/sidecar writes on rejected admission (inline-manifest
  persist at `modelhost.ts:718-720` must not have run). Preserve current
  in-flight join result, not merely invocation count.
- [ ] ModelRun boundary next: inline manifest, exact descriptor equality
  (composed args included) and launch-event + adopted-path generation
  capture. Test raw missing-manifest and mismatched launch payload refuse;
  zero/unknown allocation and force cannot bypass; `skipTuned:true` raw
  override refuses; frozen runtime-root mismatch refuses RootMismatch;
  ambient-env mutation after authority construction cannot redirect the
  loader (frozen-env injection). Agent-gateway fallthrough without inline
  manifest refuses ManagedManifestRequired. Error includes typed refusal
  through actual done subscription and apply helper — `action:"pending"`,
  structured `admission` intact.
- [ ] Context tests: two independent clients/aliases to one real
  random-loopback target; direct and tunnel; `operatorRunTool` →
  `workloadApply` → inproc `serverStart` end-to-end ctx; degraded authority
  at all hops refuses AuthorityUnavailable (never legacy); two separate
  test-agent contexts never cross-contaminate. Mutate alias-keyed store,
  one-kind-only gate, empty `localCallerProxy` ctx, empty
  `workloadApply`-`getClient` ctx and empty operator caller separately.
- [ ] Scope regression: demonstrate that `serverStop`/`modelHostStop` on a
  charged key does not free the old charge and a different-digest start
  remains refused without verified whole-runtime absence; that a sirius/
  embersynth-dispatched gateway manifest is ledger-invisible; that
  keepAlive/rpcServerStart/candidateTest/cli-local spawns are outside the
  ledger. Document that current controller replacement is not
  supported/activated. Do not disguise this as the no-teardown
  managed-update acceptance being complete.
- [ ] Fresh focused tests, scoped lint/format/secrets, all package
  typechecks, independent final-SHA boundary review, macOS/Linux CI and
  isolated four-repo sweeps with published pins. Serialize heavy gates;
  record raw default-root environment failures separately from canonical
  package/preload gates. No force pushes or hook bypasses.

## Test list

New files (all prospective RED first; nothing here claims prior passage):

- `packages/core/test/managed-admission.test.ts` — pure-policy arithmetic,
  invalid inputs, state-table and digest tests.
- `packages/remote/test/residency/admission-store.test.ts` — two real
  connections, transaction fencing, busy/corruption, epoch/reopen,
  persisted authority ID.
- `packages/remote/test/residency/admission-authority.test.ts` — owned
  fake-process lifecycle, generations (launch-event, spawn-seam, adopted),
  joins, uncertainty terminality, verified absence.
- `packages/remote/test/residency/admission-entrypoints.test.ts` — real
  router fixtures: both wrapped boundaries, ctx continuity (direct, tunnel,
  `localCallerProxy`, `workloadApply`, `operatorRunTool`), degraded
  binding, frozen-env injection.

Existing suites that must stay green (regression surface): the workload
admission/apply suites —
`packages/remote/src/workload/admission.test.ts`,
`apply.multi.test.ts`, `packages/remote/test/workload-apply-preflight.
test.ts`, `workload-apply-sub-cleanup.test.ts`,
`router-workload*.test.ts`, `workload-concurrency.test.ts` — plus
`packages/core/test/residency-admission.test.ts` (legacy policy untouched)
and the MCP `ops-chat-coverage` smoke assertion (no new tools; dispatch
table unchanged).

Proposed commands after implementation, not claimed results:

```sh
bun test packages/core/test/managed-admission.test.ts
bun run --cwd packages/remote test -- test/residency/admission-store.test.ts test/residency/admission-authority.test.ts test/residency/admission-entrypoints.test.ts
bun run --cwd packages/remote test -- src/workload/admission.test.ts src/workload/apply.multi.test.ts test/workload-apply-preflight.test.ts test/workload-apply-sub-cleanup.test.ts
bun run typecheck
bun run --cwd packages/remote tsc --noEmit
bun run lint
bun run format:check
bun run secrets:scan
```

## Non-goals

No production activation/configuration; no `agent serve` construction of
the authority; no operator command, public configuration switch or
automatic-residency enablement; no release/claim-clearing RPC; no TTL or
lease; no controller lock substituted for the target ledger; no managed
in-place spec change/replacement; no eviction protocol; no heuristic
allocation feeding the ledger; no NodeRun-at-target budget source; no
coverage claim over keepAlive, rpcServerStart/shards, candidateTest,
standalone CLI local dispatch, sirius/embersynth provider loads,
composite/container spawns, direct core imports or second agents on one
host; no uncertain→resident repromotion; no global tRPC error formatter;
no provider/registry/service changes; no changes to merged memory/
admission PRs or published dependency pins; no completion claim for
#274/#275/#276/#278.

## Activation dependencies and unresolved choices

Implementable as an inactive facility with a verified-empty test authority;
must not be activated until these separate contracts are resolved and
tested:

1. Complete target-owned bootstrap inventory of existing managed
   processes, including malformed/unknown sidecars and pre-existing
   in-flight loads; no empty-ledger-means-free assumption.
2. A single authority for each physical memory domain: stable host
   identity, host-singleton shared location/ownership or enforceable
   one-agent-per-host invariant, and protection against two
   `install-launchd --dir` deployments. Same-target aliases are covered;
   two runtime roots on one machine are not.
3. Standalone-local and other spawn-path bypass closure (the deferred-
   unmanaged list above), and a non-destructive managed replacement/
   eviction protocol before controller stops anything.
4. Whole-runtime absence proof for each real engine and its descendants,
   plus explicit target-budget policy delivery (NodeRun transport) if
   NodeRun budgets are to be authoritative. No guessed delivery of
   controller files and no PID-file-only release.

These are remaining activation/design issues, not reasons to substitute a
controller lock or TTL cleanup. Automatic residency stays OFF. No source,
production configuration, registry, provider or service change was made
while preparing this plan.
