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
import { memoryCalibrationKey } from "@llamactl/core/resources/memory";
import {
  listWorkloadDirs,
  listWorkloadRoutes,
  workloadRuntimeDir,
} from "@llamactl/core/workloadRuntime";
import {
  measuredCalibrationStorePath,
  readMeasuredMemoryCalibrationStrict,
} from "@llamactl/fleet-supervisor/measured-memory";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  AdmissionAuthority,
  AdmitRequest,
  AuthorityClaimRow,
  ManagedStopProof,
  ValidateParkedCredit,
} from "./admission-authority.js";
import type { NativeWakeLimits } from "./admission-store.js";
import type { InferenceHolds, InferenceHoldState } from "./inference-holds.js";

import { existsSync, mkdirSync, readFileSync, statSync } from "../safe-fs.js";
import { modelHostCalibrationLaunch, pinModelHostStartup } from "../server/modelhost.js";
import {
  declaredModelHostMemoryGiB,
  DEFAULT_MEASURED_ENVELOPE_MAX_AGE_MS,
  measuredEnvelopeAdmissibility,
} from "../workload/admission.js";
import { modelRunStartInvocation, parseEvictTargets } from "../workload/apply.js";
import {
  modelHostExternalBindHost,
  ModelHostManifestSchema,
} from "../workload/modelhost-schema.js";
import { loadNodeRunByName, nodeRunPath } from "../workload/noderun-store.js";
import { ModelRunSchema } from "../workload/schema.js";
import { defaultWorkloadsDir, loadWorkloadByNameAny, workloadPath } from "../workload/store.js";
import {
  type CalibratableLaunch,
  deriveManagedLaunchCalibrationKey,
} from "./launch-calibration.js";
import {
  createManagedLaunchAdmission,
  type ManagedAdmissionReadout,
  type ManagedApplyBudget,
  type ManagedCalibrationReadout,
  type ManagedLaunchAdmission,
  type ManagedLaunchRequest,
  type ManagedProfileWorkloadObservation,
} from "./managed-launch-admission.js";
import {
  evaluateManagedProfileStart,
  managedProfileLaunchRefusal,
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
  inferenceHolds?: InferenceHolds;
  validateParkedCredit?: ValidateParkedCredit | undefined;
  aroundOwnedLifecycle?: (<T>(run: () => T) => T) | undefined;
}

function unresolvedInference(state: InferenceHoldState | undefined): boolean {
  return state === "prior" || state === "unknown";
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

type CapacityPhase =
  | "bootstrap"
  | "profile-preflight"
  | "reservation"
  | "launch"
  | "engine-entry"
  | "spawn";

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
  const cgroupLimit = sample.scope.kind === "cgroup-v2" ? sample.scope.limitBytes : null;
  const scope = cgroupLimit === null ? host : cgroupLimit / GiB;
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
    phase: "launch" | "engine-entry" | "spawn",
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
    admission.run(request, signal, async (commit, checkSpawn) => {
      const refusal = physical.checkLaunch(request, "launch");
      if (refusal !== undefined) return { ran: false, detail: refusal };
      const gate = preLaunchGate(physical, request);
      const result = await engineGate.run(gate, () =>
        start(commit, () => physical.checkLaunch(request, "spawn") ?? checkSpawn?.()),
      );
      // A refusal at the first managed runtime mutation proves no engine ran.
      return gate.refusal === undefined ? result : { ran: false, detail: gate.refusal };
    });
}

type ApprovedPlan = Pick<AdmitRequest, "specDigest" | "allocationGiB"> & {
  measuredCalibrationDigest?: string;
  calibration?: ManagedCalibrationReadout;
};
type DesiredManifest = ReturnType<typeof loadWorkloadByNameAny>;
type PlanRefusal = { refusal: string };

type PlanCompiler = (
  manifest: DesiredManifest,
  describe?: boolean,
) => ApprovedPlan | PlanRefusal | undefined;

interface CalibrationOptions {
  ownerNodeId: string;
  path: string;
  nowMs: () => number;
}

function calibrationStoreState(path: string): "missing" | "present" | "unavailable" {
  try {
    return statSync(path).isFile() ? "present" : "unavailable";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "missing"
      : "unavailable";
  }
}

function calibratedPlan(
  declaredGiB: number,
  specDigest: string,
  getLaunch: () => CalibratableLaunch | undefined,
  opts: CalibrationOptions,
  describe: boolean,
): ApprovedPlan | PlanRefusal {
  const declared = { allocationGiB: declaredGiB, specDigest };
  const store = calibrationStoreState(opts.path);
  if (!describe && store === "missing") return declared;
  const launch = readDesired(getLaunch);
  if (launch === undefined) return declared;
  const key = deriveManagedLaunchCalibrationKey(launch, opts.ownerNodeId);
  if (key === undefined) return declared;
  const candidateKey = memoryCalibrationKey(key);
  if (candidateKey === null) return declared;
  if (store === "unavailable") return { refusal: "ManagedCalibrationStoreUnavailable" };
  const envelope =
    store === "missing"
      ? null
      : readDesired(() => readMeasuredMemoryCalibrationStrict(candidateKey, opts.path));
  if (envelope === undefined) return { refusal: "ManagedCalibrationStoreUnavailable" };
  const use =
    envelope === null
      ? undefined
      : measuredEnvelopeAdmissibility({
          envelope,
          candidateKey,
          nowMs: opts.nowMs(),
          maxAgeMs: DEFAULT_MEASURED_ENVELOPE_MAX_AGE_MS,
        });
  const allocationGiB = use?.usable ? Math.max(declaredGiB, use.envelopeBytes / GiB) : declaredGiB;
  return {
    allocationGiB,
    specDigest,
    calibration: { key, declaredGiB, allocationGiB, measured: use?.usable === true },
    ...(use?.usable ? { measuredCalibrationDigest: key.managedLaunchDigest } : {}),
  };
}

function compileDesired(
  manifest: DesiredManifest,
  calibration: CalibrationOptions,
  describe = false,
): ApprovedPlan | PlanRefusal | undefined {
  if (manifest.kind === "ModelHost") {
    if (modelHostExternalBindHost(manifest.spec) !== null)
      return { refusal: "ManagedExternalBindUnavailable" };
    const allocationGiB = declaredModelHostMemoryGiB(manifest);
    if (allocationGiB === null || allocationGiB <= 0) return undefined;
    const pinned = pinModelHostStartup(manifest);
    return calibratedPlan(
      allocationGiB,
      pinned.effectiveSpecDigest,
      () => modelHostCalibrationLaunch(pinned),
      calibration,
      describe,
    );
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
  const resolved = resolveEnv();
  const prepared = server.prepareManagedServerStart({ ...opts, resolved, key: { name: workload } });
  if ("result" in prepared) return undefined;
  // A retry can drop the explicit --host and fall back to the endpoint.
  const fallback = opts.endpoint?.host ?? resolved.LLAMA_CPP_HOST;
  if (server.hostBindRefusal(["--host", fallback, ...prepared.launch.args], undefined, false))
    return { refusal: "ManagedExternalBindUnavailable" };
  return calibratedPlan(
    allocationGiB,
    prepared.effectiveSpecDigest,
    () => ({ ...prepared.launch, engine: "llamacpp", env: process.env }),
    calibration,
    describe,
  );
}

function approveLaunch(
  request: ManagedLaunchRequest,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
  pending: DesiredManifest | undefined,
  nodeName: string,
  compile: PlanCompiler,
): ApprovedPlan | PlanRefusal | undefined {
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
  const approved = readDesired(() => compile(manifest));
  if (approved !== undefined && "refusal" in approved) return approved;
  if (approved?.specDigest !== request.effectiveSpecDigest) return undefined;
  const profiles = managedProfileMemberProfiles(manifest.metadata.annotations);
  if (profiles.length === 0) return approved;
  const selected = readManagedProfileSelection(defaultResidencyStorePath(), nodeName);
  const decision = evaluateManagedProfileStart(selected, profiles, managedProfilePermit());
  return decision.ok ? approved : { refusal: decision.reason };
}

function allowsProfileServing(
  nodeName: string,
  aliases: ReadonlySet<string>,
  workloadsDir: string,
  workload: string,
): boolean {
  const manifest = readDesired(() => loadWorkloadByNameAny(workload, workloadsDir));
  if (manifest === undefined || !manifest.spec.enabled || !aliases.has(manifest.spec.node))
    return false;
  const profiles = managedProfileMemberProfiles(manifest.metadata.annotations);
  if (profiles.length === 0) return true;
  const selection = readManagedProfileSelection(defaultResidencyStorePath(), nodeName);
  return evaluateManagedProfileStart(selection, profiles).ok;
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
  compile: PlanCompiler,
): ManagedApplyBudget | undefined {
  if (!manifest.spec.enabled) return undefined;
  if (budgetGiB === undefined || !Number.isFinite(budgetGiB) || budgetGiB <= 0) {
    throw new Error("BudgetUnknown: managed apply requires a finite target budget");
  }
  const approved = compile(manifest);
  if (approved === undefined)
    throw new Error("ManagedSpecUnknown: managed apply cannot pin this manifest");
  if ("refusal" in approved) throw new Error(approved.refusal);
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
  compile: PlanCompiler,
): (ApprovedPlan & { runtimeKey: string; kind: ManagedWorkloadKind }) | PlanRefusal {
  const manifest = readDesired(() => loadWorkloadByNameAny(workload, workloadsDir));
  if (
    manifest === undefined ||
    !aliases.has(manifest.spec.node) ||
    !manifest.spec.enabled ||
    parseEvictTargets(manifest).length > 0
  ) {
    return { refusal: `ManagedReplacementSpecUnknown: ${workload}` };
  }
  const plan = readDesired(() => compile(manifest));
  if (plan === undefined) return { refusal: `ManagedReplacementSpecUnknown: ${workload}` };
  if ("refusal" in plan) return { refusal: `${plan.refusal}: ${workload}` };
  return { ...plan, runtimeKey: workload, kind: manifest.kind };
}

function preflightManagedProfile(
  plan: Parameters<NonNullable<ManagedLaunchAdmission["preflightProfile"]>>[0],
  opts: {
    authority: AdmissionAuthority;
    budget: number | undefined;
    workloadsDir: string;
    aliases: ReadonlySet<string>;
    compile: PlanCompiler;
  },
): string | undefined {
  const { authority, budget, workloadsDir, aliases, compile } = opts;
  if (!authority.isOperational()) return "AuthorityUnavailable";
  const claims = authority.snapshot();
  const victims = new Set(plan.victims);
  const planned = new Set([...plan.retained, ...plan.victims]);
  const unexpected = claims.find((row) => row.state !== "resident" || !planned.has(row.runtimeKey));
  if (unexpected !== undefined) return `ManagedUnplannedRuntime: ${unexpected.runtimeKey}`;
  const unverifiedVictim = plan.victims.find((name) => {
    const row = claims.find((claim) => claim.runtimeKey === name);
    return (
      row?.state !== "resident" ||
      row.kind === undefined ||
      authority.prepareStopRelease(name, row.kind) === undefined
    );
  });
  if (unverifiedVictim !== undefined) return `ManagedVictimUnverified: ${unverifiedVictim}`;

  const unverifiedRetained = plan.retained.find(
    (name) => !claims.some((row) => row.runtimeKey === name && verifiedResident(row, authority)),
  );
  if (unverifiedRetained !== undefined) return `ManagedRetainedUnverified: ${unverifiedRetained}`;

  const projected: ManagedAdmissionClaim[] = claims.filter((row) => !victims.has(row.runtimeKey));
  for (const name of plan.replacements) {
    const incoming = profileReplacement(name, workloadsDir, aliases, compile);
    if ("refusal" in incoming) return incoming.refusal;
    const decision = evaluateManagedAdmission({ budgetGiB: budget, incoming, claims: projected });
    if (decision.kind === "refuse") return `${decision.reason}: ${decision.detail}`;
    if (decision.kind !== "admit") return `ManagedReplacementUnverified: ${name}`;
    projected.push({ ...incoming, state: "pending", claimId: `profile:${name}` });
  }
  return undefined;
}

function profileWorkload(
  opts: NodeManagedAdmissionOptions,
  resolved: ReturnType<typeof resolveEnv>,
  authority: AdmissionAuthority,
  workload: string,
  kind: ManagedWorkloadKind,
): ManagedProfileWorkloadObservation | undefined {
  const unknown = { state: "unknown" } as const;
  if (
    opts.verifyJournalPair?.() !== undefined ||
    !authority.isOperational() ||
    unresolvedInference(opts.inferenceHolds?.state(workload))
  ) {
    return unknown;
  }
  const claim = authority.snapshot().find((row) => row.runtimeKey === workload);
  if (claim === undefined) return undefined;
  if (claim.kind !== kind || claim.state !== "resident" || claim.native !== undefined)
    return unknown;
  const proof = authority.prepareStopRelease(workload, kind);
  const pid = claim.generations.at(-1)?.pid;
  if (proof === undefined || pid === undefined || proof.verifyGeneration(pid) !== "alive")
    return unknown;
  const routes = readDesired(() => listWorkloadRoutes(resolved, workload));
  return routes?.some((route) => route.kind === kind && route.pid === pid)
    ? { state: "running", allocationGiB: claim.allocationGiB }
    : unknown;
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

function managedReadout(
  opts: NodeManagedAdmissionOptions,
  authority: AdmissionAuthority,
  budgetGiB: () => number | undefined,
): ManagedAdmissionReadout {
  const operational = opts.verifyJournalPair?.() === undefined && authority.isOperational();
  const selection = operational
    ? readManagedProfileSelection(defaultResidencyStorePath(), opts.nodeName)
    : { kind: "unknown" as const };
  return {
    ownerNodeId: opts.nodeName,
    ledger: operational ? "available" : "unavailable",
    profile:
      selection.kind === "selected"
        ? { kind: selection.kind, profile: selection.profile }
        : { kind: selection.kind },
    budgetGiB: operational ? (budgetGiB() ?? null) : null,
    claims: operational
      ? authority.snapshot().map((claim) => ({
          workload: claim.runtimeKey,
          kind: claim.kind ?? null,
          state: claim.state,
          allocationGiB: claim.allocationGiB,
          ...(opts.inferenceHolds === undefined
            ? {}
            : { inferenceHold: opts.inferenceHolds.state(claim.runtimeKey) }),
        }))
      : [],
  };
}

function verifyManagedDesiredOwner(
  manifest: DesiredManifest,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
  inferenceHolds: InferenceHolds | undefined,
): void {
  const name = manifest.metadata.name;
  if (unresolvedInference(inferenceHolds?.state(name)))
    throw new Error("ManagedInferenceUnresolved");
  if (!existsSync(workloadPath(name, workloadsDir))) return;
  const previous = readDesired(() => loadWorkloadByNameAny(name, workloadsDir));
  if (previous?.kind !== manifest.kind || !aliases.has(previous.spec.node)) {
    throw new Error("ManagedManifestConflict: the stored workload has a different owner or kind");
  }
}

function stopWithInferenceFence(
  authority: AdmissionAuthority,
  holds: InferenceHolds | undefined,
): NonNullable<ManagedLaunchAdmission["prepareStopRelease"]> {
  return (workload, kind): ManagedStopProof | undefined => {
    const clear = (): boolean => holds === undefined || holds.state(workload) === "clear";
    const proof = clear() ? authority.prepareStopRelease(workload, kind) : undefined;
    return proof === undefined
      ? undefined
      : {
          ...proof,
          verifyGeneration: (pid) => (clear() ? proof.verifyGeneration(pid) : "unknown"),
        };
  };
}

type ColdResidentGeneration = { pid: number; runtimeGeneration: string };
type ColdResidentReader = (
  workload: string,
  specDigest: string,
) => ColdResidentGeneration | undefined;

function coldResidentReader(
  resolved: ReturnType<typeof resolveEnv>,
  runtime: LocalAdmissionRuntime,
  verifyJournalPair: NodeManagedAdmissionOptions["verifyJournalPair"],
): ColdResidentReader {
  return (workload, specDigest): ColdResidentGeneration | undefined => {
    if (verifyJournalPair?.() !== undefined || !runtime.authority.isOperational()) return undefined;
    const resident = runtime.authority
      .snapshot()
      .find(
        (row) =>
          row.runtimeKey === workload &&
          row.kind === "ModelRun" &&
          row.state === "resident" &&
          row.specDigest === specDigest,
      );
    const generation = resident?.generations.at(-1);
    if (resident === undefined || generation?.birthId === undefined) return undefined;
    const live = runtime.capture(generation.pid);
    if (
      live?.birthId !== generation.birthId ||
      server.readServerPid({ name: workload }, resolved) !== generation.pid
    )
      return undefined;
    return {
      pid: generation.pid,
      runtimeGeneration: createHash("sha256")
        .update(JSON.stringify([resident.claimId, resident.generationVersion, generation.birthId]))
        .digest("hex"),
    };
  };
}

function readManagedRuntimePid(
  resolved: ReturnType<typeof resolveEnv>,
  name: string,
): number | undefined {
  const key = { name };
  const run = server.readServerPid(key, resolved);
  const host = readModelHostState(key, resolved)?.pid ?? readModelHostStarting(key, resolved)?.pid;
  return run !== null && host !== undefined ? undefined : (run ?? host);
}

function readOwnedCalibration(
  compile: PlanCompiler,
  workloadsDir: string,
  aliases: ReadonlySet<string>,
  workload: string,
): ManagedCalibrationReadout | undefined {
  const manifest = readDesired(() => loadWorkloadByNameAny(workload, workloadsDir));
  if (
    manifest?.metadata.name !== workload ||
    !manifest.spec.enabled ||
    !aliases.has(manifest.spec.node)
  ) {
    return undefined;
  }
  const plan = readDesired(() => compile(manifest, true));
  return plan === undefined || "refusal" in plan ? undefined : plan.calibration;
}

function planCompiler(ownerNodeId: string, nowMs: () => number): PlanCompiler {
  const calibration = { ownerNodeId, path: measuredCalibrationStorePath(), nowMs };
  return (manifest, describe) => compileDesired(manifest, calibration, describe);
}

interface NodeManagedAdmission {
  admission: ManagedLaunchAdmission;
  authority: AdmissionAuthority;
  readColdResidentGeneration: ColdResidentReader;
  readNativeWakeLimits(): NativeWakeLimits | undefined;
  verifyActivation(): string | undefined;
}

function verifyManagedActivation(
  opts: NodeManagedAdmissionOptions,
  authority: AdmissionAuthority,
  physical: PhysicalPolicy | undefined,
  budgetGiB: () => number | undefined,
  inspectRuntime: () => string | undefined,
): string | undefined {
  if (!authority.isOperational()) return "AuthorityUnavailable";
  const measured = physical?.measure();
  if (measured === undefined) {
    if (budgetGiB() === undefined) return "BudgetUnknown";
  } else {
    auditCapacity(opts, "bootstrap", measured);
    if ("refusal" in measured) return measured.refusal;
  }
  return inspectRuntime();
}

function readNativeWakeLimits(
  opts: NodeManagedAdmissionOptions,
  physical: PhysicalPolicy | undefined,
  inspectAllocation: () => string | undefined,
): NativeWakeLimits | undefined {
  if (inspectAllocation() !== undefined) return undefined;
  const measured = physical?.measure();
  if (measured === undefined) return undefined;
  auditCapacity(opts, "launch", measured);
  return "refusal" in measured ? undefined : measured;
}

export async function openNodeManagedAdmission(
  opts: NodeManagedAdmissionOptions,
): Promise<NodeManagedAdmission> {
  const resolved = resolveEnv();
  const runtimeDir = resolved.LOCAL_AI_RUNTIME_DIR;
  const workloadsDir = opts.workloadsDir ?? defaultWorkloadsDir();
  const aliases = new Set([opts.nodeName, ...(opts.aliases ?? [])]);
  const compile = planCompiler(opts.nodeName, opts.nowMs ?? Date.now);
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
    readPidFile: (name) => readManagedRuntimePid(resolved, name),
    nativeAllocationFence: {
      verifyOwner: () => opts.verifyJournalPair?.() === undefined,
      validateParkedCredit: opts.validateParkedCredit,
    },
  });
  const { authority } = runtime;
  const physical =
    measure === undefined ? undefined : ownerPhysicalPolicy(opts, measure, runtime.authority);
  const runOwnedLifecycle = <T>(run: () => T): T =>
    withManagedRuntimeMutation(
      runtimeDir,
      () =>
        opts.verifyJournalPair?.() === undefined &&
        runtime.authority.isOperational() &&
        (engineGate.getStore()?.mayEnter() ?? true),
      () => (opts.aroundOwnedLifecycle === undefined ? run() : opts.aroundOwnedLifecycle(run)),
    );
  const inspectRuntime = (): string | undefined =>
    opts.verifyJournalPair?.() ?? managedInventoryRefusal(resolved, runtime);
  const inspectAllocation = (): string | undefined =>
    inspectRuntime() ?? authority.nativeAllocationRefusal();
  const admission = createManagedLaunchAdmission({
    runOwnedLifecycle,
    authority,
    capture: (_request, pid) => runtime.capture(pid),
    inspectRuntime: inspectAllocation,
    resolve: (request) => {
      const profileRefusal = authority.nativeAllocationRefusal() ?? managedProfileLaunchRefusal();
      if (profileRefusal !== undefined) return { refusal: profileRefusal };
      if (unresolvedInference(opts.inferenceHolds?.state(request.runtimeKey))) {
        return { refusal: "ManagedInferenceUnresolved" };
      }
      return resolveEnv().LOCAL_AI_RUNTIME_DIR === runtimeDir
        ? approveLaunch(request, workloadsDir, aliases, desired.getStore(), opts.nodeName, compile)
        : undefined;
    },
  });
  return {
    admission: {
      ...admission,
      prepareStopRelease: stopWithInferenceFence(runtime.authority, opts.inferenceHolds),
      ...(physical === undefined
        ? {}
        : { run: launchWithPhysicalGate(admission, physical, engineGate) }),
      ownsNode: (name) => aliases.has(name),
      ownerNodeId: opts.nodeName,
      readStatus: () => managedReadout(opts, runtime.authority, budgetGiB),
      readCalibration: readOwnedCalibration.bind(null, compile, workloadsDir, aliases),
      allowsManagedServing: (workload) =>
        opts.verifyJournalPair?.() === undefined && authority.allowsServing(workload),
      allowsProfileServing: (workload) =>
        allowsProfileServing(opts.nodeName, aliases, workloadsDir, workload),
      observeProfileWorkload: profileWorkload.bind(null, opts, resolved, runtime.authority),
      preflightProfile(plan): string | undefined {
        const runtimeRefusal = inspectAllocation();
        if (runtimeRefusal !== undefined) return runtimeRefusal;
        const unresolved = plan.victims.find((name) =>
          unresolvedInference(opts.inferenceHolds?.state(name)),
        );
        if (unresolved !== undefined) return `ManagedInferenceUnresolved: ${unresolved}`;
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
          compile,
        });
      },
      async withDesiredManifest<T>(
        input: unknown,
        apply: (owned: boolean, budget?: ManagedApplyBudget) => Promise<T>,
      ): Promise<T> {
        const manifest = parseDesired(input);
        if (manifest === undefined || !aliases.has(manifest.spec.node)) return await apply(false);
        verifyManagedDesiredOwner(manifest, workloadsDir, aliases, opts.inferenceHolds);
        const inventoryError = manifest.spec.enabled ? inspectAllocation() : undefined;
        if (inventoryError !== undefined) throw new Error(inventoryError);
        const budget = checkManagedApply(manifest, runtime.authority, budgetGiB(), compile);
        return await desired.run(manifest, () => apply(true, budget));
      },
    },
    authority,
    readColdResidentGeneration: coldResidentReader(resolved, runtime, opts.verifyJournalPair),
    readNativeWakeLimits: () => readNativeWakeLimits(opts, physical, inspectAllocation),
    verifyActivation: () =>
      verifyManagedActivation(opts, authority, physical, budgetGiB, inspectRuntime),
  };
}

function managedInventoryRefusal(
  resolved: ReturnType<typeof resolveEnv>,
  runtime: LocalAdmissionRuntime,
): string | undefined {
  return readDesired(() => verifyLocalInventory(resolved, runtime)) === true
    ? undefined
    : "ManagedRuntimeInventoryUnknown";
}
