import { reconcileOnce, type ReconcileOptions, type ReconcileResult } from './reconciler.js';
import type { ApplyEvent } from './apply.js';
import type { ModelRun } from './schema.js';

export interface ReconcileLoopStatus {
  running: boolean;
  intervalMs: number;
  lastPassAt: string | null;
  lastResult: ReconcileResult | null;
  nextPassAt: string | null;
}

interface LoopState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  intervalMs: number;
  lastPassAt: number | null;
  lastResult: ReconcileResult | null;
  lastEvents: Array<ApplyEvent & { name: string; ts: string }>;
  inflight: boolean;
}

const state: LoopState = {
  timer: null,
  running: false,
  intervalMs: 10_000,
  lastPassAt: null,
  lastResult: null,
  lastEvents: [],
  inflight: false,
};

/**
 * In-process reconcile loop. Runs alongside the control plane — the
 * Electron main process or a CLI daemon — so the user can toggle
 * auto-heal from the UI without provisioning a separate service.
 *
 * Production installations that want a persistent reconciler outside
 * the UI's lifecycle should still use `llamactl controller serve`;
 * this in-process variant is deliberately scoped to "auto-heal while
 * the app is running".
 */
function scheduleNext(getClient: ReconcileOptions['getClient']): void {
  if (!state.running) return;
  state.timer = setTimeout(() => {
    void tick(getClient);
  }, state.intervalMs);
}

async function tick(getClient: ReconcileOptions['getClient']): Promise<void> {
  if (state.inflight) return;
  state.inflight = true;
  const events: Array<ApplyEvent & { name: string; ts: string }> = [];
  try {
    const result = await reconcileOnce({
      // Skip manifests whose restartPolicy is Never — the whole
      // point of the policy is "controller leaves this alone".
      filter: (m: ModelRun) => m.spec.restartPolicy !== 'Never',
      getClient,
      onEvent: (e) => {
        events.push({ ...e, ts: new Date().toISOString() });
      },
    });
    state.lastResult = result;
  } catch (err) {
    const now = new Date().toISOString();
    events.push({
      name: '(loop)',
      type: 'skipped',
      message: `reconcile loop error: ${(err as Error).message}`,
      ts: now,
    });
    state.lastResult = {
      errors: 1,
      reports: [
        { name: '(loop)', node: '-', action: 'unchanged', error: (err as Error).message },
      ],
    };
  } finally {
    state.inflight = false;
    state.lastPassAt = Date.now();
    // Keep the last 200 events for UI display without unbounded growth.
    state.lastEvents = [...state.lastEvents, ...events].slice(-200);
    scheduleNext(getClient);
  }
}

export function startReconcileLoop(opts: {
  getClient: ReconcileOptions['getClient'];
  intervalMs?: number;
}): void {
  if (state.running) return;
  state.running = true;
  state.intervalMs = opts.intervalMs ?? 10_000;
  // Kick immediately so the UI sees an initial pass without waiting.
  void tick(opts.getClient);
}

export function stopReconcileLoop(): void {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export async function kickReconcileLoop(
  getClient: ReconcileOptions['getClient'],
): Promise<void> {
  await tick(getClient);
}

export function reconcileLoopStatus(): ReconcileLoopStatus {
  const nextPassAt =
    state.running && state.lastPassAt
      ? new Date(state.lastPassAt + state.intervalMs).toISOString()
      : null;
  return {
    running: state.running,
    intervalMs: state.intervalMs,
    lastPassAt: state.lastPassAt ? new Date(state.lastPassAt).toISOString() : null,
    lastResult: state.lastResult,
    nextPassAt,
  };
}

export function reconcileLoopEvents(): Array<ApplyEvent & { name: string; ts: string }> {
  return state.lastEvents.slice();
}
