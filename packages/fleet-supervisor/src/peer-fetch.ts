import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import type { FleetSnapshotEntry } from './types.js';
import type { AggregatorPeer } from './aggregator.js';

interface PeerFetchResult {
  statusCode: number;
  body: string;
}

function doRequest(peer: AggregatorPeer): Promise<PeerFetchResult> {
  const ca = peer.caPemPath ? readFileSync(peer.caPemPath, 'utf8') : undefined;
  const agent = ca ? new Agent({ ca }) : undefined;
  const target = new URL('/v1/fleet/snapshot', peer.endpoint);
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'GET',
        ...(agent ? { agent } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function createPeerFetch(
  peer: AggregatorPeer,
): () => Promise<FleetSnapshotEntry | null> {
  return async () => {
    const result = await doRequest(peer);
    if (result.statusCode === 204) return null;
    if (result.statusCode !== 200) {
      throw new Error(`peer ${peer.id} returned ${result.statusCode}`);
    }
    return JSON.parse(result.body) as FleetSnapshotEntry;
  };
}
