import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

// Import via '@llamactl/core' (NOT the relative core path) so this resolves to
// the SAME openaiProxy module instance serve.ts uses. Under bun the symlinked
// package path and the relative path are distinct module instances, so a
// relative import would publish to a productionPeerSnapshots the proxy never
// reads (routes silently never appear).
import { openaiProxy, routingCapabilities, routingCatalog } from "@llamactl/core";
import { resolveToken } from "@llamactl/core/config/kubeconfig";
import { listPeers, type PeerNode } from "@llamactl/core/config/peers";
import { callViaTunnelRelay } from "@llamactl/core/tunnel-relay";

import { makePinnedFetch } from "../client/links.js";

/**
 * Production peer-snapshot poller. Periodically fetches each cluster peer's
 * `/v1/fleet/snapshot` and publishes the result to the openaiProxy via
 * setPeerSnapshots, so cross-node (peer) models become routable through this
 * proxy with prefix-cache. listPeers() already excludes the local node and
 * carries the bearer token + pinned TLS cert; listClusterRoutes filters stale
 * (>30s) and HIGH-pressure peers, and local routes always win a model-id
 * collision — so publishing a peer's full model list is safe.
 */

interface RawFleetWorkload {
  name?: string;
  kind?: string;
  models?: unknown;
  endpoint?: string;
  reachable?: boolean;
  revision?: string | null;
  labels?: unknown;
}

interface RawFleetSnapshot {
  node_mem?: { free_mb?: number; inactive_mb?: number };
  workloads?: unknown;
  declaredProvenance?: unknown;
}

// Treat a peer as HIGH pressure (routes dropped by listClusterRoutes) only when
// AVAILABLE memory is genuinely low. On macOS `free_mb` alone is a poor signal —
// the OS holds most RAM as reclaimable `inactive` cache, so free_mb is routinely
// a few hundred MB even when GBs are available. Use free + inactive.
const HIGH_PRESSURE_AVAILABLE_MB = 768;
export const DEFAULT_PEER_FETCH_TIMEOUT_MS = 8_000;

function parseWorkloadPort(endpoint: string | undefined): number {
  if (!endpoint) return 0;
  try {
    return Number(new URL(endpoint).port) || 0;
  } catch {
    return 0;
  }
}

// #518: forward only the experimental or degraded qualification label onto a
// peer model row. A peer can add an exclusion or a demotion but never lift a
// locally inherited stage, so any other label, value or shape is dropped. The
// plain-object check rejects null, strings and arrays that a malformed snapshot
// could carry; the Array.isArray and getPrototypeOf guards are defence in depth
// with no observable effect on JSON-parsed input, which never yields those
// shapes.
function peerQualificationLabels(labels: unknown): Record<string, string> | undefined {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return undefined;
  if (Object.getPrototypeOf(labels) !== Object.prototype) return undefined;
  const record = labels as Record<string, unknown>;
  const stage = record[routingCapabilities.QUALIFICATION_LABEL];
  if (stage !== "experimental" && stage !== "degraded") return undefined;
  return { [routingCapabilities.QUALIFICATION_LABEL]: stage };
}

function isFleetWorkload(value: unknown): value is RawFleetWorkload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten reachable workloads into deduped { modelId, port, revision } rows. */
function collectPeerWorkloads(rawWorkloads: RawFleetWorkload[]): PeerSnapshot["workloads"] {
  const seen = new Set<string>();
  const workloads: PeerSnapshot["workloads"] = [];
  for (const w of rawWorkloads) {
    if (w.reachable === false || !Array.isArray(w.models)) continue;
    const port = parseWorkloadPort(w.endpoint);
    const revision = w.revision ?? null;
    const labels = peerQualificationLabels(w.labels);
    for (const modelId of w.models) {
      if (typeof modelId !== "string" || !modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      workloads.push({
        modelId,
        port,
        revision,
        ...(labels !== undefined ? { labels } : {}),
      });
    }
  }
  return workloads;
}

function allowsDeclarationProvenance(peer: PeerNode): boolean {
  // Tunnel hello names can share a bearer. This version requires a direct
  // connection using the configured peer's pinned certificate.
  return (
    peer.tunnelPreferred !== true &&
    peer.endpoint.startsWith("https://") &&
    Boolean(peer.certificate?.trim()) &&
    Boolean(peer.token?.trim())
  );
}

function uniqueWorkloadByAlias(
  workloads: RawFleetWorkload[],
): Map<string, RawFleetWorkload | null> {
  const aliases = new Map<string, RawFleetWorkload | null>();
  for (const workload of workloads) {
    if (!Array.isArray(workload.models)) continue;
    for (const model of new Set(workload.models)) {
      if (typeof model === "string") aliases.set(model, aliases.has(model) ? null : workload);
    }
  }
  return aliases;
}

function matchesWorkload(
  entry: routingCatalog.PeerDeclarationProvenanceV1["entries"][number],
  workload: RawFleetWorkload | null | undefined,
): boolean {
  if (workload === undefined) return entry.state !== "ready";
  if (workload?.name !== entry.workload) return false;
  if (workload.kind !== undefined && workload.kind !== entry.kind) return false;
  return entry.state !== "ready" || workload.reachable === true;
}

function readDeclarationProvenance(
  peer: PeerNode,
  value: unknown,
  workloads: RawFleetWorkload[],
): routingCatalog.PeerDeclarationProvenanceV1 | undefined {
  if (!allowsDeclarationProvenance(peer)) return undefined;
  const proof = routingCatalog.readPeerDeclarationProvenance(value, peer.id);
  if (proof === undefined) return undefined;
  const aliases = uniqueWorkloadByAlias(workloads);
  return proof.entries.every((entry) => matchesWorkload(entry, aliases.get(entry.id)))
    ? proof
    : undefined;
}

function computePeerPressure(nodeMem: RawFleetSnapshot["node_mem"]): PeerSnapshot["pressure"] {
  let availableMb: number | null = null;
  if (nodeMem && (typeof nodeMem.free_mb === "number" || typeof nodeMem.inactive_mb === "number")) {
    availableMb = (nodeMem.free_mb ?? 0) + (nodeMem.inactive_mb ?? 0);
  }
  return availableMb !== null && availableMb < HIGH_PRESSURE_AVAILABLE_MB ? "HIGH" : "NORMAL";
}

function resolveTunnelRelayToken(peer: PeerNode): string {
  if (peer.tunnelRelayToken) return peer.tunnelRelayToken;
  if (peer.token) return peer.token;
  if (peer.tunnelRelayTokenRef)
    return resolveToken({ name: peer.id, tokenRef: peer.tunnelRelayTokenRef });
  if (peer.tokenRef) return resolveToken({ name: peer.id, tokenRef: peer.tokenRef });
  throw new Error(`peer ${peer.id} has tunnelPreferred=true but no tunnel relay bearer set`);
}

async function readPeerSnapshotDirectWithTimeout(
  peer: PeerNode,
  timeoutMs: number,
): Promise<RawFleetSnapshot | null> {
  const headers: Record<string, string> = {};
  if (peer.token) headers["authorization"] = `Bearer ${peer.token}`;
  const negotiatedProof = allowsDeclarationProvenance(peer);
  if (negotiatedProof) headers[routingCatalog.PEER_DECLARATION_PROVENANCE_HEADER] = "1";
  const pinnedFetch = makePinnedFetch({
    name: peer.id,
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    certificateFingerprint: peer.fingerprint,
    tlsServerName: peer.tlsServerName,
  });
  // #306: ask agents without a fleet journal for their local routes; older agents ignore the parameter.
  const target = new URL("/v1/fleet/snapshot?include=local-routes", peer.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await pinnedFetch(target, {
      method: "GET",
      headers,
      signal: controller.signal,
      ...(negotiatedProof ? { redirect: "error" } : {}),
    });
    if (!res.ok) {
      // Discarding the response leaves Bun transferring its body after this tick.
      controller.abort();
      return null;
    }
    return (await Promise.race([
      res.json(),
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new Error("peer snapshot fetch timed out"));
          return;
        }
        controller.signal.addEventListener(
          "abort",
          (): void => {
            reject(new Error("peer snapshot fetch timed out"));
          },
          { once: true },
        );
      }),
    ]).catch(() => null)) as RawFleetSnapshot | null;
  } catch {
    return null; // unreachable / TLS error / timeout -> no peer routes this tick
  } finally {
    clearTimeout(timer);
  }
}

async function readPeerSnapshotDirect(peer: PeerNode): Promise<RawFleetSnapshot | null> {
  return await readPeerSnapshotDirectWithTimeout(peer, DEFAULT_PEER_FETCH_TIMEOUT_MS);
}

async function readPeerSnapshotViaTunnel(peer: PeerNode): Promise<RawFleetSnapshot | null> {
  if (!peer.tunnelCentralUrl) {
    throw new Error(
      `peer ${peer.id} has tunnelPreferred=true but no tunnelCentralUrl set; cannot route via reverse tunnel`,
    );
  }
  const result = await callViaTunnelRelay({
    centralUrl: peer.tunnelCentralUrl,
    nodeName: peer.tunnelNodeName ?? peer.id,
    method: "fleetSnapshot",
    // #306: older agents ignore the input and keep returning the journal snapshot or null.
    input: { include: ["local-routes"] },
    bearer: resolveTunnelRelayToken(peer),
    type: "query",
    ...(peer.tunnelCentralCertificate ? { pinnedCa: peer.tunnelCentralCertificate } : {}),
    ...(peer.tunnelCentralFingerprint
      ? { expectedFingerprint: peer.tunnelCentralFingerprint }
      : {}),
  });
  return result as RawFleetSnapshot | null;
}

async function fetchPeerSnapshot(
  peer: PeerNode,
  nowMs: number,
  timeoutMs: number = DEFAULT_PEER_FETCH_TIMEOUT_MS,
): Promise<PeerSnapshot | null> {
  const snap =
    peer.tunnelPreferred === true
      ? await readPeerSnapshotViaTunnel(peer).catch(() => null)
      : await readPeerSnapshotDirectWithTimeout(peer, timeoutMs).catch(() => null);
  if (!snap || !Array.isArray(snap.workloads)) return null;

  const rawWorkloads = snap.workloads.filter(isFleetWorkload);
  const workloads = collectPeerWorkloads(rawWorkloads);
  const declaredProvenance = readDeclarationProvenance(peer, snap.declaredProvenance, rawWorkloads);
  if (workloads.length === 0 && declaredProvenance === undefined) return null;
  return {
    workloads,
    ...(declaredProvenance === undefined ? {} : { declaredProvenance }),
    pressure: computePeerPressure(snap.node_mem),
    fetchedAt: nowMs,
  };
}

function withoutDeclarationProvenance(snapshot: PeerSnapshot): PeerSnapshot {
  if (snapshot.declaredProvenance === undefined) return snapshot;
  const { declaredProvenance: _discarded, ...legacy } = snapshot;
  return legacy;
}

function duplicatePeerIds(peers: PeerNode[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of peers) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

export interface PeerSnapshotPollerOptions {
  intervalMs?: number;
  nowFn?: () => number;
  /** Override peer discovery (tests). Defaults to listPeers(). */
  listPeersFn?: () => PeerNode[];
  /** Override the per-peer fetch (tests). */
  fetchFn?: (peer: PeerNode, nowMs: number) => Promise<PeerSnapshot | null>;
  /** Timeout for direct per-peer snapshot fetch + JSON body read. */
  peerSnapshotFetchTimeoutMs?: number;
  /** Override the publish sink (tests). Defaults to setPeerSnapshots. */
  publish?: (snapshots: Map<string, PeerSnapshot>) => void;
}

/**
 * Start the poller. Runs one tick immediately, then every intervalMs. Returns a
 * stop function. A no-peer cluster publishes an empty map (local-only routing).
 */
export function startPeerSnapshotPoller(opts: PeerSnapshotPollerOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 15_000;
  const nowFn = opts.nowFn ?? ((): number => Date.now());
  const discover = opts.listPeersFn ?? ((): PeerNode[] => listPeers());
  const peerSnapshotFetchTimeoutMs =
    opts.peerSnapshotFetchTimeoutMs ?? DEFAULT_PEER_FETCH_TIMEOUT_MS;
  const fetchOne =
    opts.fetchFn ??
    ((peer: PeerNode, nowMs: number): Promise<PeerSnapshot | null> =>
      fetchPeerSnapshot(peer, nowMs, peerSnapshotFetchTimeoutMs));
  const publish = opts.publish ?? openaiProxy.setPeerSnapshots;
  let stopped = false;
  let inflight = false;
  let lastPublished = new Map<string, PeerSnapshot>();
  const isStopped = (): boolean => stopped;

  const discoverPeers = (): PeerNode[] | null => {
    try {
      return discover();
    } catch {
      // A broken kubeconfig cannot vouch for the previous set of owners.
      if ([...lastPublished.values()].some((snap) => snap.declaredProvenance !== undefined)) {
        const legacy = new Map(
          [...lastPublished].map(([id, snap]) => [id, withoutDeclarationProvenance(snap)]),
        );
        publish(legacy);
        lastPublished = legacy;
      }
      return null;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const peers = discoverPeers();
      if (peers === null) return;
      const duplicates = duplicatePeerIds(peers);
      // Seed with the previous snapshot for each still-configured peer so a
      // single transient fetch failure (TLS keepalive, a 204 between supervisor
      // journal writes) does NOT wipe the peer's routes. listClusterRoutes
      // still drops a snapshot once it ages past its staleness window, so a
      // genuinely-down peer falls out on its own; peers removed from the config
      // are dropped immediately by not seeding them.
      const next = new Map<string, PeerSnapshot>();
      for (const peer of peers) {
        const prev = lastPublished.get(peer.id);
        if (prev !== undefined) next.set(peer.id, withoutDeclarationProvenance(prev));
      }
      const nowMs = nowFn();
      await Promise.all(
        peers.map(async (peer) => {
          try {
            const snap = await fetchOne(peer, nowMs);
            if (snap) {
              next.set(
                peer.id,
                duplicates.has(peer.id) ? withoutDeclarationProvenance(snap) : snap,
              );
            }
          } catch {
            // Per-peer failure must not block peers already in flight.
          }
        }),
      );
      if (!isStopped()) {
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
          process.stderr.write(
            `[peer-poll] published ${String(next.size)} peer(s); models=[${after}]\n`,
          );
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

export const __peerSnapshotInternals = { fetchPeerSnapshot, DEFAULT_PEER_FETCH_TIMEOUT_MS };
