import type { FleetSnapshotEntry } from "./types.js";
import type { AggregatorPeer } from "./aggregator.js";
import { resolveToken } from "../../remote/src/config/kubeconfig.js";

interface PeerFetchResult {
  statusCode: number;
  body: string;
}

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

function doRequest(peer: AggregatorPeer): Promise<PeerFetchResult> {
  const headers: Record<string, string> = {};
  const token = resolvedPeerToken(peer);
  if (token) headers.authorization = `Bearer ${token}`;
  const target = new URL("/v1/fleet/snapshot", peer.endpoint);
  const init: RequestInit & { tls?: { ca: string } } = {
    method: "GET",
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(peer.certificate ? { tls: { ca: peer.certificate } } : {}),
  };
  return fetch(target.toString(), init).then(async (res) => ({
    statusCode: res.status,
    body: await res.text(),
  }));
}

export function createPeerFetch(peer: AggregatorPeer): () => Promise<FleetSnapshotEntry | null> {
  return async () => {
    const result = await doRequest(peer);
    if (result.statusCode === 204) return null;
    if (result.statusCode !== 200) {
      throw new Error(`peer ${peer.id} returned ${result.statusCode}`);
    }
    return JSON.parse(result.body) as FleetSnapshotEntry;
  };
}
