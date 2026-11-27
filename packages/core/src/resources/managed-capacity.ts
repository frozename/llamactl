import type { HostMemoryObservation } from "./memory.js";

import { MEMORY_BUDGET_HEADROOM_RATIO } from "../residency/admission.js";

export type ManagedMemoryPressure = HostMemoryObservation["pressure"];

export type ManagedCapacityScope =
  | { kind: "host-physical" }
  | {
      kind: "cgroup-v2";
      /** Null means every hard limit is "max", even when a reclaim threshold bounds headroom. */
      limitBytes: number | null;
      availableBytes: number;
    }
  | { kind: "unknown" };

export interface ManagedCapacitySample {
  source: "darwin-vm" | "linux-procfs" | "unsupported";
  observedAtMs: number;
  physicalBytes: number | null;
  availableBytes: number | null;
  scope: ManagedCapacityScope;
  pressure: ManagedMemoryPressure;
  swapUsedBytes: number | null;
}

export interface ManagedCapacityOptions {
  nowMs: number;
  maxAgeMs?: number;
  configuredBudgetGiB?: number;
  safetyMarginRatio?: number;
  hostReserveGiB?: number;
  maxSwapUsedGiB?: number;
}

type CapacityRefusal =
  | "CapacityUnknown"
  | "CapacityScopeUnknown"
  | "InvalidCapacity"
  | "MemoryPressure"
  | "NoMemoryHeadroom"
  | "PressureUnknown"
  | "StaleCapacity"
  | "SwapUnknown"
  | "SwapUsed";

export type ManagedCapacityDecision =
  | {
      ok: true;
      /** Safe conservative bound for callers with a single total-budget check. */
      budgetGiB: number;
      /** Total ledger cap, independent of today's free bytes. */
      ledgerCeilingGiB: number;
      /** Additional memory available now. Do not treat it as retained capacity after a later load. */
      launchHeadroomGiB: number;
      hostReserveGiB: number;
    }
  | { ok: false; reason: CapacityRefusal };

type Policy = {
  maxAgeMs: number;
  configuredBudgetGiB: number | undefined;
  margin: number;
  reserve: number;
  swapLimit: number;
};

const GiB = 1024 ** 3;

function nonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function policyOf(options: ManagedCapacityOptions): Policy | undefined {
  const {
    nowMs,
    maxAgeMs = 30_000,
    configuredBudgetGiB,
    safetyMarginRatio: margin = MEMORY_BUDGET_HEADROOM_RATIO,
    hostReserveGiB: reserve = 0,
    maxSwapUsedGiB: swapLimit = 0,
  } = options;
  const validBudget =
    configuredBudgetGiB === undefined ||
    (Number.isFinite(configuredBudgetGiB) && configuredBudgetGiB > 0);
  return nonnegative(nowMs) &&
    nonnegative(maxAgeMs) &&
    validBudget &&
    margin > 0 &&
    margin <= 1 &&
    nonnegative(reserve) &&
    nonnegative(swapLimit)
    ? { maxAgeMs, configuredBudgetGiB, margin, reserve, swapLimit }
    : undefined;
}

function readingRefusal(
  sample: ManagedCapacitySample,
  nowMs: number,
  policy: Policy,
): CapacityRefusal | undefined {
  const { observedAtMs, pressure, swapUsedBytes } = sample;
  if (!nonnegative(observedAtMs) || observedAtMs > nowMs) return "InvalidCapacity";
  if (nowMs - observedAtMs > policy.maxAgeMs) return "StaleCapacity";
  if (pressure === null) return "PressureUnknown";
  if (pressure !== "normal") return "MemoryPressure";
  if (swapUsedBytes === null) return "SwapUnknown";
  if (!nonnegative(swapUsedBytes)) return "InvalidCapacity";
  if (swapUsedBytes / GiB > policy.swapLimit) return "SwapUsed";
  return undefined;
}

function scopeCeilings(
  scope: ManagedCapacityScope,
): { limitGiB: number; availableGiB: number } | { reason: CapacityRefusal } {
  if (scope.kind === "unknown") return { reason: "CapacityScopeUnknown" };
  if (scope.kind === "host-physical") {
    return { limitGiB: Number.POSITIVE_INFINITY, availableGiB: Number.POSITIVE_INFINITY };
  }
  const { limitBytes, availableBytes } = scope;
  if (
    !nonnegative(availableBytes) ||
    (limitBytes !== null && (!nonnegative(limitBytes) || availableBytes > limitBytes))
  ) {
    return { reason: "InvalidCapacity" };
  }
  return {
    limitGiB: limitBytes === null ? Number.POSITIVE_INFINITY : limitBytes / GiB,
    availableGiB: availableBytes / GiB,
  };
}

export function projectManagedCapacity(
  sample: ManagedCapacitySample | undefined,
  options: ManagedCapacityOptions,
): ManagedCapacityDecision {
  const policy = policyOf(options);
  if (policy === undefined) return { ok: false, reason: "InvalidCapacity" };
  if (sample === undefined) return { ok: false, reason: "CapacityUnknown" };
  const { physicalBytes, availableBytes } = sample;
  if (physicalBytes === null || availableBytes === null)
    return { ok: false, reason: "CapacityUnknown" };
  if (
    !nonnegative(physicalBytes) ||
    physicalBytes === 0 ||
    !nonnegative(availableBytes) ||
    availableBytes > physicalBytes
  ) {
    return { ok: false, reason: "InvalidCapacity" };
  }
  const ceilings = scopeCeilings(sample.scope);
  if ("reason" in ceilings) return { ok: false, reason: ceilings.reason };
  const refusal = readingRefusal(sample, options.nowMs, policy);
  if (refusal !== undefined) return { ok: false, reason: refusal };

  const physicalGiB = physicalBytes / GiB;
  const hostReserveGiB = Math.max(policy.reserve, physicalGiB * (1 - policy.margin));
  const ledgerCeilingGiB = Math.min(
    policy.configuredBudgetGiB ?? Number.POSITIVE_INFINITY,
    physicalGiB - hostReserveGiB,
    ceilings.limitGiB,
  );
  const launchHeadroomGiB = Math.min(availableBytes / GiB - hostReserveGiB, ceilings.availableGiB);
  const budgetGiB = Math.min(ledgerCeilingGiB, launchHeadroomGiB);
  return budgetGiB > 0
    ? { ok: true, budgetGiB, ledgerCeilingGiB, launchHeadroomGiB, hostReserveGiB }
    : { ok: false, reason: "NoMemoryHeadroom" };
}
