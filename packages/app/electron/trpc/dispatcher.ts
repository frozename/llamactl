import { initTRPC } from '@trpc/server';
import { createTRPCClient } from '@trpc/client';
import {
  router as baseRouter,
  type AppRouter,
  buildPinnedLinks,
  config as kubecfg,
  LOCAL_NODE_ENDPOINT,
  type PinnedFetchFactory,
} from '@llamactl/remote';
import { makeNodePinnedFetch } from './node-pinned-fetch.js';

/**
 * Electron main's dispatcher router. Exposes the same wire shape as
 * `@llamactl/remote`'s router but, for every call, reads the current
 * context's `defaultNode` and decides:
 *
 *   - local (endpoint is `inproc://...`) or control-plane allowlist
 *     → fall through to `baseRouter.createCaller({})`
 *   - remote → build a pinned-TLS tRPC client with the Electron-main
 *     fetch (undici Agent + pinned CA) and forward the call
 *
 * The wrapper keeps queries, mutations, and subscriptions routable
 * with identical semantics from the renderer's perspective. Subscription
 * forwarding bridges the remote async-iterable stream back into a local
 * async generator, matching the tRPC v11 subscription contract.
 */

const t = initTRPC.create();

/**
 * Procedures that MUST always run on the control plane, even when a
 * remote node is selected. These manage kubeconfig state (the list of
 * nodes, the current default) and workload orchestration — both only
 * make sense from the control plane's perspective.
 */
const CONTROL_PLANE_ONLY = new Set<string>([
  'nodeList',
  'nodeAdd',
  'nodeRemove',
  'nodeTest',
  'nodeSetDefault',
  'workloadList',
  'workloadDescribe',
  'workloadApply',
  'workloadDelete',
  'workloadValidate',
  'workloadTemplate',
]);

interface DispatchTarget {
  kind: 'local' | 'remote';
  node?: {
    name: string;
    endpoint: string;
    certificate: string | null;
    certificateFingerprint: string | null;
  };
  token?: string;
}

function resolveDispatchTarget(path: string): DispatchTarget {
  if (CONTROL_PLANE_ONLY.has(path)) return { kind: 'local' };
  let cfg;
  try {
    cfg = kubecfg.loadConfig();
  } catch {
    return { kind: 'local' };
  }
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return { kind: 'local' };
  const nodeName = ctx.defaultNode;
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === nodeName);
  if (!node || node.endpoint === LOCAL_NODE_ENDPOINT) return { kind: 'local' };
  const user = cfg.users.find((u) => u.name === ctx.user);
  if (!user) return { kind: 'local' };
  let token: string;
  try {
    token = kubecfg.resolveToken(user);
  } catch {
    return { kind: 'local' };
  }
  return {
    kind: 'remote',
    node: {
      name: node.name,
      endpoint: node.endpoint,
      certificate: node.certificate ?? null,
      certificateFingerprint: node.certificateFingerprint ?? null,
    },
    token,
  };
}

function buildRemoteClient(
  target: DispatchTarget,
  fetchFactory: PinnedFetchFactory,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (!target.node || !target.token) {
    throw new Error('remote target missing node or token');
  }
  return createTRPCClient({
    links: buildPinnedLinks(
      {
        name: target.node.name,
        endpoint: target.node.endpoint,
        certificate: target.node.certificate ?? undefined,
        certificateFingerprint: target.node.certificateFingerprint ?? undefined,
      },
      target.token,
      fetchFactory,
    ),
  });
}

function wrapQueryOrMutation(
  path: string,
  type: 'query' | 'mutation',
  fetchFactory: PinnedFetchFactory,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolver = async ({ input }: { input: any }) => {
    const target = resolveDispatchTarget(path);
    if (target.kind === 'local') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caller = baseRouter.createCaller({}) as any;
      return caller[path](input);
    }
    const client = buildRemoteClient(target, fetchFactory);
    return type === 'query'
      ? client[path].query(input)
      : client[path].mutate(input);
  };
  // Input shape is inferred from the underlying procedure at call time;
  // we don't re-validate here because the destination (local caller or
  // remote agent) will re-validate against its own zod schema.
  return type === 'query'
    ? t.procedure.query(resolver)
    : t.procedure.mutation(resolver);
}

function wrapSubscription(path: string, fetchFactory: PinnedFetchFactory): unknown {
  return t.procedure.subscription(async function* (opts) {
    const target = resolveDispatchTarget(path);
    const clientSignal = opts.signal as AbortSignal | undefined;
    if (target.kind === 'local') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caller = baseRouter.createCaller({}) as any;
      const iterable = await caller[path](opts.input);
      for await (const ev of iterable as AsyncIterable<unknown>) {
        if (clientSignal?.aborted) break;
        yield ev;
      }
      return;
    }
    // Remote: bridge tRPC client's callback subscription into an
    // async generator, honoring client disconnects.
    const client = buildRemoteClient(target, fetchFactory);
    const queue: unknown[] = [];
    let done = false;
    let err: unknown = null;
    let wake: (() => void) | null = null;
    const drain = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };

    const sub = client[path].subscribe(opts.input, {
      onData: (ev: unknown) => {
        queue.push(ev);
        drain();
      },
      onError: (e: unknown) => {
        err = e;
        done = true;
        drain();
      },
      onComplete: () => {
        done = true;
        drain();
      },
    });

    const onClientAbort = (): void => {
      try {
        sub?.unsubscribe?.();
      } catch {
        // best effort
      }
      done = true;
      drain();
    };
    clientSignal?.addEventListener('abort', onClientAbort);

    try {
      while (true) {
        if (queue.length > 0) {
          const next = queue.shift();
          yield next;
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (err) throw err;
    } finally {
      clientSignal?.removeEventListener('abort', onClientAbort);
      try {
        sub?.unsubscribe?.();
      } catch {
        // best effort
      }
    }
  });
}

/**
 * Build the dispatching router by introspecting `baseRouter._def.procedures`
 * and creating a forwarding procedure for each. The cast to `AppRouter`
 * at the end preserves the typed wire shape for the renderer — it still
 * imports `AppRouter` from `@llamactl/remote` and gets full
 * per-procedure inference on `trpc.*` hooks.
 *
 * `fetchFactory` defaults to the undici-backed Node factory; tests
 * running under Bun can inject the Bun-native one (`makePinnedFetch`
 * from `@llamactl/remote`) so the self-signed cert round-trips
 * without needing Node's HTTPS agent.
 */
export function buildDispatcherRouter(
  fetchFactory: PinnedFetchFactory = makeNodePinnedFetch,
): AppRouter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const procs: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseDef = (baseRouter as any)._def;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source = baseDef.procedures as Record<string, any>;
  for (const [name, orig] of Object.entries(source)) {
    const type = orig?._def?.type as 'query' | 'mutation' | 'subscription' | undefined;
    if (type === 'query') procs[name] = wrapQueryOrMutation(name, 'query', fetchFactory);
    else if (type === 'mutation') procs[name] = wrapQueryOrMutation(name, 'mutation', fetchFactory);
    else if (type === 'subscription') procs[name] = wrapSubscription(name, fetchFactory);
  }
  return t.router(procs) as unknown as AppRouter;
}
