import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedEnv } from '@llamactl/core';
import type { ModelRun } from './schema.js';

export interface AdmissionInput {
  nodeName: string;
  nodeBudgetGiB: number;
  livingManifests: ModelRun[];
  incoming: ModelRun;
  forceAdmit: boolean;
}

export type AdmissionResult =
  | { ok: true; reservedAfter: number; budget: number }
  | { ok: false; reservedAfter: number; budget: number; reason: string };

export function sumReservedForNode(manifests: ModelRun[], nodeName: string): number {
  let sum = 0;
  for (const m of manifests) {
    if (m.spec.node !== nodeName) continue;
    if (m.spec.enabled === false) continue;
    sum += m.spec.resources?.expectedMemoryGiB ?? 0;
  }
  return sum;
}

export function computeNodeBudget(input: AdmissionInput): AdmissionResult {
  const reservedAfter =
    sumReservedForNode(input.livingManifests, input.nodeName) +
    (input.incoming.spec.resources?.expectedMemoryGiB ?? 0);
  if (input.forceAdmit) return { ok: true, reservedAfter, budget: input.nodeBudgetGiB };
  if (reservedAfter > input.nodeBudgetGiB) {
    return {
      ok: false,
      reservedAfter,
      budget: input.nodeBudgetGiB,
      reason: `node '${input.nodeName}' would reserve ${reservedAfter.toFixed(1)} GiB (> ${input.nodeBudgetGiB.toFixed(1)} GiB budget)`,
    };
  }
  return { ok: true, reservedAfter, budget: input.nodeBudgetGiB };
}

export function estimateWorkloadMemoryGiB(
  manifest: ModelRun,
  resolved: ResolvedEnv,
): number | null {
  if (manifest.spec.gateway) return null;
  if (manifest.spec.target.kind !== 'rel') return null;
  const ggufPath = join(resolved.LLAMA_CPP_MODELS, manifest.spec.target.value);
  try {
    const sz = statSync(ggufPath).size;
    return (sz * 1.1) / 1024 ** 3;
  } catch {
    return null;
  }
}
