import { resolveEnv } from "@llamactl/core/env";
import { readWorkloadEpoch } from "@llamactl/core/kvstore";
import { listLocalRoutes, type LocalRoute } from "@llamactl/core/workloadRuntime";
import {
  defaultFleetJournalPath,
  readLatestFleetSnapshotFromJournal,
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

export function handleFleetSnapshotRoute(
  req: Request,
  opts: FleetSnapshotRouteOptions = {},
): Response {
  const latest = readFleetSnapshot(opts);
  if (latest !== null) return Response.json(latest, { status: 200 });
  // #306: only callers that ask (the internal proxy's peer poller) get the
  // local-routes fallback; supervisors and the CLI keep seeing 204.
  if (!wantsLocalRoutes(req)) return new Response(null, { status: 204 });
  const fallback = localRoutesFallback(opts);
  if (fallback === null) return new Response(null, { status: 204 });
  return Response.json(fallback, { status: 200 });
}
