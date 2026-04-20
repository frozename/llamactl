import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { resolveEnv } from './env.js';
import type { ResolvedEnv } from './types.js';

/**
 * Distinct failure modes `checkRpcServerAvailable()` can surface. Each
 * reason pairs with a `hint` string intended to be copy-pasteable —
 * operators who hit `rpc-server-missing` can copy the cmake line
 * verbatim to rebuild llama.cpp with RPC enabled.
 */
export type RpcServerDoctorReason =
  | 'LLAMA_CPP_BIN-unset'
  | 'LLAMA_CPP_BIN-missing'
  | 'rpc-server-missing'
  | 'rpc-server-not-executable';

export interface RpcServerDoctorResult {
  ok: boolean;
  /** Resolved path to rpc-server when `ok: true` or when we got as far
   *  as locating the file (e.g. not-executable). Null otherwise. */
  path: string | null;
  /** Echo of the resolved $LLAMA_CPP_BIN; null only when the env var
   *  itself was unset. */
  llamaCppBin: string | null;
  reason?: RpcServerDoctorReason;
  hint?: string;
}

/**
 * Preflight check for `$LLAMA_CPP_BIN/rpc-server`. llama.cpp only
 * builds `rpc-server` when configured with `-DGGML_RPC=ON`, so a stock
 * build lacks it. This helper maps each failure mode to a structured
 * reason + copy-pasteable hint so apply-time preflight and the
 * `llamactl agent rpc-doctor` CLI can both surface the same message
 * shape. Pure fs — no network, no spawn.
 */
export function checkRpcServerAvailable(
  env: NodeJS.ProcessEnv = process.env,
): RpcServerDoctorResult {
  const bin = env.LLAMA_CPP_BIN?.trim();
  if (!bin) {
    return {
      ok: false,
      path: null,
      llamaCppBin: null,
      reason: 'LLAMA_CPP_BIN-unset',
      hint: 'set $LLAMA_CPP_BIN to the llama.cpp build/bin directory',
    };
  }
  if (!existsSync(bin)) {
    return {
      ok: false,
      path: null,
      llamaCppBin: bin,
      reason: 'LLAMA_CPP_BIN-missing',
      hint: `LLAMA_CPP_BIN=${bin} does not exist`,
    };
  }
  const rpc = join(bin, 'rpc-server');
  if (!existsSync(rpc)) {
    return {
      ok: false,
      path: null,
      llamaCppBin: bin,
      reason: 'rpc-server-missing',
      hint:
        'rpc-server is built only when llama.cpp is configured with ' +
        '-DGGML_RPC=ON. From your llama.cpp source tree: ' +
        'cmake -B build -DGGML_RPC=ON && cmake --build build --target rpc-server',
    };
  }
  try {
    accessSync(rpc, constants.X_OK);
  } catch {
    return {
      ok: false,
      path: rpc,
      llamaCppBin: bin,
      reason: 'rpc-server-not-executable',
      hint: `chmod +x ${rpc}`,
    };
  }
  return { ok: true, path: rpc, llamaCppBin: bin };
}

/**
 * llama.cpp RPC worker (`rpc-server`) lifecycle. A worker binds a TCP
 * port and serves a slice of the coordinating llama-server's model
 * compute. This module mirrors server.ts's surface so apply.ts can
 * manage workers and coordinators through the same mental model.
 *
 * RPC readiness is a plain TCP connect probe — rpc-server has no
 * HTTP /health endpoint. Two seconds at 100 ms intervals is enough
 * for the real binary to finish its model-shard load on a warm disk.
 */

export type RpcServerEvent =
  | { type: 'launch'; pid: number; command: string; args: string[] }
  | { type: 'waiting'; attempt: number }
  | { type: 'ready'; pid: number; endpoint: string }
  | { type: 'timeout'; pid: number }
  | { type: 'exited'; code: number | null };

export interface StartRpcServerOptions {
  /** Host to bind on; defaults to 0.0.0.0 so the coordinator can reach it. */
  host?: string;
  /** Port to bind on; required — the coordinator's --rpc url embeds it. */
  port: number;
  /** Optional model path the worker preloads (leaves out by default). */
  modelPath?: string;
  extraArgs?: string[];
  timeoutSeconds?: number;
  onEvent?: (e: RpcServerEvent) => void;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface StartRpcServerResult {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  error?: string;
}

export interface RpcServerStatus {
  state: 'up' | 'down';
  endpoint: string | null;
  pid: number | null;
  host: string | null;
  port: number | null;
}

function pidFile(resolved: ResolvedEnv): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'rpc-server.pid');
}
function stateFile(resolved: ResolvedEnv): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'rpc-server.state');
}
function logFile(resolved: ResolvedEnv): string {
  return join(resolved.LLAMA_CPP_LOGS, 'rpc-server.log');
}

export function rpcServerPidFile(resolved: ResolvedEnv = resolveEnv()): string {
  return pidFile(resolved);
}

function readPid(resolved: ResolvedEnv): number | null {
  const file = pidFile(resolved);
  if (!existsSync(file)) return null;
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface PersistedState {
  pid: number;
  host: string;
  port: number;
}

function writeState(resolved: ResolvedEnv, state: PersistedState): void {
  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  writeFileSync(stateFile(resolved), JSON.stringify(state));
}

function readState(resolved: ResolvedEnv): PersistedState | null {
  const file = stateFile(resolved);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
    if (typeof parsed.pid === 'number' && typeof parsed.host === 'string' && typeof parsed.port === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearTracking(resolved: ResolvedEnv): void {
  try { unlinkSync(pidFile(resolved)); } catch {}
  try { unlinkSync(stateFile(resolved)); } catch {}
}

export async function rpcServerStatus(
  resolved: ResolvedEnv = resolveEnv(),
): Promise<RpcServerStatus> {
  const storedPid = readPid(resolved);
  const pid = storedPid && isAlive(storedPid) ? storedPid : null;
  if (storedPid && !pid) clearTracking(resolved);
  const persisted = readState(resolved);
  if (persisted && !pid) clearTracking(resolved);
  const state: RpcServerStatus['state'] = pid !== null ? 'up' : 'down';
  const host = pid && persisted ? persisted.host : null;
  const port = pid && persisted ? persisted.port : null;
  return {
    state,
    endpoint: host && port ? `${host}:${port}` : null,
    pid,
    host,
    port,
  };
}

export async function startRpcServer(
  opts: StartRpcServerOptions,
): Promise<StartRpcServerResult> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const bin = join(resolved.LLAMA_CPP_BIN, 'rpc-server');
  if (!existsSync(bin)) {
    return {
      ok: false,
      pid: null,
      endpoint: '',
      error: `rpc-server binary not found: ${bin}`,
    };
  }
  const host = opts.host ?? '0.0.0.0';
  const port = opts.port;
  const advertiseHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const endpoint = `${advertiseHost}:${port}`;

  await stopRpcServer({ resolved });

  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });
  const logFd = openSync(logFile(resolved), 'a');
  const args = ['--host', host, '--port', String(port)];
  if (opts.modelPath) args.push('-m', opts.modelPath);
  if (opts.extraArgs) args.push(...opts.extraArgs);

  const child = spawn(bin, args, {
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);
  const pid = child.pid ?? 0;
  opts.onEvent?.({ type: 'launch', pid, command: bin, args });

  if (pid === 0) {
    return { ok: false, pid: null, endpoint, error: 'rpc-server failed to spawn' };
  }

  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  writeFileSync(pidFile(resolved), String(pid));
  writeState(resolved, { pid, host: advertiseHost, port });

  const killOnAbort = (): void => {
    try { if (isAlive(pid)) process.kill(pid, 'SIGTERM'); } catch {}
  };
  if (opts.signal) {
    if (opts.signal.aborted) killOnAbort();
    else opts.signal.addEventListener('abort', killOnAbort, { once: true });
  }

  const timeoutSeconds = opts.timeoutSeconds ?? 10;
  const outcome = await pollTcp(advertiseHost, port, timeoutSeconds, opts.onEvent, opts.signal);
  if (outcome === 'ready') {
    opts.onEvent?.({ type: 'ready', pid, endpoint });
    return { ok: true, pid, endpoint };
  }
  if (outcome === 'exited') {
    clearTracking(resolved);
    opts.onEvent?.({ type: 'exited', code: null });
    return { ok: false, pid, endpoint, error: 'rpc-server exited before becoming ready' };
  }
  opts.onEvent?.({ type: 'timeout', pid });
  // Leave the process alive; caller can explicitly stop. Tests treat
  // timeout as failure and call stopRpcServer in afterEach.
  return { ok: false, pid, endpoint, error: 'rpc-server readiness timeout' };
}

export interface StopRpcServerOptions {
  resolved?: ResolvedEnv;
  graceSeconds?: number;
}

export interface StopRpcServerResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
}

export async function stopRpcServer(
  opts: StopRpcServerOptions = {},
): Promise<StopRpcServerResult> {
  const resolved = opts.resolved ?? resolveEnv();
  const grace = Math.max(1, opts.graceSeconds ?? 5);
  const pid = readPid(resolved);
  if (pid === null || !isAlive(pid)) {
    clearTracking(resolved);
    return { stopped: true, pid, killed: false };
  }
  try { process.kill(pid, 'SIGTERM'); } catch {
    clearTracking(resolved);
    return { stopped: true, pid, killed: false };
  }
  for (let i = 0; i < grace; i++) {
    if (!isAlive(pid)) {
      clearTracking(resolved);
      return { stopped: true, pid, killed: false };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  clearTracking(resolved);
  return { stopped: true, pid, killed: true };
}

async function pollTcp(
  host: string,
  port: number,
  timeoutSeconds: number,
  onEvent?: (e: RpcServerEvent) => void,
  signal?: AbortSignal,
): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'timeout';
    attempt++;
    const reachable = await tcpProbe(host, port, 500);
    if (reachable) return 'ready';
    onEvent?.({ type: 'waiting', attempt });
    await new Promise((r) => setTimeout(r, 100));
  }
  return 'timeout';
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean): void => {
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}
