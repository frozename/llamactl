import {
  type ControllerHostHistory,
  type ModelHostRestartReason,
  readControllerHostHistory,
  recordModelHostReconcileError,
  recordModelHostReconcileRecovered,
  recordModelHostRestart,
  updateControllerHostHistory,
  withReconcileError,
  withReconcileRecovered,
  withRestart,
} from "@llamactl/core/engines/conditions";
import {
  computeModelHostSpecHash,
  readModelHostStartAttempt,
  readModelHostState,
  removeModelHostStartAttempt,
  removeModelHostState,
  writeModelHostStartAttempt,
} from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";

import type { ModelRun } from "./schema.js";

import { existsSync } from "../safe-fs.js";
import { defaultNodeBudgetGiB } from "./admission.js";
import {
  type ApplyEvent,
  applyOne,
  applyOneModelHost,
  type ApplyResult,
  EVICTED_AT_ANNOTATION,
  EVICTED_BY_ANNOTATION,
  EVICTION_INTENT_GRACE_MS,
  parseEvictTargets,
  replacementHoldsEviction,
  type WorkloadClient,
} from "./apply.js";
import {
  externalManagerOf,
  LOCAL_NODE_ID,
  type ModelHostManifest,
  specForHash,
} from "./modelhost-schema.js";
import { listModelHosts, loadModelHostByName, saveModelHost } from "./modelhost-store.js";
import {
  DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS,
  DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS,
  type NodeRpcPassState,
  NodeRpcSkippedError,
  NodeRpcTimeoutError,
  type NodeRpcTimeouts,
  withNodeRpcDeadline,
} from "./node-rpc-deadline.js";
import { listNodeRuns } from "./noderun-store.js";
import {
  defaultWorkloadsDir,
  listWorkloads,
  loadWorkloadByName,
  loadWorkloadByNameAny,
  saveWorkload,
  workloadPath,
} from "./store.js";

export interface ReconcileNodeReport {
  /** Absent only on the reconcile loop's synthetic "(loop)" error row. */
  kind?: "ModelRun" | "ModelHost";
  name: string;
  node: string;
  action: ApplyResult["action"] | "skipped-deleted" | "skipped-external";
  error?: string;
  /** Set with action "skipped-external": the manager named in the host's
   *  llamactl.io/managed-by label. */
  managedBy?: string;
  /** Set with action "unchanged" when an eviction intent marker suppressed
   *  this pass: the name of the replacement that evicted the workload. */
  evictedBy?: string;
  /** Set when the engine was up as of the last pass but not Running now: on
   *  the local node proof is the launch record; on a remote node it is the
   *  controller history's lastKnownRunning (#308). */
  foundDead?: boolean;
  /** #221: set only when the row's error is a node RPC deadline timeout or
   *  a per-pass skip after one (NodeRpcTimeoutError / NodeRpcSkippedError).
   *  The error message itself is unchanged. */
  reason?: "NodeUnreachable";
}

export interface ReconcileResult {
  reports: ReconcileNodeReport[];
  errors: number;
}

export interface ReconcileOptions {
  workloadsDir?: string;
  /** Resolve a workload client for a given node name. Structural so
   *  router.ts can satisfy it without importing NodeClient (which
   *  would re-trigger the AppRouter circular-type alias). */
  getClient: (nodeName: string) => WorkloadClient;
  /** Forwarded to applyOne so the per-workload port-collision
   *  preflight detects aliases that resolve to the same physical node. */
  resolveNodeIdentity?: (nodeName: string) => string | null;
  /** Bubble up per-workload progress for logging. */
  onEvent?: (e: ApplyEvent & { name: string }) => void;
  /** Optional filter to only reconcile a subset. */
  filter?: (m: ModelRun) => boolean;
  /** Clock stamping the controller history for remote ModelHosts (#308);
   *  defaults to new Date(). */
  now?: () => Date;
  /** Per-call deadlines for node .query / .mutate RPCs; defaults to
   *  DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS / DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS. */
  rpcTimeouts?: Partial<NodeRpcTimeouts>;
  /** #221: per-node deadlines that override `rpcTimeouts` field by field, read
   *  from the kubeconfig's node `rpcTimeouts` block. Resolved once per node
   *  per pass; a per-node value never leaks to another node. */
  rpcTimeoutsFor?: (nodeName: string) => Partial<NodeRpcTimeouts> | undefined;
  /** How long an evicted-by marker holds a victim down while its
   *  replacement is missing or not yet confirmed. Defaults to
   *  EVICTION_INTENT_GRACE_MS (15 minutes). */
  evictionGraceMs?: number;
}

/** Controller-side bookkeeping context for #308: where the ModelHost history
 *  dir lives and the clock that stamps it. Injected so tests drive time. */
interface HostRecordContext {
  dir: string;
  now: () => Date;
}

async function queryNodeMemBytes(client: WorkloadClient): Promise<number | null> {
  if (!client.nodeFacts) return null;
  try {
    return (await client.nodeFacts.query()).memBytes;
  } catch {
    return null;
  }
}

/**
 * Size the admission budget for a ModelRun on `nodeName`. An explicit
 * NodeRun budget wins; `local` uses the controller's RAM; otherwise
 * 75% of the node's reported memory, queried at most once per node
 * per pass. A missing, rejected or timed-out nodeFacts falls back to
 * the controller's RAM.
 */
async function resolveModelRunBudgetGiB(
  nodeName: string,
  nodeBudgetByName: Map<string, number | undefined>,
  nodeMemBytesByName: Map<string, Promise<number | null>>,
  getClient: (nodeName: string) => WorkloadClient,
): Promise<number> {
  const explicit = nodeBudgetByName.get(nodeName);
  if (explicit !== undefined) return explicit;
  if (nodeName === LOCAL_NODE_ID) return defaultNodeBudgetGiB();
  let memBytes = nodeMemBytesByName.get(nodeName);
  if (memBytes === undefined) {
    memBytes = queryNodeMemBytes(getClient(nodeName));
    nodeMemBytesByName.set(nodeName, memBytes);
  }
  return defaultNodeBudgetGiB(undefined, await memBytes);
}

/** #221: a node RPC deadline timeout, or a per-pass skip after one. */
function isNodeUnreachableError(err: unknown): boolean {
  return err instanceof NodeRpcTimeoutError || err instanceof NodeRpcSkippedError;
}

/** The report field for an error caught while reconciling one workload. */
function nodeUnreachableField(err: unknown): Pick<ReconcileNodeReport, "reason"> {
  return isNodeUnreachableError(err) ? { reason: "NodeUnreachable" } : {};
}

function hostSpecSnapshot(manifest: ModelHostManifest): Record<string, unknown> {
  const { spec } = manifest;
  return {
    engine: spec.engine,
    binary: spec.binary,
    endpoint: spec.endpoint,
    hostedModels: spec.hostedModels,
    extraArgs: spec.extraArgs,
    resources: spec.resources,
    restartPolicy: spec.restartPolicy,
    timeoutSeconds: spec.timeoutSeconds,
    env: spec.env,
  };
}

function liveHostSpecSnapshot(current: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: current["engine"],
    binary: current["binary"],
    endpoint: current["endpoint"],
    hostedModels: current["hostedModels"],
    extraArgs: current["extraArgs"],
    resources: current["resources"],
    restartPolicy: current["restartPolicy"],
    timeoutSeconds: current["timeoutSeconds"],
    env: current["env"],
  };
}

// Retained for future use when modelHostStatus surfaces launch args
// and reconcile can detect spec drift on-tick rather than only on the
// explicit `apply -f` path.

function hostSpecsEqual(manifest: ModelHostManifest, current: Record<string, unknown>): boolean {
  return (
    JSON.stringify(hostSpecSnapshot(manifest)) === JSON.stringify(liveHostSpecSnapshot(current))
  );
}

/**
 * One reconciliation pass across every workload in the store. Each
 * workload is applied in sequence (avoids N parallel serverStart
 * subscriptions competing for the same port on a shared node). The
 * persisted manifest's status section is updated in place so
 * `llamactl get workloads` reflects the latest pass. Node .query /
 * .mutate RPCs carry a per-call deadline (see node-rpc-deadline.ts)
 * so one unreachable node cannot stall the rest of the pass; #221 lets
 * a node's kubeconfig `rpcTimeouts` block override the pass defaults
 * per field. After the first timeout on a node, that node's remaining
 * calls in the pass fail fast with NodeRpcSkippedError; the next pass
 * retries it.
 */
export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileResult> {
  const timeoutsByNode = new Map<string, NodeRpcTimeouts>();
  const timeoutsForNode = (nodeName: string): NodeRpcTimeouts => {
    const cached = timeoutsByNode.get(nodeName);
    if (cached !== undefined) return cached;
    const perNode = opts.rpcTimeoutsFor?.(nodeName);
    const resolved: NodeRpcTimeouts = {
      queryMs: perNode?.queryMs ?? opts.rpcTimeouts?.queryMs ?? DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS,
      mutateMs:
        perNode?.mutateMs ?? opts.rpcTimeouts?.mutateMs ?? DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS,
    };
    timeoutsByNode.set(nodeName, resolved);
    return resolved;
  };
  const pass: NodeRpcPassState = { timedOut: new Map() };
  const deadlineOpts: ReconcileOptions = {
    ...opts,
    getClient: (nodeName) =>
      withNodeRpcDeadline(opts.getClient(nodeName), nodeName, timeoutsForNode(nodeName), pass),
  };
  const dir = opts.workloadsDir ?? defaultWorkloadsDir();
  const all = listWorkloads(dir);
  const hosts = listModelHosts(dir);
  // Absent NodeRun budgets stay undefined rather than resolving to the
  // controller's RAM here, so both the ModelRun and ModelHost paths can
  // fall through to the target node's reported memory.
  const nodeBudgetByName = new Map<string, number | undefined>(
    listNodeRuns(dir).map((nodeRun) => [nodeRun.metadata.name, nodeRun.spec.budget?.memoryGiB]),
  );
  const nodeMemBytesByName = new Map<string, Promise<number | null>>();
  const manifests = opts.filter ? all.filter(opts.filter) : all;
  const reports: ReconcileNodeReport[] = [];
  let errors = 0;

  for (const manifest of manifests) {
    errors += await reconcileModelRun(
      manifest,
      deadlineOpts,
      dir,
      nodeBudgetByName,
      nodeMemBytesByName,
      reports,
    );
  }

  for (const manifest of hosts) {
    errors += await reconcileModelHost(manifest, deadlineOpts, dir, nodeBudgetByName, reports);
  }

  return { reports, errors };
}

type EvictionDecision = { kind: "none" } | { kind: "hold"; evictedBy: string } | { kind: "stale" };

type EvictionGuard = { kind: "hold"; evictedBy: string } | { kind: "apply"; manifest: ModelRun };

/** Clear a stale eviction marker from disk; fall back to the snapshot. */
function clearStaleEvictionMarker(manifest: ModelRun, dir: string): ModelRun {
  try {
    const fresh = loadWorkloadByName(manifest.metadata.name, dir);
    const {
      [EVICTED_BY_ANNOTATION]: _evictedBy,
      [EVICTED_AT_ANNOTATION]: _evictedAt,
      ...annotations
    } = fresh.metadata.annotations;
    const cleared: ModelRun = { ...fresh, metadata: { ...fresh.metadata, annotations } };
    saveWorkload(cleared, dir);
    return cleared;
  } catch {
    // The manifest vanished or the marker clear failed; apply the
    // pass-start snapshot and let a later pass retry the removal.
    return manifest;
  }
}

/**
 * ModelHost variant of clearStaleEvictionMarker: same marker strip through
 * the ModelHost store. annotations is optional on ModelHost, so the key is
 * dropped entirely when nothing remains rather than left as {}.
 */
function clearStaleHostEvictionMarker(manifest: ModelHostManifest, dir: string): ModelHostManifest {
  try {
    const fresh = loadModelHostByName(manifest.metadata.name, dir);
    const {
      [EVICTED_BY_ANNOTATION]: _evictedBy,
      [EVICTED_AT_ANNOTATION]: _evictedAt,
      ...annotations
    } = fresh.metadata.annotations ?? {};
    const { annotations: _stale, ...metadata } = fresh.metadata;
    const cleared: ModelHostManifest = {
      ...fresh,
      metadata: Object.keys(annotations).length > 0 ? { ...metadata, annotations } : metadata,
    };
    saveModelHost(cleared, dir);
    return cleared;
  } catch {
    // The manifest vanished or the marker clear failed; reconcile the
    // pass-start snapshot and let a later pass retry the removal.
    return manifest;
  }
}

/**
 * DF-02 resurrection-guard decision shared by ModelRun and ModelHost
 * victims (#275): a verified eviction stamps evicted-by / evicted-at on
 * the victim before the stop RPC. While that intent is live the
 * reconciler must not restart the victim underneath its replacement —
 * the caller reports the hold with no status RPC and no apply. The hold
 * owner must be a ModelRun naming this victim, exactly as the apply-side
 * liveEvictionOwner check requires.
 */
function evictionDecision(
  name: string,
  annotations: Record<string, string> | undefined,
  opts: ReconcileOptions,
  dir: string,
): EvictionDecision {
  const evictedBy = annotations?.[EVICTED_BY_ANNOTATION];
  if (annotations === undefined || !evictedBy) return { kind: "none" };
  const graceMs = opts.evictionGraceMs ?? EVICTION_INTENT_GRACE_MS;
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const evictedAt = annotations[EVICTED_AT_ANNOTATION];
  const atMs = evictedAt === undefined ? Number.NaN : Date.parse(evictedAt);
  const withinGrace = !Number.isNaN(atMs) && nowMs - atMs < graceMs;
  let replacement: ModelRun | ModelHostManifest | undefined;
  try {
    replacement = loadWorkloadByNameAny(evictedBy, dir);
  } catch {
    replacement = undefined;
  }
  const namesVictim =
    replacement?.kind === "ModelRun" && parseEvictTargets(replacement).includes(name);
  if (replacementHoldsEviction(replacement, withinGrace, namesVictim)) {
    return { kind: "hold", evictedBy };
  }
  return { kind: "stale" };
}

/**
 * DF-02 resurrection guard for ModelRun victims: the pass-start snapshot
 * predates this workload's turn, so the decision runs on the on-disk
 * annotations; a lapsed marker is cleared before the apply continues.
 */
function evictionGuard(manifest: ModelRun, opts: ReconcileOptions, dir: string): EvictionGuard {
  const name = manifest.metadata.name;
  // The pass-start snapshot predates this workload's turn: an earlier
  // apply in the same pass can stamp this victim's marker (same-tick
  // eviction) or a failed replacement's rollback can clear one, so the
  // guard decides on the on-disk annotations, not the snapshot.
  let annotations = manifest.metadata.annotations;
  try {
    const fresh = loadWorkloadByName(name, dir);
    if (fresh.metadata.name === name) annotations = fresh.metadata.annotations;
  } catch {
    // Vanished or unreadable mid-pass; the snapshot still decides.
  }
  const decision = evictionDecision(name, annotations, opts, dir);
  if (decision.kind === "hold") return { kind: "hold", evictedBy: decision.evictedBy };
  if (decision.kind === "stale") {
    return { kind: "apply", manifest: clearStaleEvictionMarker(manifest, dir) };
  }
  return { kind: "apply", manifest };
}

/**
 * Reconcile one ModelRun manifest. Pushes its report(s) onto
 * `reports` and returns the number of errors observed.
 */
async function reconcileModelRun(
  manifest: ModelRun,
  opts: ReconcileOptions,
  dir: string,
  nodeBudgetByName: Map<string, number | undefined>,
  nodeMemBytesByName: Map<string, Promise<number | null>>,
  reports: ReconcileNodeReport[],
): Promise<number> {
  const name = manifest.metadata.name;
  const { spec } = manifest;
  let errors = 0;
  try {
    const manifestPath = workloadPath(name, dir);
    if (!existsSync(manifestPath)) {
      reports.push({ kind: "ModelRun", name, node: spec.node, action: "skipped-deleted" });
      return 0;
    }
    const guard = evictionGuard(manifest, opts, dir);
    if (guard.kind === "hold") {
      reports.push({
        kind: "ModelRun",
        name,
        node: spec.node,
        action: "unchanged",
        evictedBy: guard.evictedBy,
      });
      return 0;
    }
    const result = await applyOne(
      guard.manifest,
      opts.getClient,
      (e) => {
        opts.onEvent?.({ ...e, name });
      },
      undefined,
      {
        workloadsDir: dir,
        ...(opts.resolveNodeIdentity && { resolveNodeIdentity: opts.resolveNodeIdentity }),
        ...(opts.evictionGraceMs !== undefined ? { evictionGraceMs: opts.evictionGraceMs } : {}),
        getNodeBudgetGiB: (nodeName) =>
          resolveModelRunBudgetGiB(nodeName, nodeBudgetByName, nodeMemBytesByName, opts.getClient),
      },
    );
    if (result.error) errors++;
    reports.push({
      kind: "ModelRun",
      name,
      node: spec.node,
      action: result.action,
      ...(result.error ? { error: result.error } : {}),
    });
    if (!existsSync(manifestPath)) {
      reports[reports.length - 1] = {
        kind: "ModelRun",
        name,
        node: spec.node,
        action: "skipped-deleted",
      };
      return errors;
    }
    // Persist status WITHOUT clobbering a concurrent spec edit. A reconcile
    // pass snapshots every manifest up-front (listWorkloads) and can run for
    // minutes when a serverStart on another workload is slow or times out. If
    // `llamactl enable/disable` (or a manual edit) writes spec.enabled to disk
    // during that window, writing back the pass-start snapshot would silently
    // revert it. Re-read the current on-disk manifest and merge only our
    // status; the next pass observes the new spec and converges.
    let toPersist: ModelRun = { ...manifest, status: result.statusSection };
    try {
      toPersist = { ...loadWorkloadByName(name, dir), status: result.statusSection };
    } catch {
      // Preserve a rename by not writing the stale snapshot back when the
      // original manifest path vanished mid-pass.
      return errors;
    }
    saveWorkload(toPersist, dir);
  } catch (err) {
    errors++;
    const message = (err as Error).message;
    reports.push({
      kind: "ModelRun",
      name,
      node: spec.node,
      action: "unchanged",
      error: message,
      ...nodeUnreachableField(err),
    });
  }
  return errors;
}

/**
 * #332: true when a local host's launch record carries a specHash that differs
 * from the manifest, i.e. the spec was edited while the engine was down. A
 * record without a specHash (written before the field existed) proves nothing,
 * so it returns false. Always false for a remote host: statusModelHost reports
 * no specHash for a Stopped host.
 */
function localSpecChangedWhileDown(
  spec: ModelHostManifest["spec"],
  localState: ReturnType<typeof readModelHostState>,
  desiredHash: string,
): boolean {
  if (spec.node !== LOCAL_NODE_ID) return false;
  const recordedHash = localState?.specHash;
  return typeof recordedHash === "string" && recordedHash !== desiredHash;
}

type HostReconcileDecision = "sweep-disabled" | "converged" | "never-stopped" | "apply";

/**
 * Decide what one ModelHost reconcile pass should do:
 *
 *   sweep-disabled — host is disabled and not Running; clear any
 *                    stale sidecar and report unchanged.
 *   converged      — Running with a matching specHash; nothing to do.
 *   never-stopped  — enabled, restartPolicy Never, not Running, and remote
 *                    or with a local launch record (#332); report
 *                    unchanged and do not start it. Exception: a local
 *                    launch record whose specHash differs from the
 *                    manifest means the spec changed while the host was
 *                    down, so that host is applied. A record with no
 *                    specHash and every remote host stay down (a Stopped
 *                    remote reports no specHash). A start-attempt marker
 *                    whose specHash differs from the manifest (or absent)
 *                    means no attempt has been made for this spec, so the
 *                    host is applied.
 *   apply          — anything else; run applyOneModelHost.
 *
 * Idempotent reconcile with spec-drift detection. For local
 * workloads, the controller-owned sidecar is the source of truth
 * for observed specHash. For remote workloads, trust the remote
 * modelHostStatus.specHash surfaced by the node dispatcher. Skip
 * restart iff Running and observedHash matches desiredHash. A
 * start-attempt marker grants at most one automatic attempt per
 * spec hash; editing the spec produces a new hash and a new attempt.
 */
function classifyHostReconcile(
  spec: ModelHostManifest["spec"],
  localState: ReturnType<typeof readModelHostState>,
  current: { state: string; specHash?: string },
  startAttemptHash: string | null,
): HostReconcileDecision {
  if (!spec.enabled && current.state !== "Running") return "sweep-disabled";
  const desiredHash = computeModelHostSpecHash(specForHash(spec));
  const observedHash = spec.node === LOCAL_NODE_ID ? localState?.specHash : current.specHash;
  if (current.state === "Running" && observedHash === desiredHash) return "converged";
  // #332: restartPolicy Never leaves a down engine down. A local host with no
  // launch record was never started here (an `apply -f` hand-off), so it starts.
  // A local host whose recorded specHash differs was edited while down, so it
  // starts too.
  const neverLaunched =
    spec.node === LOCAL_NODE_ID && localState === null && startAttemptHash !== desiredHash;
  const editedWhileDown = localSpecChangedWhileDown(spec, localState, desiredHash);
  if (
    spec.restartPolicy === "Never" &&
    current.state !== "Running" &&
    !neverLaunched &&
    !editedWhileDown
  ) {
    return "never-stopped";
  }
  return "apply";
}

type HostOutcome =
  | {
      kind: "ok";
      recovered: string;
      restart?: ModelHostRestartReason;
      /** Remote history: whether the engine is known running after this pass.
       *  Unset on the local path (a launch record carries that signal). */
      lastKnownRunning?: boolean;
    }
  | { kind: "error"; reason: string; message: string };

function sameHistory(a: ControllerHostHistory, b: ControllerHostHistory): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persist the pass outcome. For a local host that is the controller-owned
 * conditions sidecar in the runtime dir; for a remote host the node's own
 * sidecar is unreachable from here, so the controller keeps its mirror at
 * .modelhost-history/<node>/<name>.json (#308): the same condition/restart
 * reducers, plus lastKnownRunning so a later found-dead restart is detectable.
 * A pass that changes nothing writes nothing, so a steadily healthy remote
 * host costs no disk. Bookkeeping failures (disk full, permissions) must
 * never turn a pass into an error.
 */
function recordHostOutcome(
  spec: ModelHostManifest["spec"],
  name: string,
  outcome: HostOutcome,
  ctx: HostRecordContext,
): void {
  const iso = ctx.now().toISOString();
  try {
    if (spec.node === LOCAL_NODE_ID) {
      const resolved = resolveEnv(process.env);
      if (outcome.kind === "error") {
        recordModelHostReconcileError({ name }, outcome, resolved);
        return;
      }
      if (outcome.restart) recordModelHostRestart({ name }, outcome.restart, resolved);
      recordModelHostReconcileRecovered({ name }, outcome.recovered, resolved);
      return;
    }
    updateControllerHostHistory(ctx.dir, spec.node, name, ctx.now(), (h) => {
      let next: ControllerHostHistory;
      if (outcome.kind === "error") {
        next = { ...h, ...withReconcileError(h, outcome, iso) };
      } else {
        next = { ...h };
        if (outcome.restart) next = { ...next, ...withRestart(next, outcome.restart, iso) };
        const recovered = withReconcileRecovered(next, outcome.recovered, iso);
        if (recovered) next = { ...next, ...recovered };
        if (outcome.lastKnownRunning !== undefined) {
          next = { ...next, lastKnownRunning: outcome.lastKnownRunning };
        }
      }
      return sameHistory(h, next) ? null : next;
    });
  } catch {
    // Conditions are observability; the reconcile result stands without them.
  }
}

interface HostReportExtra {
  error?: { reason: string; message: string };
  foundDead?: boolean;
  reason?: "NodeUnreachable";
}

/**
 * #221: the pushHostReport extra for an error caught while reconciling one
 * ModelHost. A node RPC timeout or skip is NodeUnreachable, both on the
 * report and in the local ReconcileError condition; anything else stays
 * ReconcileFailed. The message is unchanged.
 */
function caughtHostError(err: unknown): HostReportExtra {
  const message = (err as Error).message;
  return isNodeUnreachableError(err)
    ? { error: { reason: "NodeUnreachable", message }, reason: "NodeUnreachable" }
    : { error: { reason: "ReconcileFailed", message } };
}

function pushHostReport(
  reports: ReconcileNodeReport[],
  spec: ModelHostManifest["spec"],
  name: string,
  action: ReconcileNodeReport["action"],
  extra: HostReportExtra,
  ctx: HostRecordContext,
): number {
  reports.push({
    kind: "ModelHost",
    name,
    node: spec.node,
    action,
    ...(extra.error !== undefined ? { error: extra.error.message } : {}),
    ...(extra.foundDead === true ? { foundDead: true } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
  });
  if (extra.error === undefined) return 0;
  recordHostOutcome(spec, name, { kind: "error", ...extra.error }, ctx);
  return 1;
}

function restartReason(wasRunning: boolean, foundDead: boolean): ModelHostRestartReason | null {
  if (wasRunning) return "SpecChanged";
  return foundDead ? "EngineExited" : null;
}

/**
 * A disabled host that isn't Running may still have a stale sidecar (e.g. a
 * dead-pid sidecar left by an out-of-band exit). statusModelHost reports
 * Stopped for a dead pid, so this short-circuit runs before the apply path
 * that would otherwise remove it — sweep it here so the sidecar does not
 * leak. No-op when the sidecar is already absent.
 */
function sweepDisabledHost(
  spec: ModelHostManifest["spec"],
  name: string,
  reports: ReconcileNodeReport[],
  ctx: HostRecordContext,
): number {
  if (spec.node === LOCAL_NODE_ID) {
    removeModelHostState({ name }, resolveEnv(process.env));
    removeModelHostStartAttempt({ name }, resolveEnv(process.env));
  }
  recordHostOutcome(
    spec,
    name,
    { kind: "ok", recovered: "Disabled", lastKnownRunning: false },
    ctx,
  );
  return pushHostReport(reports, spec, name, "unchanged", {}, ctx);
}

/**
 * Report a ModelHost pass that runs no apply. #332: a never-stopped host is
 * reported unchanged with no error and no foundDead flag (so the controller
 * logs no restart that never happens), and no conditions are written for it.
 */
function settleHostWithoutApply(
  decision: Exclude<HostReconcileDecision, "apply">,
  spec: ModelHostManifest["spec"],
  name: string,
  reports: ReconcileNodeReport[],
  ctx: HostRecordContext,
): number {
  if (decision === "sweep-disabled") return sweepDisabledHost(spec, name, reports, ctx);
  if (decision === "converged") {
    recordHostOutcome(
      spec,
      name,
      { kind: "ok", recovered: "Recovered", lastKnownRunning: true },
      ctx,
    );
  }
  return pushHostReport(reports, spec, name, "unchanged", {}, ctx);
}

/**
 * Reconcile one ModelHost manifest. A host labeled llamactl.io/managed-by
 * belongs to another controller: report skipped-external and touch nothing
 * else — no client, no status query, no start/stop, no sidecar sweep, no
 * conditions write, no save.
 */
async function reconcileModelHost(
  manifest: ModelHostManifest,
  opts: ReconcileOptions,
  dir: string,
  nodeBudgetByName: Map<string, number | undefined>,
  reports: ReconcileNodeReport[],
): Promise<number> {
  // The pass-start snapshot goes stale while earlier hosts are awaited: a
  // hand-over marker written to this host's file mid-pass must be honoured
  // before any client access, so re-read it here.
  let current = manifest;
  try {
    current = loadModelHostByName(manifest.metadata.name, dir);
  } catch {
    // Manifest vanished or became unreadable mid-pass; fall through with the
    // snapshot so the regular error paths report it.
  }
  const managedBy = externalManagerOf(current);
  if (managedBy !== null) {
    const { spec } = current;
    const name = current.metadata.name;
    reports.push({
      kind: "ModelHost",
      name,
      node: spec.node,
      action: "skipped-external",
      managedBy,
    });
    return 0;
  }
  // DF-02 (#275): the same resurrection guard as ModelRun victims, decided
  // on the re-read `current`. A live hold reports unchanged with no client
  // access and no apply; a lapsed marker is cleared on disk and the pass
  // continues with the cleared manifest.
  const name = current.metadata.name;
  const decision = evictionDecision(name, current.metadata.annotations, opts, dir);
  if (decision.kind === "hold") {
    reports.push({
      kind: "ModelHost",
      name,
      node: current.spec.node,
      action: "unchanged",
      evictedBy: decision.evictedBy,
    });
    return 0;
  }
  const host = decision.kind === "stale" ? clearStaleHostEvictionMarker(current, dir) : current;
  return await reconcileUnmanagedModelHost(host, opts, dir, nodeBudgetByName, reports);
}

/**
 * Persist the applied manifest unless the on-disk copy gained an external
 * managed-by marker (or vanished) while the apply was awaited: another
 * controller owns the hand-over now, so the stale in-memory manifest must
 * not be written back over it. The write carries the ON-DISK
 * metadata.annotations — a CLI eviction marker stamped during the apply
 * await is controller-side metadata this pass never saw, and dropping it
 * would let the next pass resurrect the victim.
 */
function saveAppliedHost(manifest: ModelHostManifest, name: string, dir: string): void {
  let onDisk: ModelHostManifest;
  try {
    onDisk = loadModelHostByName(name, dir);
  } catch {
    // The vanished or unreadable file is not ours to recreate.
    return;
  }
  if (externalManagerOf(onDisk) !== null) return;
  const annotations = onDisk.metadata.annotations;
  const { annotations: _applied, ...appliedMetadata } = manifest.metadata;
  saveModelHost(
    {
      ...manifest,
      metadata: annotations === undefined ? appliedMetadata : { ...appliedMetadata, annotations },
    },
    dir,
  );
}

/** #358: the spec hash of a local host's last automatic start attempt, if any. */
function readLocalStartAttempt(spec: ModelHostManifest["spec"], name: string): string | null {
  if (spec.node !== LOCAL_NODE_ID) return null;
  return readModelHostStartAttempt({ name }, resolveEnv(process.env));
}

/**
 * #358: before starting a local restartPolicy Never host that has no launch
 * record, record the attempt against its spec hash. The launch record is
 * written only after readiness, so without this marker a first start that
 * dies during load would leave the host looking never-launched and every
 * later pass would start it again. Best-effort: a failed write does not
 * block the apply.
 */
function markNeverHostStartAttempt(
  spec: ModelHostManifest["spec"],
  name: string,
  localState: ReturnType<typeof readModelHostState>,
): void {
  if (spec.restartPolicy !== "Never" || spec.node !== LOCAL_NODE_ID || localState !== null) return;
  try {
    writeModelHostStartAttempt(
      { name },
      computeModelHostSpecHash(specForHash(spec)),
      resolveEnv(process.env),
    );
  } catch {
    // The marker is a restart guard; the apply proceeds without it.
  }
}

async function reconcileUnmanagedModelHost(
  manifest: ModelHostManifest,
  opts: ReconcileOptions,
  dir: string,
  nodeBudgetByName: Map<string, number | undefined>,
  reports: ReconcileNodeReport[],
): Promise<number> {
  const name = manifest.metadata.name;
  const { spec } = manifest;
  const ctx: HostRecordContext = { dir, now: opts.now ?? ((): Date => new Date()) };
  try {
    const client = opts.getClient(spec.node);
    const current = await client.modelHostStatus.query({ workload: name });
    // The remote could not prove whether the recorded pid is ours: do not
    // sweep the sidecar (a possibly-live host would lose its identity anchor)
    // and do not spawn over it. Report the uncertainty so the pass surfaces
    // it instead of looking clean.
    if (current.identityUnknown === true) {
      return pushHostReport(
        reports,
        spec,
        name,
        "unchanged",
        {
          error: {
            reason: "PidIdentityUnknown",
            message: "pid identity unknown; preserving state for a later pass",
          },
        },
        ctx,
      );
    }
    const localState =
      spec.node === LOCAL_NODE_ID ? readModelHostState({ name }, resolveEnv(process.env)) : null;
    const decision = classifyHostReconcile(
      spec,
      localState,
      current,
      readLocalStartAttempt(spec, name),
    );
    if (decision !== "apply") return settleHostWithoutApply(decision, spec, name, reports, ctx);
    const wasRunning = current.state === "Running";
    // #308: locally a launch record proves the engine was up; for a remote
    // host the controller's own history carries that signal instead.
    const foundDead =
      !wasRunning &&
      (spec.node === LOCAL_NODE_ID
        ? localState !== null
        : readControllerHostHistory(ctx.dir, spec.node, name)?.lastKnownRunning === true);
    markNeverHostStartAttempt(spec, name, localState);
    const result = await applyOneModelHost(
      manifest,
      opts.getClient,
      (e) => {
        opts.onEvent?.({ ...e, name });
      },
      {
        env: process.env,
        workloadsDir: dir,
        getNodeBudgetGiB: (nodeName) => nodeBudgetByName.get(nodeName),
      },
    );
    const action = wasRunning ? "restarted" : "started";
    if (result.ok && result.kind === "ModelHost") {
      removeModelHostStartAttempt({ name }, resolveEnv(process.env));
      pushHostReport(reports, spec, name, action, { foundDead }, ctx);
      saveAppliedHost(result.manifest, name, dir);
      const restart = restartReason(wasRunning, foundDead);
      recordHostOutcome(
        spec,
        name,
        {
          kind: "ok",
          recovered: "Recovered",
          ...(restart !== null ? { restart } : {}),
          lastKnownRunning: spec.enabled,
        },
        ctx,
      );
      return 0;
    }
    // applyOneModelHost only emits {ok:true, kind:'ModelHost'} or
    // {ok:false, error}; the ModelRun shape can't arrive here, but
    // narrow defensively for TS.
    const errMsg = result.ok ? "unexpected non-ModelHost outcome" : result.error;
    return pushHostReport(
      reports,
      spec,
      name,
      "unchanged",
      {
        error: { reason: "ApplyFailed", message: errMsg },
        foundDead,
      },
      ctx,
    );
  } catch (err) {
    return pushHostReport(reports, spec, name, "unchanged", caughtHostError(err), ctx);
  }
}
