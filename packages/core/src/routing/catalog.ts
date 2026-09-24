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

import { LEGACY_PROXY_CAPABILITIES, RouteCapabilitiesSchema } from "./capabilities.js";

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

function endpointHasCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
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
  endpoint: z
    .string()
    .min(1)
    .refine((value) => !endpointHasCredentials(value), {
      message: "endpoint must not embed credentials",
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
  };
}

function upstreamIdFor(group: DeploymentGroup): string {
  // llama-server --alias makes the upstream report the alias, not the rel;
  // the rel stays the first public id so the upstream selector is index 1.
  const [first, second] = group.models;
  if (group.kind === "ModelRun" && second !== undefined) return second;
  return first ?? "";
}

function adForGroup(group: DeploymentGroup): RouteAdvertisementV1 {
  return {
    schemaVersion: 1,
    routeId: `route/${group.owner}/${group.workload}`,
    deploymentId: `deploy/${group.owner}/${group.workload}`,
    backendId: `backend/${group.owner}/${group.workload}`,
    ownerNodeId: group.owner,
    publicModelIds: [...group.models],
    upstreamModelId: upstreamIdFor(group),
    backendKind: "local-model",
    transport: group.isPeer ? "worker-rpc" : "local-http",
    endpoint: group.endpoint,
    providerKind: group.engine,
    capabilities: LEGACY_PROXY_CAPABILITIES,
    modelRevision: group.modelRevision,
    deploymentEpoch: group.deploymentEpoch,
    adapterRevision: UNKNOWN_REVISION,
    policyRevision: UNKNOWN_REVISION,
    weight: 1,
    draining: false,
  };
}

// Legacy collision ordering from openaiProxy.buildRouteMap: ModelRun before
// ModelHost, then workload-name order; the first route per alias wins.
function compareDeployments(a: DeploymentGroup, b: DeploymentGroup): number {
  if (a.kind !== b.kind) return a.kind === "ModelRun" ? -1 : 1;
  return a.workload.localeCompare(b.workload);
}

function sameServingIdentity(a: RouteAdvertisementV1, b: RouteAdvertisementV1): boolean {
  if (a.upstreamModelId !== b.upstreamModelId) return false;
  if (a.modelRevision.status !== "known" || b.modelRevision.status !== "known") return false;
  return a.modelRevision.value === b.modelRevision.value;
}

function admissionConflict(
  ad: RouteAdvertisementV1,
  alias: string,
  existing: readonly RouteCandidate[],
): AliasConflict | null {
  const first = existing.at(0);
  if (first === undefined) return null;
  if (ad.replicaGroup !== undefined) {
    const member = existing.find((c) => c.advertisement.replicaGroup === ad.replicaGroup);
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
    list.push({ advertisement: ad, alias, source: "advertised", legacyWinner: false });
    catalog.candidates.set(alias, list);
  }
  return { accepted: true };
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
    if (!group.seen.has(route.model)) {
      group.seen.add(route.model);
      group.models.push(route.model);
    }
  }
  const sorted = [...groups.values()].sort(compareDeployments);
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
