/** Durable inputs to the managed launch owner's profile check. */
export const MANAGED_PROFILE_TARGET_PREFIX = "managed-profile:";
export const PROFILE_SWITCH_OPERATION_PREFIX = "profile-switch:";

export function profileSwitchOperationKey(node: string): string {
  return PROFILE_SWITCH_OPERATION_PREFIX + node;
}

export function managedProfileTargetState(profile: string): string {
  return MANAGED_PROFILE_TARGET_PREFIX + profile;
}

export function managedProfileFromTargetState(target: string): string | null {
  if (!target.startsWith(MANAGED_PROFILE_TARGET_PREFIX)) return null;
  const profile = target.slice(MANAGED_PROFILE_TARGET_PREFIX.length);
  return profile.length === 0 ? null : profile;
}

export type ManagedProfileSelection =
  | { kind: "unselected" }
  | { kind: "selected"; profile: string; operationId: string }
  | {
      kind: "switching";
      operationId: string;
      dispatch: { profile: string; fenceToken: number } | null;
    }
  | { kind: "unknown"; operationId?: string };

export type ManagedProfilePermit = {
  operationId: string;
  fenceToken: number;
};

export type ManagedProfileStartDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "ProfileInactive";
      profile: string;
      operationId: string;
    }
  | { ok: false; reason: "ProfileSwitchBusy"; operationId: string }
  | { ok: false; reason: "ProfileSelectionUnknown"; operationId?: string };

export function evaluateManagedProfileStart(
  selection: ManagedProfileSelection,
  profiles: readonly string[],
  permit?: ManagedProfilePermit,
): ManagedProfileStartDecision {
  if (profiles.length === 0) return { ok: true };
  if (selection.kind === "unknown") {
    return {
      ok: false,
      reason: "ProfileSelectionUnknown",
      ...(selection.operationId === undefined ? {} : { operationId: selection.operationId }),
    };
  }
  if (selection.kind === "switching") return evaluateProfileDispatch(selection, profiles, permit);
  if (permit !== undefined) {
    return { ok: false, reason: "ProfileSwitchBusy", operationId: permit.operationId };
  }
  if (selection.kind === "unselected") return { ok: true };
  return profiles.includes(selection.profile)
    ? { ok: true }
    : {
        ok: false,
        reason: "ProfileInactive",
        profile: selection.profile,
        operationId: selection.operationId,
      };
}

function evaluateProfileDispatch(
  selection: Extract<ManagedProfileSelection, { kind: "switching" }>,
  profiles: readonly string[],
  permit: ManagedProfilePermit | undefined,
): ManagedProfileStartDecision {
  const { dispatch, operationId } = selection;
  return dispatch !== null &&
    permit?.operationId === operationId &&
    permit.fenceToken === dispatch.fenceToken &&
    profiles.includes(dispatch.profile)
    ? { ok: true }
    : { ok: false, reason: "ProfileSwitchBusy", operationId };
}
