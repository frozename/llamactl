/**
 * RouteAdvertisementV1 + RouteCatalogV1 — the unified route catalog
 * (P0.2, design §4.1). Every deployment candidate is retained; legacy
 * unqualified-alias precedence is preserved as candidate order. A peer is
 * a transport location, not a backend kind. No secrets: peer tokens,
 * certificates, argv and env values never enter an advertisement.
 * Pure module — no I/O, no upstream calls.
 */
import { z } from "zod";

import type { ClusterRoute, LocalRoute } from "../workloadRuntime.js";

import { QUALIFICATION_STAGES } from "../schemas.js";
import {
  type CapabilityRejection,
  isExperimentalRoute,
  LEGACY_PROXY_CAPABILITIES,
  RouteCapabilitiesSchema,
} from "./capabilities.js";

const isQualificationStage = (stage: string): boolean =>
  (QUALIFICATION_STAGES as readonly string[]).includes(stage);

export const BackendKindSchema = z.enum(["local-model", "cloud-api", "cli", "acp"]);
export type BackendKind = z.infer<typeof BackendKindSchema>;

export const RouteTransportSchema = z.enum(["local-http", "worker-rpc", "cloud-direct"]);
export type RouteTransport = z.infer<typeof RouteTransportSchema>;

export const RevisionV1Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: z.string().min(1) }),
  z.object({ status: z.literal("unknown") }),
]);
export type RevisionV1 = z.infer<typeof RevisionV1Schema>;

export const UNKNOWN_REVISION: RevisionV1 = { status: "unknown" };

export function knownRevision(value: string): RevisionV1 {
  return { status: "known", value };
}

function endpointIsCredentialFree(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

/**
 * Strip an endpoint down to its credential-free reference form:
 * scheme, host, port and path only. Anything the URL parser cannot
 * handle passes through untouched so the schema rejects it — fail
 * closed, never silently rewrite a malformed endpoint into a valid one.
 */
function credentialFreeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    // Rebuild rather than toString() so an already-clean endpoint is
    // byte-identical — URL adds a trailing "/" for root paths.
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return value;
  }
}

export const RouteAdvertisementV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  routeId: z.string().min(1),
  deploymentId: z.string().min(1),
  backendId: z.string().min(1),
  ownerNodeId: z.string().min(1),
  publicModelIds: z.array(z.string().min(1)).min(1),
  upstreamModelId: z.string().min(1),
  backendKind: BackendKindSchema,
  transport: RouteTransportSchema,
  endpoint: z.string().min(1).refine(endpointIsCredentialFree, {
    message:
      "endpoint must be a credential-free http(s) reference (no userinfo, query or fragment)",
  }),
  providerKind: z.string().min(1).optional(),
  bindingId: z.string().min(1).optional(),
  capabilities: RouteCapabilitiesSchema,
  modelRevision: RevisionV1Schema,
  deploymentEpoch: RevisionV1Schema,
  adapterRevision: RevisionV1Schema,
  policyRevision: RevisionV1Schema,
  weight: z.number().nonnegative().default(1),
  maxConcurrency: z.number().int().positive().optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  healthyUntil: z.number().optional(),
  draining: z.boolean().default(false),
  credentialScopeId: z.string().min(1).optional(),
  tenantVisibility: z.array(z.string().min(1)).optional(),
  region: z.string().min(1).optional(),
  trustDomain: z.string().min(1).optional(),
  replicaGroup: z.string().min(1).optional(),
  priority: z.number().optional(),
  // #518. The stage carries a QUALIFICATION_STAGES value; the refine
  // validates it at this boundary while keeping the inferred type a plain
  // string, so hand-built advertisements and label-derived stages typecheck.
  qualification: z
    .object({
      stage: z
        .string()
        .min(1)
        .refine(isQualificationStage, {
          message: `stage must be one of: ${QUALIFICATION_STAGES.join(", ")}`,
        }),
    })
    .optional(),
});
export type RouteAdvertisementV1 = z.infer<typeof RouteAdvertisementV1Schema>;

export const AliasBindingV1Schema = z.object({
  publicId: z.string().min(1),
  routeId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  replicaGroup: z.string().min(1).optional(),
  priority: z.number().optional(),
});
export type AliasBindingV1 = z.infer<typeof AliasBindingV1Schema>;

export const AliasConflictV1Schema = z.object({
  alias: z.string(),
  existingRouteId: z.string(),
  rejectedRouteId: z.string(),
  reason: z.enum(["alias-conflict", "incompatible-replica"]),
});
export type AliasConflictV1 = z.infer<typeof AliasConflictV1Schema>;
export type AliasConflict = AliasConflictV1;

export const RouteCatalogV1Schema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().min(1),
  configRevision: RevisionV1Schema,
  generatedAt: z.number(),
  expiresAt: z.number(),
  deployments: z.array(RouteAdvertisementV1Schema),
  aliasBindings: z.array(AliasBindingV1Schema).default([]),
  conflicts: z.array(AliasConflictV1Schema).default([]),
});
export type RouteCatalogV1 = z.infer<typeof RouteCatalogV1Schema>;

export interface RouteCandidate {
  advertisement: RouteAdvertisementV1;
  alias: string;
  source: "legacy" | "advertised";
  /**
   * First candidate for this alias in legacy precedence order.
   *
   * Known divergence (#518): for a default-target id (LLAMA_CPP_SERVER_ALIAS
   * / LLAMA_CPP_DEFAULT_MODEL) served only by an experimental route, the
   * proxy drops that route so requests fall through to the node's default
   * endpoint, while the catalog still marks the experimental candidate
   * legacyWinner. Callers must go through selectCatalogCandidates with
   * `pinned: false` for such ids instead of trusting legacyWinner.
   * createProxy now selects through selectCatalogCandidates with
   * `pinned = !defaultTargetModelIds(resolved).has(model)` and builds its
   * routes with stageByModel, so legacyWinner is informational only.
   *
   * `legacyWinner` marks the first legacy candidate for the alias at build
   * time and is informational only: an admitted healthy advertisement can
   * lead it, and insertCandidate keeps each alias list in healthy, degraded,
   * experimental order, so callers read effectiveCandidate or
   * selectCatalogCandidates instead.
   */
  legacyWinner: boolean;
}

export interface RouteCatalog {
  schemaVersion: 1;
  catalogVersion: string;
  configRevision: RevisionV1;
  generatedAt: number;
  expiresAt: number;
  candidates: Map<string, RouteCandidate[]>;
  deployments: RouteAdvertisementV1[];
  conflicts: AliasConflict[];
}

export function catalogCandidatesFor(
  catalog: RouteCatalog,
  publicModelId: string,
): RouteCandidate[] {
  return catalog.candidates.get(publicModelId) ?? [];
}

export function effectiveCandidate(
  catalog: RouteCatalog,
  publicModelId: string,
): RouteCandidate | null {
  return catalogCandidatesFor(catalog, publicModelId)[0] ?? null;
}

interface DeploymentGroup {
  workload: string;
  kind: "ModelRun" | "ModelHost";
  engine: LocalRoute["engine"];
  isPeer: boolean;
  owner: string;
  endpoint: string;
  modelRevision: RevisionV1;
  deploymentEpoch: RevisionV1;
  models: string[];
  seen: Set<string>;
  /** True when any route of the group is experimental (#518). */
  experimental: boolean;
  /** First qualificationStage seen on a route of the group (#518). */
  stage?: string;
}

function groupKeyFor(route: ClusterRoute): string {
  return "isPeer" in route ? `peer|${route.workload}` : `local|${route.workload}`;
}

function groupFor(route: ClusterRoute, nodeId: string): DeploymentGroup {
  const isPeer = "isPeer" in route;
  return {
    workload: route.workload,
    kind: route.kind,
    engine: route.engine,
    isPeer,
    owner: isPeer ? route.targetNodeId : nodeId,
    endpoint: isPeer ? route.peerEndpoint : `http://${route.host}:${String(route.port)}`,
    modelRevision:
      isPeer && route.revision !== undefined && route.revision !== null
        ? knownRevision(route.revision)
        : UNKNOWN_REVISION,
    deploymentEpoch: isPeer ? UNKNOWN_REVISION : knownRevision(`pid:${String(route.pid)}`),
    models: [],
    seen: new Set(),
    experimental: isExperimentalRoute(route),
    ...(route.qualificationStage !== undefined ? { stage: route.qualificationStage } : {}),
  };
}

function upstreamIdFor(group: DeploymentGroup): string {
  // llama-server --alias makes the upstream report an alias, not the rel.
  // The flat route list carries no rel marker, and models is sorted for
  // deterministic output — so the canonical selector is the second sorted
  // public id when a ModelRun serves more than one.
  const [first, second] = group.models;
  if (group.kind === "ModelRun" && second !== undefined) return second;
  return first ?? "";
}

function deploymentIdFor(owner: string, workload: string): string {
  return `deploy/${owner}/${workload}`;
}

/**
 * The workload a node's own local deployment id names, or null for any
 * other id, so a caller re-checking one deployment can re-read that
 * workload alone. An advertisement may reuse the id shape: the name is
 * only a candidate until it is found among the workload directories.
 */
export function workloadOfDeployment(deploymentId: string, nodeId: string): string | null {
  const prefix = deploymentIdFor(nodeId, "");
  return deploymentId.startsWith(prefix) ? deploymentId.slice(prefix.length) : null;
}

function qualificationForGroup(group: DeploymentGroup): { stage: string } | undefined {
  if (group.experimental) return { stage: "experimental" };
  return group.stage === undefined ? undefined : { stage: group.stage };
}

function adForGroup(group: DeploymentGroup): RouteAdvertisementV1 {
  // Legacy-derived advertisements go through the same schema validation
  // as added ones — the endpoint is rewritten to its credential-free
  // form first so a peer URL carrying userinfo/query/fragment cannot
  // reach catalog output.
  const qualification = qualificationForGroup(group);
  return RouteAdvertisementV1Schema.parse({
    schemaVersion: 1,
    routeId: `route/${group.owner}/${group.workload}`,
    deploymentId: deploymentIdFor(group.owner, group.workload),
    backendId: `backend/${group.owner}/${group.workload}`,
    ownerNodeId: group.owner,
    publicModelIds: [...group.models],
    upstreamModelId: upstreamIdFor(group),
    backendKind: "local-model",
    transport: group.isPeer ? "worker-rpc" : "local-http",
    endpoint: credentialFreeEndpoint(group.endpoint),
    providerKind: group.engine,
    capabilities: LEGACY_PROXY_CAPABILITIES,
    modelRevision: group.modelRevision,
    deploymentEpoch: group.deploymentEpoch,
    adapterRevision: UNKNOWN_REVISION,
    policyRevision: UNKNOWN_REVISION,
    weight: 1,
    draining: false,
    ...(qualification !== undefined ? { qualification } : {}),
  });
}

/**
 * Legacy collision tier of a deployment group (#518): experimental 2,
 * degraded 1, healthy 0 — the same tiers as legacyQualificationTier in
 * routing/capabilities.ts. A group is experimental when any of its routes
 * is, so a deployment that carries both marks stays last.
 */
function legacyGroupTier(group: DeploymentGroup): 0 | 1 | 2 {
  if (group.experimental) return 2;
  return group.stage === "degraded" ? 1 : 0;
}

// Legacy collision ordering from openaiProxy.buildRouteMap: ModelRun before
// ModelHost, then workload-name order; the first route per alias wins.
// #518 adds a leading healthy-before-degraded-before-experimental tier, kept
// in parity with orderedProxyRoutes in openaiProxy.ts — neither a degraded
// nor an experimental deployment wins an alias over a healthy one, and an
// experimental deployment never wins over a degraded one.
function compareDeployments(a: DeploymentGroup, b: DeploymentGroup): number {
  const tierDelta = legacyGroupTier(a) - legacyGroupTier(b);
  if (tierDelta !== 0) return tierDelta;
  if (a.kind !== b.kind) return a.kind === "ModelRun" ? -1 : 1;
  return a.workload.localeCompare(b.workload);
}

function revisionEqual(a: RevisionV1, b: RevisionV1): boolean {
  if (a.status !== b.status) return false;
  return a.status !== "known" || (b.status === "known" && a.value === b.value);
}

function sameServingIdentity(a: RouteAdvertisementV1, b: RouteAdvertisementV1): boolean {
  if (a.upstreamModelId !== b.upstreamModelId) return false;
  if (a.backendKind !== b.backendKind) return false;
  if (a.providerKind !== b.providerKind) return false;
  if (a.modelRevision.status !== "known" || b.modelRevision.status !== "known") return false;
  if (a.modelRevision.value !== b.modelRevision.value) return false;
  return (
    revisionEqual(a.deploymentEpoch, b.deploymentEpoch) &&
    revisionEqual(a.adapterRevision, b.adapterRevision) &&
    revisionEqual(a.policyRevision, b.policyRevision)
  );
}

function admissionConflict(
  ad: RouteAdvertisementV1,
  alias: string,
  existing: readonly RouteCandidate[],
): AliasConflict | null {
  // #518 parity with #896 (admitPeerRoute and seedPeerHolders in
  // workloadRuntime.ts): a healthy advertisement is admitted for an id held
  // only by degraded or experimental peer or advertised candidates, while
  // local routes stay authoritative even when degraded. A degraded
  // advertisement never shadows or joins a healthy or degraded holder, and an
  // experimental advertisement is judged against all candidates so it can
  // neither shadow nor intrude on an alias or replica group.
  const peers = isExperimentalAdvertisement(ad)
    ? existing
    : isDegradedAdvertisement(ad)
      ? existing.filter((c) => !isExperimentalAdvertisement(c.advertisement))
      : existing.filter(blocksHealthyAdvertisement);
  const first = peers.at(0);
  if (first === undefined) return null;
  if (ad.replicaGroup !== undefined) {
    const member = peers.find((c) => c.advertisement.replicaGroup === ad.replicaGroup);
    if (member !== undefined) {
      return sameServingIdentity(member.advertisement, ad)
        ? null
        : {
            alias,
            existingRouteId: member.advertisement.routeId,
            rejectedRouteId: ad.routeId,
            reason: "incompatible-replica",
          };
    }
  }
  if (ad.priority !== undefined) return null;
  return {
    alias,
    existingRouteId: first.advertisement.routeId,
    rejectedRouteId: ad.routeId,
    reason: "alias-conflict",
  };
}

/** True when an advertisement declares its qualification stage experimental (#518). */
export function isExperimentalAdvertisement(ad: RouteAdvertisementV1): boolean {
  return ad.qualification?.stage === "experimental";
}

/** True when an advertisement declares its qualification stage degraded (#518). */
export function isDegradedAdvertisement(ad: RouteAdvertisementV1): boolean {
  return ad.qualification?.stage === "degraded";
}

/**
 * Advertised-path collision tier of an advertisement (#518): experimental 2,
 * degraded 1, healthy 0 — the twin of legacyGroupTier above and
 * legacyQualificationTier in routing/capabilities.ts.
 */
function advertisementTier(ad: RouteAdvertisementV1): 0 | 1 | 2 {
  if (isExperimentalAdvertisement(ad)) return 2;
  return isDegradedAdvertisement(ad) ? 1 : 0;
}

/** True for a node's own legacy route, which stays authoritative whatever its
 *  stage (#518, parity with the local authority in seedPeerHolders). */
function isLocalLegacyCandidate(c: RouteCandidate): boolean {
  return c.source === "legacy" && c.advertisement.transport === "local-http";
}

/** Candidates a healthy advertisement is judged against: healthy ones plus
 *  local legacy routes, a degraded local route included (#518). */
function blocksHealthyAdvertisement(c: RouteCandidate): boolean {
  const tier = advertisementTier(c.advertisement);
  return tier === 0 || (tier === 1 && isLocalLegacyCandidate(c));
}

/** Insert an advertisement so each alias list stays in healthy, degraded,
 *  experimental order (#518) — the same tier order as compareDeployments: a
 *  healthy candidate goes before the first degraded or experimental one, a
 *  degraded one before the first experimental, experimental ones append. */
function insertCandidate(list: RouteCandidate[], candidate: RouteCandidate): void {
  const tier = advertisementTier(candidate.advertisement);
  const firstLater = list.findIndex((c) => advertisementTier(c.advertisement) > tier);
  if (firstLater === -1) list.push(candidate);
  else list.splice(firstLater, 0, candidate);
}

export function addCatalogAdvertisement(
  catalog: RouteCatalog,
  input: RouteAdvertisementV1,
): { accepted: true } | { accepted: false; rejection: AliasConflict } {
  const ad = RouteAdvertisementV1Schema.parse(input);
  const rejections: AliasConflict[] = [];
  for (const alias of ad.publicModelIds) {
    const existing = catalog.candidates.get(alias) ?? [];
    if (existing.length === 0) continue;
    const conflict = admissionConflict(ad, alias, existing);
    if (conflict !== null) rejections.push(conflict);
  }
  const firstRejection = rejections.at(0);
  if (firstRejection !== undefined) {
    catalog.conflicts.push(...rejections);
    return { accepted: false, rejection: firstRejection };
  }
  catalog.deployments.push(ad);
  for (const alias of ad.publicModelIds) {
    const list = catalog.candidates.get(alias) ?? [];
    insertCandidate(list, { advertisement: ad, alias, source: "advertised", legacyWinner: false });
    catalog.candidates.set(alias, list);
  }
  return { accepted: true };
}

/**
 * Split an alias' candidates into eligible and rejected for a request.
 * #518: non-experimental candidates are always eligible in catalog order;
 * an experimental candidate is eligible only when the client pinned the
 * exact id (`opts.pinned`) and no non-experimental candidate exists for the
 * alias — otherwise it is rejected with `experimental-excluded`.
 */
export function selectCatalogCandidates(
  catalog: RouteCatalog,
  publicModelId: string,
  opts: { pinned?: boolean } = {},
): {
  eligible: RouteCandidate[];
  rejected: { candidate: RouteCandidate; rejection: CapabilityRejection }[];
} {
  const candidates = catalogCandidatesFor(catalog, publicModelId);
  const hasStable = candidates.some((c) => !isExperimentalAdvertisement(c.advertisement));
  const eligible: RouteCandidate[] = [];
  const rejected: { candidate: RouteCandidate; rejection: CapabilityRejection }[] = [];
  for (const candidate of candidates) {
    if (isExperimentalAdvertisement(candidate.advertisement)) {
      if (opts.pinned === true && !hasStable) {
        eligible.push(candidate);
      } else {
        rejected.push({ candidate, rejection: { reason: "experimental-excluded" } });
      }
    } else {
      eligible.push(candidate);
    }
  }
  return { eligible, rejected };
}

function mergeRouteIntoGroup(group: DeploymentGroup, route: ClusterRoute): void {
  if (isExperimentalRoute(route)) group.experimental = true;
  if (group.stage === undefined && route.qualificationStage !== undefined) {
    group.stage = route.qualificationStage;
  }
  if (!group.seen.has(route.model)) {
    group.seen.add(route.model);
    group.models.push(route.model);
  }
}

export function buildRouteCatalog(opts: {
  routes: readonly ClusterRoute[];
  nodeId?: string;
  catalogVersion?: string;
  configRevision?: RevisionV1;
  ttlMs?: number;
  now?: number;
  advertisements?: readonly RouteAdvertisementV1[];
}): RouteCatalog {
  const nodeId = opts.nodeId ?? "local";
  const now = opts.now ?? Date.now();
  const groups = new Map<string, DeploymentGroup>();
  for (const route of opts.routes) {
    const key = groupKeyFor(route);
    let group = groups.get(key);
    if (group === undefined) {
      group = groupFor(route, nodeId);
      groups.set(key, group);
    }
    mergeRouteIntoGroup(group, route);
  }
  const sorted = [...groups.values()].sort(compareDeployments);
  // Model ids within a deployment arrive in input order; sort them so the
  // serialized catalog is identical for every permutation of the input.
  for (const group of sorted) {
    group.models.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  const catalog: RouteCatalog = {
    schemaVersion: 1,
    catalogVersion: opts.catalogVersion ?? `cat-${String(now)}`,
    configRevision: opts.configRevision ?? UNKNOWN_REVISION,
    generatedAt: now,
    expiresAt: now + (opts.ttlMs ?? 30_000),
    candidates: new Map(),
    deployments: [],
    conflicts: [],
  };
  for (const group of sorted) {
    const ad = adForGroup(group);
    catalog.deployments.push(ad);
    for (const alias of ad.publicModelIds) {
      const list = catalog.candidates.get(alias) ?? [];
      list.push({
        advertisement: ad,
        alias,
        source: "legacy",
        legacyWinner: list.length === 0,
      });
      catalog.candidates.set(alias, list);
    }
  }
  for (const ad of opts.advertisements ?? []) {
    addCatalogAdvertisement(catalog, ad);
  }
  return catalog;
}

export function routeCatalogToV1(catalog: RouteCatalog): RouteCatalogV1 {
  const aliasBindings: AliasBindingV1[] = [];
  for (const [alias, candidates] of catalog.candidates) {
    for (const [ordinal, candidate] of candidates.entries()) {
      aliasBindings.push({
        publicId: alias,
        routeId: candidate.advertisement.routeId,
        ordinal,
        ...(candidate.advertisement.replicaGroup !== undefined
          ? { replicaGroup: candidate.advertisement.replicaGroup }
          : {}),
        ...(candidate.advertisement.priority !== undefined
          ? { priority: candidate.advertisement.priority }
          : {}),
      });
    }
  }
  return {
    schemaVersion: 1,
    catalogVersion: catalog.catalogVersion,
    configRevision: catalog.configRevision,
    generatedAt: catalog.generatedAt,
    expiresAt: catalog.expiresAt,
    deployments: catalog.deployments,
    aliasBindings,
    conflicts: catalog.conflicts,
  };
}

export function serializeRouteCatalog(catalog: RouteCatalog): string {
  return JSON.stringify(routeCatalogToV1(catalog));
}

export const DeclaredModelStateSchema = z.enum([
  "cold",
  "loading",
  "ready",
  "draining",
  "disabled",
  "unavailable",
]);
export type DeclaredModelState = z.infer<typeof DeclaredModelStateSchema>;

/** #280 DF-07: stale reasons that can be projected by declared binding. */
export const DECLARED_STALE_REASONS = ["stale-owner-epoch", "stale-artifact-revision"] as const;
export type DeclaredStaleReason = (typeof DECLARED_STALE_REASONS)[number];

export function isDeclaredStaleReason(reason: string | undefined): reason is DeclaredStaleReason {
  return (DECLARED_STALE_REASONS as readonly string[]).includes(reason ?? "");
}

/**
 * DeclaredModelEntryV1 — a workload-declared model id that is not (yet) a
 * route (#280 DF-07). Declared entries carry no endpoint, host, port or
 * path, and are never routes: they exist so a pin of a declared-but-not-
 * loaded id can be answered with a typed rejection instead of falling
 * through to the node's default endpoint. `autoLoadEligible` marks the
 * `cold` state — the only state a load can be scheduled from — so the
 * schema refuses it on `disabled`/`unavailable`, where no load can run.
 */
export const DeclaredModelEntryV1Schema = z
  .object({
    id: z.string().min(1),
    workload: z.string().min(1),
    kind: z.enum(["ModelRun", "ModelHost"]),
    ownerNodeId: z.string().min(1),
    state: DeclaredModelStateSchema,
    autoLoadEligible: z.boolean(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.autoLoadEligible && (entry.state === "disabled" || entry.state === "unavailable")) {
      ctx.addIssue({
        code: "custom",
        message: "autoLoadEligible cannot be true for disabled or unavailable states",
      });
    }
  });
export type DeclaredModelEntryV1 = z.infer<typeof DeclaredModelEntryV1Schema>;

export const PEER_DECLARATION_PROVENANCE_HEADER = "x-llamactl-declaration-provenance";
export const PEER_DECLARATION_INVENTORY_HEADER = "x-llamactl-declaration-inventory";

const PeerEmptyDeclarationInventorySchema = z.strictObject({
  schemaVersion: z.literal(2),
  ownerNodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  complete: z.literal(true),
  entries: z.tuple([]),
});

export type PeerEmptyDeclarationInventory = z.infer<typeof PeerEmptyDeclarationInventorySchema>;

export function readEmptyPeerDeclarationInventory(
  value: unknown,
  ownerNodeId: string,
): PeerEmptyDeclarationInventory | undefined {
  const parsed = PeerEmptyDeclarationInventorySchema.safeParse(value);
  return parsed.success && parsed.data.ownerNodeId === ownerNodeId ? parsed.data : undefined;
}

const publishedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const peerModelId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/)
  .refine(
    (id) =>
      !id.includes(":/") &&
      id.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );

const PeerDeclarationEntryV1Schema = z
  .strictObject({
    id: peerModelId,
    workload: z.string().regex(/^[a-z0-9][-a-z0-9]{0,62}$/),
    kind: z.enum(["ModelRun", "ModelHost"]),
    ownerNodeId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    state: DeclaredModelStateSchema,
    artifactRevision: publishedDigest,
    policyRevision: publishedDigest,
    deploymentEpoch: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .optional(),
  })
  .refine((entry) => entry.state !== "ready" || entry.deploymentEpoch !== undefined);

const PeerDeclarationProvenanceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(PeerDeclarationEntryV1Schema).min(1),
});

/** Evidence only. This companion neither publishes a route nor authorizes a load. */
export type PeerDeclarationProvenanceV1 = z.infer<typeof PeerDeclarationProvenanceV1Schema>;

export function readPeerDeclarationProvenance(
  value: unknown,
  ownerNodeId: string,
): PeerDeclarationProvenanceV1 | undefined {
  const parsed = PeerDeclarationProvenanceV1Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (entry.ownerNodeId !== ownerNodeId || seen.has(entry.id)) return undefined;
    seen.add(entry.id);
  }
  return parsed.data;
}
