/**
 * Dry-run profile switch planner for recoverable whole-process fleet
 * profile switching (DF-06, #279). Pure and synchronous: request in,
 * plan or refusal out. Execution under the fence, persisted suppression,
 * crash recovery and lease composition are deferred.
 */
import type { ResidencyGroupDeclaration, ResidencyState } from "./lifecycle.js";

import { resolveResidencyPolicy } from "./admission.js";
import { findExclusiveGroupViolations, isOccupyingResidencyState } from "./lifecycle.js";

export const DEFAULT_PROFILE_SWITCH_TIMEOUTS = Object.freeze<ProfileSwitchTimeouts>({
  drainMs: 30_000,
  unloadMs: 60_000,
  loadMs: 600_000,
  readyMs: 120_000,
});

export type ProfileSwitchTimeouts = {
  drainMs: number;
  unloadMs: number;
  loadMs: number;
  readyMs: number;
};

// Overrides are boundary input: present keys are validated in
// planProfileSwitch, so null/undefined/non-number values stay representable.
export type ProfileSwitchTimeoutOverrides = {
  [K in keyof ProfileSwitchTimeouts]?: number | null | undefined;
};

export type ProfileSwitchRequest = {
  node: string;
  to: string;
  from?: string | null;
  budgetGiB: number | null;
  groups: readonly ResidencyGroupDeclaration[];
  workloads: PlannerWorkload[];
  requiredServices?: string[];
  policy?: ProfileSwitchPolicy;
  lastSwitchAtMs?: number | null;
  inFlightOperationId?: string | null;
  nowMs: number;
  timeouts?: ProfileSwitchTimeoutOverrides | null;
};

export type PlannerWorkload = {
  id: string;
  profiles: string[];
  state: ResidencyState;
  expectedMemoryGiB: number;
  group?: string;
  protected?: boolean;
  disabled?: boolean;
  loadedAtMs?: number;
};

export type ProfileSwitchPolicy = {
  minResidencySeconds?: number;
  switchCooldownSeconds?: number;
};

export type StepKind =
  | "fence-admission"
  | "drain"
  | "persist-suppression"
  | "unload"
  | "verify-release"
  | "reserve"
  | "start"
  | "verify-ready"
  | "publish"
  | "complete";

export type ProfileSwitchStep = {
  kind: StepKind;
  workloads?: string[];
  freedGiB?: number;
  reservationGiB?: number;
  profile?: string;
};

export type OkPlan = {
  ok: true;
  noop: boolean;
  node: string;
  from: string | null;
  to: string;
  victims: string[];
  replacements: string[];
  retained: string[];
  protected: string[];
  skipped: string[];
  beforeGiB: number;
  afterGiB: number;
  peakGiB: number;
  budgetGiB: number | null;
  steps: ProfileSwitchStep[];
  deadlineMs: number;
};

export type RefusalPlan = {
  ok: false;
  reason: string;
  detail: string;
  workloads: string[];
  retryAfterMs: number | null;
  steps: ProfileSwitchStep[];
};

export type ProfileSwitchPlan = OkPlan | RefusalPlan;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedCopy(arr: string[]): string[] {
  return [...arr].sort(compareStrings);
}

function isFiniteBudgetGiB(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isInvalidMemory(value: number): boolean {
  return !Number.isFinite(value) || value < 0;
}

function sumMemory(workloads: PlannerWorkload[]): number {
  return workloads.reduce((sum, w) => sum + Math.max(0, w.expectedMemoryGiB), 0);
}

function buildRefusal(
  reason: string,
  detail: string,
  workloads: string[],
  retryAfterMs: number | null = null,
): RefusalPlan {
  return {
    ok: false,
    reason,
    detail,
    workloads: sortedCopy(workloads),
    retryAfterMs,
    steps: [],
  };
}

function checkEmptyTo(request: ProfileSwitchRequest): RefusalPlan | null {
  if (request.to === "") {
    return buildRefusal("InvalidRequest", '"to" is empty', []);
  }
  return null;
}

function checkDuplicateIds(request: ProfileSwitchRequest): RefusalPlan | null {
  const seen = new Set<string>();
  for (const wl of request.workloads) {
    if (seen.has(wl.id)) {
      return buildRefusal("InvalidRequest", `duplicate workload id "${wl.id}"`, []);
    }
    seen.add(wl.id);
  }
  return null;
}

function checkInvalidMemory(request: ProfileSwitchRequest): RefusalPlan | null {
  for (const wl of request.workloads) {
    if (isInvalidMemory(wl.expectedMemoryGiB)) {
      return buildRefusal(
        "InvalidRequest",
        `workload "${wl.id}" has non-finite or negative expectedMemoryGiB`,
        [],
      );
    }
  }
  return null;
}

function checkGroupDeclarations(request: ProfileSwitchRequest): RefusalPlan | null {
  const groupNames = new Set(request.groups.map((g) => g.name));
  for (const wl of request.workloads) {
    if (wl.group !== undefined && !groupNames.has(wl.group)) {
      return buildRefusal(
        "InvalidRequest",
        `workload "${wl.id}" group "${wl.group}" is not declared in groups`,
        [],
      );
    }
  }
  return null;
}

function checkEmptyRequiredServices(request: ProfileSwitchRequest): RefusalPlan | null {
  const required = request.requiredServices;
  if (required) {
    for (const svc of required) {
      if (svc === "") {
        return buildRefusal("InvalidRequest", "a requiredServices entry is an empty string", []);
      }
    }
  }
  return null;
}

const PROFILE_SWITCH_TIMEOUT_KEYS = ["drainMs", "unloadMs", "loadMs", "readyMs"] as const;

function checkTimeouts(request: ProfileSwitchRequest): RefusalPlan | null {
  const overrides: unknown = request.timeouts;
  if (overrides === undefined || overrides === null) {
    return null;
  }
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    return buildRefusal("InvalidRequest", "timeouts must be an object", []);
  }
  const record = overrides as Record<string, unknown>;
  for (const key of PROFILE_SWITCH_TIMEOUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return buildRefusal(
        "InvalidRequest",
        `timeouts.${key} must be a finite non-negative number`,
        [],
      );
    }
  }
  return null;
}

function validateRequest(request: ProfileSwitchRequest): RefusalPlan | null {
  const emptyTo = checkEmptyTo(request);
  if (emptyTo) return emptyTo;

  const duplicateIds = checkDuplicateIds(request);
  if (duplicateIds) return duplicateIds;

  const invalidMemory = checkInvalidMemory(request);
  if (invalidMemory) return invalidMemory;

  const groupDeclarations = checkGroupDeclarations(request);
  if (groupDeclarations) return groupDeclarations;

  const emptyServices = checkEmptyRequiredServices(request);
  if (emptyServices) return emptyServices;

  const invalidTimeouts = checkTimeouts(request);
  if (invalidTimeouts) return invalidTimeouts;

  return null;
}

type Partition = {
  occupying: PlannerWorkload[];
  victims: PlannerWorkload[];
  retained: PlannerWorkload[];
  protected: PlannerWorkload[];
  skipped: PlannerWorkload[];
  unavailableTargets: PlannerWorkload[];
  replacements: PlannerWorkload[];
};

function findOccupying(request: ProfileSwitchRequest): PlannerWorkload[] {
  return request.workloads.filter((w) => isOccupyingResidencyState(w.state));
}

function classifyOccupying(
  occupying: PlannerWorkload[],
  targetProfile: string,
): {
  victims: PlannerWorkload[];
  retained: PlannerWorkload[];
  protected: PlannerWorkload[];
} {
  const victims: PlannerWorkload[] = [];
  const retained: PlannerWorkload[] = [];
  const protectedList: PlannerWorkload[] = [];

  for (const wl of occupying) {
    const hasTarget = wl.profiles.includes(targetProfile);
    if (!hasTarget) {
      if (wl.protected) {
        protectedList.push(wl);
        retained.push(wl);
      } else {
        victims.push(wl);
      }
    } else {
      retained.push(wl);
      if (wl.protected) {
        protectedList.push(wl);
      }
    }
  }

  return { victims, retained, protected: protectedList };
}

function classifyNonOccupying(
  request: ProfileSwitchRequest,
  targetProfile: string,
): {
  skipped: PlannerWorkload[];
  unavailableTargets: PlannerWorkload[];
  replacements: PlannerWorkload[];
} {
  const skipped: PlannerWorkload[] = [];
  const unavailableTargets: PlannerWorkload[] = [];
  const replacements: PlannerWorkload[] = [];

  for (const wl of request.workloads) {
    if (isOccupyingResidencyState(wl.state)) continue;

    const hasTarget = wl.profiles.includes(targetProfile);
    if (isDisabledSkipped(wl, hasTarget)) {
      skipped.push(wl);
      continue;
    }

    if (!hasTarget) continue;

    if (wl.state === "failed" || wl.state === "unavailable") {
      unavailableTargets.push(wl);
    } else if (wl.state === "downloaded") {
      replacements.push(wl);
    }
  }

  return { skipped, unavailableTargets, replacements };
}

function isDisabledSkipped(wl: PlannerWorkload, hasTarget: boolean): boolean {
  return wl.disabled === true && hasTarget;
}

function buildPartitionList<T extends { id: string }>(
  list: T[],
  source: readonly PlannerWorkload[],
): T[] {
  return sortedCopy(list.map((w) => w.id)).map(
    (id) => source.find((w) => w.id === id) as unknown as T,
  );
}

function partitionWorkloads(request: ProfileSwitchRequest): Partition {
  const occupying = findOccupying(request);
  const targetProfile = request.to;

  const {
    victims,
    retained,
    protected: protectedList,
  } = classifyOccupying(occupying, targetProfile);

  const { skipped, unavailableTargets, replacements } = classifyNonOccupying(
    request,
    targetProfile,
  );

  return {
    occupying,
    victims: buildPartitionList(victims, occupying),
    retained: buildPartitionList(retained, occupying),
    protected: buildPartitionList(protectedList, occupying),
    skipped: buildPartitionList(skipped, request.workloads),
    unavailableTargets: buildPartitionList(unavailableTargets, request.workloads),
    replacements: buildPartitionList(replacements, request.workloads),
  };
}

function checkRequiredServices(
  request: ProfileSwitchRequest,
  partition: Partition,
): RefusalPlan | null {
  const required = request.requiredServices;
  if (!required || required.length === 0) return null;

  const retainedIds = new Set(partition.retained.map((w) => w.id));
  const replacementIds = new Set(partition.replacements.map((w) => w.id));
  const available = new Set([...retainedIds, ...replacementIds]);

  const missing: string[] = [];
  for (const svc of required) {
    if (!available.has(svc)) {
      missing.push(svc);
    }
  }
  if (missing.length > 0) {
    return buildRefusal(
      "RequiredServiceUnavailable",
      `required services ${missing.join(", ")} are unavailable`,
      missing,
    );
  }
  return null;
}

function checkNodeBusy(request: ProfileSwitchRequest): RefusalPlan | null {
  const inFlight = request.inFlightOperationId;
  if (inFlight !== null && inFlight !== undefined) {
    return buildRefusal("NodeBusy", "an in-flight operation is already in progress", []);
  }

  const busyWorkloads = request.workloads.filter(
    (w) => w.state === "draining" || w.state === "unloading",
  );
  if (busyWorkloads.length > 0) {
    return buildRefusal(
      "NodeBusy",
      `${String(busyWorkloads.length)} workload(s) in draining/unloading state`,
      sortedCopy(busyWorkloads.map((w) => w.id)),
    );
  }

  return null;
}

function buildNoopPlan(
  request: ProfileSwitchRequest,
  partition: Partition,
  nowMs: number,
  from: string | null,
): OkPlan {
  const occupying = request.workloads.filter((w) => isOccupyingResidencyState(w.state));
  const beforeGiB = sumMemory(occupying);
  const afterGiB = sumMemory(occupying);

  return {
    ok: true,
    noop: true,
    node: request.node,
    from,
    to: request.to,
    victims: sortedCopy(partition.victims.map((w) => w.id)),
    replacements: sortedCopy(partition.replacements.map((w) => w.id)),
    retained: sortedCopy(partition.retained.map((w) => w.id)),
    protected: sortedCopy(partition.protected.map((w) => w.id)),
    skipped: sortedCopy(partition.skipped.map((w) => w.id)),
    beforeGiB,
    afterGiB,
    peakGiB: Math.max(beforeGiB, afterGiB),
    budgetGiB: request.budgetGiB,
    steps: [],
    deadlineMs: nowMs,
  };
}

function checkCooldown(request: ProfileSwitchRequest, nowMs: number): RefusalPlan | null {
  const policy = resolveResidencyPolicy(request.policy ?? null);
  const cooldownMs = policy.switchCooldownSeconds * 1000;

  if (cooldownMs > 0) {
    const lastSwitchAtMs = request.lastSwitchAtMs;
    if (
      lastSwitchAtMs !== null &&
      lastSwitchAtMs !== undefined &&
      nowMs - lastSwitchAtMs < cooldownMs
    ) {
      const retryAfterMs = lastSwitchAtMs + cooldownMs - nowMs;
      return buildRefusal(
        "Cooldown",
        `switch cooldown active (${String(retryAfterMs)}ms remaining)`,
        [],
        retryAfterMs,
      );
    }
  }

  return null;
}

function checkExclusiveGroups(
  request: ProfileSwitchRequest,
  partition: Partition,
): RefusalPlan | null {
  const postOccupying = partition.retained;
  const postReplacements = partition.replacements.map((w) => ({
    id: w.id,
    state: "ready",
    group: w.group,
  }));
  const postMembers = [...postOccupying, ...postReplacements] as {
    id: string;
    state: ResidencyState;
    group?: string;
  }[];

  const violations = findExclusiveGroupViolations(request.groups, postMembers);
  if (violations.length > 0) {
    for (const violation of violations) {
      const hasProtected = violation.members.some((id) =>
        partition.protected.some((p) => p.id === id),
      );
      if (hasProtected) {
        return buildRefusal(
          "ProtectedEviction",
          `exclusive group ${violation.group} holds protected member(s) ${violation.members.join(", ")}`,
          violation.members,
        );
      }
    }
    const firstViolation = violations.at(0);
    if (firstViolation === undefined) {
      return null;
    }
    return buildRefusal(
      "ExclusiveGroupConflict",
      `exclusive group ${firstViolation.group} has multiple occupants: ${firstViolation.members.join(", ")}`,
      firstViolation.members,
    );
  }

  return null;
}

function checkMinResidency(
  request: ProfileSwitchRequest,
  partition: Partition,
  nowMs: number,
): RefusalPlan | null {
  const policy = resolveResidencyPolicy(request.policy ?? null);
  const minResidencySeconds = policy.minResidencySeconds;

  if (minResidencySeconds > 0) {
    const tooYoung: { id: string; remainingMs: number }[] = [];
    for (const victim of partition.victims) {
      const loadedAtMs = victim.loadedAtMs;
      if (loadedAtMs !== undefined) {
        const age = nowMs - loadedAtMs;
        const minMs = minResidencySeconds * 1000;
        if (age < minMs) {
          tooYoung.push({ id: victim.id, remainingMs: minMs - age });
        }
      }
    }
    if (tooYoung.length > 0) {
      const maxRemaining = Math.max(...tooYoung.map((t) => t.remainingMs));
      return buildRefusal(
        "MinResidency",
        `${String(tooYoung.length)} victim(s) have not met minimum residency`,
        sortedCopy(tooYoung.map((t) => t.id)),
        maxRemaining,
      );
    }
  }

  return null;
}

function checkBudget(request: ProfileSwitchRequest, partition: Partition): RefusalPlan | null {
  const beforeGiB = sumMemory(partition.occupying);
  const afterGiB = sumMemory(partition.retained.concat(partition.replacements));

  if (afterGiB > 0 && !isFiniteBudgetGiB(request.budgetGiB)) {
    return buildRefusal("UnknownBudget", "budgetGiB is null or non-finite", []);
  }
  if (afterGiB > (isFiniteBudgetGiB(request.budgetGiB) ? request.budgetGiB : 0)) {
    const overIds = partition.replacements.map((w) => w.id);
    return buildRefusal(
      "OverBudget",
      `afterGiB ${String(afterGiB)} exceeds budgetGiB ${String(request.budgetGiB)}`,
      overIds,
    );
  }

  return null;
}

function checkTargetUnavailable(partition: Partition): RefusalPlan | null {
  if (partition.unavailableTargets.length > 0) {
    return buildRefusal(
      "TargetUnavailable",
      `${String(partition.unavailableTargets.length)} target(s) in failed/unavailable state`,
      sortedCopy(partition.unavailableTargets.map((w) => w.id)),
    );
  }
  return null;
}

function isNoop(partition: Partition): boolean {
  return (
    partition.victims.length === 0 &&
    partition.replacements.length === 0 &&
    partition.unavailableTargets.length === 0
  );
}

function buildSteps(request: ProfileSwitchRequest, partition: Partition): ProfileSwitchStep[] {
  const steps: ProfileSwitchStep[] = [];

  steps.push({ kind: "fence-admission" });

  if (partition.victims.length > 0) {
    const victimIds = partition.victims.map((w) => w.id);
    const freedGiB = sumMemory(partition.victims);

    steps.push({ kind: "drain", workloads: victimIds });
    steps.push({ kind: "persist-suppression", workloads: victimIds });
    steps.push({ kind: "unload", workloads: victimIds });
    steps.push({ kind: "verify-release", workloads: victimIds, freedGiB });
  }

  if (partition.replacements.length > 0) {
    const replacementIds = partition.replacements.map((w) => w.id);
    const reservationGiB = sumMemory(partition.replacements);

    steps.push({ kind: "reserve", workloads: replacementIds, reservationGiB });
    steps.push({ kind: "start", workloads: replacementIds });
    steps.push({ kind: "verify-ready", workloads: replacementIds });
  }

  steps.push({ kind: "publish", profile: request.to });
  steps.push({ kind: "complete" });

  return steps;
}

function resolveTimeouts(
  overrides: ProfileSwitchTimeoutOverrides | null | undefined,
): ProfileSwitchTimeouts {
  const resolved: ProfileSwitchTimeouts = { ...DEFAULT_PROFILE_SWITCH_TIMEOUTS };
  if (overrides === undefined || overrides === null) {
    return resolved;
  }
  for (const key of PROFILE_SWITCH_TIMEOUT_KEYS) {
    const value = overrides[key];
    if (typeof value === "number") {
      resolved[key] = value;
    }
  }
  return resolved;
}

function computeDeadlineMs(request: ProfileSwitchRequest, partition: Partition): number {
  const timeouts = resolveTimeouts(request.timeouts);
  let total = 0;

  if (partition.victims.length > 0) {
    total += timeouts.drainMs;
    total += timeouts.unloadMs;
  }
  if (partition.replacements.length > 0) {
    total += timeouts.loadMs;
    total += timeouts.readyMs;
  }

  return request.nowMs + total;
}

export function planProfileSwitch(request: ProfileSwitchRequest): ProfileSwitchPlan {
  const nowMs = request.nowMs;
  const from = request.from ?? null;

  const validationError = validateRequest(request);
  if (validationError) return validationError;

  const busyError = checkNodeBusy(request);
  if (busyError) return busyError;

  const partition = partitionWorkloads(request);

  const requiredError = checkRequiredServices(request, partition);
  if (requiredError) return requiredError;

  if (isNoop(partition)) {
    return buildNoopPlan(request, partition, nowMs, from);
  }

  const cooldownError = checkCooldown(request, nowMs);
  if (cooldownError) return cooldownError;

  const targetError = checkTargetUnavailable(partition);
  if (targetError) return targetError;

  const groupError = checkExclusiveGroups(request, partition);
  if (groupError) return groupError;

  const minResidencyError = checkMinResidency(request, partition, nowMs);
  if (minResidencyError) return minResidencyError;

  const budgetError = checkBudget(request, partition);
  if (budgetError) return budgetError;

  const steps = buildSteps(request, partition);
  const deadlineMs = computeDeadlineMs(request, partition);

  const beforeGiB = sumMemory(partition.occupying);
  const afterGiB = sumMemory(partition.retained.concat(partition.replacements));
  const peakGiB = Math.max(beforeGiB, afterGiB);

  return {
    ok: true,
    noop: false,
    node: request.node,
    from,
    to: request.to,
    victims: sortedCopy(partition.victims.map((w) => w.id)),
    replacements: sortedCopy(partition.replacements.map((w) => w.id)),
    retained: sortedCopy(partition.retained.map((w) => w.id)),
    protected: sortedCopy(partition.protected.map((w) => w.id)),
    skipped: sortedCopy(partition.skipped.map((w) => w.id)),
    beforeGiB,
    afterGiB,
    peakGiB,
    budgetGiB: request.budgetGiB,
    steps,
    deadlineMs,
  };
}
