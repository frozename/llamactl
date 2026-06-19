import type { AggregatorPeer } from "./aggregator.js";
import type { FleetSnapshotEntry } from "./types.js";

import { resolveToken } from "../../remote/src/config/kubeconfig.js";

interface PeerFetchResult {
  statusCode: number;
  body: string;
}

export interface PeerFetchOptions {
  timeoutMs?: number;
}

const DEFAULT_PEER_FETCH_TIMEOUT_MS = 8_000;
const loggedTokenWarnings = new Set<string>();

function resolvedPeerToken(peer: AggregatorPeer): string | undefined {
  if (peer.token) return peer.token;
  if (!peer.tokenRef) return undefined;
  try {
    return resolveToken({ name: peer.id, tokenRef: peer.tokenRef });
  } catch (err) {
    const key = `${peer.id}:${peer.endpoint}`;
    if (!loggedTokenWarnings.has(key)) {
      console.warn(`unable to resolve token for peer '${peer.id}': ${(err as Error).message}`);
      loggedTokenWarnings.add(key);
    }
    return undefined;
  }
}

async function doRequest(
  peer: AggregatorPeer,
  opts: PeerFetchOptions = {},
): Promise<PeerFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PEER_FETCH_TIMEOUT_MS;
  const headers: Record<string, string> = {};
  const token = resolvedPeerToken(peer);
  if (token) headers.authorization = `Bearer ${token}`;
  const target = new URL("/v1/fleet/snapshot", peer.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const init: RequestInit & { tls?: { ca: string } } = {
    method: "GET",
    signal: controller.signal,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(peer.certificate ? { tls: { ca: peer.certificate } } : {}),
  };
  try {
    const res = await fetch(target.toString(), init);
    return {
      statusCode: res.status,
      body: await res.text(),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`peer ${peer.id} snapshot timed out after ${String(timeoutMs)}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createPeerFetch(
  peer: AggregatorPeer,
  opts: PeerFetchOptions = {},
): () => Promise<FleetSnapshotEntry | null> {
  return async () => {
    const result = await doRequest(peer, opts);
    if (result.statusCode === 204) return null;
    if (result.statusCode !== 200) {
      throw new Error(`peer ${peer.id} returned ${String(result.statusCode)}`);
    }
    return JSON.parse(result.body) as FleetSnapshotEntry;
  };
}
