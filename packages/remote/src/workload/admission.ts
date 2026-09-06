import type { ResolvedEnv } from "@llamactl/core";

import { totalmem } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { readdirSync, statSync } from "../safe-fs.js";

const MODEL_HOST_MEMORY_HEURISTIC_MULTIPLIER = 2;

export interface AdmissionInput {
  nodeName: string;
  nodeBudgetGiB: number;
  livingManifests: ModelRun[];
  incoming: ModelRun;
  forceAdmit: boolean;
}

export interface ReservationBreakdownItem {
  name: string;
  expectedMemoryGiB: number;
}

export type AdmissionResult =
  | { ok: true; reservedAfter: number; budget: number }
  | {
      ok: false;
      reservedAfter: number;
      budget: number;
      reason: string;
      breakdown: ReservationBreakdownItem[];
    };

export function reservedForNodeBreakdown(
  manifests: ModelRun[],
  nodeName: string,
): ReservationBreakdownItem[] {
  const items: ReservationBreakdownItem[] = [];
  for (const m of manifests) {
    if (m.spec.node !== nodeName) continue;
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

export function defaultNodeBudgetGiB(nodeBudgetFromManifest?: number): number {
  if (typeof nodeBudgetFromManifest === "number") return nodeBudgetFromManifest;
  return (totalmem() / 1024 ** 3) * 0.75;
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
    `--force does not bypass the budget; free capacity with --evict <name> or raise the node budget (NodeRun spec.budget.memoryGiB, default 75% of total RAM)`,
  ].join(". ");
}

export function computeNodeBudget(input: AdmissionInput): AdmissionResult {
  const livingItems = reservedForNodeBreakdown(input.livingManifests, input.nodeName);
  const reservedBefore = livingItems.reduce((sum, item) => sum + item.expectedMemoryGiB, 0);
  const incomingMemory = input.incoming.spec.resources?.expectedMemoryGiB ?? 0;
  const incomingItem = { name: input.incoming.metadata.name, expectedMemoryGiB: incomingMemory };
  const reservedAfter = reservedBefore + incomingMemory;
  if (input.forceAdmit) return { ok: true, reservedAfter, budget: input.nodeBudgetGiB };
  if (reservedAfter > input.nodeBudgetGiB) {
    const breakdown = [...livingItems, incomingItem].filter((i) => i.expectedMemoryGiB > 0);
    return {
      ok: false,
      reservedAfter,
      budget: input.nodeBudgetGiB,
      reason: formatAdmissionBreakdown(
        input.nodeName,
        input.nodeBudgetGiB,
        incomingItem,
        livingItems,
        reservedAfter,
      ),
      breakdown,
    };
  }
  return { ok: true, reservedAfter, budget: input.nodeBudgetGiB };
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
