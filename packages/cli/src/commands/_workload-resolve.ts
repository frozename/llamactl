import { type ResolvedEnv, workloadRuntime } from "@llamactl/core";
import { workloadStore } from "@llamactl/remote";

import {
  isLocalDispatch as defaultIsLocalDispatch,
  resolveEffectiveNodeName as defaultResolveEffectiveNodeName,
} from "../dispatcher.js";
import { required } from "../required.js";

export interface ResolveWorkloadDeps {
  isLocalDispatch?: typeof defaultIsLocalDispatch;
  resolveEffectiveNodeName?: typeof defaultResolveEffectiveNodeName;
  listWorkloads?: typeof workloadStore.listAnyWorkloadsForAdmission;
}

/**
 * Live-then-known precedence shared by the local and remote paths: a
 * single live workload wins, otherwise a single known workload, otherwise
 * synthesize (when asked) or fail with a name-required error.
 */
function pickByPrecedence(
  live: string[],
  known: string[],
  opts?: { synthesizeIfEmpty?: boolean },
): string {
  if (live.length === 1) return required(live[0]);
  if (live.length > 1) {
    throw new Error(`multiple workloads live (${live.join(", ")}); pass --name <workload>`);
  }
  if (known.length === 1) return required(known[0]);
  if (known.length > 1) {
    throw new Error(
      `multiple workloads on this node (${known.join(", ")}); pass --name <workload>`,
    );
  }
  if (opts?.synthesizeIfEmpty) return `imperative-${String(Date.now())}`;
  throw new Error("no live workloads; pass --name <workload>");
}

export function resolveWorkloadName(
  explicit: string | undefined,
  resolved: ResolvedEnv,
  opts?: { synthesizeIfEmpty?: boolean },
  deps: ResolveWorkloadDeps = {},
): string {
  if (explicit) return explicit;

  const isLocal = deps.isLocalDispatch ?? defaultIsLocalDispatch;
  if (!isLocal()) {
    // A non-local `--node` target. The manifest store is control-plane
    // central — a node agent never persists the manifests placed on it,
    // so the remote node's own list is empty for anything applied to it.
    // Resolve from THIS machine's store, scoped to the workloads actually
    // assigned to the target node (spec.node), instead of auto-picking
    // across every local workload regardless of node. The admission lister
    // projects ModelHost manifests into the result too, so they resolve on
    // the remote path the same way the local path detects modelhost.pid.
    const resolveNode = deps.resolveEffectiveNodeName ?? defaultResolveEffectiveNodeName;
    const list = deps.listWorkloads ?? workloadStore.listAnyWorkloadsForAdmission;
    const node = resolveNode();
    const names = list()
      .filter((m) => m.spec.node === node)
      .map((m) => m.metadata.name);
    // `server start` (the only synthesizeIfEmpty caller) means "create a
    // server on this node" — it must NOT adopt, and silently overwrite,
    // an existing workload already assigned there. Synthesize a fresh name
    // instead, matching the pre-dual-path behavior where a remote-targeted
    // start read an empty local runtime dir. stop/status/logs omit the
    // flag and still resolve the node's single assigned workload.
    const known = opts?.synthesizeIfEmpty ? [] : names;
    if (known.length === 0 && !opts?.synthesizeIfEmpty) {
      throw new Error(`no workloads assigned to node ${node}; pass --name <workload>`);
    }
    return pickByPrecedence([], known, opts);
  }

  const live = workloadRuntime.listLocalWorkloads(resolved).map((w: { name: string }) => w.name);
  const known = workloadRuntime.listWorkloadDirs(resolved);
  return pickByPrecedence(live, known, opts);
}
