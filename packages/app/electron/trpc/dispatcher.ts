import { initTRPC } from '@trpc/server';
import { createTRPCClient } from '@trpc/client';
import { z } from 'zod';
import {
  router as baseRouter,
  type AppRouter as BaseAppRouter,
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
  'nodeOpenAIConfig',
  'workloadList',
  'workloadDescribe',
  'workloadApply',
  'workloadDelete',
  'workloadValidate',
  'workloadTemplate',
  // UI-only procedures added by this module never go over the wire.
  'uiSetActiveNode',
  'uiGetActiveNode',
]);

/**
 * Runtime override for the UI's active node. Separate from kubeconfig's
 * `currentContext.defaultNode` so switching the renderer's active node
 * doesn't also silently change the CLI's default. When `null` the
 * dispatcher falls back to kubeconfig (matches the CLI behavior).
 */
let activeNodeOverride: string | null = null;

function setActiveNodeOverride(name: string | null): void {
  activeNodeOverride = name;
}
function getActiveNodeOverride(): string | null {
  return activeNodeOverride;
}

/**
 * Test-only helper — resets the module-level active-node override to
 * `null`. Tests that exercise the UI override path leave state behind
 * otherwise, which leaks into later tests that expect kubeconfig-only
 * dispatch semantics.
 */
export function __resetActiveNodeOverrideForTests(): void {
  activeNodeOverride = null;
}

/**
 * Typed UI-only sub-router. Declared up-front so the renderer's
 * `AppRouter` picks up `uiSetActiveNode` / `uiGetActiveNode` with full
 * per-procedure inference. These procedures never hit the base router
 * and never forward; `CONTROL_PLANE_ONLY` blocks accidental routing.
 */
const uiRouter = t.router({
  uiSetActiveNode: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input }) => {
      setActiveNodeOverride(input.name);
      return { ok: true as const, name: input.name };
    }),
  uiGetActiveNode: t.procedure.query(() => ({
    name: activeNodeOverride,
  })),
});

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
  // The renderer's selected node takes precedence over kubeconfig's
  // default — so switching the UI doesn't also change what `llamactl`
  // defaults to from the CLI.
  const nodeName = getActiveNodeOverride() ?? ctx.defaultNode;
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
 * and creating a forwarding procedure for each, then merging in the
 * UI-only `uiSetActiveNode` / `uiGetActiveNode` procedures. The
 * renderer imports the inferred return type as its `AppRouter`, so
 * every call — base-forwarded or UI-local — has full tRPC inference.
 *
 * `fetchFactory` defaults to the undici-backed Node factory; tests
 * running under Bun can inject the Bun-native one (`makePinnedFetch`
 * from `@llamactl/remote`) so the self-signed cert round-trips
 * without needing Node's HTTPS agent.
 */
export function buildDispatcherRouter(
  fetchFactory: PinnedFetchFactory = makeNodePinnedFetch,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): BaseAppRouter {
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
  // Cast the dynamic wrapped router to the base AppRouter type, then
  // merge with the typed UI router. The resulting type surfaces every
  // forwarded procedure AND the two UI procedures to the renderer.
  const wrappedBase = t.router(procs) as unknown as BaseAppRouter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t.mergeRouters(wrappedBase, uiRouter) as any;
}

/**
 * Exported type for the renderer's UI-only client. Carries just the
 * two procedures so the renderer can call `uiSetActiveNode` /
 * `uiGetActiveNode` through a small typed client without widening the
 * main `AppRouter` type (which would force a router-merge whose
 * inferred form references deep `@llamactl/core` paths and breaks
 * `composite: true` declaration emit in this workspace).
 */
export type UIRouter = typeof uiRouter;
