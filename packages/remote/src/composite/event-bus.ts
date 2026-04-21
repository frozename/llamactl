/**
 * Composite event bus — bridges the `applyComposite` callback-driven
 * event stream to live tRPC `compositeStatus` subscribers. Runs are
 * keyed by composite name so concurrent applies of unrelated composites
 * don't cross-talk.
 *
 * Lifecycle:
 *   startRun(name)  → opens a fresh buffer for `name` (clearing any
 *                     prior run + its retention timer).
 *   emit(name, e)   → appends to the buffer and fan-outs to all active
 *                     listeners for `name`. Listener exceptions are
 *                     swallowed so slow/broken subscribers never block
 *                     the applier.
 *   endRun(name)    → flips `done = true` and schedules the run's
 *                     eviction after a retention window. Late
 *                     subscribers arriving inside that window still
 *                     receive the full buffered story.
 *   subscribe       → replays the existing buffer synchronously, then
 *                     attaches the listener for future emissions.
 *   currentRun      → snapshot for the status subscription to decide
 *                     "live vs. fallback-to-persisted".
 *
 * This module is deliberately in-memory. Durability of the final
 * apply outcome lives on the composite YAML's `status` field via
 * `saveComposite(..)`.
 */
import type { CompositeApplyEvent } from './types.js';

export interface CompositeRun {
  name: string;
  startedAt: string;
  events: CompositeApplyEvent[];
  done: boolean;
}

export interface CompositeEventBus {
  startRun(name: string): void;
  emit(name: string, event: CompositeApplyEvent): void;
  endRun(name: string): void;
  subscribe(name: string, listener: (e: CompositeApplyEvent) => void): () => void;
  currentRun(name: string): CompositeRun | null;
}

/**
 * Retention window (ms) after `endRun` before the run is evicted. Long
 * enough for a late subscriber to pick up the outcome of an apply that
 * completed seconds ago; short enough that memory doesn't drift.
 */
export const COMPOSITE_RETENTION_MS = 30_000;

/**
 * Per-run event-count ceiling. Composite applies typically emit 10-30
 * events. We cap at a generous multiple to protect against runaway
 * event loops without changing well-behaved runs.
 */
export const COMPOSITE_MAX_EVENTS_PER_RUN = 1_000;

interface RunState {
  run: CompositeRun;
  listeners: Set<(e: CompositeApplyEvent) => void>;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

export function createCompositeEventBus(): CompositeEventBus {
  const runs = new Map<string, RunState>();

  const clearRetention = (state: RunState): void => {
    if (state.retentionTimer !== null) {
      clearTimeout(state.retentionTimer);
      state.retentionTimer = null;
    }
  };

  const startRun: CompositeEventBus['startRun'] = (name) => {
    const existing = runs.get(name);
    if (existing) {
      clearRetention(existing);
      // Drop any listeners from the previous run — a fresh start means
      // those subscribers are watching an already-ended run and should
      // be reattached by the subscription layer if still interested.
      existing.listeners.clear();
    }
    runs.set(name, {
      run: {
        name,
        startedAt: new Date().toISOString(),
        events: [],
        done: false,
      },
      listeners: new Set(),
      retentionTimer: null,
    });
  };

  const emit: CompositeEventBus['emit'] = (name, event) => {
    const state = runs.get(name);
    if (!state) return;
    if (state.run.events.length >= COMPOSITE_MAX_EVENTS_PER_RUN) return;
    state.run.events.push(event);
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        // Fire-and-forget — a broken subscriber must never stop the
        // applier or other subscribers.
      }
    }
  };

  const endRun: CompositeEventBus['endRun'] = (name) => {
    const state = runs.get(name);
    if (!state) return;
    state.run.done = true;
    clearRetention(state);
    state.retentionTimer = setTimeout(() => {
      // Only evict if we still hold *this* run. A fresh startRun(name)
      // will have cleared `retentionTimer` and replaced the state.
      const current = runs.get(name);
      if (current === state) {
        runs.delete(name);
      }
    }, COMPOSITE_RETENTION_MS);
    // Unref so the timer never keeps the process alive on its own.
    const t = state.retentionTimer as unknown as { unref?: () => void };
    t.unref?.();
  };

  const subscribe: CompositeEventBus['subscribe'] = (name, listener) => {
    const state = runs.get(name);
    if (!state) {
      return () => {
        /* nothing to unsubscribe */
      };
    }
    // Replay the existing buffer synchronously before attaching so
    // late subscribers see the whole story without missing events
    // that emit between replay and listen.
    for (const ev of state.run.events) {
      try {
        listener(ev);
      } catch {
        // same swallow-policy as emit — never propagate
      }
    }
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };

  const currentRun: CompositeEventBus['currentRun'] = (name) => {
    const state = runs.get(name);
    if (!state) return null;
    // Return a shallow copy so mutations on `events` by the caller
    // don't stomp the live buffer. The events themselves are frozen-
    // shape plain objects from `applyComposite` so a shallow clone of
    // the array is enough.
    return {
      name: state.run.name,
      startedAt: state.run.startedAt,
      events: [...state.run.events],
      done: state.run.done,
    };
  };

  return { startRun, emit, endRun, subscribe, currentRun };
}

/**
 * Module-level singleton — the applier + router share this instance
 * without needing DI plumbing. Tests should call `_resetForTests()` in
 * `beforeEach` to clear state between cases.
 */
export const compositeEvents: CompositeEventBus = createCompositeEventBus();

/**
 * Test-only escape hatch. Replaces the singleton's internals with a
 * fresh bus so state from a prior test can't leak. Exported with a
 * leading underscore so production callers don't reach for it.
 */
export function _resetForTests(): void {
  const fresh = createCompositeEventBus();
  (compositeEvents as { startRun: CompositeEventBus['startRun'] }).startRun =
    fresh.startRun;
  (compositeEvents as { emit: CompositeEventBus['emit'] }).emit = fresh.emit;
  (compositeEvents as { endRun: CompositeEventBus['endRun'] }).endRun =
    fresh.endRun;
  (compositeEvents as { subscribe: CompositeEventBus['subscribe'] }).subscribe =
    fresh.subscribe;
  (
    compositeEvents as { currentRun: CompositeEventBus['currentRun'] }
  ).currentRun = fresh.currentRun;
}
