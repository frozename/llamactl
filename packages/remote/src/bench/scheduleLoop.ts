import {
  defaultScheduleFilePath,
  isDue,
  loadSchedules,
  saveSchedules,
  updateSchedule,
  type BenchSchedule,
} from './schedule.js';

/**
 * In-process bench scheduler. Every `tickIntervalMs` it iterates the
 * schedule store and fires `benchPresetRun` for every schedule that's
 * due. Intentionally minimal — there's no queue, no concurrency, no
 * backoff; a single run at a time, one node at a time, so a slow
 * bench doesn't cascade into overlapping model loads on the same
 * GPU. Users who need richer scheduling can run `llamactl bench run`
 * from a cron of their own.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SubscribeCallbacks = { onData: (e: any) => void; onError: (err: any) => void; onComplete: () => void };

export interface BenchClient {
  benchPresetRun: {
    subscribe(
      input: { target: string; mode?: 'auto' | 'text' | 'vision' },
      callbacks: SubscribeCallbacks,
    ): { unsubscribe?: () => void };
  };
}

export interface BenchLoopStatus {
  running: boolean;
  tickIntervalMs: number;
  lastTickAt: string | null;
  nextTickAt: string | null;
  /** `true` while a bench run is currently executing — further ticks
   *  are skipped until it returns. */
  inflight: boolean;
  /** Short log of the most recent activity (bounded to 200 entries). */
  recent: Array<{ ts: string; id: string; rel: string; node: string; ok: boolean; message?: string }>;
}

interface LoopState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  tickIntervalMs: number;
  inflight: boolean;
  lastTickAt: number | null;
  recent: BenchLoopStatus['recent'];
}

const state: LoopState = {
  timer: null,
  running: false,
  tickIntervalMs: 60_000,
  inflight: false,
  lastTickAt: null,
  recent: [],
};

function schedule(getClient: (nodeName: string) => BenchClient): void {
  if (!state.running) return;
  state.timer = setTimeout(() => {
    void tick(getClient);
  }, state.tickIntervalMs);
}

async function runOne(schedule: BenchSchedule, client: BenchClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 15-minute hard cap so a hung bench doesn't wedge the loop.
    const timer = setTimeout(
      () => reject(new Error('bench run timed out after 15m')),
      15 * 60_000,
    );
    let errored = false;
    const sub = client.benchPresetRun.subscribe(
      { target: schedule.rel, mode: schedule.mode },
      {
        onData: (evt: unknown) => {
          const e = evt as { type?: string; result?: { error?: string } };
          if (e.type === 'done-preset' && e.result?.error) {
            errored = true;
            clearTimeout(timer);
            reject(new Error(e.result.error));
          }
        },
        onError: (err: unknown) => {
          if (errored) return;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
        onComplete: () => {
          if (errored) return;
          clearTimeout(timer);
          resolve();
        },
      },
    );
    void sub;
  });
}

async function tick(getClient: (nodeName: string) => BenchClient): Promise<void> {
  if (state.inflight) return;
  state.inflight = true;
  state.lastTickAt = Date.now();
  try {
    const path = defaultScheduleFilePath();
    let schedules = loadSchedules(path);
    const now = Date.now();
    for (const s of schedules) {
      if (!isDue(s, now)) continue;
      const ts = new Date().toISOString();
      try {
        const client = getClient(s.node);
        await runOne(s, client);
        schedules = updateSchedule(schedules, s.id, {
          lastRunAt: new Date().toISOString(),
          lastError: null,
        });
        state.recent = [
          ...state.recent,
          { ts, id: s.id, rel: s.rel, node: s.node, ok: true },
        ].slice(-200);
      } catch (err) {
        const msg = (err as Error).message;
        schedules = updateSchedule(schedules, s.id, {
          lastRunAt: new Date().toISOString(),
          lastError: msg,
        });
        state.recent = [
          ...state.recent,
          { ts, id: s.id, rel: s.rel, node: s.node, ok: false, message: msg },
        ].slice(-200);
      }
      saveSchedules(schedules, path);
    }
  } finally {
    state.inflight = false;
    schedule(getClient);
  }
}

export function startBenchScheduler(opts: {
  getClient: (nodeName: string) => BenchClient;
  tickIntervalMs?: number;
}): void {
  if (state.running) return;
  state.running = true;
  state.tickIntervalMs = opts.tickIntervalMs ?? 60_000;
  void tick(opts.getClient);
}

export function stopBenchScheduler(): void {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export async function kickBenchScheduler(
  getClient: (nodeName: string) => BenchClient,
): Promise<void> {
  await tick(getClient);
}

export function benchSchedulerStatus(): BenchLoopStatus {
  return {
    running: state.running,
    tickIntervalMs: state.tickIntervalMs,
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    nextTickAt:
      state.running && state.lastTickAt
        ? new Date(state.lastTickAt + state.tickIntervalMs).toISOString()
        : null,
    inflight: state.inflight,
    recent: state.recent.slice(),
  };
}
