import { routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { readWorkloadEpoch } from "@llamactl/core/kvstore";
import { listLocalRoutes, type LocalRoute } from "@llamactl/core/workloadRuntime";
import {
  defaultFleetJournalPath,
  type FleetSnapshotEntry,
  readLatestFleetSnapshotFromJournal,
  type WorkloadSnapshot,
} from "@llamactl/fleet-supervisor";

export interface FleetSnapshotRouteOptions {
  journalPath?: string;
  /** #306: route source for the `include=local-routes` fallback. Defaults to listLocalRoutes(resolveEnv()). */
  localRoutes?: () => LocalRoute[];
  /** #306: boot token per workload for the fallback. Defaults to readWorkloadEpoch. */
  revisionOf?: (name: string) => string | null;
  /** #306: clock for the fallback's `ts`. Defaults to new Date(). */
  now?: () => Date;
  /** The owner can explicitly publish a v2 empty inventory after verifying complete absence. */
  declaredProvenance?: { ownerNodeId: string; read: () => unknown };
}

/** #306: one workload of the minimal snapshot served when the journal has no entry. */
export interface LocalRoutesSnapshotWorkload {
  name: string;
  models: string[];
  endpoint: string;
  reachable: true;
  revision: string | null;
  /** Part of #518: present only when a route of this workload is experimental
   *  or degraded, carrying `llamactl.io/qualification: experimental` (exclude)
   *  or `llamactl.io/qualification: degraded` (demote) so a peer rates the
   *  route the same way this node does. experimental wins when a workload has
   *  both. include=local-routes callers also get this label on journal
   *  workloads whose workload name matches such a local route. */
  labels?: Record<string, string>;
}

/** #306: no node_mem (the peer poller then rates pressure NORMAL) and no metrics. */
export interface LocalRoutesSnapshot {
  kind: "local-routes";
  ts: string;
  workloads: LocalRoutesSnapshotWorkload[];
}

export function readFleetSnapshot(
  opts: FleetSnapshotRouteOptions = {},
): ReturnType<typeof readLatestFleetSnapshotFromJournal> {
  const journalPath = opts.journalPath ?? defaultFleetJournalPath();
  const snapshot = readLatestFleetSnapshotFromJournal(journalPath);
  // A journal is not an authoritative declaration publisher.
  if (snapshot !== null) {
    Reflect.deleteProperty(snapshot, "declaredProvenance");
    Reflect.deleteProperty(snapshot, "declaredInventory");
  }
  return snapshot;
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** #518: the qualification stages a workload advertises to peers. Experimental
 *  is an exclusion, degraded a demotion; any other stage advertises nothing. */
type AdvertisedStage = "experimental" | "degraded";

/** #518: a `llamactl.io/qualification` label carrying `stage`. */
function qualificationLabel(stage: AdvertisedStage): Record<string, string> {
  return { [routingCapabilities.QUALIFICATION_LABEL]: stage };
}

/** Group routes by workload, keeping route order and dropping duplicate model
 *  ids, and advertise each workload's qualification stage (#518). */
export function buildLocalRoutesSnapshot(
  routes: readonly LocalRoute[],
  revisionOf: (name: string) => string | null,
  now: Date,
): LocalRoutesSnapshot | null {
  const byWorkload = new Map<string, LocalRoutesSnapshotWorkload>();
  for (const route of routes) {
    let entry = byWorkload.get(route.workload);
    if (entry === undefined) {
      entry = {
        name: route.workload,
        models: [],
        endpoint: `http://${urlHost(route.host)}:${String(route.port)}`,
        reachable: true,
        revision: revisionOf(route.workload),
      };
      byWorkload.set(route.workload, entry);
    }
    // #518: experimental outranks degraded, so a later degraded route never
    // overwrites an experimental label on the same workload.
    if (routingCapabilities.isExperimentalRoute(route)) {
      entry.labels = qualificationLabel("experimental");
    } else if (route.qualificationStage === "degraded" && entry.labels === undefined) {
      entry.labels = qualificationLabel("degraded");
    }
    if (!entry.models.includes(route.model)) {
      entry.models.push(route.model);
    }
  }
  if (byWorkload.size === 0) {
    return null;
  }
  return {
    kind: "local-routes",
    ts: now.toISOString(),
    workloads: [...byWorkload.values()],
  };
}

function wantsLocalRoutes(req: Request): boolean {
  try {
    return new URL(req.url).searchParams.getAll("include").includes("local-routes");
  } catch {
    return false;
  }
}

function localRoutesFallback(opts: FleetSnapshotRouteOptions): LocalRoutesSnapshot | null {
  try {
    const resolved = resolveEnv();
    const routes = opts.localRoutes ? opts.localRoutes() : listLocalRoutes(resolved);
    const revisionOf =
      opts.revisionOf ??
      ((name: string): string | null => {
        try {
          return readWorkloadEpoch({ name }, resolved);
        } catch {
          return null;
        }
      });
    return buildLocalRoutesSnapshot(routes, revisionOf, opts.now ? opts.now() : new Date());
  } catch {
    return null;
  }
}

/** #518: a journal workload plus the optional qualification label the
 *  include=local-routes overlay may add — fleet-supervisor's
 *  WorkloadSnapshot itself stays untouched. */
export type LabeledWorkloadSnapshot = WorkloadSnapshot & { labels?: Record<string, string> };

/** #518: a journal entry whose workloads may carry a qualification label. */
export type LabeledFleetSnapshotEntry = Omit<FleetSnapshotEntry, "workloads"> & {
  workloads: LabeledWorkloadSnapshot[];
};

/**
 * #518: overlay the qualification label the local routes advertise —
 * `llamactl.io/qualification: experimental` or `degraded` — onto journal
 * workloads whose workload name matches such a local route, so a peer poller
 * asking include=local-routes sees the same exclusion and demotion signals the
 * local-routes fallback advertises. experimental wins for a workload that has
 * both kinds of route, whatever the route order. Returns `entry` unchanged —
 * the same object — when there is nothing to label, when the route source
 * fails, or when no route is experimental or degraded; journal snapshots
 * otherwise win byte-identical. Never mutates `entry`.
 */
export function labelJournalExperimentalWorkloads(
  entry: FleetSnapshotEntry,
  opts: FleetSnapshotRouteOptions,
): FleetSnapshotEntry | LabeledFleetSnapshotEntry {
  if (!Array.isArray(entry.workloads) || entry.workloads.length === 0) {
    return entry;
  }
  let routes: LocalRoute[];
  try {
    routes = opts.localRoutes ? opts.localRoutes() : listLocalRoutes(resolveEnv());
  } catch {
    return entry;
  }
  const stages = new Map<string, AdvertisedStage>();
  for (const route of routes) {
    // Experimental outranks degraded, so a later degraded route never
    // overwrites an experimental label on the same workload.
    if (routingCapabilities.isExperimentalRoute(route)) {
      stages.set(route.workload, "experimental");
    } else if (route.qualificationStage === "degraded" && !stages.has(route.workload)) {
      stages.set(route.workload, "degraded");
    }
  }
  if (stages.size === 0) {
    return entry;
  }
  return {
    ...entry,
    workloads: entry.workloads.map((workload) => {
      const stage = stages.get(workload.name);
      return stage === undefined ? workload : { ...workload, labels: qualificationLabel(stage) };
    }),
  };
}

/**
 * #306: journal snapshot when present; else the local-routes fallback if
 * asked for. #518: include=local-routes callers also get the qualification
 * label overlaid onto journal workloads matching an experimental or degraded
 * local route; without the flag the journal entry is served unchanged.
 */
export function readFleetSnapshotOrLocalRoutes(
  opts: FleetSnapshotRouteOptions,
  includeLocalRoutes: boolean,
): FleetSnapshotEntry | LabeledFleetSnapshotEntry | LocalRoutesSnapshot | null {
  const latest = readFleetSnapshot(opts);
  if (latest !== null) {
    return includeLocalRoutes ? labelJournalExperimentalWorkloads(latest, opts) : latest;
  }
  // #306: only callers that ask (the internal proxy's peer poller) get the
  // local-routes fallback; supervisors and the CLI keep seeing 204.
  if (!includeLocalRoutes) return null;
  return localRoutesFallback(opts);
}

type PublishedDeclaration =
  | { declaredProvenance: routingCatalog.PeerDeclarationProvenanceV1 }
  | { declaredInventory: routingCatalog.PeerEmptyDeclarationInventory };

function readPublishedDeclaration(
  req: Request,
  source: FleetSnapshotRouteOptions["declaredProvenance"],
): PublishedDeclaration | undefined {
  const wantsProvenance =
    req.headers.get(routingCatalog.PEER_DECLARATION_PROVENANCE_HEADER) === "1";
  const wantsInventory = req.headers.get(routingCatalog.PEER_DECLARATION_INVENTORY_HEADER) === "2";
  if (source === undefined || (!wantsProvenance && !wantsInventory)) return undefined;
  try {
    const value = source.read();
    if (wantsProvenance) {
      const proof = routingCatalog.readPeerDeclarationProvenance(value, source.ownerNodeId);
      if (proof !== undefined) return { declaredProvenance: proof };
    }
    if (wantsInventory) {
      const inventory = routingCatalog.readEmptyPeerDeclarationInventory(value, source.ownerNodeId);
      if (inventory !== undefined) return { declaredInventory: inventory };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function handleFleetSnapshotRoute(
  req: Request,
  opts: FleetSnapshotRouteOptions = {},
): Response {
  const includeLocal = wantsLocalRoutes(req);
  const snapshot = readFleetSnapshotOrLocalRoutes(opts, includeLocal);
  const declaration = includeLocal
    ? readPublishedDeclaration(req, opts.declaredProvenance)
    : undefined;
  if (snapshot === null && declaration === undefined) {
    return new Response(null, { status: 204 });
  }
  const body = snapshot ?? {
    kind: "local-routes",
    ts: (opts.now?.() ?? new Date()).toISOString(),
    workloads: [],
  };
  return declaration === undefined
    ? Response.json(body)
    : Response.json({ ...body, ...declaration }, { headers: { "cache-control": "no-store" } });
}
