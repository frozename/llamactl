import { createTRPCClient } from '@trpc/client';
import { router as appRouter, type AppRouter } from '../router.js';
import { buildPinnedLinks } from './links.js';
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

/**
 * Minimal shape of the tunnel-server `send` call that the
 * dispatcher uses when routing through a reverse tunnel. Kept
 * interface-typed here so `@llamactl/remote/client/node-client`
 * doesn't import tunnel-server itself — the caller hands in a
 * function that maps a tRPC procedure + input to a single tunnel
 * req/res round-trip.
 *
 * The adapter MUST be supplied an object whose `id` is unique per
 * call; the server handle from `createTunnelServer().send` already
 * requires callers to provide this.
 */
export type TunnelSendFn = (req: {
  id: string;
  method: string;
  params: unknown;
}) => Promise<{
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}>;

export interface NodeClientOptions {
  /** If omitted, uses the current-context's defaultNode. */
  nodeName?: string;
  /** Override context by name (ignores currentContext). */
  contextName?: string;
  /** Override process.env used for tokenRef path expansion. */
  env?: NodeJS.ProcessEnv;
  /**
   * Reverse-tunnel dispatcher (I.3.3). When the resolved node has
   * `tunnelPreferred: true` AND this callable is supplied, queries
   * + mutations route through the tunnel instead of opening a
   * pinned HTTPS tRPC client. Subscriptions still fall through to
   * HTTPS for now — the tunnel frame protocol is req/res-only.
   */
  tunnelSend?: TunnelSendFn;
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
  if (node.tunnelPreferred === true && opts.tunnelSend) {
    return proxyFromTunnel(opts.tunnelSend, nodeName);
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
  return createTRPCClient<AppRouter>({
    links: buildPinnedLinks(node, token),
  });
}

/**
 * Route tRPC queries + mutations through the reverse tunnel (I.3.3).
 * Subscriptions go through HTTPS until a stream frame lands on the
 * tunnel protocol — for now the subscribe surface on the proxy
 * throws a deliberate "not-supported" error so callers never
 * silently hang.
 */
function proxyFromTunnel(send: TunnelSendFn, nodeName: string): NodeClient {
  let counter = 0;
  const nextId = (): string =>
    `tunnel-${nodeName}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

  async function invoke(type: 'query' | 'mutation', method: string, input: unknown): Promise<unknown> {
    const res = await send({
      id: nextId(),
      method,
      params: { type, input },
    });
    if (res.error) {
      const err = new Error(res.error.message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).code = res.error.code;
      throw err;
    }
    return res.result;
  }

  function buildLeaf(method: string): Record<string, unknown> {
    return {
      query: (input: unknown) => invoke('query', method, input),
      mutate: (input: unknown) => invoke('mutation', method, input),
      subscribe: (): never => {
        throw new Error(
          `tunnel-routed subscribe('${method}') is not supported yet — stream frames over the tunnel land in I.3.4`,
        );
      },
    };
  }

  // The tRPC proxy is a deep-dotted structure (client.catalog.list
  // .query(...)). We emulate that with a recursive Proxy that
  // accumulates the dotted path until the consumer reaches for
  // `.query` / `.mutate` / `.subscribe`.
  function makeNamespaceProxy(path: string[]): unknown {
    // Cached leaf actions so consecutive accesses to .query/.mutate
    // return a stable reference — cheap + avoids allocating closures
    // per read.
    let leaf: Record<string, unknown> | null = null;
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'query' || prop === 'mutate' || prop === 'subscribe') {
          if (!leaf) leaf = buildLeaf(path.join('.'));
          return leaf[prop];
        }
        return makeNamespaceProxy([...path, prop]);
      },
    };
    return new Proxy({}, handler);
  }
  return makeNamespaceProxy([]) as NodeClient;
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
