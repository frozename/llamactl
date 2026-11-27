import type { ResidencyLeases } from "@llamactl/core/residency/leases";

import { z } from "zod";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { ModelRun } from "../workload/schema.js";
import type {
  ManagedAdmissionReadout,
  ManagedLaunchAdmission,
} from "./managed-launch-admission.js";

import { parseEvictTargets } from "../workload/apply.js";
import { liveLockHolder } from "../workload/lock.js";
import { MANAGED_BY_LABEL, ModelHostManifestSchema } from "../workload/modelhost-schema.js";
import { loadWorkloadByNameAny, withWorkloadsMutex } from "../workload/store.js";
import { managedProfileMemberProfiles } from "./managed-profile-selection.js";

export const residencyControlInput = z.strictObject({
  action: z.enum(["load", "unload"]),
  node: z.string().min(1),
  workload: ModelHostManifestSchema.shape.metadata.shape.name,
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

type Input = z.output<typeof residencyControlInput>;
type Manifest = ModelRun | ModelHostManifest;
type OperatorMode = "manual" | "profile";

type Target = {
  action: Input["action"];
  node: string;
  workload: string;
};

type ControlRefusal = { ok: false; reason: string; activeCount?: number };
type Execution = { ok: true } | ControlRefusal;

export type ResidencyControlResult = Target &
  ({ ok: true; outcome: "preview" | "completed" } | ControlRefusal);

const active = new Map<string, { mode: OperatorMode; count: number }>();

// Managed agent ownership excludes other processes. Within that process a
// manual stop must not invalidate a profile's retained-member proof.
export function enterManagedOperatorAction(
  node: string,
  mode: OperatorMode,
): (() => void) | undefined {
  const current = active.get(node);
  if (current !== undefined && (current.mode === "manual" || mode === "manual")) return undefined;
  const entry = current ?? { mode, count: 0 };
  active.set(node, entry);
  entry.count++;
  return () => {
    entry.count--;
    if (entry.count === 0) active.delete(node);
  };
}

function refuse(reason: string, activeCount?: number): ControlRefusal {
  return { ok: false, reason, ...(activeCount === undefined ? {} : { activeCount }) };
}

function readManifest(workload: string, dir: string): Manifest | undefined {
  try {
    return loadWorkloadByNameAny(workload, dir);
  } catch {
    return undefined;
  }
}

function loadRefusal(
  manifest: Manifest,
  status: ManagedAdmissionReadout,
): ControlRefusal | undefined {
  if (!manifest.spec.enabled) return refuse("WorkloadDisabled");
  if (parseEvictTargets(manifest).length > 0) return refuse("ManagedReplacementRequiresProfile");
  const profiles = managedProfileMemberProfiles(manifest.metadata.annotations);
  if (profiles.length > 0 && status.profile.kind !== "selected") return refuse("ProfileUnselected");
  if (
    status.profile.kind === "selected" &&
    profiles.length > 0 &&
    !profiles.includes(status.profile.profile)
  ) {
    return refuse("WorkloadOutsideProfile");
  }
  if (status.budgetGiB === null) return refuse("BudgetUnknown");
  const expected = manifest.spec.resources?.expectedMemoryGiB;
  if (expected === undefined || expected <= 0) return refuse("ManagedSpecUnknown");
  const held = status.claims.reduce((total, claim) => total + claim.allocationGiB, 0);
  if (held + expected > status.budgetGiB) return refuse("BudgetExceeded");
  return undefined;
}

function unloadRefusal(
  manifest: Manifest,
  claim: ManagedAdmissionReadout["claims"][number] | undefined,
  registry: ResidencyLeases,
): ControlRefusal | undefined {
  if (managedProfileMemberProfiles(manifest.metadata.annotations).length === 0) {
    return refuse("WorkloadProtected");
  }
  if (claim?.state !== "resident" || claim.kind !== manifest.kind) {
    return refuse("ManagedResidentUnverified");
  }
  const snapshot = registry.snapshot(manifest.metadata.name);
  if (snapshot.active.length > 0) return refuse("LeasesActive", snapshot.active.length);
  if (snapshot.phase === "draining") return refuse("DrainInProgress");
  if (snapshot.phase !== "open") return refuse("ManagedResidentUnverified");
  if (claim.inferenceHold !== "clear") return refuse("ManagedInferenceUnresolved");
  return undefined;
}

function actionRefusal(
  action: Input["action"],
  manifest: Manifest,
  status: ManagedAdmissionReadout,
  registry: ResidencyLeases,
): ControlRefusal | undefined {
  if (status.ledger !== "available") return refuse("AuthorityUnavailable");
  if (status.profile.kind === "switching") return refuse("NodeBusy");
  if (status.profile.kind === "unknown") return refuse("ProfileUnverified");
  const claim = status.claims.find((entry) => entry.workload === manifest.metadata.name);
  if (action === "unload") return unloadRefusal(manifest, claim, registry);
  if (claim?.state === "resident") return refuse("ManagedRuntimeResident");
  if (claim !== undefined) return refuse("ManagedClaimUnsettled");
  return loadRefusal(manifest, status);
}

interface ControlOptions {
  managed: ManagedLaunchAdmission | undefined;
  registry: ResidencyLeases | null;
  workloadsDir: string;
  signal?: AbortSignal | undefined;
  execute: (action: Input["action"], manifest: Manifest) => Promise<Execution>;
}

export async function controlManagedResidency(
  input: Input,
  opts: ControlOptions,
): Promise<ResidencyControlResult> {
  const { action, node, workload } = input;
  const request = { action, node, workload };
  const { managed, registry, workloadsDir } = opts;
  if (!input.dryRun && !input.confirm) return { ...request, ...refuse("ConfirmationRequired") };
  if (
    registry === null ||
    managed?.ownerNodeId === undefined ||
    managed.ownsNode === undefined ||
    managed.readStatus === undefined ||
    managed.runOwnedLifecycle === undefined ||
    managed.prepareStopRelease === undefined
  ) {
    return { ...request, ...refuse("ManagedControlUnavailable") };
  }
  if (!managed.ownsNode(node)) return { ...request, ...refuse("NotServingNode") };

  const run = (): Promise<ResidencyControlResult> =>
    inspectControl(
      input,
      opts,
      { ...request, node: managed.ownerNodeId ?? node },
      managed,
      registry,
    );

  if (input.dryRun) return await run();
  const leave = enterManagedOperatorAction(managed.ownerNodeId, "manual");
  if (leave === undefined) return { ...request, ...refuse("NodeBusy") };
  try {
    return await withWorkloadsMutex(workloadsDir, run);
  } finally {
    leave();
  }
}

async function inspectControl(
  input: Input,
  opts: ControlOptions,
  target: Target,
  managed: ManagedLaunchAdmission,
  registry: ResidencyLeases,
): Promise<ResidencyControlResult> {
  if (opts.signal?.aborted === true) return { ...target, ...refuse("ControlCanceled") };
  const manifest = readManifest(target.workload, opts.workloadsDir);
  if (manifest?.metadata.name !== target.workload) {
    return { ...target, ...refuse("WorkloadUnavailable") };
  }
  if (managed.ownsNode?.(manifest.spec.node) !== true) {
    return { ...target, ...refuse("WorkloadNotOwned") };
  }
  if (manifest.metadata.labels?.[MANAGED_BY_LABEL]?.trim()) {
    return { ...target, ...refuse("WorkloadExternallyManaged") };
  }
  const status = managed.readStatus?.();
  if (status?.ownerNodeId !== target.node) return { ...target, ...refuse("AuthorityUnavailable") };
  const blocked = actionRefusal(target.action, manifest, status, registry);
  if (blocked !== undefined) return { ...target, ...blocked };
  if (input.dryRun) return { ...target, ok: true, outcome: "preview" };
  if (liveLockHolder(opts.workloadsDir) !== null) {
    return { ...target, ...refuse("ControllerActive") };
  }

  try {
    const outcome = await opts.execute(target.action, manifest);
    return outcome.ok ? { ...target, ok: true, outcome: "completed" } : { ...target, ...outcome };
  } catch {
    return {
      ...target,
      ...refuse(target.action === "load" ? "LoadUnconfirmed" : "UnloadUnconfirmed"),
    };
  }
}
