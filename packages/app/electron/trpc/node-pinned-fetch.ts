import { Agent } from 'undici';
import {
  assertFingerprintMatch,
  type ClusterNode,
  type PinnedFetch,
} from '@llamactl/remote';

/**
 * Electron main runs Node.js (not Bun), so Bun's `fetch({ tls: { ca } })`
 * option is a no-op there. Node's built-in fetch (undici) accepts a
 * per-request `dispatcher` — a pre-configured undici Agent carries the
 * pinned CA through the TLS handshake, rejecting any cert chain that
 * doesn't terminate at the agent's self-signed certificate.
 *
 * We pass this as the `fetchFactory` argument to
 * `buildPinnedLinks(node, token, makeNodePinnedFetch)`; downstream the
 * tRPC links call it for every HTTP request, including SSE subscription
 * bootstrapping through eventsource@4.
 */
export function makeNodePinnedFetch(node: ClusterNode): PinnedFetch {
  assertFingerprintMatch(node);
  const ca = node.certificate;
  const dispatcher = ca
    ? new Agent({ connect: { ca } })
    : undefined;

  return async (input: string | URL | Request, init?: RequestInit) => {
    const extra = dispatcher ? { dispatcher } : {};
    return fetch(input as string | URL, {
      ...init,
      ...extra,
    } as RequestInit);
  };
}
