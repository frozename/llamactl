import { callTRPCProcedure, type AnyTRPCRouter } from '@trpc/server';
import type { TunnelReq } from './messages.js';

/**
 * Agent-side bridge between the reverse tunnel's `req` frames and a
 * tRPC `createCaller`-shaped surface. Given a tRPC caller
 * (`appRouter.createCaller(ctx)`), returns a function the tunnel
 * client can use as its `handleRequest`:
 *
 *   const caller = appRouter.createCaller({ env, auth });
 *   const handle = createTunnelRouterHandler(caller);
 *   const client = createTunnelClient({ url, bearer, nodeName,
 *                                       handleRequest: handle });
 *
 * Frame contract:
 *   req.method = "dot.separated.path.to.procedure"
 *   req.params = { type: 'query' | 'mutation' | 'subscription',
 *                  input: unknown }
 *
 * `type` disambiguates query vs mutation when a procedure name is
 * unique either way; the caller proxy is invoked the same way
 * regardless so we accept both and pass input straight through.
 *
 * Subscriptions are routed through a separate
 * `createTunnelSubscriptionHandler(router, createContext)` rather
 * than the caller, because `createCaller` doesn't expose the
 * observable-shaped subscription path — tRPC's public
 * `callTRPCProcedure` walks the router directly and returns the
 * AsyncIterable / Observable that subscription procedures produce.
 *
 * Missing / unknown procedure → the handler throws, which the
 * tunnel client surfaces as `res.error`. Malformed params → throws.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCaller = any;

export interface TunnelRouterParams {
  /** 'query' | 'mutation' | 'subscription' — query/mutation go through
   *  the caller path; subscription goes through
   *  `createTunnelSubscriptionHandler`. */
  type?: 'query' | 'mutation' | 'subscription';
  input?: unknown;
}

export function createTunnelRouterHandler(
  caller: AnyCaller,
): (req: TunnelReq) => Promise<unknown> {
  return async (req: TunnelReq) => {
    const method = req.method;
    const params = (req.params ?? {}) as TunnelRouterParams;
    const target = walkCaller(caller, method);
    if (target === undefined) {
      throw new Error(`unknown procedure: ${method}`);
    }
    // tRPC's caller exposes procedures as callables that accept the
    // input directly and return a promise; the method-name path is
    // traversal, not method-call magic.
    return await target(params.input);
  };
}

/**
 * Walk a dotted procedure path into the caller. Returns the
 * invokable at the leaf or undefined when any segment is missing /
 * non-callable. Narrow `any` usage — tRPC v11's caller types are
 * structurally callable but don't expose a typed walker.
 *
 * Property access is permitted on both 'object' and 'function'
 * cursors: tRPC v11's createCaller returns a Proxy whose top-level
 * `typeof` is 'function' (the callable target), even though property
 * access into procedures still works. Restricting to 'object' would
 * fail on the very first segment for any real caller.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkCaller(caller: any, method: string): ((input: unknown) => Promise<unknown>) | undefined {
  const parts = method.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = caller;
  for (const part of parts) {
    if (cursor == null) return undefined;
    if (typeof cursor !== 'object' && typeof cursor !== 'function') return undefined;
    cursor = cursor[part];
    if (cursor === undefined) return undefined;
  }
  if (typeof cursor !== 'function') return undefined;
  // Don't use cursor.bind(caller): tRPC v11's caller is a Proxy that
  // intercepts EVERY property access (including `.bind`) and treats
  // it as another procedure-path segment, so cursor.bind would walk
  // into the proxy and 404. Use the prototype method directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Function.prototype.bind.call(cursor, caller) as (input: unknown) => Promise<unknown>;
}

/**
 * Handle shape returned by `createTunnelSubscriptionHandler`. The
 * tunnel-client subscribes to this when a subscription req arrives;
 * events fan out to `onEvent` one at a time, and `cancel()` tears
 * down the underlying AsyncIterable (triggering the procedure's
 * `signal.aborted` branch, which aborts in-flight generator work).
 */
export interface TunnelSubscription {
  subscribe(handlers: {
    onEvent: (data: unknown) => void;
    onError: (err: Error) => void;
    onComplete: () => void;
  }): { cancel: () => void };
}

/**
 * Build a subscription-aware handler that resolves tRPC v11
 * subscription procedures directly against the router (not via
 * `createCaller`, which doesn't expose the AsyncIterable path).
 *
 * The returned function mirrors `createTunnelRouterHandler`'s shape
 * but returns an eagerly-built `TunnelSubscription` rather than a
 * Promise. The caller pattern:
 *
 *   const makeSub = createTunnelSubscriptionHandler(router, ctxFn);
 *   const sub = makeSub(req);
 *   const {cancel} = sub.subscribe({
 *     onEvent: (d) => ship stream-event,
 *     onError: (e) => ship stream-done {ok:false, error},
 *     onComplete: () => ship stream-done {ok:true},
 *   });
 *   // later, from a stream-cancel frame:
 *   cancel();
 *
 * Implementation notes:
 *   - `callTRPCProcedure` with `type: 'subscription'` returns the
 *     router's raw procedure return value (AsyncIterable for
 *     `async function*` generators; Observable for `.subscription(
 *     observable(obs => ...))` style — we wrap both at runtime).
 *   - The per-subscription AbortController is passed to the
 *     procedure via `signal`; `cancel()` aborts it, which the
 *     generator body translates into `signal.aborted` and bails out.
 *     That's the same shape the HTTPS SSE path uses.
 */
export function createTunnelSubscriptionHandler(
  router: AnyTRPCRouter,
  createContext: () => unknown,
): (req: TunnelReq) => TunnelSubscription {
  return (req: TunnelReq): TunnelSubscription => {
    const params = (req.params ?? {}) as TunnelRouterParams;
    const path = req.method;
    return {
      subscribe(handlers) {
        const abort = new AbortController();
        // `settled` — handlers have fired their terminal callback
        // (onComplete OR onError). Once set, further callbacks are
        // no-ops so duplicate teardown is safe.
        let settled = false;
        // `cancelled` — external `cancel()` was called. Distinct
        // from `settled` because we must still fire onComplete after
        // the generator body observes the abort and returns cleanly.
        let cancelled = false;
        const safeError = (err: Error): void => {
          if (settled) return;
          settled = true;
          try {
            handlers.onError(err);
          } catch {
            // caller's onError threw; nothing sane to do
          }
        };
        const safeComplete = (): void => {
          if (settled) return;
          settled = true;
          try {
            handlers.onComplete();
          } catch {
            // caller's onComplete threw; ignore
          }
        };
        const pump = async (): Promise<void> => {
          let result: unknown;
          try {
            result = await callTRPCProcedure({
              router,
              path,
              getRawInput: async () => params.input,
              ctx: createContext(),
              type: 'subscription',
              signal: abort.signal,
              batchIndex: 0,
            });
          } catch (err) {
            // If callTRPCProcedure rejected because we aborted before
            // the procedure resolved, treat as a clean complete.
            if (cancelled) {
              safeComplete();
              return;
            }
            safeError(err as Error);
            return;
          }
          // The procedure's return could be an AsyncIterable (async
          // generator) or an Observable. Normalise to AsyncIterable.
          const iterable = toAsyncIterable(result, abort.signal);
          if (!iterable) {
            safeError(
              new Error(
                `subscription '${path}' did not return an async iterable`,
              ),
            );
            return;
          }
          try {
            for await (const value of iterable) {
              if (abort.signal.aborted) break;
              try {
                handlers.onEvent(value);
              } catch {
                // caller's onEvent threw; continue pumping — the
                // tunnel client catches and ships a stream-done
                // {ok:false} on its own. Don't double-close here.
              }
            }
            safeComplete();
          } catch (err) {
            // Abort-driven teardown surfaces as a throw from the
            // iterator's `.return()` path in some runtimes; if the
            // caller asked to cancel, treat it as a clean complete.
            if (abort.signal.aborted || cancelled) {
              safeComplete();
              return;
            }
            safeError(err as Error);
          }
        };
        void pump();
        return {
          cancel(): void {
            if (cancelled) return;
            cancelled = true;
            try {
              abort.abort();
            } catch {
              // ignore
            }
          },
        };
      },
    };
  };
}

/**
 * Convert a subscription's raw return to an AsyncIterable. The
 * return may be:
 *   - AsyncIterable (async generator) — passed through.
 *   - Observable ({subscribe(observer): TeardownLogic}) — wrapped
 *     into an AsyncIterable that pulls via push-pull deferreds.
 *   - anything else — rejected; the caller surfaces an error frame.
 */
function toAsyncIterable(
  value: unknown,
  signal: AbortSignal,
): AsyncIterable<unknown> | null {
  if (value == null) return null;
  if (isAsyncIterable(value)) return value;
  if (isObservable(value)) return observableToAsyncIterable(value, signal);
  return null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value == null || typeof value !== 'object') return false;
  return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

interface MinimalObservable {
  subscribe(observer: {
    next?: (v: unknown) => void;
    error?: (err: unknown) => void;
    complete?: () => void;
  }): { unsubscribe: () => void } | (() => void) | void;
}

function isObservable(value: unknown): value is MinimalObservable {
  if (value == null || typeof value !== 'object') return false;
  return typeof (value as { subscribe?: unknown }).subscribe === 'function';
}

/**
 * Push-pull bridge from Observable → AsyncIterable. Values pushed
 * faster than the consumer pulls are buffered in an array; pulls
 * with no pending value await a Deferred. Abort via the supplied
 * signal tears down the observable subscription (via the returned
 * teardown from `observable.subscribe`) and completes the iterator.
 */
function observableToAsyncIterable(
  observable: MinimalObservable,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      const buffer: Array<{ kind: 'v'; value: unknown } | { kind: 'e'; err: unknown } | { kind: 'c' }> = [];
      let pending: { resolve: (v: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
      let done = false;
      const teardownHandle = observable.subscribe({
        next(v) {
          if (done) return;
          if (pending) {
            const p = pending;
            pending = null;
            p.resolve({ value: v, done: false });
          } else {
            buffer.push({ kind: 'v', value: v });
          }
        },
        error(err) {
          if (done) return;
          done = true;
          if (pending) {
            const p = pending;
            pending = null;
            p.reject(err);
          } else {
            buffer.push({ kind: 'e', err });
          }
        },
        complete() {
          if (done) return;
          done = true;
          if (pending) {
            const p = pending;
            pending = null;
            p.resolve({ value: undefined, done: true });
          } else {
            buffer.push({ kind: 'c' });
          }
        },
      });
      const teardown = (): void => {
        if (typeof teardownHandle === 'function') teardownHandle();
        else if (teardownHandle && typeof (teardownHandle as { unsubscribe?: unknown }).unsubscribe === 'function') {
          (teardownHandle as { unsubscribe: () => void }).unsubscribe();
        }
      };
      const onAbort = (): void => {
        if (done) return;
        done = true;
        try {
          teardown();
        } catch {
          // ignore
        }
        if (pending) {
          const p = pending;
          pending = null;
          p.resolve({ value: undefined, done: true });
        } else {
          buffer.push({ kind: 'c' });
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (buffer.length > 0) {
            const head = buffer.shift()!;
            if (head.kind === 'v') return { value: head.value, done: false };
            if (head.kind === 'c') return { value: undefined, done: true };
            throw head.err;
          }
          if (done) return { value: undefined, done: true };
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            pending = { resolve, reject };
          });
        },
        async return(): Promise<IteratorResult<unknown>> {
          if (!done) {
            done = true;
            try {
              teardown();
            } catch {
              // ignore
            }
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}
