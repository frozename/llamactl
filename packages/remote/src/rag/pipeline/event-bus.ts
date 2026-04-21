/**
 * RAG pipeline event bus. Tracks "is this pipeline ingesting right
 * now" state for the Electron Pipelines tab + any ops-chat surface
 * that wants to show liveness. Narrower than the composite event
 * bus (no subscribe/emit — the UI polls, it doesn't subscribe), but
 * the lifecycle shape + 30s retention window are the same.
 *
 * Lifecycle:
 *   startRun(name, { sources })  → opens a fresh record for `name`,
 *                                   clearing any retention timer
 *                                   from a previous run.
 *   endRun(name)                  → flips `done=true` + schedules
 *                                   eviction after RETENTION_MS.
 *                                   `allRunning()` stops including
 *                                   the name immediately; `currentRun`
 *                                   keeps returning the (done=true)
 *                                   record for the retention window
 *                                   so late-arriving pollers can see
 *                                   "just finished".
 *   allRunning()                  → names where `!done`. Drives the
 *                                   Pipelines tab's "running" badge.
 *   currentRun(name)              → snapshot of the run (or null).
 *
 * In-memory only. Crashes lose the signal by design; the journal's
 * `run-started` entry is the persistent marker for forensic
 * recovery and the scheduler's own `inFlight` Set is the
 * re-entry guard.
 */

export interface PipelineRun {
  name: string;
  startedAt: string;
  sources: string[];
  done: boolean;
}

export interface PipelineEventBus {
  startRun(name: string, init: { sources: string[] }): void;
  endRun(name: string): void;
  currentRun(name: string): PipelineRun | null;
  allRunning(): string[];
}

/**
 * Retention window (ms) after `endRun` before the run is evicted.
 * Matches the composite bus's 30s so late pollers (Pipelines tab
 * at 2s refetch = up to 15 polls) still see "just finished" state.
 */
export const PIPELINE_RETENTION_MS = 30_000;

interface RunState {
  run: PipelineRun;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

export function createPipelineEventBus(): PipelineEventBus {
  const runs = new Map<string, RunState>();

  const clearRetention = (state: RunState): void => {
    if (state.retentionTimer !== null) {
      clearTimeout(state.retentionTimer);
      state.retentionTimer = null;
    }
  };

  const startRun: PipelineEventBus['startRun'] = (name, init) => {
    const existing = runs.get(name);
    if (existing) clearRetention(existing);
    runs.set(name, {
      run: {
        name,
        startedAt: new Date().toISOString(),
        sources: [...init.sources],
        done: false,
      },
      retentionTimer: null,
    });
  };

  const endRun: PipelineEventBus['endRun'] = (name) => {
    const state = runs.get(name);
    if (!state) return;
    state.run.done = true;
    clearRetention(state);
    state.retentionTimer = setTimeout(() => {
      // Only evict if we still hold *this* run. A fresh startRun(name)
      // will have cleared retentionTimer and replaced the state, so
      // comparing by identity is the right guard.
      const current = runs.get(name);
      if (current === state) runs.delete(name);
    }, PIPELINE_RETENTION_MS);
    const t = state.retentionTimer as unknown as { unref?: () => void };
    t.unref?.();
  };

  const currentRun: PipelineEventBus['currentRun'] = (name) => {
    const state = runs.get(name);
    if (!state) return null;
    return {
      name: state.run.name,
      startedAt: state.run.startedAt,
      sources: [...state.run.sources],
      done: state.run.done,
    };
  };

  const allRunning: PipelineEventBus['allRunning'] = () => {
    const out: string[] = [];
    for (const [name, state] of runs) {
      if (!state.run.done) out.push(name);
    }
    return out;
  };

  return { startRun, endRun, currentRun, allRunning };
}

/**
 * Module-level singleton. Runtime calls startRun / endRun; the
 * tRPC router reads via allRunning / currentRun. Tests call
 * `_resetPipelineEventsForTests()` in `beforeEach` to clear any
 * leaked state.
 */
export const pipelineEvents: PipelineEventBus = createPipelineEventBus();

export function _resetPipelineEventsForTests(): void {
  const fresh = createPipelineEventBus();
  (pipelineEvents as { startRun: PipelineEventBus['startRun'] }).startRun =
    fresh.startRun;
  (pipelineEvents as { endRun: PipelineEventBus['endRun'] }).endRun =
    fresh.endRun;
  (pipelineEvents as { currentRun: PipelineEventBus['currentRun'] }).currentRun =
    fresh.currentRun;
  (pipelineEvents as { allRunning: PipelineEventBus['allRunning'] }).allRunning =
    fresh.allRunning;
}
