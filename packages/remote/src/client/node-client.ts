import { resolveNode, resolveToken } from "@llamactl/core/config/kubeconfig";
import { type ClusterNode, type Config, LOCAL_NODE_ENDPOINT } from "@llamactl/core/config/schema";
import { createTRPCClient } from "@trpc/client";

import { router as appRouter, type AppRouter } from "../router.js";
import { buildPinnedLinks } from "./links.js";

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
export type TunnelSendFn = (req: { id: string; method: string; params: unknown }) => Promise<{
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}>;

/**
 * Reverse-tunnel subscription dispatcher (I.3.4 / Slice B). Shape
 * mirrors tRPC v11's client-subscription surface — the caller
 * passes `{onData, onError, onComplete, onStarted?}` handlers; the
 * returned `{unsubscribe}` closes the SSE connection (which the
 * `handleTunnelRelay` relay in turn translates into a
 * `stream-cancel` frame on the ws tunnel).
 */
export type TunnelSubscribeFn = (
  method: string,
  input: unknown,
  handlers: {
    onData: (e: unknown) => void;
    onError: (err: unknown) => void;
    onComplete: () => void;
    onStarted?: () => void;
  },
) => { unsubscribe: () => void };

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
   * pinned HTTPS tRPC client.
   */
  tunnelSend?: TunnelSendFn;
  /**
   * Reverse-tunnel subscription dispatcher (I.3.4). When set
   * alongside `tunnelSend`, subscription calls on the proxy route
   * through the tunnel-relay SSE endpoint instead of throwing
   * "not supported". Absent → `.subscribe(...)` throws with the
   * same not-supported message as before so callers notice.
   */
  tunnelSubscribe?: TunnelSubscribeFn;
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
    return proxyFromTunnel(opts.tunnelSend, nodeName, opts.tunnelSubscribe);
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
  const caller = appRouter.createCaller({}) as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const callerWithSignal = (signal: AbortSignal): Record<string, (...args: unknown[]) => unknown> =>
    appRouter.createCaller({}, { signal }) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;

  function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    if (typeof value !== "object" || value === null) return false;
    // Symbol.asyncIterator is the runtime contract tRPC v11 uses for
    // async-generator subscriptions in in-proc callers.
    return (
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
    );
  }

  function subscribeViaCaller(
    method: string,
    input: unknown,
    handlers: {
      onData: (e: unknown) => void;
      onError: (err: unknown) => void;
      onComplete: () => void;
      onStarted?: () => void;
    },
  ): { unsubscribe: () => void } {
    const abort = new AbortController();
    let settled = false;

    const close = (): void => {
      if (abort.signal.aborted) return;
      abort.abort();
    };

    const resolveStream = async (): Promise<AsyncIterable<unknown>> => {
      const methodFn = callerWithSignal(abort.signal)[method];
      if (typeof methodFn !== "function") {
        throw new Error(`unknown procedure '${method}'`);
      }
      const stream = await methodFn(input);
      if (!isAsyncIterable(stream)) {
        throw new Error(`inproc subscribe('${method}') did not return an AsyncIterable`);
      }
      return stream;
    };

    // A caller-initiated abort settles as a clean completion; any
    // other failure surfaces through onError. Either way only the
    // first settlement wins.
    const settleFailure = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (abort.signal.aborted) handlers.onComplete();
      else handlers.onError(err);
    };

    const run = async (): Promise<void> => {
      try {
        const stream = await resolveStream();
        handlers.onStarted?.();
        for await (const event of stream) {
          if (settled) break;
          handlers.onData(event);
        }
        if (!settled) {
          settled = true;
          handlers.onComplete();
        }
      } catch (err) {
        settleFailure(err);
      } finally {
        close();
      }
    };

    void run();
    return { unsubscribe: close };
  }

  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const fn = caller[prop];
      if (typeof fn !== "function") return undefined;
      // Binding tRPC v10's caller proxy via .bind() breaks path
      // tracking; wrapping each call as a fresh invocation preserves
      // the proxy's per-call context. The .query/.mutate/.subscribe
      // surface mirrors the remote proxy client so downstream code
      // treats both paths identically.
      const invoke = (...args: unknown[]): unknown => Reflect.apply(fn, caller, args);
      return {
        query: invoke,
        mutate: invoke,
        subscribe: (
          input: unknown,
          handlers: {
            onData: (e: unknown) => void;
            onError: (err: unknown) => void;
            onComplete: () => void;
            onStarted?: () => void;
          },
        ) => subscribeViaCaller(prop, input, handlers),
      };
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
 * Route tRPC queries + mutations (and, when `tunnelSubscribe` is
 * supplied, subscriptions) through the reverse tunnel (I.3.3/I.3.4).
 * Without `tunnelSubscribe`, the subscribe surface on the proxy
 * throws a deliberate "not-supported" error so callers never
 * silently hang.
 */
function proxyFromTunnel(
  send: TunnelSendFn,
  nodeName: string,
  subscribeFn?: TunnelSubscribeFn,
): NodeClient {
  let counter = 0;
  const nextId = (): string =>
    `tunnel-${nodeName}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

  async function invoke(
    type: "query" | "mutation",
    method: string,
    input: unknown,
  ): Promise<unknown> {
    const res = await send({
      id: nextId(),
      method,
      params: { type, input },
    });
    if (res.error) {
      const err = new Error(res.error.message);
      Object.assign(err, { code: res.error.code });
      throw err;
    }
    return res.result;
  }

  function buildLeaf(method: string): Record<string, unknown> {
    return {
      query: (input: unknown) => invoke("query", method, input),
      mutate: (input: unknown) => invoke("mutation", method, input),
      subscribe: (
        input: unknown,
        handlers: {
          onData: (e: unknown) => void;
          onError: (err: unknown) => void;
          onComplete: () => void;
          onStarted?: () => void;
        },
      ): { unsubscribe: () => void } => {
        if (!subscribeFn) {
          throw new Error(
            `tunnel-routed subscribe('${method}') requires a tunnelSubscribe dispatcher; none was configured`,
          );
        }
        return subscribeFn(method, input, handlers);
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
        if (typeof prop !== "string") return undefined;
        if (prop === "query" || prop === "mutate" || prop === "subscribe") {
          leaf ??= buildLeaf(path.join("."));
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
      name: "ad-hoc",
      endpoint: opts.url,
      certificate: opts.certificate,
      certificateFingerprint: opts.certificateFingerprint,
    },
    opts.token,
  );
}
