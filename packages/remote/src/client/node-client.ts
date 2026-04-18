import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { EventSource } from 'eventsource';
import { router as appRouter, type AppRouter } from '../router.js';
import {
  fingerprintsEqual,
  computeFingerprint,
} from '../server/tls.js';
import {
  resolveNode,
  resolveToken,
} from '../config/kubeconfig.js';
import {
  LOCAL_NODE_ENDPOINT,
  type ClusterNode,
  type Config,
} from '../config/schema.js';

export type NodeClient = ReturnType<typeof createTRPCClient<AppRouter>>;

export interface NodeClientOptions {
  /** If omitted, uses the current-context's defaultNode. */
  nodeName?: string;
  /** Override context by name (ignores currentContext). */
  contextName?: string;
  /** Override process.env used for tokenRef path expansion. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves a node from kubeconfig + context + user, then returns a
 * ready-to-use tRPC proxy client. For the `local` sentinel this
 * short-circuits to `router.createCaller({})` — no HTTP, zero
 * serialization, identical type surface. For remote nodes it
 * configures httpBatchLink with pinned-cert TLS (as CA) and a bearer
 * Authorization header.
 */
export function createNodeClient(config: Config, opts: NodeClientOptions = {}): NodeClient {
  const nodeName = opts.nodeName ?? resolveDefaultNodeName(config, opts.contextName);
  const { node, user } = resolveNode(config, nodeName, opts.contextName);

  if (node.endpoint === LOCAL_NODE_ENDPOINT) {
    return proxyFromCaller();
  }
  const token = resolveToken(user, opts.env);
  return proxyFromHttp(node, token);
}

function resolveDefaultNodeName(config: Config, contextName?: string): string {
  const ctx = contextName
    ? config.contexts.find((c) => c.name === contextName)
    : config.contexts.find((c) => c.name === config.currentContext);
  if (!ctx) throw new Error(`context '${contextName ?? config.currentContext}' not found`);
  return ctx.defaultNode;
}

/**
 * Wraps `router.createCaller({})` in a surface that mimics tRPC's proxy
 * client so `client.foo.query(...)` / `.mutate(...)` work identically
 * across local and remote paths. The receiver sees an identical type
 * surface either way.
 */
function proxyFromCaller(): NodeClient {
  const caller = appRouter.createCaller({}) as unknown as Record<string, (...args: unknown[]) => unknown>;
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (typeof caller[prop] !== 'function') return undefined;
      // Binding tRPC v10's caller proxy via .bind() breaks path
      // tracking; wrapping each call as a fresh invocation preserves
      // the proxy's per-call context. The .query/.mutate/.subscribe
      // surface mirrors the remote proxy client so downstream code
      // treats both paths identically.
      const invoke = (...args: unknown[]): unknown => caller[prop]!(...args);
      return { query: invoke, mutate: invoke, subscribe: invoke };
    },
  };
  return new Proxy({}, handler) as NodeClient;
}

function proxyFromHttp(node: ClusterNode, token: string): NodeClient {
  const pinnedFetch = makePinnedFetch(node);
  const trpcUrl = `${node.endpoint}/trpc`;
  const authHeader = `Bearer ${token}`;
  return createTRPCClient<AppRouter>({
    links: [
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
        // Query + mutation path — same httpBatchLink as before.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    ],
  });
}

// eventsource@4's FetchLike is a stripped-down RequestInit. We widen to
// a loose shape that our pinned fetch wrapper can satisfy.
type EventSourceFetchLike = (
  url: string | URL,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; body?: unknown },
) => Promise<Response>;

type FetchInput = string | URL | Request;
type PinnedFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

function makePinnedFetch(node: ClusterNode): PinnedFetch {
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

/** Exposed for callers that already have an agent's URL+token+cert. */
export function createRemoteNodeClient(opts: {
  url: string;
  token: string;
  certificate?: string;
  certificateFingerprint?: string;
}): NodeClient {
  return proxyFromHttp(
    {
      name: 'ad-hoc',
      endpoint: opts.url,
      certificate: opts.certificate,
      certificateFingerprint: opts.certificateFingerprint,
    },
    opts.token,
  );
}
