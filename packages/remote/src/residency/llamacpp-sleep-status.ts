/**
 * DF-10 (#283) node-local llama.cpp sleep residency for modelHostStatus; reads
 * recorded controller state only, never probes the engine.
 */
import type {
  LlamacppSleepController,
  SleepResidency,
} from "@llamactl/core/residency/llamacpp-sleep";

import { isSleepResidency } from "@llamactl/core/residency/llamacpp-sleep";

let nodeController: LlamacppSleepController | null = null;

export function setNodeLlamacppSleepController(controller: LlamacppSleepController | null): void {
  nodeController = controller;
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
