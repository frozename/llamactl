/**
 * #279 DF-06 — pure, synchronous adapter that turns the node's
 * declared workloads (ModelRun + ModelHost manifests) plus observed
 * state into a `ProfileSwitchRequest`, keyed on the opt-in
 * `llamactl.io/residency-profiles` annotation: annotated workloads
 * declare the profiles they serve, unannotated ones are pinned
 * `protected` so a profile switch can never evict them. The module
 * has no live caller yet; executing the switch, fencing, suppression
 * and crash recovery are deferred.
 */
import type {
  PlannerWorkload,
  ProfileSwitchPolicy,
  ProfileSwitchRequest,
} from "@llamactl/core/residency/planner";

import {
  RESIDENCY_GROUPS,
  type ResidencyGroupDeclaration,
} from "@llamactl/core/residency/lifecycle";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { ModelRun } from "../workload/schema.js";

export const RESIDENCY_PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
export const RESIDENCY_PROTECTED_ANNOTATION = "llamactl.io/residency-protected";

// Deliberate duplicate of server/modelhost.ts:60: importing that module
// here would pull the launch path into a pure module, so the constant
// is re-declared and the contract test pins the two for parity.
export const RESIDENCY_GROUP_LABEL = "llamactl.io/residency-group";

export type ObservedWorkloadState = "running" | "starting" | "stopped" | "unknown";

export type ProfileWorkloadSource =
  | { kind: "ModelRun"; manifest: ModelRun }
  | { kind: "ModelHost"; manifest: ModelHostManifest };

export type BuildProfileSwitchRequestInput = {
  node: string;
  to: string;
  from?: string | null;
  nowMs: number;
  budgetGiB: number | null;
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  observed: ReadonlyMap<string, ObservedWorkloadState>;
  // The contract test keys its memory table by workload name, so the
  // callback accepts the id directly alongside the resolved source.
  memoryGiBOf: (src: ProfileWorkloadSource | string) => number;
  groups?: readonly ResidencyGroupDeclaration[];
  policy?: ProfileSwitchPolicy;
  requiredServices?: string[];
  lastSwitchAtMs?: number | null;
};

export type BuildProfileSwitchRequestResult =
  | { ok: true; request: ProfileSwitchRequest }
  | { ok: false; reason: "UnknownState" | "NotOptedIn"; workloads: string[] };

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function parseProfiles(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function mapState(observed: Exclude<ObservedWorkloadState, "unknown">): PlannerWorkload["state"] {
  switch (observed) {
    case "running":
      return "ready";
    case "starting":
      return "loading";
    case "stopped":
      return "downloaded";
  }
}

function nameOf(src: ProfileWorkloadSource): string {
  return src.manifest.metadata.name;
}

function buildWorkload(
  src: ProfileWorkloadSource,
  state: Exclude<ObservedWorkloadState, "unknown">,
  input: BuildProfileSwitchRequestInput,
): PlannerWorkload {
  const annotations = src.manifest.metadata.annotations;
  const profiles = parseProfiles(annotations?.[RESIDENCY_PROFILES_ANNOTATION]);
  const groupLabel = src.manifest.metadata.labels?.[RESIDENCY_GROUP_LABEL];
  const protectedAnnotated = annotations?.[RESIDENCY_PROTECTED_ANNOTATION] === "true";
  const protectedWorkload = profiles.length === 0 ? true : protectedAnnotated;
  return {
    id: nameOf(src),
    profiles,
    state: mapState(state),
    expectedMemoryGiB: input.memoryGiBOf(nameOf(src)),
    ...(typeof groupLabel === "string" && groupLabel.length > 0 ? { group: groupLabel } : {}),
    ...(protectedWorkload ? { protected: true } : {}),
    ...(src.manifest.spec.enabled ? {} : { disabled: true }),
  };
}

export function buildProfileSwitchRequest(
  input: BuildProfileSwitchRequestInput,
): BuildProfileSwitchRequestResult {
  const sources: ProfileWorkloadSource[] = [
    ...input.modelRuns.map((manifest): ProfileWorkloadSource => ({ kind: "ModelRun", manifest })),
    ...input.modelHosts.map((manifest): ProfileWorkloadSource => ({ kind: "ModelHost", manifest })),
  ];

  const onNode = sources.filter(
    (src) => src.manifest.spec.node === input.node || input.observed.has(nameOf(src)),
  );

  const annotated = onNode.some(
    (src) =>
      parseProfiles(src.manifest.metadata.annotations?.[RESIDENCY_PROFILES_ANNOTATION]).length > 0,
  );
  if (!annotated) {
    return { ok: false, reason: "NotOptedIn", workloads: [] };
  }

  const resolved = onNode.map((src) => ({
    src,
    state: input.observed.get(nameOf(src)) ?? "unknown",
  }));

  const unknown = resolved
    .filter((entry) => entry.state === "unknown")
    .map((entry) => nameOf(entry.src))
    .sort(compareStrings);
  if (unknown.length > 0) {
    return { ok: false, reason: "UnknownState", workloads: unknown };
  }

  const workloads = resolved
    .filter(
      (
        entry,
      ): entry is {
        src: ProfileWorkloadSource;
        state: Exclude<ObservedWorkloadState, "unknown">;
      } => entry.state !== "unknown",
    )
    .map((entry) => buildWorkload(entry.src, entry.state, input))
    .sort((a, b) => compareStrings(a.id, b.id));

  const request: ProfileSwitchRequest = {
    node: input.node,
    to: input.to,
    from: input.from ?? null,
    budgetGiB: input.budgetGiB,
    groups: input.groups ?? RESIDENCY_GROUPS,
    workloads,
    nowMs: input.nowMs,
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
    ...(input.requiredServices !== undefined
      ? { requiredServices: [...input.requiredServices] }
      : {}),
    ...(input.lastSwitchAtMs !== undefined ? { lastSwitchAtMs: input.lastSwitchAtMs } : {}),
  };

  return { ok: true, request };
}
