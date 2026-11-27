import { server } from "@llamactl/core";
import {
  modelhostPidFile,
  modelhostStartingFile,
  readModelHostStarting,
  readModelHostState,
} from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { capacityBudgetGiB, type ManagedWorkloadKind } from "@llamactl/core/residency/admission";
import { withManagedRuntimeMutation } from "@llamactl/core/residency/managed-runtime";
import { listWorkloadDirs, workloadRuntimeDir } from "@llamactl/core/workloadRuntime";
import { join } from "node:path";

import type { AdmissionAuthority, AdmitRequest } from "./admission-authority.js";

import { existsSync, mkdirSync, readFileSync } from "../safe-fs.js";
import { pinModelHostStartup } from "../server/modelhost.js";
import { declaredModelHostMemoryGiB } from "../workload/admission.js";
import { modelRunStartInvocation } from "../workload/apply.js";
import { loadNodeRunByName, nodeRunPath } from "../workload/noderun-store.js";
import { defaultWorkloadsDir, loadWorkloadByNameAny } from "../workload/store.js";
import {
  createManagedLaunchAdmission,
  type ManagedLaunchAdmission,
  type ManagedLaunchRequest,
} from "./managed-launch-admission.js";
import { type LocalAdmissionRuntime, openLocalAdmissionRuntime } from "./process-generation.js";

export interface VerifiedNodeCapacity {
  nodeName: string;
  memBytes: number;
  observedAtMs: number;
}

export interface NodeManagedAdmissionOptions {
  nodeName: string;
  /** Authenticated aliases of this same physical node. */
  aliases?: readonly string[];
  workloadsDir?: string;
  verifiedCapacity?: () => VerifiedNodeCapacity | undefined;
  nowMs?: () => number;
}

const MAX_CAPACITY_AGE_MS = 30_000;

function readDesired<T>(load: () => T): T | undefined {
  try {
    return load();
  } catch {
    return undefined;
  }
}

function localBudget(
  opts: NodeManagedAdmissionOptions,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
): number | undefined {
  const nodeRun = readDesired(() => loadNodeRunByName(opts.nodeName, workloadsDir));
  if (
    nodeRun !== undefined &&
    (nodeRun.metadata.name !== opts.nodeName || !aliases.has(nodeRun.spec.node))
  ) {
    return undefined;
  }
  if (nodeRun === undefined && existsSync(nodeRunPath(opts.nodeName, workloadsDir)))
    return undefined;
  if (nodeRun?.spec.budget !== undefined) return nodeRun.spec.budget.memoryGiB;
  const sample = opts.verifiedCapacity?.();
  if (
    sample === undefined ||
    !aliases.has(sample.nodeName) ||
    !Number.isFinite(sample.memBytes) ||
    sample.memBytes <= 0
  ) {
    return undefined;
  }
  const age = (opts.nowMs ?? Date.now)() - sample.observedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > MAX_CAPACITY_AGE_MS) return undefined;
  return capacityBudgetGiB(sample.memBytes, nodeRun?.spec.residency?.safetyMarginRatio);
}

type ApprovedPlan = Pick<AdmitRequest, "specDigest" | "allocationGiB">;

function compileDesired(
  manifest: ReturnType<typeof loadWorkloadByNameAny>,
): ApprovedPlan | undefined {
  if (manifest.kind === "ModelHost") {
    const allocationGiB = declaredModelHostMemoryGiB(manifest);
    if (allocationGiB === null || allocationGiB <= 0) return undefined;
    return { allocationGiB, specDigest: pinModelHostStartup(manifest).effectiveSpecDigest };
  }

  const allocationGiB = manifest.spec.resources?.expectedMemoryGiB;
  // A tensor-parallel launch needs authorization and reservations on its
  // workers as well as on the coordinator.
  if (
    allocationGiB === undefined ||
    allocationGiB <= 0 ||
    manifest.spec.gateway ||
    manifest.spec.workers.length > 0
  ) {
    return undefined;
  }
  const { workload, ...opts } = modelRunStartInvocation(manifest);
  const prepared = server.prepareManagedServerStart({ ...opts, key: { name: workload } });
  return "result" in prepared
    ? undefined
    : { allocationGiB, specDigest: prepared.effectiveSpecDigest };
}

function approveLaunch(
  request: ManagedLaunchRequest,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
): ApprovedPlan | undefined {
  if (request.effectiveSpecDigest === undefined) return undefined;
  const manifest = readDesired(() => loadWorkloadByNameAny(request.runtimeKey, workloadsDir));
  if (
    manifest?.kind !== request.kind ||
    manifest.metadata.name !== request.runtimeKey ||
    !manifest.spec.enabled ||
    !aliases.has(manifest.spec.node)
  ) {
    return undefined;
  }
  const approved = readDesired(() => compileDesired(manifest));
  return approved?.specDigest === request.effectiveSpecDigest ? approved : undefined;
}

interface RuntimeRecord {
  name: string;
  kind: ManagedWorkloadKind;
  pid: number | undefined;
}

function localRuntimeRecords(resolved: ReturnType<typeof resolveEnv>): RuntimeRecord[] {
  const records: RuntimeRecord[] = [];
  if (existsSync(join(resolved.LOCAL_AI_RUNTIME_DIR, "llama-server.pid"))) {
    records.push({ name: "", kind: "ModelRun", pid: undefined });
  }
  for (const name of listWorkloadDirs(resolved)) {
    const key = { name };
    if (existsSync(join(workloadRuntimeDir(resolved, key), "llama-server.pid"))) {
      records.push({
        name,
        kind: "ModelRun",
        pid: server.readServerPid(key, resolved) ?? undefined,
      });
    }
    const hostPid = modelhostPidFile(resolved, key);
    if (existsSync(hostPid)) {
      records.push({
        name,
        kind: "ModelHost",
        pid: readDesired(() => Number(readFileSync(hostPid, "utf8").trim())),
      });
    }
    if (existsSync(modelhostStartingFile(resolved, key))) {
      records.push({ name, kind: "ModelHost", pid: readModelHostStarting(key, resolved)?.pid });
    }
  }
  return records;
}

function verifyLocalInventory(
  resolved: ReturnType<typeof resolveEnv>,
  runtime: LocalAdmissionRuntime,
): boolean {
  const claims = runtime.authority.snapshot();
  return localRuntimeRecords(resolved).every(({ name, kind, pid }) => {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
    const captured = runtime.capture(pid);
    if (captured?.birthId !== undefined) {
      return claims.some(
        (row) =>
          row.runtimeKey === name &&
          row.kind === kind &&
          row.generations.some((gen) => gen.pid === pid && gen.birthId === captured.birthId),
      );
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  });
}

export async function openNodeManagedAdmission(opts: NodeManagedAdmissionOptions): Promise<{
  admission: ManagedLaunchAdmission;
  authority: AdmissionAuthority;
  verifyActivation(): string | undefined;
}> {
  const resolved = resolveEnv();
  const runtimeDir = resolved.LOCAL_AI_RUNTIME_DIR;
  const workloadsDir = opts.workloadsDir ?? defaultWorkloadsDir();
  const aliases = new Set([opts.nodeName, ...(opts.aliases ?? [])]);
  mkdirSync(runtimeDir, { recursive: true });
  const runtime = await openLocalAdmissionRuntime({
    storePath: join(runtimeDir, "residency-admission.db"),
    budgetGiB: () => localBudget(opts, workloadsDir, aliases),
    readPidFile: (name) => {
      const key = { name };
      const run = server.readServerPid(key, resolved);
      const host =
        readModelHostState(key, resolved)?.pid ?? readModelHostStarting(key, resolved)?.pid;
      return run !== null && host !== undefined ? undefined : (run ?? host);
    },
  });
  const runOwnedLifecycle = <T>(run: () => T): T => withManagedRuntimeMutation(runtimeDir, run);
  const inspectRuntime = (): string | undefined =>
    readDesired(() => verifyLocalInventory(resolved, runtime)) === true
      ? undefined
      : "ManagedRuntimeInventoryUnknown";
  const admission = createManagedLaunchAdmission({
    runOwnedLifecycle,
    authority: runtime.authority,
    capture: (_request, pid) => runtime.capture(pid),
    inspectRuntime,
    resolve: (request) =>
      resolveEnv().LOCAL_AI_RUNTIME_DIR === runtimeDir
        ? approveLaunch(request, workloadsDir, aliases)
        : undefined,
  });
  return {
    admission,
    authority: runtime.authority,
    verifyActivation(): string | undefined {
      if (!runtime.authority.isOperational()) return "AuthorityUnavailable";
      if (localBudget(opts, workloadsDir, aliases) === undefined) return "BudgetUnknown";
      return inspectRuntime();
    },
  };
}
