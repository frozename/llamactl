import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  benchProfileFile,
  defaultModeForRel,
  findLatestProfile,
  machineLabel,
  readBenchProfiles,
  serverProfileArgs,
} from './bench/index.js';
import { resolveBuildId } from './build.js';
import { ctxForModel } from './ctx.js';
import { resolveEnv } from './env.js';
import { resolveTarget } from './target.js';
import type { ResolvedEnv } from './types.js';

/**
 * Lifecycle events emitted during `startServer`. Forwarded to the CLI
 * (stderr) and any Electron subscription so the renderer can show a
 * live start-up log.
 */
export type ServerEvent =
  | { type: 'launch'; pid: number; command: string; args: string[] }
  | { type: 'waiting'; attempt: number; httpCode: string | null }
  | { type: 'ready'; pid: number; endpoint: string }
  | { type: 'retry'; reason: string }
  | { type: 'timeout'; pid: number }
  | { type: 'exited'; code: number | null };

function pidFile(resolved: ResolvedEnv): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'llama-server.pid');
}

function serverLog(resolved: ResolvedEnv): string {
  return join(resolved.LLAMA_CPP_LOGS, 'server.log');
}

export function endpoint(resolved: ResolvedEnv = resolveEnv()): string {
  return `http://${resolved.LLAMA_CPP_HOST}:${resolved.LLAMA_CPP_PORT}`;
}

function useTunedArgsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LLAMA_CPP_USE_TUNED_ARGS ?? 'true';
  switch (raw) {
    case '0':
    case 'false':
    case 'FALSE':
    case 'no':
    case 'NO':
    case 'off':
    case 'OFF':
      return false;
    default:
      return true;
  }
}

function safeRetryArgs(): string[] {
  return [
    '--flash-attn', 'off',
    '--no-cache-prompt',
    '--parallel', '1',
    '--no-cont-batching',
    '--no-mmproj-offload',
    '--no-warmup',
  ];
}

function hasMmprojArg(args: readonly string[]): boolean {
  return args.some((a) =>
    a === '--mmproj' || a === '-mm' || a === '--mmproj-url' || a === '--mmproj-auto',
  );
}

// ---- PID helpers -------------------------------------------------------

/**
 * Read the stored llama-server PID. Returns null when the file is
 * absent or malformed. The caller should then verify the PID is alive
 * (kill -0) before trusting it — stale files linger after crashes.
 */
export function readServerPid(resolved: ResolvedEnv = resolveEnv()): number | null {
  const file = pidFile(resolved);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeServerPid(resolved: ResolvedEnv, pid: number): void {
  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  writeFileSync(pidFile(resolved), `${pid}\n`);
}

function removeServerPid(resolved: ResolvedEnv): void {
  try {
    unlinkSync(pidFile(resolved));
  } catch {
    // no-op
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- status ------------------------------------------------------------

export interface ServerStatus {
  state: 'up' | 'down';
  endpoint: string;
  pid: number | null;
  health: {
    httpCode: number | null;
    reachable: boolean;
  };
}

/**
 * Report whether a local llama-server is reachable. Combines the stored
 * PID (if any, and alive) with a live `GET /health` probe so the status
 * reflects reality even when the PID file went stale from an unclean
 * shutdown.
 */
export async function serverStatus(
  resolved: ResolvedEnv = resolveEnv(),
): Promise<ServerStatus> {
  const pidRaw = readServerPid(resolved);
  const pid = pidRaw && isProcessAlive(pidRaw) ? pidRaw : null;
  if (pidRaw && !pid) removeServerPid(resolved);

  const healthUrl = `${endpoint(resolved)}/health`;
  let httpCode: number | null = null;
  try {
    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });
    httpCode = res.status;
  } catch {
    httpCode = null;
  }

  const reachable = httpCode === 200;
  const state: ServerStatus['state'] = reachable || pid !== null ? 'up' : 'down';

  return {
    state,
    endpoint: endpoint(resolved),
    pid,
    health: { httpCode, reachable },
  };
}

// ---- start/stop --------------------------------------------------------

export interface StartServerOptions {
  target: string;
  /** Additional arguments appended to the llama-server invocation. */
  extraArgs?: string[];
  /** How long to wait for /health to return 200 before giving up. */
  timeoutSeconds?: number;
  /** Skip tuned-profile arg lookup even when LLAMA_CPP_USE_TUNED_ARGS is on. */
  skipTuned?: boolean;
  onEvent?: (e: ServerEvent) => void;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, aborts an in-flight start: SIGTERMs the detached
   * llama-server child (tracked via PID) and short-circuits the
   * readiness polling with `aborted` outcome.
   */
  signal?: AbortSignal;
}

export interface StartServerResult {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  tunedProfile: string | null;
  retried: boolean;
  error?: string;
}

async function pollReady(
  pid: number,
  healthUrl: string,
  timeoutSeconds: number,
  onEvent?: (e: ServerEvent) => void,
  signal?: AbortSignal,
): Promise<'ready' | 'exited' | 'timeout' | 'aborted'> {
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    if (signal?.aborted) return 'aborted';
    let httpCode: string | null = null;
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(1000),
      });
      httpCode = String(res.status);
      if (res.status === 200) return 'ready';
      if (res.status === 503) {
        onEvent?.({ type: 'waiting', attempt, httpCode });
      } else if (!isProcessAlive(pid)) {
        return 'exited';
      }
    } catch {
      if (!isProcessAlive(pid)) return 'exited';
      onEvent?.({ type: 'waiting', attempt, httpCode });
    }
    // Interruptible sleep so SIGTERM + abort react within ~1s.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
  if (signal?.aborted) return 'aborted';
  return isProcessAlive(pid) ? 'timeout' : 'exited';
}

/**
 * Start llama-server in the background. Mirrors the shell `llama-start`:
 *
 *   1. Resolve the target to a rel + model path; fail if missing.
 *   2. Stop any previous instance, then spawn llama-server detached,
 *      redirecting stdout/stderr to `$LLAMA_CPP_LOGS/server.log`.
 *   3. Apply tuned launch args from bench-profiles.tsv when a record
 *      exists for (machine, rel, mode, ctx, build); otherwise use the
 *      `default` profile args.
 *   4. Poll `/health` until 200 or timeout; retry once with safe-flag
 *      mmproj args if the first attempt didn't come up and mmproj was
 *      in the arg set.
 *
 * Returns a structured result; non-null `error` indicates a hard
 * failure the caller should surface.
 */
export async function startServer(
  opts: StartServerOptions,
): Promise<StartServerResult> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const rel = resolveTarget(opts.target, env);
  if (!rel) {
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved),
      tunedProfile: null,
      retried: false,
      error: `Unknown target: ${opts.target}`,
    };
  }
  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  if (!existsSync(modelPath)) {
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved),
      tunedProfile: null,
      retried: false,
      error: `Model file not found: ${modelPath}`,
    };
  }
  const bin = join(resolved.LLAMA_CPP_BIN, 'llama-server');
  if (!existsSync(bin)) {
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved),
      tunedProfile: null,
      retried: false,
      error: `llama-server binary not found: ${bin}`,
    };
  }

  // Stop any existing instance — best effort.
  await stopServer({ resolved });

  mkdirSync(resolved.LLAMA_CPP_MODELS, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_CACHE, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });

  // Tuned-profile lookup.
  let tunedProfile: string | null = null;
  const extra = opts.extraArgs ?? [];
  const launchArgs: string[] = [];
  if (!opts.skipTuned && useTunedArgsEnabled(env)) {
    const mode = hasMmprojArg(extra) ? 'vision' : defaultModeForRel(rel, resolved);
    const ctx = ctxForModel(rel, resolved);
    const build = resolveBuildId(resolved);
    const machine = machineLabel(resolved);
    const rows = readBenchProfiles(benchProfileFile(resolved));
    const hit = findLatestProfile(rows, { machine, rel, mode, ctx, build });
    if (hit) {
      tunedProfile = hit.profile;
      launchArgs.push(...serverProfileArgs(hit.profile).split(/\s+/).filter(Boolean));
    } else {
      launchArgs.push(...serverProfileArgs('default').split(/\s+/).filter(Boolean));
    }
  } else {
    launchArgs.push(...serverProfileArgs('default').split(/\s+/).filter(Boolean));
  }
  launchArgs.push(...extra);

  const pid = await launchBackground({
    bin,
    modelPath,
    args: launchArgs,
    resolved,
    onEvent: opts.onEvent,
  });
  writeServerPid(resolved, pid);

  // Wire the caller's abort signal to SIGTERM the detached child so
  // a tRPC unsubscribe or Ctrl-C doesn't leave an orphan server.
  const killOnAbort = () => {
    try {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) killOnAbort();
    else opts.signal.addEventListener('abort', killOnAbort, { once: true });
  }

  const timeoutSeconds = opts.timeoutSeconds ?? 60;
  const healthUrl = `${endpoint(resolved)}/health`;
  let outcome = await pollReady(pid, healthUrl, timeoutSeconds, opts.onEvent, opts.signal);
  if (outcome === 'aborted') {
    opts.signal?.removeEventListener('abort', killOnAbort);
    killOnAbort();
    removeServerPid(resolved);
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved),
      tunedProfile,
      retried: false,
      error: 'Start aborted by caller',
    };
  }
  if (outcome === 'ready') {
    opts.signal?.removeEventListener('abort', killOnAbort);
    opts.onEvent?.({ type: 'ready', pid, endpoint: endpoint(resolved) });
    return {
      ok: true,
      pid,
      endpoint: endpoint(resolved),
      tunedProfile,
      retried: false,
    };
  }

  // Retry path: mmproj-safe flags.
  let retried = false;
  if (hasMmprojArg(launchArgs)) {
    opts.onEvent?.({ type: 'retry', reason: 'mmproj safe-flag retry' });
    await stopServer({ resolved });
    const retryArgs = [...launchArgs, ...safeRetryArgs()];
    const retryPid = await launchBackground({
      bin,
      modelPath,
      args: retryArgs,
      resolved,
      onEvent: opts.onEvent,
    });
    writeServerPid(resolved, retryPid);
    outcome = await pollReady(retryPid, healthUrl, timeoutSeconds, opts.onEvent, opts.signal);
    retried = true;
    if (outcome === 'aborted') {
      try {
        if (isProcessAlive(retryPid)) process.kill(retryPid, 'SIGTERM');
      } catch {
        // already gone
      }
      removeServerPid(resolved);
      opts.signal?.removeEventListener('abort', killOnAbort);
      return {
        ok: false,
        pid: null,
        endpoint: endpoint(resolved),
        tunedProfile,
        retried: true,
        error: 'Start aborted by caller',
      };
    }
    if (outcome === 'ready') {
      opts.signal?.removeEventListener('abort', killOnAbort);
      opts.onEvent?.({ type: 'ready', pid: retryPid, endpoint: endpoint(resolved) });
      return {
        ok: true,
        pid: retryPid,
        endpoint: endpoint(resolved),
        tunedProfile,
        retried: true,
      };
    }
  }

  opts.signal?.removeEventListener('abort', killOnAbort);

  if (outcome === 'timeout') {
    opts.onEvent?.({ type: 'timeout', pid });
    return {
      ok: false,
      pid,
      endpoint: endpoint(resolved),
      tunedProfile,
      retried,
      error: `llama-server readiness check timed out after ${timeoutSeconds}s`,
    };
  }

  opts.onEvent?.({ type: 'exited', code: null });
  return {
    ok: false,
    pid: null,
    endpoint: endpoint(resolved),
    tunedProfile,
    retried,
    error: 'llama-server exited before becoming ready',
  };
}

interface LaunchArgs {
  bin: string;
  modelPath: string;
  args: string[];
  resolved: ResolvedEnv;
  onEvent?: (e: ServerEvent) => void;
}

async function launchBackground(opts: LaunchArgs): Promise<number> {
  const { openSync, closeSync } = await import('node:fs');
  mkdirSync(opts.resolved.LLAMA_CPP_LOGS, { recursive: true });
  const logFd = openSync(serverLog(opts.resolved), 'a');
  const fullArgs = [
    '-m', opts.modelPath,
    '--alias', opts.resolved.LLAMA_CPP_SERVER_ALIAS,
    '--host', opts.resolved.LLAMA_CPP_HOST,
    '--port', opts.resolved.LLAMA_CPP_PORT,
    '-ngl', '999',
    ...opts.args,
  ];
  const child = spawn(opts.bin, fullArgs, {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);
  const pid = child.pid ?? 0;
  opts.onEvent?.({ type: 'launch', pid, command: opts.bin, args: fullArgs });
  return pid;
}

// ---- stop --------------------------------------------------------------

export interface StopServerOptions {
  resolved?: ResolvedEnv;
  /** Max seconds to wait for SIGTERM to take effect before SIGKILL. */
  graceSeconds?: number;
}

export interface StopServerResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
}

/**
 * Stop the tracked llama-server. First tries SIGTERM against the PID
 * in the PID file, then escalates to SIGKILL if the process is still
 * alive after the grace period. Clears the PID file on exit.
 */
export async function stopServer(
  opts: StopServerOptions = {},
): Promise<StopServerResult> {
  const resolved = opts.resolved ?? resolveEnv();
  const grace = Math.max(1, opts.graceSeconds ?? 5);
  const pid = readServerPid(resolved);
  if (pid === null || !isProcessAlive(pid)) {
    removeServerPid(resolved);
    return { stopped: true, pid, killed: false };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removeServerPid(resolved);
    return { stopped: true, pid, killed: false };
  }

  for (let i = 0; i < grace; i += 1) {
    if (!isProcessAlive(pid)) {
      removeServerPid(resolved);
      return { stopped: true, pid, killed: false };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // process already gone
  }
  removeServerPid(resolved);
  return { stopped: true, pid, killed: true };
}
