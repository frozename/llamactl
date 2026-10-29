import type { ResolvedEnv } from "@llamactl/core";

import {
  type AdmissionReservation,
  admitAgainstFiniteBudget,
  capacityBudgetGiB,
} from "@llamactl/core/residency/admission";
import { totalmem } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { readdirSync, statSync } from "../safe-fs.js";

const MODEL_HOST_MEMORY_HEURISTIC_MULTIPLIER = 2;

export interface AdmissionInput {
  nodeName: string;
  /** null means the budget could not be verified — never Infinity. */
  nodeBudgetGiB: number | null;
  livingManifests: ModelRun[];
  incoming: ModelRun;
  forceAdmit: boolean;
  /** Alias-aware node equality; defaults to name equality. */
  sameNode?: (otherNode: string) => boolean;
}

export interface ReservationBreakdownItem {
  name: string;
  expectedMemoryGiB: number;
}

export type AdmissionResult =
  | { ok: true; reservedAfter: number; budget: number | null }
  | {
      ok: false;
      kind: "invalid-reservation";
      invalid: AdmissionReservation[];
      reason: string;
    }
  | {
      ok: false;
      kind: "unknown-budget";
      reservedAfter: number;
      reason: string;
    }
  | {
      ok: false;
      kind: "over-budget";
      reservedAfter: number;
      budget: number;
      reason: string;
      breakdown: ReservationBreakdownItem[];
    };

export function reservedForNodeBreakdown(
  manifests: ModelRun[],
  nodeName: string,
  sameNode: (otherNode: string) => boolean = (other) => other === nodeName,
): ReservationBreakdownItem[] {
  const items: ReservationBreakdownItem[] = [];
  for (const m of manifests) {
    if (!sameNode(m.spec.node)) continue;
    if (!m.spec.enabled) continue;
    const expectedMemoryGiB = m.spec.resources?.expectedMemoryGiB ?? 0;
    if (expectedMemoryGiB > 0) items.push({ name: m.metadata.name, expectedMemoryGiB });
  }
  return items;
}

export function sumReservedForNode(manifests: ModelRun[], nodeName: string): number {
  return reservedForNodeBreakdown(manifests, nodeName).reduce(
    (sum, item) => sum + item.expectedMemoryGiB,
    0,
  );
}

export function defaultNodeBudgetGiB(
  nodeBudgetFromManifest?: number,
  nodeMemBytes?: number | null,
): number {
  if (typeof nodeBudgetFromManifest === "number") return nodeBudgetFromManifest;
  if (typeof nodeMemBytes === "number" && Number.isFinite(nodeMemBytes) && nodeMemBytes > 0) {
    return capacityBudgetGiB(nodeMemBytes);
  }
  return capacityBudgetGiB(totalmem());
}

function formatAdmissionBreakdown(
  nodeName: string,
  budget: number,
  incoming: ReservationBreakdownItem,
  living: ReservationBreakdownItem[],
  reservedAfter: number,
): string {
  const livingDesc =
    living.length > 0
      ? living.map((i) => `'${i.name}' ${i.expectedMemoryGiB.toFixed(1)} GiB`).join(", ")
      : "(none)";
  return [
    `node '${nodeName}' would reserve ${reservedAfter.toFixed(1)} GiB after adding '${incoming.name}' (${incoming.expectedMemoryGiB.toFixed(1)} GiB) to existing: ${livingDesc}`,
    `Budget is ${budget.toFixed(1)} GiB`,
    `the llamactl.io/force-admit annotation (set by apply --force) is the explicit legacy override that admits past this budget; free capacity with --evict <name> or raise the node budget (NodeRun spec.budget.memoryGiB, default 75% of total RAM)`,
  ].join(". ");
}

function formatInvalidReservationReason(nodeName: string, invalid: AdmissionReservation[]): string {
  const names = invalid.map((i) => `'${i.name}' (${String(i.expectedMemoryGiB)})`).join(", ");
  return [
    `node '${nodeName}' has invalid reservation quantities: ${names}`,
    `expectedMemoryGiB must be a finite non-negative number; refusing to sum NaN or infinities into the accounting`,
    `Correct spec.resources.expectedMemoryGiB in the named manifests. The llamactl.io/force-admit annotation overrides a finite budget, it does not launder an invalid quantity`,
  ].join(". ");
}

function formatUnknownBudgetReason(
  nodeName: string,
  incoming: ReservationBreakdownItem,
  reservedAfter: number,
): string {
  return [
    `node '${nodeName}' memory budget is unknown; refusing to charge '${incoming.name}' (${incoming.expectedMemoryGiB.toFixed(1)} GiB) against it (declared reservations after this workload: ${reservedAfter.toFixed(1)} GiB)`,
    `Declare a budget with NodeRun spec.budget.memoryGiB, or make the target node's reported memory reachable (llamactl node test ${nodeName})`,
    `The llamactl.io/force-admit annotation is the explicit escape hatch`,
  ].join(". ");
}

export function computeNodeBudget(input: AdmissionInput): AdmissionResult {
  const livingItems = reservedForNodeBreakdown(
    input.livingManifests,
    input.nodeName,
    input.sameNode,
  );
  const incomingMemory = input.incoming.spec.resources?.expectedMemoryGiB ?? 0;
  const incomingItem = { name: input.incoming.metadata.name, expectedMemoryGiB: incomingMemory };
  const decision = admitAgainstFiniteBudget({
    budgetGiB: input.nodeBudgetGiB,
    living: livingItems satisfies AdmissionReservation[],
    incoming: incomingItem,
    forceAdmit: input.forceAdmit,
  });
  if (decision.ok) {
    return { ok: true, reservedAfter: decision.reservedAfterGiB, budget: decision.budgetGiB };
  }
  if (decision.kind === "invalid-reservation") {
    return {
      ok: false,
      kind: "invalid-reservation",
      invalid: decision.invalid,
      reason: formatInvalidReservationReason(input.nodeName, decision.invalid),
    };
  }
  if (decision.kind === "unknown-budget") {
    return {
      ok: false,
      kind: "unknown-budget",
      reservedAfter: decision.reservedAfterGiB,
      reason: formatUnknownBudgetReason(input.nodeName, incomingItem, decision.reservedAfterGiB),
    };
  }
  return {
    ok: false,
    kind: "over-budget",
    reservedAfter: decision.reservedAfterGiB,
    budget: decision.budgetGiB,
    reason: formatAdmissionBreakdown(
      input.nodeName,
      decision.budgetGiB,
      incomingItem,
      livingItems,
      decision.reservedAfterGiB,
    ),
    breakdown: decision.contributors,
  };
}

export function estimateWorkloadMemoryGiB(
  manifest: ModelRun,
  resolved: ResolvedEnv,
): number | null {
  if (manifest.spec.gateway) return null;
  if (manifest.spec.target.kind !== "rel") return null;
  const ggufPath = join(resolved.LLAMA_CPP_MODELS, manifest.spec.target.value);
  try {
    const sz = statSync(ggufPath).size;
    return (sz * 1.1) / 1024 ** 3;
  } catch {
    return null;
  }
}

function pathSizeBytes(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path)) {
    total += pathSizeBytes(join(path, entry));
  }
  return total;
}

export function estimateModelHostMemoryGiB(
  manifest: ModelHostManifest,
  resolved: ResolvedEnv,
): number | null {
  const declared = manifest.spec.resources?.expectedMemoryGiB;
  if (declared !== undefined) return declared;
  const rel = manifest.spec.hostedModels[0]?.rel;
  if (!rel) return null;
  try {
    return (
      (pathSizeBytes(join(resolved.LLAMA_CPP_MODELS, rel)) *
        MODEL_HOST_MEMORY_HEURISTIC_MULTIPLIER) /
      1024 ** 3
    );
  } catch {
    return null;
  }
}
