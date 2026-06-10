// Import via '@llamactl/core' (NOT the relative core path) so this resolves to
// the SAME openaiProxy module instance serve.ts uses. Under bun the symlinked
// package path and the relative path are distinct module instances, so a
// relative import would publish to a productionPeerSnapshots the proxy never
// reads (routes silently never appear).
import { openaiProxy } from "@llamactl/core";
import type { PeerSnapshot } from "../../../core/src/workloadRuntime.js";
import { listPeers, type PeerNode } from "../config/peers.js";
import { makePinnedFetch } from "../client/links.js";
import type { ClusterNode } from "../config/schema.js";

/**
 * Production peer-snapshot poller. Periodically fetches each cluster peer's
 * `/v1/fleet/snapshot` and publishes the result to the openaiProxy via
 * setPeerSnapshots, so cross-node (peer) models become routable through this
 * proxy with prefix-cache. listPeers() already excludes the local node and
 * carries the bearer token + pinned TLS cert; listClusterRoutes filters stale
 * (>30s) and HIGH-pressure peers, and local routes always win a model-id
 * collision — so publishing a peer's full model list is safe.
 */

interface RawFleetSnapshot {
  node_mem?: { free_mb?: number; inactive_mb?: number };
  workloads?: Array<{
    models?: string[];
    endpoint?: string;
    reachable?: boolean;
    revision?: string | null;
  }>;
}

// Treat a peer as HIGH pressure (routes dropped by listClusterRoutes) only when
// AVAILABLE memory is genuinely low. On macOS `free_mb` alone is a poor signal —
// the OS holds most RAM as reclaimable `inactive` cache, so free_mb is routinely
// a few hundred MB even when GBs are available. Use free + inactive.
const HIGH_PRESSURE_AVAILABLE_MB = 768;

async function fetchPeerSnapshot(peer: PeerNode, nowMs: number): Promise<PeerSnapshot | null> {
  const headers: Record<string, string> = {};
  if (peer.token) headers.authorization = `Bearer ${peer.token}`;
  const pinnedFetch = makePinnedFetch({
    name: peer.id,
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    fingerprint: peer.fingerprint,
  } as ClusterNode);
  const target = new URL("/v1/fleet/snapshot", peer.endpoint);
  let res: Response;
  try {
    res = await pinnedFetch(target, { method: "GET", headers });
  } catch {
    return null; // unreachable / TLS error -> no peer routes this tick
  }
  if (!res.ok) return null; // 204 (no journal entry yet) or error
  const snap = (await res.json().catch(() => null)) as RawFleetSnapshot | null;
  if (!snap?.workloads?.length) return null;

  const seen = new Set<string>();
  const workloads: Array<{ modelId: string; port: number; revision?: string | null }> = [];
  for (const w of snap.workloads) {
    if (w.reachable === false) continue;
    let port = 0;
    if (w.endpoint) {
      try {
        port = Number(new URL(w.endpoint).port) || 0;
      } catch {
        port = 0;
      }
    }
    const revision = w.revision ?? null;
    for (const modelId of w.models ?? []) {
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      workloads.push({ modelId, port, revision });
    }
  }
  if (workloads.length === 0) return null;
  const nm = snap.node_mem;
  const availableMb =
    typeof nm?.free_mb === "number" || typeof nm?.inactive_mb === "number"
      ? (nm?.free_mb ?? 0) + (nm?.inactive_mb ?? 0)
      : null;
  const pressure: PeerSnapshot["pressure"] =
    availableMb !== null && availableMb < HIGH_PRESSURE_AVAILABLE_MB ? "HIGH" : "NORMAL";
  return { workloads, pressure, fetchedAt: nowMs };
}

export interface PeerSnapshotPollerOptions {
  intervalMs?: number;
  nowFn?: () => number;
  /** Override peer discovery (tests). Defaults to listPeers(). */
  listPeersFn?: () => PeerNode[];
  /** Override the per-peer fetch (tests). */
  fetchFn?: (peer: PeerNode, nowMs: number) => Promise<PeerSnapshot | null>;
  /** Override the publish sink (tests). Defaults to setPeerSnapshots. */
  publish?: (snapshots: Map<string, PeerSnapshot>) => void;
}

/**
 * Start the poller. Runs one tick immediately, then every intervalMs. Returns a
 * stop function. A no-peer cluster publishes an empty map (local-only routing).
 */
export function startPeerSnapshotPoller(opts: PeerSnapshotPollerOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 15_000;
  const nowFn = opts.nowFn ?? (() => Date.now());
  const discover = opts.listPeersFn ?? (() => listPeers());
  const fetchOne = opts.fetchFn ?? fetchPeerSnapshot;
  const publish = opts.publish ?? openaiProxy.setPeerSnapshots;
  let stopped = false;
  let inflight = false;
  let lastPublished = new Map<string, PeerSnapshot>();

  const tick = async (): Promise<void> => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const peers = discover();
      // Seed with the previous snapshot for each still-configured peer so a
      // single transient fetch failure (TLS keepalive, a 204 between supervisor
      // journal writes) does NOT wipe the peer's routes. listClusterRoutes
      // still drops a snapshot once it ages past its staleness window, so a
      // genuinely-down peer falls out on its own; peers removed from the config
      // are dropped immediately by not seeding them.
      const next = new Map<string, PeerSnapshot>();
      for (const peer of peers) {
        const prev = lastPublished.get(peer.id);
        if (prev) next.set(peer.id, prev);
      }
      await Promise.all(
        peers.map(async (peer) => {
          const snap = await fetchOne(peer, nowFn());
          if (snap) next.set(peer.id, snap);
        }),
      );
      if (!stopped) {
        const before = [...lastPublished.values()]
          .flatMap((s) => s.workloads.map((w) => w.modelId))
          .sort()
          .join(",");
        const after = [...next.values()]
          .flatMap((s) => s.workloads.map((w) => w.modelId))
          .sort()
          .join(",");
        lastPublished = next;
        publish(next);
        if (before !== after) {
          process.stderr.write(`[peer-poll] published ${next.size} peer(s); models=[${after}]\n`);
        }
      }
    } catch {
      // Keep the previous published snapshots on a transient failure.
    } finally {
      inflight = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export const __peerSnapshotInternals = { fetchPeerSnapshot };
