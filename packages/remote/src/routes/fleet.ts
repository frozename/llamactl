import { routingCapabilities } from "@llamactl/core";
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
}

/** #306: one workload of the minimal snapshot served when the journal has no entry. */
export interface LocalRoutesSnapshotWorkload {
  name: string;
  models: string[];
  endpoint: string;
  reachable: true;
  revision: string | null;
  /** Part of #518: present only when a route is experimental, carrying
   *  `llamactl.io/qualification: experimental` so a peer can exclude it.
   *  include=local-routes callers also get this label on journal workloads
   *  whose workload name matches an experimental local route. */
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
  return readLatestFleetSnapshotFromJournal(journalPath);
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Group routes by workload, keeping route order and dropping duplicate model ids. */
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
    if (routingCapabilities.isExperimentalRoute(route)) {
      entry.labels = { [routingCapabilities.QUALIFICATION_LABEL]: "experimental" };
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

/** #518: a journal workload plus the optional experimental label the
 *  include=local-routes overlay may add — fleet-supervisor's
 *  WorkloadSnapshot itself stays untouched. */
export type LabeledWorkloadSnapshot = WorkloadSnapshot & { labels?: Record<string, string> };

/** #518: a journal entry whose workloads may carry the experimental label. */
export type LabeledFleetSnapshotEntry = Omit<FleetSnapshotEntry, "workloads"> & {
  workloads: LabeledWorkloadSnapshot[];
};

/**
 * #518: overlay `llamactl.io/qualification: experimental` onto journal
 * workloads whose workload name matches an experimental local route, so a
 * peer poller asking include=local-routes sees the same exclusion signal
 * the local-routes fallback advertises. Returns `entry` unchanged — the
 * same object — when there is nothing to label, when the route source
 * fails, or when no route is experimental; journal snapshots otherwise win
 * byte-identical. Never mutates `entry`.
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
  const experimental = new Set(
    routes
      .filter((route) => routingCapabilities.isExperimentalRoute(route))
      .map((route) => route.workload),
  );
  if (experimental.size === 0) {
    return entry;
  }
  return {
    ...entry,
    workloads: entry.workloads.map((workload) =>
      experimental.has(workload.name)
        ? {
            ...workload,
            labels: { [routingCapabilities.QUALIFICATION_LABEL]: "experimental" },
          }
        : workload,
    ),
  };
}

/**
 * #306: journal snapshot when present; else the local-routes fallback if
 * asked for. #518: include=local-routes callers also get the experimental
 * label overlaid onto journal workloads matching an experimental local
 * route; without the flag the journal entry is served unchanged.
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

export function handleFleetSnapshotRoute(
  req: Request,
  opts: FleetSnapshotRouteOptions = {},
): Response {
  const snapshot = readFleetSnapshotOrLocalRoutes(opts, wantsLocalRoutes(req));
  if (snapshot === null) return new Response(null, { status: 204 });
  return Response.json(snapshot, { status: 200 });
}
