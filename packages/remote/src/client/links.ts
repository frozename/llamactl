import type { TRPCLink } from '@trpc/client';
import {
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { EventSource } from 'eventsource';
import {
  fingerprintsEqual,
  computeFingerprint,
} from '../server/tls.js';
import type { ClusterNode } from '../config/schema.js';

/**
 * Cycle-free link builder shared by `node-client.ts` (typed AppRouter
 * client) and the workload procedures inside `router.ts` (which need a
 * remote forwarder but must not import AppRouter). Keep this file free
 * of any router-type imports so neither consumer pulls a circular alias.
 */

type FetchInput = string | URL | Request;
type PinnedFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

// eventsource@4's FetchLike is a stripped-down RequestInit. We widen to
// a loose shape that our pinned fetch wrapper can satisfy.
type EventSourceFetchLike = (
  url: string | URL,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; body?: unknown },
) => Promise<Response>;

export function makePinnedFetch(node: ClusterNode): PinnedFetch {
  const ca = node.certificate;
  const expectedFp = node.certificateFingerprint ?? null;
  if (expectedFp && ca) {
    // Defensive: the supplied PEM's fingerprint must match the stored
    // fingerprint, in case kubeconfig was tampered with between writes.
    const actual = computeFingerprint(ca);
    if (!fingerprintsEqual(actual, expectedFp)) {
      throw new Error(
        `certificate fingerprint mismatch for node '${node.name}': ` +
        `expected ${expectedFp}, got ${actual}`,
      );
    }
  }

  return async (input, init) => {
    // Bun's fetch accepts a `tls` option that ignores system roots and
    // trusts only the provided CA list. Since the agent's self-signed
    // cert is also its own CA, this pins the TLS handshake to exactly
    // that cert.
    const extraInit = ca ? { tls: { ca } } : {};
    return fetch(input as FetchInput, { ...init, ...extraInit } as RequestInit);
  };
}

/**
 * Build the tRPC link array that carries a bearer token and pinned TLS
 * to a remote agent. Subscriptions go over SSE (eventsource ponyfill on
 * Bun); queries/mutations go over httpBatchLink. Returns `TRPCLink[]`
 * cast to `any` to avoid leaking an AppRouter dependency into this
 * file — the consumer annotates their `createTRPCClient` call with the
 * concrete router type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPinnedLinks(node: ClusterNode, token: string): TRPCLink<any>[] {
  const pinnedFetch = makePinnedFetch(node);
  const trpcUrl = `${node.endpoint}/trpc`;
  const authHeader = `Bearer ${token}`;
  return [
    splitLink({
      condition: (op) => op.type === 'subscription',
      // SSE path for subscriptions. Bun has no global EventSource, so
      // we ponyfill with `eventsource@4`; tRPC's SSE link routes its
      // HTTP calls through the ponyfill's `fetch` override, which lets
      // us carry the pinned-TLS CA and the bearer token that the
      // agent's auth middleware requires.
      true: httpSubscriptionLink({
        url: trpcUrl,
        EventSource,
        eventSourceOptions: {
          fetch: ((url: string | URL, init?: Record<string, unknown>) =>
            pinnedFetch(url as string, {
              ...(init as RequestInit | undefined),
              headers: {
                ...((init?.['headers'] as Record<string, string> | undefined) ?? {}),
                authorization: authHeader,
              },
            })) as unknown as EventSourceFetchLike,
        },
      }),
      false: httpBatchLink({
        url: trpcUrl,
        headers: { authorization: authHeader },
        // Bun's native fetch and tRPC's internal FetchEsque type
        // differ on ReadableStream generics; the runtime shapes are
        // compatible so we erase the TS mismatch here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetch: pinnedFetch as any,
      }),
    }),
  ];
}
