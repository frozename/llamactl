/**
 * #280 DF-07 — declared cold-model catalog for one node. Projects parsed
 * ModelHost/ModelRun manifests plus the set of currently-live model ids
 * into DeclaredModelEntryV1 rows: every id a workload would serve, with
 * its load state, so the proxy can answer a pin with a typed not-loaded
 * rejection instead of the default endpoint. The optional workloadPhase
 * hook feeds the residency lease phase into that state — a draining
 * lease projects 'draining', and a live id under an unloaded lease
 * projects 'loading'. The optional warmingModelIds set marks a live id the
 * proxy reports as warming 'loading' too. The optional withdrawnWorkloads set
 * marks a workload whose routes the proxy has pulled for the duration of a stop
 * (the #280 DF-07 stop fence), which projects its ids as 'draining' too. Pure
 * builder; the only I/O edges are
 * listDeclaredModels reading the workloads dir and declaredManifestSignature
 * stat-ing it — no credentials, no kubeconfig.
 */
import { routingCatalog } from "@llamactl/core";
import { basename, isAbsolute, join } from "node:path";

import type { ModelHostManifest } from "../workload/modelhost-schema.js";
import type { ModelRun } from "../workload/schema.js";

import { readdirSync, statSync } from "../safe-fs.js";
import { listModelHosts } from "../workload/modelhost-store.js";
import { defaultWorkloadsDir, listWorkloads } from "../workload/store.js";

export type DeclaredWorkloadPhase = "open" | "draining" | "unloaded";
type DeclaredKind = "ModelRun" | "ModelHost";
type DeclaredState = routingCatalog.DeclaredModelState;

interface DeclaredClaim {
  id: string;
  workload: string;
  kind: DeclaredKind;
  enabled: boolean;
  /** The manifest's model (hostedModels[0].rel or target.value) for stale artifact comparison. */
  manifestModel?: string;
  /**
   * The model the claim's workload's first live route reports as served, for
   * artifact-revision comparison against manifestModel only. Owner detection
   * does not read it: stale-owner-epoch requires a live route for the
   * claimed id on the claiming workload.
   */
  artifact?: string;
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

// First route model per workload: the model a live route reports as the
// served artifact (the first route per workload, matching listLocalRoutes
// ordering). Returns undefined when there are no routes for that workload.
function firstRouteModelFor(
  workload: string,
  liveRoutes: readonly { workload: string; model: string }[] | undefined,
): string | undefined {
  if (liveRoutes === undefined || liveRoutes.length === 0) return undefined;
  for (const route of liveRoutes) {
    if (route.workload === workload) return route.model;
  }
  return undefined;
}

function hostClaims(
  host: ModelHostManifest,
  nodeName: string,
  liveRoutes: readonly { workload: string; model: string }[] | undefined,
): DeclaredClaim[] {
  if (host.spec.node !== nodeName) return [];
  const manifestModel = host.spec.hostedModels[0]?.rel;
  const artifact = firstRouteModelFor(host.metadata.name, liveRoutes);
  return hostClaimIds(host)
    .filter((id) => !isAbsolute(id))
    .map((id) => ({
      id,
      workload: host.metadata.name,
      kind: "ModelHost" as const,
      enabled: host.spec.enabled,
      ...(manifestModel !== undefined ? { manifestModel } : {}),
      ...(artifact !== undefined ? { artifact } : {}),
    }));
}

function runClaims(
  run: ModelRun,
  nodeName: string,
  liveRoutes: readonly { workload: string; model: string }[] | undefined,
): DeclaredClaim[] {
  const spec = run.spec;
  if (spec.node !== nodeName || spec.target.kind !== "rel" || spec.gateway) return [];
  const manifestModel = spec.target.value;
  const artifact = firstRouteModelFor(run.metadata.name, liveRoutes);
  const ids = [...new Set([spec.target.value, ...aliasIdsFromExtraArgs(spec.extraArgs)])];
  return ids
    .filter((id) => !isAbsolute(id))
    .map((id) => ({
      id,
      workload: run.metadata.name,
      kind: "ModelRun" as const,
      enabled: spec.enabled,
      manifestModel,
      ...(artifact !== undefined ? { artifact } : {}),
    }));
}

// The phase seam is best-effort: a throwing registry degrades that claim
// to "no phase" rather than failing the whole declared source — the same
// degrade-to-nothing rule listWorkloads applies to unparseable manifests.
function phaseForWorkload(
  workloadPhase: ((workload: string) => DeclaredWorkloadPhase | undefined) | undefined,
  workload: string,
): DeclaredWorkloadPhase | undefined {
  try {
    return workloadPhase?.(workload);
  } catch {
    return undefined;
  }
}

function stateForClaim(
  claim: DeclaredClaim,
  collided: boolean,
  liveModelIds: ReadonlySet<string>,
  phase: DeclaredWorkloadPhase | undefined,
  warmingModelIds: ReadonlySet<string> | undefined,
  withdrawnWorkloads: ReadonlySet<string> | undefined,
): DeclaredState {
  if (collided) return "unavailable";
  if (!claim.enabled) return "disabled";
  // A withdrawing workload (stop fence, #280 DF-07) projects 'draining' just
  // like a draining lease phase, even with a live route and no lease phase.
  if (phase === "draining" || withdrawnWorkloads?.has(claim.workload) === true) return "draining";
  if (phase === "unloaded" && liveModelIds.has(claim.id)) return "loading";
  // A live id the proxy currently reports warming projects 'loading': a
  // 'loading' entry is now seen by the proxy's warming-only pin 503, whose
  // routing gate runs before the rejection, while the `declared` model list
  // still skips ids that are live in `data`.
  if (
    warmingModelIds !== undefined &&
    warmingModelIds.has(claim.id) &&
    liveModelIds.has(claim.id)
  ) {
    return "loading";
  }
  if (liveModelIds.has(claim.id)) return "ready";
  return "cold";
}

export function buildDeclaredModelEntries(input: {
  nodeName: string;
  modelHosts: readonly ModelHostManifest[];
  modelRuns: readonly ModelRun[];
  liveModelIds: ReadonlySet<string>;
  liveRoutes?: readonly { workload: string; model: string }[];
  workloadPhase?: (workload: string) => DeclaredWorkloadPhase | undefined;
  warmingModelIds?: ReadonlySet<string>;
  withdrawnWorkloads?: ReadonlySet<string>;
}): routingCatalog.DeclaredModelEntryV1[] {
  const claims = [
    ...input.modelHosts.flatMap((host) => hostClaims(host, input.nodeName, input.liveRoutes)),
    ...input.modelRuns.flatMap((run) => runClaims(run, input.nodeName, input.liveRoutes)),
  ];
  const claimantsById = new Map<string, number>();
  for (const claim of claims) {
    claimantsById.set(claim.id, (claimantsById.get(claim.id) ?? 0) + 1);
  }
  const entries = claims.map((claim) => {
    const collided = (claimantsById.get(claim.id) ?? 0) > 1;
    const phase = phaseForWorkload(input.workloadPhase, claim.workload);
    const state = stateForClaim(
      claim,
      collided,
      input.liveModelIds,
      phase,
      input.warmingModelIds,
      input.withdrawnWorkloads,
    );
    // Stale reasons only override cold/ready/loading states — they yield to
    // collision, disabled, and draining states.
    const staleReason =
      state === "cold" || state === "ready" || state === "loading"
        ? staleReasonForClaim(claim, input.liveRoutes)
        : undefined;
    return routingCatalog.DeclaredModelEntryV1Schema.parse({
      id: claim.id,
      workload: claim.workload,
      kind: claim.kind,
      ownerNodeId: input.nodeName,
      state: staleReason !== undefined ? "cold" : state,
      // A stale claim always has a live id, so its pre-stale state is never
      // 'cold'; a collided claim is always 'unavailable', so it never carries
      // a stale reason. Neither conjunct needs the other's guard.
      autoLoadEligible: state === "cold",
      ...(staleReason !== undefined ? { reason: staleReason } : {}),
      ...(collided ? { reason: "alias-collision" } : {}),
    });
  });
  entries.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.workload.localeCompare(b.workload);
  });
  return entries;
}

// Compute a stale reason for a claim based on liveRoutes. Returns undefined
// when there are no live routes (base behavior: no staleness) or when the
// claim's artifact and owner epoch match the live route.
function staleReasonForClaim(
  claim: DeclaredClaim,
  liveRoutes: readonly { workload: string; model: string }[] | undefined,
): string | undefined {
  // No live routes: no staleness (base behavior).
  if (liveRoutes === undefined || liveRoutes.length === 0) return undefined;
  // Check if the claim's id appears in any live route's model (i.e., the
  // claim's model is live). If not, there's no staleness — the model
  // simply isn't routed.
  const isLiveModel = liveRoutes.some((route) => route.model === claim.id);
  if (!isLiveModel) return undefined;
  // A workload serving its canonical rel need not be serving its declared alias yet.
  const ownsModel = liveRoutes.some(
    (route) => route.model === claim.id && route.workload === claim.workload,
  );
  if (!ownsModel) {
    return "stale-owner-epoch";
  }
  // Artifact revision mismatch: the manifest's model doesn't match the live
  // route model. Only check when we have the claim's manifest model info.
  if (
    claim.manifestModel !== undefined &&
    claim.artifact !== undefined &&
    claim.manifestModel !== claim.artifact
  ) {
    return "stale-artifact-revision";
  }
  return undefined;
}

const noopSkip = (): void => undefined;

function statSignature(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.mtimeNs.toString()}:${stat.size.toString()}`;
  } catch {
    return "-";
  }
}

/**
 * #280 DF-07: cheap change signature for listDeclaredModels' manifest input —
 * the workloads dir stat plus each `*.yaml` manifest's mtime and size, with
 * no YAML or schema parsing. The proxy folds it into the key of its
 * stale-binding projection so a routed request re-evaluates the declared
 * source only after a manifest edit (an in-place edit bumps the file, not
 * the dir). The optional workloadPhase hook adds the lease phase of each
 * manifest's file-stem workload name (manifests are written as
 * `<metadata.name>.yaml`), since a draining lease suppresses a stale reason.
 */
export function declaredManifestSignature({
  dir = defaultWorkloadsDir(),
  workloadPhase,
}: {
  dir?: string;
  workloadPhase?: (workload: string) => DeclaredWorkloadPhase | undefined;
} = {}): string {
  const parts: string[] = [dir, statSignature(dir)];
  let manifests: string[] = [];
  try {
    manifests = readdirSync(dir)
      .filter((entry) => entry.endsWith(".yaml"))
      .sort();
  } catch {
    // Missing or unreadable dir — the dir stat alone is the signature.
  }
  for (const entry of manifests) {
    const phase = phaseForWorkload(workloadPhase, entry.slice(0, -".yaml".length));
    parts.push(entry, statSignature(join(dir, entry)), phase ?? "-");
  }
  return parts.join("|");
}

export function listDeclaredModels({
  dir = defaultWorkloadsDir(),
  nodeName,
  liveModelIds,
  liveRoutes,
  workloadPhase,
  warmingModelIds,
  withdrawnWorkloads,
}: {
  dir?: string;
  nodeName: string;
  liveModelIds: ReadonlySet<string>;
  liveRoutes?: readonly { workload: string; model: string }[];
  workloadPhase?: (workload: string) => DeclaredWorkloadPhase | undefined;
  warmingModelIds?: ReadonlySet<string>;
  withdrawnWorkloads?: ReadonlySet<string>;
}): routingCatalog.DeclaredModelEntryV1[] {
  return buildDeclaredModelEntries({
    nodeName,
    modelHosts: listModelHosts(dir, noopSkip),
    modelRuns: listWorkloads(dir, noopSkip),
    liveModelIds,
    ...(liveRoutes !== undefined ? { liveRoutes } : {}),
    ...(workloadPhase !== undefined ? { workloadPhase } : {}),
    ...(warmingModelIds !== undefined ? { warmingModelIds } : {}),
    ...(withdrawnWorkloads !== undefined ? { withdrawnWorkloads } : {}),
  });
}
