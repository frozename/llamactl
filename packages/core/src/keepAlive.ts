import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveEnv } from './env.js';
import { formatBenchTimestamp } from './bench/runner.js';
import { endpoint, readServerPid, startServer, stopServer } from './server.js';
import { resolveTarget } from './target.js';
import type { ResolvedEnv } from './types.js';

export function keepAlivePidFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'llama-keep-alive.pid');
}

export function keepAliveStopFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'llama-keep-alive.stop');
}

export function keepAliveStateFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'llama-keep-alive.state');
}

export function keepAliveLogFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LLAMA_CPP_LOGS, 'keep-alive.log');
}

export type KeepAliveState =
  | 'launching'
  | 'resolve-failed'
  | 'starting'
  | 'ready'
  | 'restart-pending'
  | 'start-failed'
  | 'stopped';

interface StateSnapshot {
  updated_at: string;
  target: string;
  model: string;
  state: KeepAliveState;
  restarts: number;
  backoff_seconds: number;
  log: string;
}

function writeState(
  resolved: ResolvedEnv,
  snapshot: Omit<StateSnapshot, 'updated_at' | 'log'>,
): void {
  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });
  const body =
    [
      `updated_at=${formatBenchTimestamp()}`,
      `target=${snapshot.target}`,
      `model=${snapshot.model}`,
      `state=${snapshot.state}`,
      `restarts=${snapshot.restarts}`,
      `backoff_seconds=${snapshot.backoff_seconds}`,
      `log=${keepAliveLogFile(resolved)}`,
    ].join('\n') + '\n';
  writeFileSync(keepAliveStateFile(resolved), body);
}

function parseState(raw: string): Partial<StateSnapshot> {
  const out: Partial<StateSnapshot> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case 'updated_at':
        out.updated_at = value;
        break;
      case 'target':
        out.target = value;
        break;
      case 'model':
        out.model = value;
        break;
      case 'state':
        out.state = value as KeepAliveState;
        break;
      case 'restarts':
        out.restarts = Number.parseInt(value, 10) || 0;
        break;
      case 'backoff_seconds':
        out.backoff_seconds = Number.parseInt(value, 10) || 0;
        break;
      case 'log':
        out.log = value;
        break;
    }
  }
  return out;
}

export function readKeepAliveState(
  resolved: ResolvedEnv = resolveEnv(),
): Partial<StateSnapshot> | null {
  const file = keepAliveStateFile(resolved);
  if (!existsSync(file)) return null;
  try {
    return parseState(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readKeepAlivePid(
  resolved: ResolvedEnv = resolveEnv(),
): number | null {
  const file = keepAlivePidFile(resolved);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export interface KeepAliveStatus {
  running: boolean;
  pid: number | null;
  state: Partial<StateSnapshot> | null;
}

export function keepAliveStatus(
  resolved: ResolvedEnv = resolveEnv(),
): KeepAliveStatus {
  const pid = readKeepAlivePid(resolved);
  const state = readKeepAliveState(resolved);
  if (!pid && existsSync(keepAlivePidFile(resolved))) {
    try {
      unlinkSync(keepAlivePidFile(resolved));
    } catch {
      // no-op
    }
  }
  return { running: pid !== null, pid, state };
}

export interface StopKeepAliveOptions {
  resolved?: ResolvedEnv;
  graceSeconds?: number;
}

export interface StopKeepAliveResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
}

/**
 * Signal the supervisor to exit by writing the stop file and wait up
 * to `graceSeconds` for the worker to acknowledge. If the worker is
 * still alive after the grace window, SIGTERM it. Always stops the
 * llama-server as a safety net in case the supervisor missed cleanup.
 */
export async function stopKeepAlive(
  opts: StopKeepAliveOptions = {},
): Promise<StopKeepAliveResult> {
  const resolved = opts.resolved ?? resolveEnv();
  const grace = Math.max(1, opts.graceSeconds ?? 10);
  const pid = readKeepAlivePid(resolved);
  if (pid === null) {
    try {
      unlinkSync(keepAlivePidFile(resolved));
    } catch {
      // no-op
    }
    try {
      unlinkSync(keepAliveStopFile(resolved));
    } catch {
      // no-op
    }
    return { stopped: true, pid: null, killed: false };
  }

  // Touch the stop file so the worker exits cleanly at the next tick.
  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  writeFileSync(keepAliveStopFile(resolved), '');

  let waited = 0;
  while (waited < grace && isAlive(pid)) {
    await new Promise((r) => setTimeout(r, 1000));
    waited += 1;
  }
  let killed = false;
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      killed = true;
    } catch {
      // no-op
    }
  }
  await stopServer({ resolved });
  try {
    unlinkSync(keepAlivePidFile(resolved));
  } catch {
    // no-op
  }
  try {
    unlinkSync(keepAliveStopFile(resolved));
  } catch {
    // no-op
  }
  return { stopped: true, pid, killed };
}

export interface RunKeepAliveWorkerOptions {
  target: string;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  /** Poll interval in seconds. Defaults to LLAMA_CPP_KEEP_ALIVE_INTERVAL or 5. */
  intervalSeconds?: number;
  /** Exponential backoff ceiling (seconds). */
  maxBackoff?: number;
  /** Cooperative abort handle — tests can trip this to break the loop. */
  signal?: AbortSignal;
}

function logLine(resolved: ResolvedEnv, line: string): void {
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });
  appendFileSync(
    keepAliveLogFile(resolved),
    `[${formatBenchTimestamp()}] ${line}\n`,
  );
}

/**
 * Supervisor loop. Runs until the stop file appears, the abort signal
 * fires, or the process is killed. Mirrors the shell
 * `_llama_keep_alive_worker`:
 *
 *   - Resolve target → rel. On failure, record state + exp-backoff.
 *   - Ensure llama-server is up (start if not). On failure, backoff.
 *   - Poll /health every interval seconds. If it drops, restart with
 *     exponential backoff capped by `maxBackoff`.
 *
 * Writes the current state snapshot after every meaningful transition
 * so `keep-alive status` can show "ready / restart-pending / …"
 * without running commands itself.
 */
export async function runKeepAliveWorker(
  opts: RunKeepAliveWorkerOptions,
): Promise<void> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const intervalSeconds =
    opts.intervalSeconds ??
    Math.max(
      1,
      Number.parseInt(env.LLAMA_CPP_KEEP_ALIVE_INTERVAL ?? '', 10) || 5,
    );
  const maxBackoff =
    opts.maxBackoff ??
    Math.max(
      intervalSeconds,
      Number.parseInt(env.LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF ?? '', 10) || 30,
    );

  // Clear any prior stop file and write an initial state.
  try {
    unlinkSync(keepAliveStopFile(resolved));
  } catch {
    // no-op
  }
  writeFileSync(keepAlivePidFile(resolved), `${process.pid}\n`);
  writeState(resolved, {
    target: opts.target,
    model: 'pending',
    state: 'launching',
    restarts: 0,
    backoff_seconds: 1,
  });

  let restarts = 0;
  let backoff = 1;
  const sleep = (s: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, s * 1000);
      opts.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  const shouldStop = () =>
    opts.signal?.aborted === true || existsSync(keepAliveStopFile(resolved));

  const cleanup = async (finalState: KeepAliveState, rel: string) => {
    logLine(resolved, `supervisor exiting state=${finalState}`);
    writeState(resolved, {
      target: opts.target,
      model: rel || 'unknown',
      state: finalState,
      restarts,
      backoff_seconds: backoff,
    });
    await stopServer({ resolved });
    try {
      unlinkSync(keepAlivePidFile(resolved));
    } catch {
      // no-op
    }
    try {
      unlinkSync(keepAliveStopFile(resolved));
    } catch {
      // no-op
    }
  };

  let lastRel = '';
  try {
    while (!shouldStop()) {
      const rel = resolveTarget(opts.target, env);
      if (!rel) {
        logLine(resolved, `target=${opts.target} resolve-failed`);
        writeState(resolved, {
          target: opts.target,
          model: 'unresolved',
          state: 'resolve-failed',
          restarts,
          backoff_seconds: backoff,
        });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      lastRel = rel;

      writeState(resolved, {
        target: opts.target,
        model: rel,
        state: 'starting',
        restarts,
        backoff_seconds: backoff,
      });
      logLine(resolved, `starting server for rel=${rel}`);

      const startRes = await startServer({
        target: rel,
        timeoutSeconds: 60,
        resolved,
        env,
      });
      if (!startRes.ok) {
        restarts += 1;
        logLine(
          resolved,
          `start-failed rel=${rel} error=${startRes.error ?? 'unknown'}`,
        );
        writeState(resolved, {
          target: opts.target,
          model: rel,
          state: 'start-failed',
          restarts,
          backoff_seconds: backoff,
        });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }

      backoff = 1;
      writeState(resolved, {
        target: opts.target,
        model: rel,
        state: 'ready',
        restarts,
        backoff_seconds: backoff,
      });
      logLine(resolved, `ready rel=${rel} pid=${startRes.pid}`);

      // Poll /health.
      while (!shouldStop()) {
        await sleep(intervalSeconds);
        if (shouldStop()) break;
        let ok = false;
        try {
          const res = await fetch(`${endpoint(resolved)}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          ok = res.status === 200;
        } catch {
          ok = false;
        }
        const pid = readServerPid(resolved);
        if (!ok || pid === null) {
          logLine(resolved, `health lost for rel=${rel}, will restart`);
          break;
        }
      }
      if (shouldStop()) break;

      restarts += 1;
      writeState(resolved, {
        target: opts.target,
        model: rel,
        state: 'restart-pending',
        restarts,
        backoff_seconds: backoff,
      });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  } finally {
    await cleanup('stopped', lastRel);
  }
}
