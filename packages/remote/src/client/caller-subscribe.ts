/**
 * Drives an in-proc `router.createCaller` subscription through tRPC's
 * client-side `{onData, onError, onComplete}` handler surface. In-proc
 * callers return the procedure's async iterable instead of invoking
 * handlers, so every caller-backed proxy must bridge the two. Lives
 * apart from both proxies so the router can use it without importing
 * the node client (the AppRouter cycle).
 */

type CallerRecord = Record<string, (...args: unknown[]) => unknown>;

export interface CallerSubscriptionHandlers {
  onData: (e: unknown) => void;
  onError: (err: unknown) => void;
  onComplete: () => void;
  onStarted?: () => void;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) return false;
  // Symbol.asyncIterator is the runtime contract tRPC v11 uses for
  // async-generator subscriptions in in-proc callers.
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

export function subscribeViaCaller(
  callerWithSignal: (signal: AbortSignal) => CallerRecord,
  method: string,
  input: unknown,
  handlers: CallerSubscriptionHandlers,
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
