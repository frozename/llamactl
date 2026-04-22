import { initTRPC, TRPCError } from '@trpc/server';
import { getErrorShape } from '@trpc/server/unstable-core-do-not-import';
import { observable } from '@trpc/server/observable';
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
 * Adapt a tRPC v11 async-generator subscription result into a v10
 * `@trpc/server/observable` Observable so electron-trpc v1.0.0-alpha.0
 * (which still consumes subscriptions via `isObservable(result)` +
 * `result.subscribe({next,error,complete})`) can drive the stream.
 *
 * The returned observable:
 *  - iterates the async iterable on subscribe, emitting each yielded
 *    value via `emit.next`.
 *  - calls `emit.complete()` when the iterable ends normally.
 *  - calls `emit.error(err)` with whatever the iterable threw.
 *  - invokes `iter.return?.()` on unsubscribe to release generator
 *    resources (closes server-side watchers held inside the generator
 *    body — e.g. llama-server log tail fds).
 */
function asyncIterableToObservable<T>(iter: AsyncIterable<T>) {
  return observable<T>((emit) => {
    let cancelled = false;
    const iterator = iter[Symbol.asyncIterator]();
    (async () => {
      try {
        while (true) {
          const { value, done } = await iterator.next();
          if (cancelled) return;
          if (done) {
            emit.complete();
            return;
          }
          emit.next(value as T);
        }
      } catch (err) {
        if (!cancelled) emit.error(err as TRPCError);
      }
    })();
    return () => {
      cancelled = true;
      try {
        void iterator.return?.(undefined);
      } catch {
        // best effort
      }
    };
  });
}

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
  'nodeDiscover',
  'nodeAddCloud',
  'nodeModels',
  'chatComplete',
  'chatStream',
  'workloadList',
  'workloadsDir',
  'workloadDescribe',
  'workloadApply',
  'workloadDelete',
  'workloadValidate',
  'workloadTemplate',
  'reconcilerStatus',
  'reconcilerEvents',
  'reconcilerStart',
  'reconcilerStop',
  'reconcilerKick',
  'benchScheduleList',
  'benchScheduleAdd',
  'benchScheduleRemove',
  'benchScheduleToggle',
  'benchSchedulerStatus',
  'benchSchedulerStart',
  'benchSchedulerStop',
  'benchSchedulerKick',
  // Ops Chat: the audit journal, the session registry, and the
  // planner's allowlist all live on the control plane's filesystem +
  // main-process memory. Routing these to a remote would split the
  // session registry across processes (subscription on main, outcome
  // ack on remote) and leak audit entries into the wrong log.
  'operatorPlan',
  'operatorRunTool',
  'operatorChatStream',
  'operatorSubmitStepOutcome',
  'opsChatTools',
  'opsChatAuditTail',
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProxyClient = Record<string, any>;

/**
 * Typed caller over the base router. Hoisted to module scope because
 * `baseRouter` is a module-level constant and the caller has no
 * request-scoped context — creating a fresh caller per procedure call
 * (as we used to) was pure waste. The `as any` cast is erased by the
 * `ProxyClient` type alias so downstream reads are still dynamically
 * dispatched but we don't repeat the cast every hot path.
 */
const baseCaller: ProxyClient = baseRouter.createCaller({}) as unknown as ProxyClient;

/**
 * Pinned remote-client cache, keyed by the (endpoint + fingerprint +
 * token) tuple. A fresh node registration, token rotation, or cert
 * change produces a new key and a cache miss; existing keys reuse
 * the already-built `createTRPCClient` instance, avoiding the
 * linkBuilder + eventsource-ponyfill wiring cost on every query.
 */
const clientCache = new Map<string, ProxyClient>();

function cacheKey(target: DispatchTarget): string {
  if (!target.node || !target.token) return '';
  const fp = target.node.certificateFingerprint ?? '';
  // Use only the token's first 8 chars in the key — the full token is
  // already the cache invalidation signal; 8 chars is enough to
  // disambiguate independent rotations without keeping the secret in
  // an in-memory map key any longer than necessary.
  return `${target.node.endpoint}|${fp}|${target.token.slice(0, 8)}`;
}

function buildRemoteClient(
  target: DispatchTarget,
  fetchFactory: PinnedFetchFactory,
): ProxyClient {
  if (!target.node || !target.token) {
    throw new Error('remote target missing node or token');
  }
  const key = cacheKey(target);
  const cached = clientCache.get(key);
  if (cached) return cached;
  const client = createTRPCClient({
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
  }) as unknown as ProxyClient;
  clientCache.set(key, client);
  return client;
}

/**
 * Test-only helper — clears the pinned-client cache so tests that
 * rotate tokens or swap cert fingerprints see fresh state. Paired
 * with `__resetActiveNodeOverrideForTests`.
 */
export function __resetClientCacheForTests(): void {
  clientCache.clear();
}

function wrapQueryOrMutation(
  path: string,
  type: 'query' | 'mutation',
  fetchFactory: PinnedFetchFactory,
): unknown {
  const resolver = async ({ input }: { input: unknown }) => {
    const target = resolveDispatchTarget(path);
    if (target.kind === 'local') {
      return baseCaller[path](input);
    }
    const client = buildRemoteClient(target, fetchFactory);
    return type === 'query'
      ? client[path].query(input)
      : client[path].mutate(input);
  };
  // Input shape is inferred from the underlying procedure at call
  // time; we don't re-validate here because the destination (local
  // caller or remote agent) will re-validate against its own zod
  // schema. Declaring `.input(z.unknown())` on the wrapper is
  // load-bearing though: without it, electron-trpc v1.0.0-alpha's
  // IPC serializer throws "Cannot read properties of undefined
  // (reading 'serialize')" when the renderer invokes any wrapped
  // procedure whose base version has a Zod `.input()`. Pinning
  // `z.unknown()` keeps the transformer-lookup path happy while
  // preserving our pass-through semantics.
  const base = t.procedure.input(z.unknown());
  return type === 'query' ? base.query(resolver) : base.mutation(resolver);
}

function wrapSubscription(path: string, fetchFactory: PinnedFetchFactory): unknown {
  // Same rationale as `wrapQueryOrMutation` above: electron-trpc's
  // IPC serializer expects an `.input()` declaration on every wrapped
  // procedure, even when the wrapper itself does no validation.
  // Without it the input never crosses the renderer→main bridge on
  // subscriptions, and the base router's schema downstream sees
  // `undefined` → `"Invalid input: expected object, received
  // undefined"`. Pass-through semantics preserved via `z.unknown()`.
  return t.procedure.input(z.unknown()).subscription(async function* (opts) {
    const target = resolveDispatchTarget(path);
    const clientSignal = opts.signal as AbortSignal | undefined;
    if (target.kind === 'local') {
      // The base subscription resolver needs a real AbortSignal
      // (`bridgeEventStream` in @llamactl/remote calls
      // `signal.addEventListener('abort', ...)` unconditionally).
      // electron-trpc's v10 `callProcedure` path doesn't forward a
      // signal through `opts`, so we construct our own controller
      // and build a fresh caller bound to it. When the renderer
      // unsubscribes, our outer Observable teardown invokes
      // `iterator.return()` on this generator, which lands in the
      // `finally` and aborts the controller — letting the inner
      // subscription's cleanup fire.
      const controller = new AbortController();
      if (clientSignal?.aborted) controller.abort();
      const onOuterAbort = (): void => controller.abort();
      clientSignal?.addEventListener('abort', onOuterAbort);
      try {
        const localCaller = baseRouter.createCaller(
          {},
          { signal: controller.signal },
        ) as unknown as ProxyClient;
        const iterable = (await localCaller[path](opts.input)) as AsyncIterable<unknown>;
        for await (const ev of iterable) {
          if (controller.signal.aborted) break;
          yield ev;
        }
      } finally {
        clientSignal?.removeEventListener('abort', onOuterAbort);
        controller.abort();
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
    // tRPC v11 exposes the procedure kind on `_def.type`. Older paths
    // used `_def.query`/`_def.mutation`/`_def.subscription` booleans
    // — check both to stay robust across tRPC point releases.
    const def = orig?._def ?? {};
    let type: 'query' | 'mutation' | 'subscription' | undefined;
    if (def.type === 'query' || def.type === 'mutation' || def.type === 'subscription') {
      type = def.type;
    } else if (def.query) {
      type = 'query';
    } else if (def.mutation) {
      type = 'mutation';
    } else if (def.subscription) {
      type = 'subscription';
    }
    if (type === 'query') procs[name] = wrapQueryOrMutation(name, 'query', fetchFactory);
    else if (type === 'mutation') procs[name] = wrapQueryOrMutation(name, 'mutation', fetchFactory);
    else if (type === 'subscription') procs[name] = wrapSubscription(name, fetchFactory);
  }
  // Cast the dynamic wrapped router to the base AppRouter type, then
  // merge with the typed UI router. The resulting type surfaces every
  // forwarded procedure AND the two UI procedures to the renderer.
  const wrappedBase = t.router(procs) as unknown as BaseAppRouter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged = t.mergeRouters(wrappedBase, uiRouter) as any;
  // electron-trpc v1.0.0-alpha.0's main-side `callProcedure` wires
  // procedures in two v10-shaped ways that tRPC v11 no longer supports:
  //
  //   1. It checks `procedures[path]._def[type]` as a boolean (v10)
  //      rather than `_def.type === 'mutation'` (v11). Without the
  //      v10-style booleans, every mutation call throws
  //      `No "mutation"-procedure on path "<name>"`.
  //
  //   2. It invokes the procedure with `{ctx, path, procedures,
  //      rawInput, type}` — no `getRawInput` field. tRPC v11's
  //      procedure caller checks `if (!("getRawInput" in opts)) throw`,
  //      so we synthesize the missing field by returning a constant
  //      from a wrapped caller.
  //
  // Backfilling both shapes in place makes the alpha routes work
  // without forking electron-trpc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const procsDef = (merged._def?.procedures ?? {}) as Record<string, any>;
  for (const [path, origProc] of Object.entries(procsDef)) {
    const d = origProc?._def;
    if (!d) continue;
    if (d.type === 'query') d.query = true;
    else if (d.type === 'mutation') d.mutation = true;
    else if (d.type === 'subscription') d.subscription = true;
    // Wrap with a v10-compat shim. The shim is callable both ways:
    // when invoked with v11's `ProcedureCallOptions` (from
    // createCaller) it passes through; when invoked with v10's
    // `{ctx, path, rawInput, type, procedures}` it back-fills
    // `getRawInput: () => rawInput`.
    //
    // For subscription procedures, v11 async-generator resolvers
    // return an AsyncIterable; electron-trpc alpha's IPC handler
    // still expects a v10 Observable (it calls `isObservable(result)`).
    // We convert AsyncIterable → Observable, but only when the call
    // is the v10-shape one — detected by the missing `getRawInput`
    // field. v11 createCaller paths (tests, future callers) keep the
    // AsyncIterable so they stay native.
    const isSubscription = d.type === 'subscription';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shim: any = async (opts: any) => {
      const isV10ShapeCall = opts && typeof opts.getRawInput !== 'function';
      if (isV10ShapeCall) {
        const rawInput = opts.rawInput;
        opts = { ...opts, getRawInput: () => Promise.resolve(rawInput) };
      }
      const result = await origProc(opts);
      if (!isSubscription || !isV10ShapeCall) return result;
      return asyncIterableToObservable(result as AsyncIterable<unknown>);
    };
    shim._def = origProc._def;
    shim.procedure = origProc.procedure;
    shim.meta = origProc.meta;
    procsDef[path] = shim;
  }
  // electron-trpc v1.0.0-alpha.0's main-side IPC handler calls
  // `router.getErrorShape(...)` — a v10 API that tRPC v11 removed in
  // favor of the standalone `getErrorShape()` helper. Shim it here so
  // errors raised inside any procedure propagate to the renderer
  // instead of crashing the main process with "n.getErrorShape is not
  // a function".
  if (typeof merged.getErrorShape !== 'function') {
    merged.getErrorShape = (opts: {
      error: unknown;
      type: 'query' | 'mutation' | 'subscription' | 'unknown';
      path: string | undefined;
      input: unknown;
      ctx: unknown;
    }) =>
      getErrorShape({
        config: merged._def._config,
        error: opts.error instanceof TRPCError
          ? opts.error
          : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: opts.error as Error }),
        type: opts.type,
        path: opts.path,
        input: opts.input,
        ctx: opts.ctx,
      });
  }
  return merged;
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
