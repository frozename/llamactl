/**
 * DF-10 (#283) node-local llama.cpp sleep residency for modelHostStatus; reads
 * recorded controller state only, never probes the engine.
 */
import type {
  LlamacppSleepController,
  SleepResidency,
} from "@llamactl/core/residency/llamacpp-sleep";

import { isSleepResidency } from "@llamactl/core/residency/llamacpp-sleep";

type SleepRuntimeGeneration = { pid: number; startedAt: string };

let nodeController: LlamacppSleepController | null = null;
let generationForMember: ((name: string) => SleepRuntimeGeneration | undefined) | undefined;

export function setNodeLlamacppSleepController(
  controller: LlamacppSleepController | null,
  /** The generation captured when this controller adopted the runtime. */
  readGeneration?: (name: string) => SleepRuntimeGeneration | undefined,
): void {
  nodeController = controller;
  generationForMember = controller === null ? undefined : readGeneration;
}

export function matchesLlamacppSleepGeneration(
  name: string,
  current: SleepRuntimeGeneration,
): boolean {
  try {
    const recorded = generationForMember?.(name);
    return recorded?.pid === current.pid && recorded.startedAt === current.startedAt;
  } catch {
    return false;
  }
}

export function getNodeLlamacppSleepController(): LlamacppSleepController | null {
  return nodeController;
}

export function readLlamacppSleepResidency(
  controller: LlamacppSleepController | null,
  memberId: string,
): SleepResidency | undefined {
  if (controller === null) return undefined;
  const state = controller.snapshot().members[memberId]?.state;
  return isSleepResidency(state) ? state : undefined;
}
