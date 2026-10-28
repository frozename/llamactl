import type { NodeRun } from "./noderun-schema.js";

import {
  DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS,
  type NodeRpcPassState,
  NodeRpcSkippedError,
  NodeRpcTimeoutError,
  type NodeRpcTimeouts,
  withNodeRpcDeadline,
} from "./node-rpc-deadline.js";
import {
  applyNodeRun,
  type ArtifactResolver,
  type NodeRunApplyResult,
  type NodeRunInfraClient,
} from "./noderun-apply.js";
import { defaultNodeRunsDir, listNodeRuns, saveNodeRun } from "./noderun-store.js";

/**
 * Single-pass NodeRun reconciliation. Iterates every persisted
 * NodeRun manifest under the workloads dir, calls applyNodeRun
 * against its target node, and persists the new status back into
 * the manifest file.
 *
 * Parallel to workload/reconciler.ts for ModelRun. Kept deliberately
 * separate because the diff semantics differ — ModelRun converges on
 * a single llama-server start/restart; NodeRun converges on a set
 * of infra packages and may issue many ops per pass.
 * Node queries carry the per-call deadline from node-rpc-deadline.ts, with the
 * same per-pass skip as reconcileOnce; mutations stay unbounded.
 */

export interface NodeRunReconcileReport {
  name: string;
  node: string;
  phase: NodeRunApplyResult["status"]["phase"];
  actions: number;
  errors: number;
  error?: string;
  /** #221: set only when the error is a node RPC deadline timeout or a
   *  per-pass skip after one (NodeRpcTimeoutError / NodeRpcSkippedError).
   *  The error message itself is unchanged. */
  reason?: "NodeUnreachable";
}

export interface NodeRunReconcileResult {
  reports: NodeRunReconcileReport[];
  errors: number;
}

export interface NodeRunReconcileOptions {
  workloadsDir?: string;
  /** Resolve the target node's client. Same structural shape tRPC
   *  uses; swap a mock in tests. */
  getClient: (nodeName: string) => NodeRunInfraClient;
  /** Build the ArtifactResolver bound to a specific client. Called
   *  once per manifest (cached inside applyNodeRun's own platform
   *  probe). CLI production wiring: makeSpecArtifactResolver. */
  getArtifactResolver: (nodeName: string, client: NodeRunInfraClient) => ArtifactResolver;
  /** Tick-level callback; receives the per-manifest payload before
   *  the next one starts so callers can log progress inline. */
  onReport?: (report: NodeRunReconcileReport & { manifestName: string }) => void;
  /** Narrow the reconcile to a subset of manifests (e.g., "only
   *  those labelled env=dev"). */
  filter?: (m: NodeRun) => boolean;
  /** #221: per-call deadline for node queries (infraList, and any query the artifact
   *  resolver makes on the client it is handed). Default DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS.
   *  Mutations are never bounded here: infraInstall downloads tarballs. */
  rpcTimeouts?: { queryMs?: number };
}

/** #221: bound node queries; leave .mutate unbounded (null) so a long infraInstall
 *  download never inherits a deadline. */
function nodeRunRpcTimeouts(opts: NodeRunReconcileOptions): NodeRpcTimeouts {
  return {
    queryMs: opts.rpcTimeouts?.queryMs ?? DEFAULT_NODE_RPC_QUERY_TIMEOUT_MS,
    mutateMs: null,
  };
}

/** #221: a node RPC deadline timeout, or a per-pass skip after one (as in reconciler.ts). */
function isNodeUnreachableError(err: unknown): boolean {
  return err instanceof NodeRpcTimeoutError || err instanceof NodeRpcSkippedError;
}

/** The report field for an error caught while reconciling one NodeRun. */
function nodeUnreachableField(err: unknown): Pick<NodeRunReconcileReport, "reason"> {
  return isNodeUnreachableError(err) ? { reason: "NodeUnreachable" } : {};
}

export async function reconcileNodeRunsOnce(
  opts: NodeRunReconcileOptions,
): Promise<NodeRunReconcileResult> {
  const dir = opts.workloadsDir ?? defaultNodeRunsDir();
  const manifests = listNodeRuns(dir);
  const filtered = opts.filter ? manifests.filter(opts.filter) : manifests;
  const reports: NodeRunReconcileReport[] = [];
  let errors = 0;
  const timeouts = nodeRunRpcTimeouts(opts);
  // One pass state per call: after a node's first timeout, its later NodeRuns in this
  // pass fail fast with NodeRpcSkippedError. The next pass tries the node again.
  const pass: NodeRpcPassState = { timedOut: new Map() };

  for (const manifest of filtered) {
    const name = manifest.metadata.name;
    const node = manifest.spec.node;
    try {
      const client = withNodeRpcDeadline(opts.getClient(node), node, timeouts, pass);
      const resolveArtifact = opts.getArtifactResolver(node, client);
      const result = await applyNodeRun(manifest, { client, resolveArtifact });
      const actionCount = result.actions.filter((a) => a.type !== "skip").length;
      const errorCount = result.outcomes.filter((o) => !o.ok).length;
      if (errorCount > 0) errors++;
      const report: NodeRunReconcileReport = {
        name,
        node,
        phase: result.status.phase,
        actions: actionCount,
        errors: errorCount,
        ...(result.error ? { error: result.error } : {}),
      };
      reports.push(report);
      opts.onReport?.({ ...report, manifestName: name });
      // Persist the status so `get noderuns` reflects the latest pass.
      const persisted: NodeRun = { ...manifest, status: result.status };
      saveNodeRun(persisted, dir);
    } catch (err) {
      errors++;
      const message = (err as Error).message;
      const report: NodeRunReconcileReport = {
        name,
        node,
        phase: "Failed",
        actions: 0,
        errors: 1,
        error: message,
        ...nodeUnreachableField(err),
      };
      reports.push(report);
      opts.onReport?.({ ...report, manifestName: name });
    }
  }

  return { reports, errors };
}
