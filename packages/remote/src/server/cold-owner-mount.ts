import type { ExecutionAdmissionConfig } from "@llamactl/core/config/agent-config";
import type { RequestQueueLimits } from "@llamactl/core/residency/queue-policy";

import type { ManagedLaunchAdmission } from "../residency/managed-launch-admission.js";
import type { OwnerAdmission } from "../residency/owner-admission.js";
import type { RequestAdmissionOptions } from "../residency/request-admission.js";

import {
  type ColdOwnerAdmission,
  createColdOwnerAdmission,
  type TrustedColdOwner,
} from "../residency/cold-owner-admission.js";
import { LOCAL_NODE_ID } from "../workload/modelhost-schema.js";

export type ColdExecutionGroup = ExecutionAdmissionConfig[number] & {
  maxContextTokens: number;
  maxCompletionTokens: number;
};

export interface ManagedColdOwnerFactoryContext {
  ownerNodeId: string;
  managed: ManagedLaunchAdmission;
  executionGroups: readonly Readonly<ColdExecutionGroup>[];
}

export type ManagedColdOwnerFactory = (
  context: ManagedColdOwnerFactoryContext,
) => TrustedColdOwner | undefined;

function hasExplicitCaps(group: ExecutionAdmissionConfig[number]): group is ColdExecutionGroup {
  return (
    group.maxContextTokens !== undefined &&
    group.maxCompletionTokens !== undefined &&
    group.maxCompletionTokens <= group.maxContextTokens
  );
}

export function boundedColdExecutionGroups(
  groups: ExecutionAdmissionConfig | undefined,
): ColdExecutionGroup[] {
  return (groups ?? []).filter(hasExplicitCaps);
}

function coldLimits(groups: readonly ColdExecutionGroup[]): RequestQueueLimits {
  // One launch at a time on this owner. Warm admission still applies the
  // selected engine's cap after the cold queue has settled.
  return {
    maxExecutions: 1,
    maxQueued: Math.min(...groups.map((group) => group.maxQueued)),
    maxQueuedBytes: Math.min(...groups.map((group) => group.maxQueuedBytes)),
    maxQueueWaitMs: Math.min(...groups.map((group) => group.maxQueueWaitMs)),
    maxPerPrincipal: Math.min(...groups.map((group) => group.maxPerPrincipal)),
    starvationBoundMs: Math.min(...groups.map((group) => group.starvationBoundMs)),
    maxContextTokens: Math.min(...groups.map((group) => group.maxContextTokens)),
    retryAfterMs: 1_000,
  };
}

export function prepareColdOwnerMount(opts: {
  factory?: ManagedColdOwnerFactory | undefined;
  managed?: ManagedLaunchAdmission | undefined;
  warm?: OwnerAdmission | undefined;
  executionAdmission?: ExecutionAdmissionConfig | undefined;
  managedRuntime: boolean;
  tls: boolean;
  noAuth: boolean;
  declaredModels: boolean;
  residencyLeases: boolean;
  observeWait?: RequestAdmissionOptions["observeWait"];
}): ColdOwnerAdmission | undefined {
  const { managed, warm, factory } = opts;
  if (
    !opts.managedRuntime ||
    !opts.tls ||
    opts.noAuth ||
    !opts.declaredModels ||
    !opts.residencyLeases
  ) {
    return undefined;
  }
  if (managed?.runOwnedLifecycle === undefined || managed.ownsNode?.(LOCAL_NODE_ID) !== true) {
    return undefined;
  }
  if (factory === undefined || warm === undefined) return undefined;
  const executionGroups = boundedColdExecutionGroups(opts.executionAdmission);
  if (executionGroups.length === 0) return undefined;
  const owner = factory({ ownerNodeId: LOCAL_NODE_ID, managed, executionGroups });
  return owner === undefined
    ? undefined
    : createColdOwnerAdmission({
        ownerNodeId: LOCAL_NODE_ID,
        owner,
        warm,
        limits: coldLimits(executionGroups),
        observeWait: opts.observeWait,
      });
}
