/**
 * 8-state residency lifecycle + declarative exclusive residency groups
 * (#517, DF-03 amendment #276). Pure and synchronous: states in, decisions
 * out. Persistence in the fenced store and enforcement in the reconciler and
 * ModelHost are deferred to #276.
 */
import { z } from "zod";

export const RESIDENCY_STATES = [
  "unavailable",
  "downloaded",
  "loading",
  "warming",
  "ready",
  "draining",
  "unloading",
  "failed",
] as const;

export type ResidencyState = (typeof RESIDENCY_STATES)[number];

export const RESIDENCY_TRANSITIONS: Readonly<Record<ResidencyState, readonly ResidencyState[]>> = {
  unavailable: ["downloaded"],
  downloaded: ["loading", "unavailable"],
  loading: ["warming", "failed", "unloading"],
  warming: ["ready", "failed", "unloading"],
  ready: ["draining", "failed"],
  draining: ["unloading", "failed"],
  unloading: ["downloaded", "failed"],
  failed: ["downloaded", "unavailable"],
};

export const OCCUPYING_RESIDENCY_STATES = ["loading", "warming", "ready"] as const;

function includesValue(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

export function isResidencyState(v: unknown): v is ResidencyState {
  return includesValue(RESIDENCY_STATES, v);
}

export function isLegalResidencyTransition(from: ResidencyState, to: ResidencyState): boolean {
  return includesValue(RESIDENCY_TRANSITIONS[from], to);
}

export function isOccupyingResidencyState(s: ResidencyState): boolean {
  return includesValue(OCCUPYING_RESIDENCY_STATES, s);
}

export const ResidencyGroupDeclaration = z
  .object({ name: z.string().min(1), exclusive: z.boolean() })
  .strict();

export type ResidencyGroupDeclaration = z.infer<typeof ResidencyGroupDeclaration>;

export const ResidencyGroupDeclarations = z
  .array(ResidencyGroupDeclaration)
  .refine((declarations) => new Set(declarations.map((d) => d.name)).size === declarations.length, {
    message: "residency group names must be unique",
  });

export type ResidencyGroupDeclarations = z.infer<typeof ResidencyGroupDeclarations>;

// Membership comes from the catalog `residencyGroup` field and the
// `llamactl.io/residency-group` ModelHost label.
export const RESIDENCY_GROUPS: readonly ResidencyGroupDeclaration[] = [
  { name: "z13-large-gpu", exclusive: true },
];

export interface ResidencyMember {
  id: string;
  group?: string;
  state: ResidencyState;
}

export type ResidencyTransitionDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "UnknownMember" | "IllegalTransition" | "UnknownGroup" | "ExclusiveGroupOccupied";
      detail: string;
      from?: ResidencyState;
      to?: ResidencyState;
      group?: string;
      peer?: { id: string; state: ResidencyState };
    };

export interface ExclusiveGroupViolation {
  group: string;
  members: string[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function refusal(
  reason: "UnknownMember" | "IllegalTransition" | "UnknownGroup" | "ExclusiveGroupOccupied",
  detail: string,
  context: {
    from?: ResidencyState;
    to?: ResidencyState;
    group?: string;
    peer?: { id: string; state: ResidencyState };
  },
): ResidencyTransitionDecision {
  return { ok: false, reason, detail, ...context };
}

function occupyingPeers(
  members: readonly ResidencyMember[],
  group: string,
  selfId: string,
): ResidencyMember[] {
  return members
    .filter((m) => m.id !== selfId && m.group === group && isOccupyingResidencyState(m.state))
    .sort((a, b) => compareStrings(a.id, b.id));
}

function evaluateExclusiveEntry(
  input: {
    groups: readonly ResidencyGroupDeclaration[];
    members: readonly ResidencyMember[];
  },
  member: ResidencyMember,
): ResidencyTransitionDecision {
  const group = member.group ?? "";
  const declaration = input.groups.find((g) => g.name === group);
  if (declaration === undefined) {
    return refusal("UnknownGroup", `group ${group} is not declared`, { group });
  }
  if (!declaration.exclusive) {
    return { ok: true };
  }
  const peer = occupyingPeers(input.members, group, member.id)[0];
  if (peer === undefined) {
    return { ok: true };
  }
  return refusal(
    "ExclusiveGroupOccupied",
    `exclusive group ${group} is held by ${peer.id} in state ${peer.state}`,
    { group, peer: { id: peer.id, state: peer.state } },
  );
}

export function evaluateResidencyTransition(input: {
  groups: readonly ResidencyGroupDeclaration[];
  members: readonly ResidencyMember[];
  id: string;
  to: ResidencyState;
}): ResidencyTransitionDecision {
  const member = input.members.find((m) => m.id === input.id);
  if (member === undefined) {
    return refusal("UnknownMember", `member ${input.id} is not present`, {});
  }
  if (!isLegalResidencyTransition(member.state, input.to)) {
    return refusal("IllegalTransition", `transition ${member.state} -> ${input.to} is not legal`, {
      from: member.state,
      to: input.to,
    });
  }
  if (!isOccupyingResidencyState(input.to) || member.group === undefined) {
    return { ok: true };
  }
  return evaluateExclusiveEntry(input, member);
}

export function findExclusiveGroupViolations(
  groups: readonly ResidencyGroupDeclaration[],
  members: readonly ResidencyMember[],
): ExclusiveGroupViolation[] {
  const violations: ExclusiveGroupViolation[] = [];
  for (const group of groups) {
    if (!group.exclusive) {
      continue;
    }
    const ids = members
      .filter((m) => m.group === group.name && isOccupyingResidencyState(m.state))
      .map((m) => m.id)
      .sort(compareStrings);
    if (ids.length >= 2) {
      violations.push({ group: group.name, members: ids });
    }
  }
  return violations.sort((a, b) => compareStrings(a.group, b.group));
}
