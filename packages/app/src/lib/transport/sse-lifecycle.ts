// SSE reconnect lifecycle for the web console (#410 P4). Wraps the real
// httpSubscriptionLink one attempt at a time: a drop is classified through
// classifyTransportError, retryable failures reconnect on BACKOFF_MS, the
// backoff only resets after HEALTH_CONFIRM_MS of stable streaming, and a
// successful reopen emits exactly one RECONNECT_SIGNAL data frame so
// consumers can resync. Every inner attempt gets a fresh AbortSignal —
// tRPC 11.16's raceAbortSignals adds a permanent 'abort' listener to
// whatever signal it is handed, so the caller's op.signal must never reach
// next(). Inner completions (server RETURN) are abandoned rather than
// unsubscribed: the RETURN listener already closed the EventSource and the
// inner teardown's ac.abort() would fire the consumer's onAbort and close
// it a second time.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import type { Observer, Unsubscribable } from "@trpc/server/observable";

import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { EventSource } from "eventsource";

import { consoleSessionStore } from "../../console/session-store";
import { classifyTransportError } from "./errors";

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const HEALTH_CONFIRM_MS = 2000;

export const RECONNECT_SIGNAL = Object.freeze({ type: "__reconnect__" } as const);

export const RECONNECTING_SIGNAL = Object.freeze({ type: "__reconnecting__" } as const);

export function isReconnectSignal(value: unknown): boolean {
  return value === RECONNECT_SIGNAL || (isObject(value) && value["type"] === RECONNECT_SIGNAL.type);
}

export function isReconnectingSignal(value: unknown): boolean {
  return value === RECONNECTING_SIGNAL || (isObject(value) && value["type"] === RECONNECTING_SIGNAL.type);
}

export type SseLifecycleState = "connecting" | "streaming" | "reconnecting" | "idle" | "error";

export interface SseLifecycleStateChange {
  path: string;
  state: SseLifecycleState;
  attempt: number;
  delayMs?: number;
  error?: unknown;
}

export interface LifecycleTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// Bound wrappers read the globals at call time — never destructure or store
// them (an unbound setTimeout is an Illegal invocation in browsers), and
// create-node-scope.ts passes no timers.
export const defaultTimers: LifecycleTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Copy of @llamactl/remote's client/closed-safe-event-source.ts — duplicated
 * rather than imported to keep the web graph server-free.
 *
 * eventsource@4.1.x dispatches events from an already-read chunk after `close()`;
 * tRPC <=11.19.0's SSE RETURN listener then calls `controller.close()` without a
 * guard and throws uncaught. Use a flag instead of `readyState === CLOSED`
 * because eventsource's failConnection sets CLOSED before dispatching the
 * `error` event tRPC needs, which would turn connection failures into silent
 * completion. Delete this class once eventsource >=5.1.2 is adopted.
 */
export class ConsoleEventSource extends EventSource {
  #closedByClient = false;

  override close(): void {
    this.#closedByClient = true;
    super.close();
  }

  override dispatchEvent(event: Event): boolean {
    if (this.#closedByClient) return false;
    return super.dispatchEvent(event);
  }
}

export interface SseLifecycleLinkOptions {
  timers?: LifecycleTimers;
  onInvalidSession?: () => void;
  onStateChange?: (event: SseLifecycleStateChange) => void;
  resumablePaths?: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// TRPCClientError only carries `.shape` when built from a serialized-error
// envelope — a 'connecting' state whose error is a bare ErrorEvent is a
// transport drop, while a shaped one is a retryable server error mid-stream.
function hasTrpcEnvelope(err: unknown): boolean {
  return isObject(err) && err["shape"] !== undefined && err["shape"] !== null;
}

interface LifecycleDeps {
  op: { path: string; signal?: AbortSignal | null | undefined };
  next: (op: { path: string; signal?: AbortSignal }) => {
    subscribe(observer: Observer<unknown, unknown>): Unsubscribable;
  };
  observer: Observer<unknown, unknown>;
  timers: LifecycleTimers;
  onInvalidSession: () => void;
  onStateChange: ((event: SseLifecycleStateChange) => void) | undefined;
  resumablePaths: readonly string[];
}

interface SourceLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

class SseLifecycleRunner {
  private generation = 0;
  private attempt = 0;
  private torn = false;
  private errored = false;
  private backoffHandle: unknown;
  private healthHandle: unknown;
  private attemptSub: Unsubscribable | undefined;
  private attemptAc: AbortController | undefined;
  private attemptSource: SourceLike | undefined;
  private attemptSourceError: ((event: unknown) => void) | undefined;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly resumablePaths: readonly string[];
  private readonly callerAbort = (): void => {
    if (this.torn) return;
    this.teardown();
    this.deps.observer.complete();
  };

  constructor(private readonly deps: LifecycleDeps) {
    this.callerSignal = deps.op.signal ?? undefined;
    this.resumablePaths = deps.resumablePaths;
  }

  begin(): () => void {
    this.emitState("connecting");
    const signal = this.callerSignal;
    if (signal) {
      signal.addEventListener("abort", this.callerAbort);
      if (signal.aborted) {
        this.teardown();
        this.deps.observer.complete();
        return this.teardownBound;
      }
    }
    this.startAttempt();
    return this.teardownBound;
  }

  private readonly teardownBound = (): void => {
    this.teardown();
  };

  private emitState(
    state: SseLifecycleState,
    details: { delayMs?: number; error?: unknown } = {},
  ): void {
    this.deps.onStateChange?.({
      path: this.deps.op.path,
      state,
      attempt: this.attempt,
      ...(details.delayMs !== undefined ? { delayMs: details.delayMs } : {}),
      ...(details.error !== undefined ? { error: details.error } : {}),
    });
  }

  private clearTimers(): void {
    if (this.backoffHandle !== undefined) {
      this.deps.timers.clearTimeout(this.backoffHandle);
      this.backoffHandle = undefined;
    }
    if (this.healthHandle !== undefined) {
      this.deps.timers.clearTimeout(this.healthHandle);
      this.healthHandle = undefined;
    }
  }

  // Every inner envelope carries context.eventSource; attaching our own
  // 'error' listener turns a source drop into a synchronous handleDrop
  // inside dispatchEvent — long before the chunk resurfaces through the
  // consumer's ReadableStream hop, whose async tail the generation guard
  // then discards.
  private attachSource(source: unknown): void {
    if (this.attemptSource !== undefined || !isObject(source)) return;
    if (
      typeof source["addEventListener"] !== "function" ||
      typeof source["removeEventListener"] !== "function"
    ) {
      return;
    }
    const gen = this.generation;
    const listener = (event: unknown): void => {
      if (gen !== this.generation || this.torn) return;
      this.handleDrop(TRPCClientError.from(event as object));
    };
    const target = source as unknown as SourceLike;
    target.addEventListener("error", listener);
    this.attemptSource = target;
    this.attemptSourceError = listener;
  }

  private detachSource(): void {
    const source = this.attemptSource;
    const listener = this.attemptSourceError;
    this.attemptSource = undefined;
    this.attemptSourceError = undefined;
    if (source !== undefined && listener !== undefined) {
      source.removeEventListener("error", listener);
    }
  }

  // Generation bumps first so the inner teardown's stale observer emissions
  // (its own complete(), and the stopped/idle tail after ac.abort) land in a
  // dead generation.
  private teardownAttempt(): void {
    if (this.attemptSub === undefined && this.attemptAc === undefined) return;
    const sub = this.attemptSub;
    const ac = this.attemptAc;
    this.attemptSub = undefined;
    this.attemptAc = undefined;
    this.generation += 1;
    this.detachSource();
    sub?.unsubscribe();
    ac?.abort();
  }

  private teardown(): void {
    if (this.torn) return;
    this.torn = true;
    this.clearTimers();
    this.teardownAttempt();
    const signal = this.callerSignal;
    if (signal) signal.removeEventListener("abort", this.callerAbort);
    if (!this.errored) this.emitState("idle");
  }

  private handleDrop(err: unknown): void {
    const classified = classifyTransportError(err);
    if (this.healthHandle !== undefined) {
      this.deps.timers.clearTimeout(this.healthHandle);
      this.healthHandle = undefined;
    }
    this.teardownAttempt();
    if (!classified.retryable) {
      this.errored = true;
      if (classified.kind === "invalid_session") this.deps.onInvalidSession();
      this.emitState("error", { error: err });
      this.deps.observer.error(err);
      this.teardown();
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30000;
    this.attempt += 1;
    this.emitState("reconnecting", { delayMs: delay });
    this.backoffHandle = this.deps.timers.setTimeout(() => {
      if (this.torn) return;
      this.backoffHandle = undefined;
      this.emitState("connecting");
      this.startAttempt();
    }, delay);
  }

  // Inner connection states are never forwarded; a 'connecting' state
  // carrying a non-envelope error is a transport drop.
  private handleStateFields(fields: Record<string, unknown>): void {
    const err = fields["error"];
    if (
      fields["state"] === "connecting" &&
      err !== undefined &&
      err !== null &&
      !hasTrpcEnvelope(err)
    ) {
      this.handleDrop(err);
    }
  }

  private handleStarted(envelope: unknown): void {
    this.emitState("streaming");
    this.deps.observer.next(envelope);
    if (this.attempt > 0) {
      this.deps.observer.next({ result: { type: "data", data: RECONNECT_SIGNAL } });
    }
    if (this.healthHandle !== undefined) {
      this.deps.timers.clearTimeout(this.healthHandle);
    }
    this.healthHandle = this.deps.timers.setTimeout(() => {
      this.healthHandle = undefined;
      this.attempt = 0;
    }, HEALTH_CONFIRM_MS);
  }

  private handleInnerNext(envelope: unknown): void {
    if (isObject(envelope)) {
      const context = envelope["context"];
      if (isObject(context) && context["eventSource"] !== undefined) {
        this.attachSource(context["eventSource"]);
      }
    }
    const result = isObject(envelope) ? envelope["result"] : undefined;
    const fields: Record<string, unknown> = isObject(result) ? result : {};
    switch (fields["type"]) {
      case "state":
        this.handleStateFields(fields);
        return;
      case "started":
        this.handleStarted(envelope);
        return;
      default:
        this.deps.observer.next(envelope);
    }
  }

  private handleInnerComplete(): void {
    // A real inner completion (server RETURN / stream end). The source is
    // already closed: running the inner teardown — or aborting our attempt
    // signal — would fire the consumer's onAbort and close it a second time,
    // so the attempt is dropped without unsubscribe.
    this.generation += 1;
    this.attemptSub = undefined;
    this.attemptAc = undefined;
    this.detachSource();
    // Resumable paths: schedule a bounded reconnect behind a
    // RECONNECTING_SIGNAL data frame instead of completing.
    if (this.resumablePaths.includes(this.deps.op.path)) {
      if (this.healthHandle !== undefined) {
        this.deps.timers.clearTimeout(this.healthHandle);
        this.healthHandle = undefined;
      }
      this.deps.observer.next({ result: { type: "data", data: RECONNECTING_SIGNAL } });
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30000;
      this.attempt += 1;
      this.emitState("reconnecting", { delayMs: delay });
      this.backoffHandle = this.deps.timers.setTimeout(() => {
        if (this.torn) return;
        this.backoffHandle = undefined;
        this.emitState("connecting");
        this.startAttempt();
      }, delay);
      return;
    }
    this.deps.observer.complete();
    this.teardown();
    // The wrapped complete() must never reach its unsubscribe(): that would
    // run the inner teardownRef and its ac.abort() -> onAbort ->
    // EventSource.close() a second time. The throw unwinds into
    // httpSubscriptionLink's run().catch where isDone swallows it.
    throw new Error("sse-lifecycle inner stream ended");
  }

  private startAttempt(): void {
    const ac = new AbortController();
    this.attemptAc = ac;
    const gen = this.generation;
    this.attemptSub = this.deps.next({ ...this.deps.op, signal: ac.signal }).subscribe({
      next: (envelope) => {
        if (gen !== this.generation || this.torn) return;
        this.handleInnerNext(envelope);
      },
      error: (err) => {
        if (gen !== this.generation || this.torn) return;
        this.handleDrop(err);
      },
      complete: () => {
        if (gen !== this.generation || this.torn) return;
        this.handleInnerComplete();
      },
    });
  }
}

export function sseLifecycleLink<TRouter extends AnyRouter>(
  linkOpts: SseLifecycleLinkOptions = {},
): TRPCLink<TRouter> {
  const timers = linkOpts.timers ?? defaultTimers;
  const onInvalidSession = linkOpts.onInvalidSession ?? consoleSessionStore.markInvalid;
  const onStateChange = linkOpts.onStateChange;
  const resumablePaths = linkOpts.resumablePaths ?? [];

  return () => {
    return ({ op, next }) => {
      return observable((observer) => {
        const runner = new SseLifecycleRunner({
          op,
          next: next as unknown as LifecycleDeps["next"],
          observer: observer as unknown as LifecycleDeps["observer"],
          timers,
          onInvalidSession,
          onStateChange,
          resumablePaths,
        });
        return runner.begin();
      });
    };
  };
}
