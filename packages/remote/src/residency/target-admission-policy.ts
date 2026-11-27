import { server } from "@llamactl/core";
import {
  modelhostPidFile,
  modelhostStartingFile,
  readModelHostStarting,
  readModelHostState,
} from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import {
  capacityBudgetGiB,
  evaluateManagedAdmission,
  type ManagedWorkloadKind,
} from "@llamactl/core/residency/admission";
import { listWorkloadDirs, workloadRuntimeDir } from "@llamactl/core/workloadRuntime";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import type { AdmissionAuthority, AdmitRequest } from "./admission-authority.js";

import { existsSync, mkdirSync, readFileSync } from "../safe-fs.js";
import { pinModelHostStartup } from "../server/modelhost.js";
import { declaredModelHostMemoryGiB } from "../workload/admission.js";
import { modelRunStartInvocation, parseEvictTargets } from "../workload/apply.js";
import { ModelHostManifestSchema } from "../workload/modelhost-schema.js";
import { loadNodeRunByName, nodeRunPath } from "../workload/noderun-store.js";
import { ModelRunSchema } from "../workload/schema.js";
import { defaultWorkloadsDir, loadWorkloadByNameAny, workloadPath } from "../workload/store.js";
import {
  createManagedLaunchAdmission,
  type ManagedApplyBudget,
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
type DesiredManifest = ReturnType<typeof loadWorkloadByNameAny>;

function compileDesired(manifest: DesiredManifest): ApprovedPlan | undefined {
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
  pending: DesiredManifest | undefined,
): ApprovedPlan | undefined {
  if (request.effectiveSpecDigest === undefined) return undefined;
  const manifest =
    pending?.metadata.name === request.runtimeKey
      ? pending
      : readDesired(() => loadWorkloadByNameAny(request.runtimeKey, workloadsDir));
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

function parseDesired(input: unknown): DesiredManifest | undefined {
  const run = ModelRunSchema.safeParse(input);
  if (run.success) return run.data;
  const host = ModelHostManifestSchema.safeParse(input);
  return host.success ? host.data : undefined;
}

function checkManagedApply(
  manifest: DesiredManifest,
  authority: AdmissionAuthority,
  budgetGiB: number | undefined,
): ManagedApplyBudget | undefined {
  if (!manifest.spec.enabled) return undefined;
  if (budgetGiB === undefined || !Number.isFinite(budgetGiB) || budgetGiB <= 0) {
    throw new Error("BudgetUnknown: managed apply requires a finite target budget");
  }
  const approved = compileDesired(manifest);
  if (approved === undefined)
    throw new Error("ManagedSpecUnknown: managed apply cannot pin this manifest");
  const claims = authority.snapshot();
  const runtimeKey = manifest.metadata.name;
  const current = claims.find((row) => row.runtimeKey === runtimeKey);
  if (
    parseEvictTargets(manifest).length > 0 ||
    (current !== undefined &&
      (current.kind !== manifest.kind || current.specDigest !== approved.specDigest))
  ) {
    throw new Error("ManagedReplacementRequiresProfile: use a verified profile transition");
  }
  const decision = evaluateManagedAdmission({
    budgetGiB,
    incoming: { ...approved, runtimeKey, kind: manifest.kind },
    claims,
  });
  if (decision.kind === "refuse") throw new Error(`${decision.reason}: ${decision.detail}`);
  if (decision.kind === "join-pending")
    throw new Error("ManagedLaunchPending: the same workload is already loading");
  const reservedAfter =
    decision.kind === "admit"
      ? decision.committedGiB
      : claims.reduce((total, claim) => total + (claim.allocationGiB ?? 0), 0);
  return { ok: true, budget: budgetGiB, reservedAfter };
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
}> {
  const resolved = resolveEnv();
  const runtimeDir = resolved.LOCAL_AI_RUNTIME_DIR;
  const workloadsDir = opts.workloadsDir ?? defaultWorkloadsDir();
  const aliases = new Set([opts.nodeName, ...(opts.aliases ?? [])]);
  const desired = new AsyncLocalStorage<DesiredManifest>();
  const budgetGiB = (): number | undefined => localBudget(opts, workloadsDir, aliases);
  mkdirSync(runtimeDir, { recursive: true });
  const runtime = await openLocalAdmissionRuntime({
    storePath: join(runtimeDir, "residency-admission.db"),
    budgetGiB,
    readPidFile: (name) => {
      const key = { name };
      const run = server.readServerPid(key, resolved);
      const host =
        readModelHostState(key, resolved)?.pid ?? readModelHostStarting(key, resolved)?.pid;
      return run !== null && host !== undefined ? undefined : (run ?? host);
    },
  });
  const inspectRuntime = (): string | undefined =>
    readDesired(() => verifyLocalInventory(resolved, runtime)) === true
      ? undefined
      : "ManagedRuntimeInventoryUnknown";
  const admission = createManagedLaunchAdmission({
    authority: runtime.authority,
    capture: (_request, pid) => runtime.capture(pid),
    inspectRuntime,
    resolve: (request) =>
      resolveEnv().LOCAL_AI_RUNTIME_DIR === runtimeDir
        ? approveLaunch(request, workloadsDir, aliases, desired.getStore())
        : undefined,
  });
  return {
    admission: {
      ...admission,
      ownsNode: (name) => aliases.has(name),
      async withDesiredManifest<T>(
        input: unknown,
        apply: (owned: boolean, budget?: ManagedApplyBudget) => Promise<T>,
      ): Promise<T> {
        const manifest = parseDesired(input);
        if (manifest === undefined || !aliases.has(manifest.spec.node)) return await apply(false);
        const name = manifest.metadata.name;
        if (existsSync(workloadPath(name, workloadsDir))) {
          const previous = readDesired(() => loadWorkloadByNameAny(name, workloadsDir));
          if (
            previous === undefined ||
            previous.kind !== manifest.kind ||
            !aliases.has(previous.spec.node)
          ) {
            throw new Error(
              "ManagedManifestConflict: the stored workload has a different owner or kind",
            );
          }
        }
        const inventoryError = manifest.spec.enabled ? inspectRuntime() : undefined;
        if (inventoryError !== undefined) throw new Error(inventoryError);
        const budget = checkManagedApply(manifest, runtime.authority, budgetGiB());
        return await desired.run(manifest, () => apply(true, budget));
      },
    },
    authority: runtime.authority,
  };
}
