import { type AnyTRPCRouter, callTRPCProcedure } from "@trpc/server";

import {
  DEFAULT_STREAM_LIMITS,
  frameBytes,
  type StreamLimits,
  TUNNEL_STREAM_CANCELLED,
  TUNNEL_STREAM_OVERFLOW,
  type TunnelReq,
} from "./messages.js";

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

type CallerProcedure = (input: unknown) => Promise<unknown>;

export interface TunnelRouterParams {
  /** 'query' | 'mutation' | 'subscription' — query/mutation go through
   *  the caller path; subscription goes through
   *  `createTunnelSubscriptionHandler`. */
  type?: "query" | "mutation" | "subscription";
  input?: unknown;
}

export function createTunnelRouterHandler(caller: unknown): (req: TunnelReq) => Promise<unknown> {
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

function walkCaller(caller: unknown, method: string): CallerProcedure | undefined {
  const parts = method.split(".");
  let cursor = caller;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object" && typeof cursor !== "function") return undefined;
    cursor = Reflect.get(cursor, part);
    if (cursor === undefined) return undefined;
  }
  if (typeof cursor !== "function") return undefined;
  // Don't use cursor.bind(caller): tRPC v11's caller is a Proxy that
  // intercepts EVERY property access (including `.bind`) and treats
  // it as another procedure-path segment, so cursor.bind would walk
  // into the proxy and 404. Use the prototype method directly.

  return Function.prototype.bind.call(cursor, caller) as CallerProcedure;
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
 *   - A cancelled stream ends through `onError` typed
 *     `stream-cancelled`: the node's acknowledgement of central's
 *     `stream-cancel` (P4.1 X4), never a success-shaped end.
 *   - Streams are bounded (P4.1 X3): an event above
 *     `limits.maxFrameBytes`, or an Observable backlog above
 *     `limits.maxQueuedBytes`, ends the stream through `onError` typed
 *     `stream-overflow` and cancels the producer.
 */
export function createTunnelSubscriptionHandler(
  router: AnyTRPCRouter,
  createContext: () => unknown,
  limits: StreamLimits = DEFAULT_STREAM_LIMITS,
): (req: TunnelReq) => TunnelSubscription {
  return (req: TunnelReq): TunnelSubscription => {
    const params = (req.params ?? {}) as TunnelRouterParams;
    const path = req.method;
    return {
      subscribe(handlers): { cancel(): void } {
        const abort = new AbortController();
        // `settled` — handlers have fired their terminal callback
        // (onComplete OR onError). Once set, further callbacks are
        // no-ops so duplicate teardown is safe.
        let settled = false;
        // `cancelled` — external `cancel()` was called. Distinct
        // from `settled` because the terminal callback still fires
        // after the generator body observes the abort and returns.
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
        const finish = (): void => {
          if (cancelled) {
            safeError(streamError(TUNNEL_STREAM_CANCELLED, `subscription '${path}' cancelled`));
            return;
          }
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
              getRawInput: () => Promise.resolve(params.input),
              ctx: createContext(),
              type: "subscription",
              signal: abort.signal,
              batchIndex: 0,
            });
          } catch (err) {
            // Aborted before the procedure resolved: still a cancel.
            if (cancelled) finish();
            else safeError(err as Error);
            return;
          }
          // The procedure's return could be an AsyncIterable (async
          // generator) or an Observable. Normalise to AsyncIterable.
          const iterable = toAsyncIterable(result, abort.signal, limits);
          if (!iterable) {
            safeError(new Error(`subscription '${path}' did not return an async iterable`));
            return;
          }
          await pumpEvents(iterable, {
            abort,
            limits,
            isCancelled: () => cancelled,
            onEvent: (value) => {
              try {
                handlers.onEvent(value);
              } catch {
                // caller's onEvent threw; continue pumping — the
                // tunnel client catches and ships a stream-done
                // {ok:false} on its own. Don't double-close here.
              }
            },
            finish,
            fail: safeError,
          });
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

function streamError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isStreamOverflow(err: unknown): err is Error {
  return err instanceof Error && (err as { code?: unknown }).code === TUNNEL_STREAM_OVERFLOW;
}

/** Serialized size of one event: what its stream-event frame will carry. */
function eventBytes(value: unknown): number {
  const json = JSON.stringify(value) as string | undefined;
  return json === undefined ? 0 : frameBytes(json);
}

interface PumpOptions {
  abort: AbortController;
  limits: StreamLimits;
  isCancelled: () => boolean;
  onEvent: (value: unknown) => void;
  finish: () => void;
  fail: (err: Error) => void;
}

async function pumpEvents(iterable: AsyncIterable<unknown>, opts: PumpOptions): Promise<void> {
  try {
    for await (const value of iterable) {
      if (opts.abort.signal.aborted) break;
      const bytes = eventBytes(value);
      if (bytes > opts.limits.maxFrameBytes) {
        throw streamError(
          TUNNEL_STREAM_OVERFLOW,
          `a ${String(bytes)}-byte event exceeds the ${String(opts.limits.maxFrameBytes)}-byte frame cap`,
        );
      }
      opts.onEvent(value);
    }
    opts.finish();
  } catch (err) {
    // Leaving the loop already closed the producer; abort its signal too.
    if (isStreamOverflow(err)) {
      opts.abort.abort();
      opts.fail(err);
      return;
    }
    // Abort-driven teardown surfaces as a throw from the iterator's
    // `.return()` path in some runtimes; a cancel is still a cancel.
    if (opts.abort.signal.aborted || opts.isCancelled()) {
      opts.finish();
      return;
    }
    opts.fail(err as Error);
  }
}

/**
 * Convert a subscription's raw return to an AsyncIterable. The
 * return may be:
 *   - AsyncIterable (async generator) — passed through.
 *   - Observable ({subscribe(observer): TeardownLogic}) — wrapped
 *     into a bounded AsyncIterable that pulls via push-pull deferreds.
 *   - anything else — rejected; the caller surfaces an error frame.
 */
function toAsyncIterable(
  value: unknown,
  signal: AbortSignal,
  limits: StreamLimits,
): AsyncIterable<unknown> | null {
  if (value === null || value === undefined) return null;
  if (isAsyncIterable(value)) return value;
  if (isObservable(value)) return observableToAsyncIterable(value, signal, limits);
  return null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (value === null || value === undefined || typeof value !== "object") return false;
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

interface MinimalObservable {
  subscribe(observer: {
    next?: (v: unknown) => void;
    error?: (err: unknown) => void;
    complete?: () => void;
  }): { unsubscribe: () => void } | (() => void) | undefined;
}

function isObservable(value: unknown): value is MinimalObservable {
  if (value === null || value === undefined || typeof value !== "object") return false;
  return typeof (value as { subscribe?: unknown }).subscribe === "function";
}

type BufferedEntry =
  | { kind: "v"; value: unknown; bytes: number }
  | { kind: "e"; err: unknown }
  | { kind: "c" };

interface PendingPull {
  resolve: (v: IteratorResult<unknown>) => void;
  reject: (e: unknown) => void;
}

function deliver(pull: PendingPull, entry: BufferedEntry): void {
  if (entry.kind === "v") pull.resolve({ value: entry.value, done: false });
  else if (entry.kind === "c") pull.resolve({ value: undefined, done: true });
  else pull.reject(entry.err);
}

function unsubscribeQuietly(handle: ReturnType<MinimalObservable["subscribe"]>): void {
  try {
    if (typeof handle === "function") handle();
    else handle?.unsubscribe();
  } catch {
    // ignore
  }
}

/**
 * Push-pull bridge from Observable → AsyncIterable. Values pushed
 * faster than the consumer pulls are buffered, bounded by
 * `limits.maxQueuedBytes` of serialized events: a backlog past the cap
 * ends the iterator typed `stream-overflow` after the values already
 * queued, and unsubscribes the Observable. Pulls with no pending value
 * await a Deferred. Abort via the supplied signal tears down the
 * observable subscription and completes the iterator.
 */
function observableToAsyncIterable(
  observable: MinimalObservable,
  signal: AbortSignal,
  limits: StreamLimits,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      const buffer: BufferedEntry[] = [];
      let queuedBytes = 0;
      let pending: PendingPull | null = null;
      let done = false;
      // `handle` is unset while `subscribe` runs: a synchronous burst can
      // overflow before the teardown handle exists.
      const source: {
        handle: ReturnType<MinimalObservable["subscribe"]> | null;
        overflowed: boolean;
      } = { handle: null, overflowed: false };
      const settle = (entry: BufferedEntry): void => {
        const pull = pending;
        pending = null;
        if (pull) deliver(pull, entry);
        else buffer.push(entry);
      };
      const end = (entry: Exclude<BufferedEntry, { kind: "v" }>): void => {
        if (done) return;
        done = true;
        settle(entry);
      };
      const teardown = (): void => {
        if (source.handle !== null) unsubscribeQuietly(source.handle);
      };
      source.handle = observable.subscribe({
        next(v) {
          if (done) return;
          if (pending) {
            settle({ kind: "v", value: v, bytes: 0 });
            return;
          }
          const bytes = eventBytes(v);
          if (queuedBytes + bytes > limits.maxQueuedBytes) {
            source.overflowed = true;
            const message = `a slow consumer let ${String(queuedBytes + bytes)} bytes queue past the ${String(limits.maxQueuedBytes)}-byte cap`;
            end({ kind: "e", err: streamError(TUNNEL_STREAM_OVERFLOW, message) });
            teardown();
            return;
          }
          queuedBytes += bytes;
          buffer.push({ kind: "v", value: v, bytes });
        },
        error(err) {
          end({ kind: "e", err });
        },
        complete() {
          end({ kind: "c" });
        },
      });
      if (source.overflowed) teardown();
      const onAbort = (): void => {
        if (done) return;
        done = true;
        teardown();
        settle({ kind: "c" });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return {
        async next(): Promise<IteratorResult<unknown>> {
          const head = buffer.shift();
          if (head !== undefined) {
            if (head.kind === "v") queuedBytes -= head.bytes;
            if (head.kind === "e") throw head.err;
            return head.kind === "v"
              ? { value: head.value, done: false }
              : { value: undefined, done: true };
          }
          if (done) return { value: undefined, done: true };
          return await new Promise<IteratorResult<unknown>>((resolve, reject) => {
            pending = { resolve, reject };
          });
        },
        return(): Promise<IteratorResult<unknown>> {
          if (!done) {
            done = true;
            teardown();
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
