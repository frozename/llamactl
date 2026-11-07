import { dirname } from "node:path";

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "../safe-fs.js";
import {
  benchRunLockPath,
  type BenchSchedule,
  defaultScheduleFilePath,
  isDue,
  loadSchedules,
  recordRunOutcome,
} from "./schedule.js";

/**
 * In-process bench scheduler. Every `tickIntervalMs` it iterates the
 * schedule store and fires `benchPresetRun` for every schedule that's
 * due. Intentionally minimal — there's no queue, no concurrency, no
 * backoff; a single run at a time, one node at a time, so a slow
 * bench doesn't cascade into overlapping model loads on the same
 * GPU. Users who need richer scheduling can run `llamactl bench run`
 * from a cron of their own.
 *
 * Two cross-process invariants make `llamactl bench schedule run` +
 * `kick` + `rm` safe next to each other (and next to this module's
 * in-process callers):
 *
 * - Run fields are never written from a stale in-memory list. Each
 *   bench's outcome is stamped through `recordRunOutcome`, which
 *   re-loads the store and patches only that id, skipping a schedule
 *   that was removed or disabled while the bench ran.
 * - One run lock (a lockfile beside the store, holding pid + start
 *   time) serialises bench execution across processes. `run` takes it
 *   for the loop's lifetime; `kick` takes it for the duration of the
 *   tick and refuses while a live pid holds it. Dead pids (and pids
 *   from a crashed run in this same process) are reclaimed.
 */

type SubscribeCallbacks = {
  onData: (e: unknown) => void;
  onError: (err: unknown) => void;
  onComplete: () => void;
};

export interface BenchClient {
  benchPresetRun: {
    subscribe(
      input: { target: string; mode?: "auto" | "text" | "vision" },
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
  recent: {
    ts: string;
    id: string;
    rel: string;
    node: string;
    ok: boolean;
    message?: string;
  }[];
}

interface LoopState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  tickIntervalMs: number;
  inflight: boolean;
  lastTickAt: number | null;
  recent: BenchLoopStatus["recent"];
  /** Path of the run lock this process currently holds, if any. */
  lockPath: string | null;
}

const state: LoopState = {
  timer: null,
  running: false,
  tickIntervalMs: 60_000,
  inflight: false,
  lastTickAt: null,
  recent: [],
  lockPath: null,
};

interface RunLockPayload {
  pid: number;
  startedAt: string;
}

const RUN_LOCK_RECLAIM_ATTEMPTS = 4;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRunLock(path: string): RunLockPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown };
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, startedAt: typeof startedAt === "string" ? startedAt : "unknown" };
}

function lockHeldMessage(holder: RunLockPayload): string {
  return (
    `a bench scheduler run already holds the run lock ` +
    `(pid ${String(holder.pid)}, started ${holder.startedAt}); ` +
    `stop it before kicking or starting another run`
  );
}

function tryCreateRunLock(path: string): boolean {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    writeFileSync(path, payload, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function runLockIsStale(holder: RunLockPayload): boolean {
  return holder.pid === process.pid || !pidAlive(holder.pid);
}

function unlinkRunLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function acquireRunLock(): void {
  if (state.lockPath !== null) return;
  const path = benchRunLockPath();
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < RUN_LOCK_RECLAIM_ATTEMPTS; attempt += 1) {
    if (tryCreateRunLock(path)) {
      state.lockPath = path;
      return;
    }
    const holder = readRunLock(path);
    if (holder !== null && !runLockIsStale(holder)) throw new Error(lockHeldMessage(holder));
    unlinkRunLock(path);
  }
  throw new Error(`bench scheduler run lock at ${path} stayed contended; try again`);
}

function releaseRunLock(): void {
  if (state.lockPath === null) return;
  const path = state.lockPath;
  state.lockPath = null;
  const holder = readRunLock(path);
  if (holder === null || holder.pid === process.pid) unlinkRunLock(path);
}

function schedule(getClient: (nodeName: string) => BenchClient): void {
  if (!state.running) return;
  state.timer = setTimeout(() => {
    void tick(getClient, { forLoop: true });
  }, state.tickIntervalMs);
}

async function runOne(schedule: BenchSchedule, client: BenchClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // 15-minute hard cap so a hung bench doesn't wedge the loop.
    const timer = setTimeout(() => {
      reject(new Error("bench run timed out after 15m"));
    }, 15 * 60_000);
    let errored = false;
    const sub = client.benchPresetRun.subscribe(
      { target: schedule.rel, mode: schedule.mode },
      {
        onData: (evt: unknown) => {
          const e = evt as { type?: string; result?: { error?: string } };
          if (e.type === "done-preset" && e.result?.error) {
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

interface RunOutcome {
  entry: BenchLoopStatus["recent"][number];
  patch: { lastRunAt: string; lastError: string | null };
}

async function runWithOutcome(
  schedule: BenchSchedule,
  getClient: (nodeName: string) => BenchClient,
): Promise<RunOutcome> {
  const ts = new Date().toISOString();
  const lastRunAt = new Date().toISOString();
  try {
    await runOne(schedule, getClient(schedule.node));
    return {
      entry: { ts, id: schedule.id, rel: schedule.rel, node: schedule.node, ok: true },
      patch: { lastRunAt, lastError: null },
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      entry: {
        ts,
        id: schedule.id,
        rel: schedule.rel,
        node: schedule.node,
        ok: false,
        message: msg,
      },
      patch: { lastRunAt, lastError: msg },
    };
  }
}

async function tick(
  getClient: (nodeName: string) => BenchClient,
  opts: { forLoop: boolean },
): Promise<void> {
  if (state.inflight) return;
  state.inflight = true;
  state.lastTickAt = Date.now();
  try {
    const path = defaultScheduleFilePath();
    const now = Date.now();
    for (const s of loadSchedules(path)) {
      // A stop request (running -> false) must finish only the bench in
      // flight, never start the remaining due ones.
      if (opts.forLoop && !state.running) break;
      if (!isDue(s, now)) continue;
      const outcome = await runWithOutcome(s, getClient);
      recordRunOutcome(path, s.id, outcome.patch);
      state.recent = [...state.recent, outcome.entry].slice(-200);
    }
  } finally {
    state.inflight = false;
    if (opts.forLoop && !state.running) releaseRunLock();
    schedule(getClient);
  }
}

export function startBenchScheduler(opts: {
  getClient: (nodeName: string) => BenchClient;
  tickIntervalMs?: number;
}): void {
  if (state.running) return;
  acquireRunLock();
  state.running = true;
  state.tickIntervalMs = opts.tickIntervalMs ?? 60_000;
  void tick(opts.getClient, { forLoop: true });
}

export function stopBenchScheduler(): void {
  state.running = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  // With a bench in flight the lock is released by that tick's finally,
  // so a draining `run` keeps other processes out until it exits.
  if (!state.inflight) releaseRunLock();
}

export async function kickBenchScheduler(
  getClient: (nodeName: string) => BenchClient,
): Promise<void> {
  const heldBefore = state.lockPath !== null;
  acquireRunLock();
  try {
    await tick(getClient, { forLoop: false });
  } finally {
    if (!heldBefore) releaseRunLock();
  }
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
