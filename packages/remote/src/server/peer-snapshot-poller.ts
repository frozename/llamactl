import { setPeerSnapshots } from '../../../core/src/openaiProxy.js';
import type { PeerSnapshot } from '../../../core/src/workloadRuntime.js';
import { listPeers, type PeerNode } from '../config/peers.js';
import { makePinnedFetch } from '../client/links.js';
import type { ClusterNode } from '../config/schema.js';

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
  node_mem?: { free_mb?: number };
  workloads?: Array<{ models?: string[]; endpoint?: string; reachable?: boolean }>;
}

// Below this free memory the peer is treated as HIGH pressure and its routes
// are dropped by listClusterRoutes — avoids piling work onto a thrashing node.
const HIGH_PRESSURE_FREE_MB = 1024;

async function fetchPeerSnapshot(peer: PeerNode, nowMs: number): Promise<PeerSnapshot | null> {
  const headers: Record<string, string> = {};
  if (peer.token) headers.authorization = `Bearer ${peer.token}`;
  const pinnedFetch = makePinnedFetch({
    name: peer.id,
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    fingerprint: peer.fingerprint,
  } as ClusterNode);
  const target = new URL('/v1/fleet/snapshot', peer.endpoint);
  let res: Response;
  try {
    res = await pinnedFetch(target, { method: 'GET', headers });
  } catch {
    return null; // unreachable / TLS error -> no peer routes this tick
  }
  if (!res.ok) return null; // 204 (no journal entry yet) or error
  const snap = (await res.json().catch(() => null)) as RawFleetSnapshot | null;
  if (!snap?.workloads?.length) return null;

  const seen = new Set<string>();
  const workloads: Array<{ modelId: string; port: number }> = [];
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
    for (const modelId of w.models ?? []) {
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      workloads.push({ modelId, port });
    }
  }
  if (workloads.length === 0) return null;
  const freeMb = snap.node_mem?.free_mb;
  const pressure: PeerSnapshot['pressure'] =
    typeof freeMb === 'number' && freeMb < HIGH_PRESSURE_FREE_MB ? 'HIGH' : 'NORMAL';
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
  const publish = opts.publish ?? setPeerSnapshots;
  let stopped = false;
  let inflight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const peers = discover();
      const map = new Map<string, PeerSnapshot>();
      await Promise.all(
        peers.map(async (peer) => {
          const snap = await fetchOne(peer, nowFn());
          if (snap) map.set(peer.id, snap);
        }),
      );
      if (!stopped) publish(map);
    } catch {
      // Keep the previous published snapshots on a transient failure.
    } finally {
      inflight = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export const __peerSnapshotInternals = { fetchPeerSnapshot };
