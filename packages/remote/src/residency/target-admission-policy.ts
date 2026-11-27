import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";

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
  type ManagedAdmissionClaim,
  type ManagedWorkloadKind,
  MEMORY_BUDGET_HEADROOM_RATIO,
} from "@llamactl/core/residency/admission";
import { withManagedRuntimeMutation } from "@llamactl/core/residency/managed-runtime";
import { projectManagedCapacity } from "@llamactl/core/resources/managed-capacity";
import { listWorkloadDirs, workloadRuntimeDir } from "@llamactl/core/workloadRuntime";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import type { AdmissionAuthority, AdmitRequest, AuthorityClaimRow } from "./admission-authority.js";

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
import {
  evaluateManagedProfileStart,
  managedProfileMemberProfiles,
  managedProfilePermit,
  readManagedProfileSelection,
} from "./managed-profile-selection.js";
import { type LocalAdmissionRuntime, openLocalAdmissionRuntime } from "./process-generation.js";
import { defaultResidencyStorePath } from "./store.js";

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
  readCapacity?: () => ManagedCapacitySample | undefined;
  onCapacityAudit?: (entry: ManagedCapacityAudit) => void;
  nowMs?: () => number;
  requireExistingStore?: boolean;
  verifyJournalPair?: () => string | undefined;
}

const MAX_CAPACITY_AGE_MS = 30_000;

export function managedAdmissionStorePath(runtimeDir: string): string {
  return join(runtimeDir, "residency-admission.db");
}

function readDesired<T>(load: () => T): T | undefined {
  try {
    return load();
  } catch {
    return undefined;
  }
}

function ownerNodeRun(
  opts: NodeManagedAdmissionOptions,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
): ReturnType<typeof loadNodeRunByName> | null | undefined {
  const nodeRun = readDesired(() => loadNodeRunByName(opts.nodeName, workloadsDir));
  if (nodeRun === undefined) {
    return existsSync(nodeRunPath(opts.nodeName, workloadsDir)) ? undefined : null;
  }
  return nodeRun.metadata.name === opts.nodeName && aliases.has(nodeRun.spec.node)
    ? nodeRun
    : undefined;
}

function localBudget(
  opts: NodeManagedAdmissionOptions,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
): number | undefined {
  const nodeRun = ownerNodeRun(opts, workloadsDir, aliases);
  if (nodeRun === undefined) return undefined;
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

type CapacityPhase = "bootstrap" | "profile-preflight" | "reservation" | "launch" | "engine-entry";

export interface ManagedCapacityAudit {
  nodeName: string;
  phase: CapacityPhase;
  ledgerCeilingGiB?: number;
  launchHeadroomGiB?: number;
  requiredHeadroomGiB?: number;
  ledgerHeldGiB?: number;
  refusal?: string;
}

type CapacityLimits = { ledgerCeilingGiB: number; launchHeadroomGiB: number };

type OwnerCapacity =
  | (CapacityLimits & { observedAtMs: number })
  | ({ refusal: string } & Partial<CapacityLimits>);

const GiB = 1024 ** 3;

function capacityRefusal(reason: string): { refusal: string } {
  return { refusal: "ManagedCapacity: " + reason };
}

function ceilingWithoutHeadroom(
  sample: ManagedCapacitySample,
  ratio: number,
  configured: number | undefined,
): number {
  // The projection proved all source, pressure and swap checks before
  // returning NoMemoryHeadroom. Stops must still be able to free memory.
  const physicalGiB = (sample.physicalBytes ?? 0) / GiB;
  const host = physicalGiB - physicalGiB * (1 - ratio);
  const scope = sample.scope.kind === "cgroup-v2" ? sample.scope.limitBytes / GiB : host;
  return Math.min(host, scope, configured ?? host);
}

function physicalCapacity(
  opts: NodeManagedAdmissionOptions,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
): OwnerCapacity {
  const nodeRun = ownerNodeRun(opts, workloadsDir, aliases);
  if (nodeRun === undefined) return capacityRefusal("NodeBudgetUnknown");
  const sample = readDesired(() => opts.readCapacity?.());
  if (sample === undefined) return capacityRefusal("CapacityUnknown");
  const configured = nodeRun?.spec.budget?.memoryGiB;
  const ratio = nodeRun?.spec.residency?.safetyMarginRatio ?? MEMORY_BUDGET_HEADROOM_RATIO;
  const projected = projectManagedCapacity(sample, {
    nowMs: (opts.nowMs ?? Date.now)(),
    safetyMarginRatio: ratio,
    ...(configured === undefined ? {} : { configuredBudgetGiB: configured }),
  });
  if (!projected.ok && projected.reason !== "NoMemoryHeadroom") {
    return capacityRefusal(projected.reason);
  }
  const ledgerCeilingGiB = projected.ok
    ? projected.ledgerCeilingGiB
    : ceilingWithoutHeadroom(sample, ratio, configured);
  const limits = {
    ledgerCeilingGiB,
    launchHeadroomGiB: projected.ok ? projected.launchHeadroomGiB : 0,
  };
  if (configured !== undefined && configured > ledgerCeilingGiB) {
    return { ...limits, ...capacityRefusal("ConfiguredBudgetExceedsCapacity") };
  }
  if (ledgerCeilingGiB <= 0) return { ...limits, ...capacityRefusal("NoMemoryHeadroom") };
  return { ...limits, observedAtMs: sample.observedAtMs };
}

function auditCapacity(
  opts: NodeManagedAdmissionOptions,
  phase: CapacityPhase,
  capacity: OwnerCapacity,
  details: { requiredHeadroomGiB?: number; ledgerHeldGiB?: number; refusal?: string } = {},
): void {
  const measurement =
    "refusal" in capacity
      ? capacity
      : {
          ledgerCeilingGiB: capacity.ledgerCeilingGiB,
          launchHeadroomGiB: capacity.launchHeadroomGiB,
        };
  try {
    opts.onCapacityAudit?.({ nodeName: opts.nodeName, phase, ...measurement, ...details });
  } catch {
    // An audit sink cannot authorize a launch or strand a reservation.
  }
}

function verifiedResident(row: AuthorityClaimRow, authority: AdmissionAuthority): boolean {
  if (row.state !== "resident" || row.kind === undefined) return false;
  const stop = authority.prepareStopRelease(row.runtimeKey, row.kind);
  return (
    stop !== undefined && row.generations.some(({ pid }) => stop.verifyGeneration(pid) === "alive")
  );
}

function launchCapacityRefusal(
  limits: CapacityLimits,
  ledgerHeldGiB: number,
  requiredHeadroomGiB: number,
): string | undefined {
  if (ledgerHeldGiB > limits.ledgerCeilingGiB)
    return capacityRefusal("LedgerCeilingExceeded").refusal;
  if (requiredHeadroomGiB > limits.launchHeadroomGiB)
    return capacityRefusal("InsufficientHeadroom").refusal;
  return undefined;
}

type PhysicalPolicy = {
  measure: () => OwnerCapacity;
  checkLaunch: (
    request: ManagedLaunchRequest,
    phase: "launch" | "engine-entry",
  ) => string | undefined;
};

function ownerPhysicalPolicy(
  opts: NodeManagedAdmissionOptions,
  measure: PhysicalPolicy["measure"],
  authority: AdmissionAuthority,
): PhysicalPolicy {
  return {
    measure,
    checkLaunch(request, phase): string | undefined {
      const claims = authority.snapshot();
      const pending = claims.some(
        (row) =>
          row.runtimeKey === request.runtimeKey &&
          row.state === "pending" &&
          row.kind === request.kind &&
          row.specDigest === request.effectiveSpecDigest,
      );
      if (!pending || !authority.isOperational()) return "AuthorityUnavailable";
      const unverified = claims.filter((row) => !verifiedResident(row, authority));
      const proofAtMs = (opts.nowMs ?? Date.now)();
      const fresh = measure();
      if ("refusal" in fresh) {
        auditCapacity(opts, phase, fresh);
        return fresh.refusal;
      }
      const required = fresh.observedAtMs < proofAtMs ? claims : unverified;
      const requiredHeadroomGiB = required.reduce((sum, row) => sum + row.allocationGiB, 0);
      const ledgerHeldGiB = claims.reduce((sum, row) => sum + row.allocationGiB, 0);
      const refusal = launchCapacityRefusal(fresh, ledgerHeldGiB, requiredHeadroomGiB);
      auditCapacity(opts, phase, fresh, {
        requiredHeadroomGiB,
        ledgerHeldGiB,
        ...(refusal === undefined ? {} : { refusal }),
      });
      return refusal;
    },
  };
}

type ManagedEngineGate = { mayEnter: () => boolean; refusal?: string };

function preLaunchGate(physical: PhysicalPolicy, request: ManagedLaunchRequest): ManagedEngineGate {
  let entered = false;
  const gate: ManagedEngineGate = {
    mayEnter(): boolean {
      if (entered) return true;
      if (gate.refusal !== undefined) return false;
      const refusal = physical.checkLaunch(request, "engine-entry");
      if (refusal !== undefined) {
        gate.refusal = refusal;
        return false;
      }
      entered = true;
      return true;
    },
  };
  return gate;
}

function launchWithPhysicalGate(
  admission: ManagedLaunchAdmission,
  physical: PhysicalPolicy,
  engineGate: AsyncLocalStorage<ManagedEngineGate>,
): ManagedLaunchAdmission["run"] {
  return (request, signal, start) =>
    admission.run(request, signal, async (commit) => {
      const refusal = physical.checkLaunch(request, "launch");
      if (refusal !== undefined) return { ran: false, detail: refusal };
      const gate = preLaunchGate(physical, request);
      const result = await engineGate.run(gate, () => start(commit));
      // A refusal at the first managed runtime mutation proves no engine ran.
      return gate.refusal === undefined ? result : { ran: false, detail: gate.refusal };
    });
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
  nodeName: string,
): ApprovedPlan | { refusal: string } | undefined {
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
  if (approved?.specDigest !== request.effectiveSpecDigest) return undefined;
  const profiles = managedProfileMemberProfiles(manifest.metadata.annotations);
  if (profiles.length === 0) return approved;
  const selected = readManagedProfileSelection(defaultResidencyStorePath(), nodeName);
  const decision = evaluateManagedProfileStart(selected, profiles, managedProfilePermit());
  return decision.ok ? approved : { refusal: decision.reason };
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
      : claims.reduce((total, claim) => total + claim.allocationGiB, 0);
  return { ok: true, budget: budgetGiB, reservedAfter };
}

function profileReplacement(
  workload: string,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
): (ApprovedPlan & { runtimeKey: string; kind: ManagedWorkloadKind }) | undefined {
  const manifest = readDesired(() => loadWorkloadByNameAny(workload, workloadsDir));
  if (
    manifest === undefined ||
    !aliases.has(manifest.spec.node) ||
    !manifest.spec.enabled ||
    parseEvictTargets(manifest).length > 0
  ) {
    return undefined;
  }
  const plan = readDesired(() => compileDesired(manifest));
  return plan === undefined ? undefined : { ...plan, runtimeKey: workload, kind: manifest.kind };
}

function preflightManagedProfile(
  plan: Parameters<NonNullable<ManagedLaunchAdmission["preflightProfile"]>>[0],
  opts: {
    authority: AdmissionAuthority;
    budget: number | undefined;
    workloadsDir: string;
    aliases: ReadonlySet<string>;
  },
): string | undefined {
  const { authority, budget, workloadsDir, aliases } = opts;
  if (!authority.isOperational()) return "AuthorityUnavailable";
  const claims = authority.snapshot();
  const victims = new Set(plan.victims);
  const planned = new Set([...plan.retained, ...plan.victims]);
  const unexpected = claims.find((row) => row.state !== "resident" || !planned.has(row.runtimeKey));
  if (unexpected !== undefined) return `ManagedUnplannedRuntime: ${unexpected.runtimeKey}`;
  for (const name of victims) {
    const row = claims.find((claim) => claim.runtimeKey === name);
    if (
      row?.state !== "resident" ||
      row.kind === undefined ||
      authority.prepareStopRelease(name, row.kind) === undefined
    ) {
      return `ManagedVictimUnverified: ${name}`;
    }
  }

  const projected: ManagedAdmissionClaim[] = claims.filter((row) => !victims.has(row.runtimeKey));
  for (const name of plan.replacements) {
    const incoming = profileReplacement(name, workloadsDir, aliases);
    if (incoming === undefined) return `ManagedReplacementSpecUnknown: ${name}`;
    const decision = evaluateManagedAdmission({ budgetGiB: budget, incoming, claims: projected });
    if (decision.kind === "refuse") return `${decision.reason}: ${decision.detail}`;
    if (decision.kind !== "admit") return `ManagedReplacementUnverified: ${name}`;
    projected.push({ ...incoming, state: "pending", claimId: `profile:${name}` });
  }
  return undefined;
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
  const desired = new AsyncLocalStorage<DesiredManifest>();
  const engineGate = new AsyncLocalStorage<ManagedEngineGate>();
  const measure =
    opts.readCapacity === undefined
      ? undefined
      : (): OwnerCapacity => physicalCapacity(opts, workloadsDir, aliases);
  const budgetGiB = (): number | undefined => {
    if (measure === undefined) return localBudget(opts, workloadsDir, aliases);
    const measured = measure();
    auditCapacity(opts, "reservation", measured);
    return "refusal" in measured ? undefined : measured.ledgerCeilingGiB;
  };
  mkdirSync(runtimeDir, { recursive: true });
  const runtime = await openLocalAdmissionRuntime({
    storePath: managedAdmissionStorePath(runtimeDir),
    requireExisting: opts.requireExistingStore,
    budgetGiB,
    readPidFile: (name) => {
      const key = { name };
      const run = server.readServerPid(key, resolved);
      const host =
        readModelHostState(key, resolved)?.pid ?? readModelHostStarting(key, resolved)?.pid;
      return run !== null && host !== undefined ? undefined : (run ?? host);
    },
  });
  const physical =
    measure === undefined ? undefined : ownerPhysicalPolicy(opts, measure, runtime.authority);
  const runOwnedLifecycle = <T>(run: () => T): T =>
    withManagedRuntimeMutation(
      runtimeDir,
      () =>
        opts.verifyJournalPair?.() === undefined &&
        runtime.authority.isOperational() &&
        (engineGate.getStore()?.mayEnter() ?? true),
      run,
    );
  const inspectRuntime = (): string | undefined =>
    opts.verifyJournalPair?.() ??
    (readDesired(() => verifyLocalInventory(resolved, runtime)) === true
      ? undefined
      : "ManagedRuntimeInventoryUnknown");
  const admission = createManagedLaunchAdmission({
    runOwnedLifecycle,
    authority: runtime.authority,
    capture: (_request, pid) => runtime.capture(pid),
    inspectRuntime,
    resolve: (request) =>
      resolveEnv().LOCAL_AI_RUNTIME_DIR === runtimeDir
        ? approveLaunch(request, workloadsDir, aliases, desired.getStore(), opts.nodeName)
        : undefined,
  });
  return {
    admission: {
      ...admission,
      ...(physical === undefined
        ? {}
        : { run: launchWithPhysicalGate(admission, physical, engineGate) }),
      ownsNode: (name) => aliases.has(name),
      ownerNodeId: opts.nodeName,
      preflightProfile(plan): string | undefined {
        const runtimeRefusal = inspectRuntime();
        if (runtimeRefusal !== undefined) return runtimeRefusal;
        const measured = physical?.measure();
        if (measured !== undefined) {
          auditCapacity(opts, "profile-preflight", measured);
          if ("refusal" in measured) return measured.refusal;
        }
        return preflightManagedProfile(plan, {
          authority: runtime.authority,
          budget: measured?.ledgerCeilingGiB ?? budgetGiB(),
          workloadsDir,
          aliases,
        });
      },
      async withDesiredManifest<T>(
        input: unknown,
        apply: (owned: boolean, budget?: ManagedApplyBudget) => Promise<T>,
      ): Promise<T> {
        const manifest = parseDesired(input);
        if (manifest === undefined || !aliases.has(manifest.spec.node)) return await apply(false);
        const name = manifest.metadata.name;
        if (existsSync(workloadPath(name, workloadsDir))) {
          const previous = readDesired(() => loadWorkloadByNameAny(name, workloadsDir));
          if (previous?.kind !== manifest.kind || !aliases.has(previous.spec.node)) {
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
    verifyActivation(): string | undefined {
      if (!runtime.authority.isOperational()) return "AuthorityUnavailable";
      const measured = physical?.measure();
      if (measured === undefined) {
        if (localBudget(opts, workloadsDir, aliases) === undefined) return "BudgetUnknown";
      } else {
        auditCapacity(opts, "bootstrap", measured);
        if ("refusal" in measured) return measured.refusal;
      }
      return inspectRuntime();
    },
  };
}
