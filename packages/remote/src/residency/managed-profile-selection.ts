import {
  MANAGED_PROFILE_TARGET_PREFIX,
  managedProfileFromTargetState,
  type ManagedProfilePermit,
  type ManagedProfileSelection,
  profileSwitchOperationKey,
} from "@llamactl/core/residency/profile-selection";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  parseProfiles,
  RESIDENCY_PROFILES_ANNOTATION,
  RESIDENCY_PROTECTED_ANNOTATION,
} from "./coordinator.js";
import { readProfileOperations } from "./store.js";

export {
  evaluateManagedProfileStart,
  type ManagedProfilePermit,
  type ManagedProfileSelection,
  type ManagedProfileStartDecision,
  managedProfileTargetState,
} from "@llamactl/core/residency/profile-selection";

const currentPermit = new AsyncLocalStorage<ManagedProfilePermit>();

export function managedProfilePermit(): ManagedProfilePermit | undefined {
  return currentPermit.getStore();
}

export function withManagedProfilePermit<T>(permit: ManagedProfilePermit, apply: () => T): T {
  return currentPermit.run(permit, apply);
}

export function managedProfileMemberProfiles(
  annotations?: Readonly<Record<string, string>>,
): string[] {
  return annotations?.[RESIDENCY_PROTECTED_ANNOTATION] === "true"
    ? []
    : parseProfiles(annotations?.[RESIDENCY_PROFILES_ANNOTATION]);
}

function projectSelection(view: ReturnType<typeof readProfileOperations>): ManagedProfileSelection {
  if (view === null) return { kind: "unselected" };
  const { active, terminal, fenceToken } = view;
  if (active !== null) {
    const profile = managedProfileFromTargetState(active.targetState);
    const dispatch =
      profile !== null && active.phase === "committed" && active.fenceToken === fenceToken
        ? { profile, fenceToken }
        : null;
    return { kind: "switching", operationId: active.operationId, dispatch };
  }
  if (terminal === null) return { kind: "unselected" };
  const { operationId } = terminal;
  const profile = managedProfileFromTargetState(terminal.targetState);
  return terminal.outcome === "succeeded" && profile !== null
    ? { kind: "selected", profile, operationId }
    : { kind: "unknown", operationId };
}

export function readManagedProfileSelection(path: string, node: string): ManagedProfileSelection {
  try {
    return projectSelection(
      readProfileOperations(path, profileSwitchOperationKey(node), MANAGED_PROFILE_TARGET_PREFIX),
    );
  } catch {
    return { kind: "unknown" };
  }
}
