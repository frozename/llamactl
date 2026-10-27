import {
  type ModelHostRestartReason,
  recordModelHostReconcileError,
  recordModelHostReconcileRecovered,
  recordModelHostRestart,
} from "@llamactl/core/engines/conditions";
import {
  computeModelHostSpecHash,
  readModelHostState,
  removeModelHostState,
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
  /** ModelHost on the local node only: a launch record exists but the engine
   *  was not running, i.e. it exited or was killed since the last pass. */
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
  /** Per-call deadlines for node .query / .mutate RPCs; defaults to
   *  DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS / DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS. */
  rpcTimeouts?: Partial<NodeRpcTimeouts>;
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
 * so one unreachable node cannot stall the rest of the pass. After
 * the first timeout on a node, that node's remaining calls in the
 * pass fail fast with NodeRpcSkippedError; the next pass retries it.
 */
export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileResult> {
  const timeouts: NodeRpcTimeouts = {
    queryMs: opts.rpcTimeouts?.queryMs ?? DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS,
    mutateMs: opts.rpcTimeouts?.mutateMs ?? DEFAULT_NODE_RPC_MUTATE_TIMEOUT_MS,
  };
  const pass: NodeRpcPassState = { timedOut: new Map() };
  const deadlineOpts: ReconcileOptions = {
    ...opts,
    getClient: (nodeName) =>
      withNodeRpcDeadline(opts.getClient(nodeName), nodeName, timeouts, pass),
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
    const result = await applyOne(
      manifest,
      opts.getClient,
      (e) => {
        opts.onEvent?.({ ...e, name });
      },
      undefined,
      {
        workloadsDir: dir,
        ...(opts.resolveNodeIdentity && { resolveNodeIdentity: opts.resolveNodeIdentity }),
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
 * Decide what one ModelHost reconcile pass should do:
 *
 *   sweep-disabled — host is disabled and not Running; clear any
 *                    stale sidecar and report unchanged.
 *   converged      — Running with a matching specHash; nothing to do.
 *   apply          — anything else; run applyOneModelHost.
 *
 * Idempotent reconcile with spec-drift detection. For local
 * workloads, the controller-owned sidecar is the source of truth
 * for observed specHash. For remote workloads, trust the remote
 * modelHostStatus.specHash surfaced by the node dispatcher. Skip
 * restart iff Running and observedHash matches desiredHash.
 */
function classifyHostReconcile(
  spec: ModelHostManifest["spec"],
  localState: ReturnType<typeof readModelHostState>,
  current: { state: string; specHash?: string },
): "sweep-disabled" | "converged" | "apply" {
  if (!spec.enabled && current.state !== "Running") return "sweep-disabled";
  const desiredHash = computeModelHostSpecHash(specForHash(spec));
  const observedHash = spec.node === LOCAL_NODE_ID ? localState?.specHash : current.specHash;
  if (current.state === "Running" && observedHash === desiredHash) return "converged";
  return "apply";
}

type HostOutcome =
  | { kind: "ok"; recovered: string; restart?: ModelHostRestartReason }
  | { kind: "error"; reason: string; message: string };

/**
 * Persist the pass outcome in the local host's conditions sidecar. Only the
 * local node's runtime dir is reachable from here; a remote host's
 * conditions belong to the controller on that node. Bookkeeping failures
 * (disk full, permissions) must never turn a pass into an error.
 */
function recordHostOutcome(
  spec: ModelHostManifest["spec"],
  name: string,
  outcome: HostOutcome,
): void {
  if (spec.node !== LOCAL_NODE_ID) return;
  const resolved = resolveEnv(process.env);
  try {
    if (outcome.kind === "error") {
      recordModelHostReconcileError({ name }, outcome, resolved);
      return;
    }
    if (outcome.restart) recordModelHostRestart({ name }, outcome.restart, resolved);
    recordModelHostReconcileRecovered({ name }, outcome.recovered, resolved);
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
  recordHostOutcome(spec, name, { kind: "error", ...extra.error });
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
): number {
  if (spec.node === LOCAL_NODE_ID) {
    removeModelHostState({ name }, resolveEnv(process.env));
  }
  recordHostOutcome(spec, name, { kind: "ok", recovered: "Disabled" });
  return pushHostReport(reports, spec, name, "unchanged", {});
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
  return await reconcileUnmanagedModelHost(current, opts, dir, nodeBudgetByName, reports);
}

/**
 * Persist the applied manifest unless the on-disk copy gained an external
 * managed-by marker (or vanished) while the apply was awaited: another
 * controller owns the hand-over now, so the stale in-memory manifest must
 * not be written back over it.
 */
function saveAppliedHost(manifest: ModelHostManifest, name: string, dir: string): void {
  let claimed = true;
  try {
    claimed = externalManagerOf(loadModelHostByName(name, dir)) !== null;
  } catch {
    // claimed stays true: the vanished or unreadable file is not ours to recreate.
  }
  if (!claimed) saveModelHost(manifest, dir);
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
  try {
    const client = opts.getClient(spec.node);
    const current = await client.modelHostStatus.query({ workload: name });
    // The remote could not prove whether the recorded pid is ours: do not
    // sweep the sidecar (a possibly-live host would lose its identity anchor)
    // and do not spawn over it. Report the uncertainty so the pass surfaces
    // it instead of looking clean.
    if (current.identityUnknown === true) {
      return pushHostReport(reports, spec, name, "unchanged", {
        error: {
          reason: "PidIdentityUnknown",
          message: "pid identity unknown; preserving state for a later pass",
        },
      });
    }
    const localState =
      spec.node === LOCAL_NODE_ID ? readModelHostState({ name }, resolveEnv(process.env)) : null;
    const decision = classifyHostReconcile(spec, localState, current);
    if (decision === "sweep-disabled") return sweepDisabledHost(spec, name, reports);
    if (decision === "converged") {
      recordHostOutcome(spec, name, { kind: "ok", recovered: "Recovered" });
      return pushHostReport(reports, spec, name, "unchanged", {});
    }
    const wasRunning = current.state === "Running";
    const foundDead = !wasRunning && localState !== null;
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
      pushHostReport(reports, spec, name, action, { foundDead });
      saveAppliedHost(result.manifest, name, dir);
      const restart = restartReason(wasRunning, foundDead);
      recordHostOutcome(spec, name, {
        kind: "ok",
        recovered: "Recovered",
        ...(restart !== null ? { restart } : {}),
      });
      return 0;
    }
    // applyOneModelHost only emits {ok:true, kind:'ModelHost'} or
    // {ok:false, error}; the ModelRun shape can't arrive here, but
    // narrow defensively for TS.
    const errMsg = result.ok ? "unexpected non-ModelHost outcome" : result.error;
    return pushHostReport(reports, spec, name, "unchanged", {
      error: { reason: "ApplyFailed", message: errMsg },
      foundDead,
    });
  } catch (err) {
    return pushHostReport(reports, spec, name, "unchanged", caughtHostError(err));
  }
}
