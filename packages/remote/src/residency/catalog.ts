/**
 * #280 DF-07 — declared cold-model catalog for one node. Projects parsed
 * ModelHost/ModelRun manifests plus the set of currently-live model ids
 * into DeclaredModelEntryV1 rows: every id a workload would serve, with
 * its load state, so the proxy can answer a pin with a typed not-loaded
 * rejection instead of the default endpoint. Pure builder; the only I/O
 * edge is listDeclaredModels reading the workloads dir — no credentials,
 * no kubeconfig. Not wired into serve.ts yet.
 */
import { routingCatalog } from "@llamactl/core";
import { basename, isAbsolute } from "node:path";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { ModelRun } from "../workload/schema.js";

import { listModelHosts } from "../workload/modelhost-store.js";
import { defaultWorkloadsDir, listWorkloads } from "../workload/store.js";

type DeclaredKind = "ModelRun" | "ModelHost";
type DeclaredState = routingCatalog.DeclaredModelState;

interface DeclaredClaim {
  id: string;
  workload: string;
  kind: DeclaredKind;
  enabled: boolean;
}

// Separate-token `--alias`/`-a` values only — mirrors aliasesFromArgs in
// core/server.ts and aliasesFromExtraArgs in core/workloadRuntime.ts.
function aliasIdsFromExtraArgs(extraArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < extraArgs.length; i += 1) {
    const value = extraArgs[i + 1];
    if ((extraArgs[i] === "--alias" || extraArgs[i] === "-a") && value !== undefined) {
      out.push(value);
    }
  }
  return out;
}

// Mirrors resolveModelAliases in server/modelhost.ts — the deduped
// [rel, basename(rel)] of hostedModels[0]. Copied rather than imported:
// server/modelhost.ts is the launch path, this module stays
// manifest-pure.
function hostClaimIds(host: ModelHostManifest): string[] {
  const first = host.spec.hostedModels[0];
  if (first === undefined) return [];
  return [...new Set([first.rel, basename(first.rel)])];
}

function hostClaims(host: ModelHostManifest, nodeName: string): DeclaredClaim[] {
  if (host.spec.node !== nodeName) return [];
  return hostClaimIds(host)
    .filter((id) => !isAbsolute(id))
    .map((id) => ({
      id,
      workload: host.metadata.name,
      kind: "ModelHost" as const,
      enabled: host.spec.enabled,
    }));
}

function runClaims(run: ModelRun, nodeName: string): DeclaredClaim[] {
  const spec = run.spec;
  if (spec.node !== nodeName || spec.target.kind !== "rel" || spec.gateway) return [];
  const ids = [...new Set([spec.target.value, ...aliasIdsFromExtraArgs(spec.extraArgs)])];
  return ids
    .filter((id) => !isAbsolute(id))
    .map((id) => ({
      id,
      workload: run.metadata.name,
      kind: "ModelRun" as const,
      enabled: spec.enabled,
    }));
}

function stateForClaim(
  claim: DeclaredClaim,
  collided: boolean,
  liveModelIds: ReadonlySet<string>,
): DeclaredState {
  if (collided) return "unavailable";
  if (!claim.enabled) return "disabled";
  if (liveModelIds.has(claim.id)) return "ready";
  return "cold";
}

export function buildDeclaredModelEntries(input: {
  nodeName: string;
  modelHosts: readonly ModelHostManifest[];
  modelRuns: readonly ModelRun[];
  liveModelIds: ReadonlySet<string>;
}): routingCatalog.DeclaredModelEntryV1[] {
  const claims = [
    ...input.modelHosts.flatMap((host) => hostClaims(host, input.nodeName)),
    ...input.modelRuns.flatMap((run) => runClaims(run, input.nodeName)),
  ];
  const claimantsById = new Map<string, number>();
  for (const claim of claims) {
    claimantsById.set(claim.id, (claimantsById.get(claim.id) ?? 0) + 1);
  }
  const entries = claims.map((claim) => {
    const collided = (claimantsById.get(claim.id) ?? 0) > 1;
    const state = stateForClaim(claim, collided, input.liveModelIds);
    return routingCatalog.DeclaredModelEntryV1Schema.parse({
      id: claim.id,
      workload: claim.workload,
      kind: claim.kind,
      ownerNodeId: input.nodeName,
      state,
      autoLoadEligible: state === "cold",
      ...(collided ? { reason: "alias-collision" } : {}),
    });
  });
  entries.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.workload.localeCompare(b.workload);
  });
  return entries;
}

const noopSkip = (): void => undefined;

export function listDeclaredModels({
  dir = defaultWorkloadsDir(),
  nodeName,
  liveModelIds,
}: {
  dir?: string;
  nodeName: string;
  liveModelIds: ReadonlySet<string>;
}): routingCatalog.DeclaredModelEntryV1[] {
  return buildDeclaredModelEntries({
    nodeName,
    modelHosts: listModelHosts(dir, noopSkip),
    modelRuns: listWorkloads(dir, noopSkip),
    liveModelIds,
  });
}
