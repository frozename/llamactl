import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { ENGINES } from '../../../core/src/engines/index.js';
import { readModelHostState, removeModelHostState, writeModelHostState } from '../../../core/src/engines/state.js';
import { resolveEnv } from '../../../core/src/env.js';
import { loadModelHostByName } from '../workload/modelhost-store.js';
import type { WorkloadKey } from '../../../core/src/workloadRuntime.js';
import type { EngineBootEnv } from '../../../core/src/engines/types.js';

export interface ModelHostSpawnResult {
  pid: number | null;
}

export interface StartModelHostOptions {
  key: WorkloadKey;
  target?: string;
  extraArgs?: string[];
  endpoint?: { host?: string; port?: number };
  binary?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  workloadsDir?: string;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  probeReady?: (
    endpoint: { host: string; port: number },
    timeoutMs: number,
  ) => Promise<{ ready: boolean; modelIds: string[] }>;
}

export interface StartModelHostResult {
  ok: boolean;
  pid: number | null;
  error?: string;
}

export interface StopModelHostOptions {
  key: WorkloadKey;
  graceSeconds?: number;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  teardown?: (pid: number, graceSeconds?: number) => Promise<void>;
}

export interface StopModelHostResult {
  ok: boolean;
  pid: number | null;
  error?: string;
}

export interface StatusModelHostOptions {
  key: WorkloadKey;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StatusModelHostResult {
  state: 'Running' | 'Stopped';
  pid?: number | null;
}

function toRuntimeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ?? process.env;
}

function withRuntimeDir(env: NodeJS.ProcessEnv, runtimeDir?: string): NodeJS.ProcessEnv {
  if (!runtimeDir) return env;
  return { ...env, LOCAL_AI_RUNTIME_DIR: runtimeDir };
}

function buildModelHostSpec(manifest: Awaited<ReturnType<typeof loadModelHostByName>>) {
  return {
    engine: manifest.spec.engine,
    binary: manifest.spec.binary,
    endpoint: manifest.spec.endpoint,
    hostedModels: manifest.spec.hostedModels,
    resources: manifest.spec.resources,
    extraArgs: manifest.spec.extraArgs,
    timeoutSeconds: manifest.spec.timeoutSeconds,
  };
}

export async function startModelHost(opts: StartModelHostOptions): Promise<StartModelHostResult> {
  const env = toRuntimeEnv(opts.env);
  const runtimeEnv = withRuntimeDir(env, opts.runtimeDir);
  const resolved = resolveEnv(runtimeEnv);
  const manifest = loadModelHostByName(opts.key.name, opts.workloadsDir);
  const engine = ENGINES[manifest.spec.engine];
  const spec = buildModelHostSpec(manifest);
  const validation = engine.validateSpec(spec);
  if (!validation.ok) {
    const result = { ok: false, pid: null, error: validation.error };
    opts.onEvent?.({ type: 'done', result });
    return result;
  }

  const bootEnv: EngineBootEnv = {
    LLAMACTL_MODELS_DIR: env.LLAMACTL_MODELS_DIR,
    LLAMA_CPP_MODELS: env.LLAMA_CPP_MODELS,
    LLAMACTL_RUNTIME_DIR: env.LLAMACTL_RUNTIME_DIR,
    workloadName: opts.key.name,
  };
  const launch = engine.buildBootCommand(
    {
      ...spec,
      endpoint: opts.endpoint ?? spec.endpoint,
      binary: opts.binary ?? spec.binary,
      extraArgs: opts.extraArgs ?? spec.extraArgs,
    },
    bootEnv,
  );

  const spawn = opts.spawn ?? nodeSpawn;
  const child: ChildProcess = spawn(launch.binary, launch.args, {
    detached: true,
    stdio: 'ignore',
    env: runtimeEnv,
  });
  const pid = child.pid ?? null;
  if (pid === null) {
    const result = { ok: false, pid: null, error: 'failed to spawn modelhost process' };
    opts.onEvent?.({ type: 'done', result });
    return result;
  }

  const endpoint = opts.endpoint ?? manifest.spec.endpoint;
  const readiness = await (opts.probeReady ?? engine.probeReady)(endpoint, (opts.timeoutSeconds ?? manifest.spec.timeoutSeconds) * 1000);
  if (!readiness.ready) {
    const result = { ok: false, pid: null, error: 'modelhost failed readiness probe' };
    opts.onEvent?.({ type: 'done', result });
    return result;
  }

  const modelAliases = Array.from(new Set([manifest.spec.hostedModels[0]!.rel, basename(manifest.spec.hostedModels[0]!.rel)]));
  writeModelHostState(
    {
      kind: 'ModelHost',
      engine: manifest.spec.engine,
      pid,
      host: endpoint.host,
      port: endpoint.port,
      modelAliases,
      startedAt: new Date().toISOString(),
    },
    opts.key,
    resolved,
  );
  const result = { ok: true, pid };
  opts.onEvent?.({ type: 'done', result });
  return result;
}

export async function stopModelHost(opts: StopModelHostOptions): Promise<StopModelHostResult> {
  const resolved = resolveEnv(withRuntimeDir(toRuntimeEnv(opts.env), opts.runtimeDir));
  const state = readModelHostState(opts.key, resolved);
  if (!state) return { ok: true, pid: null };
  const teardown = opts.teardown ?? ENGINES[state.engine].teardown;
  await teardown(state.pid, opts.graceSeconds);
  removeModelHostState(opts.key, resolved);
  return { ok: true, pid: state.pid };
}

export function statusModelHost(opts: StatusModelHostOptions): StatusModelHostResult {
  const resolved = resolveEnv(withRuntimeDir(toRuntimeEnv(opts.env), opts.runtimeDir));
  const state = readModelHostState(opts.key, resolved);
  if (!state) return { state: 'Stopped' };
  return { state: 'Running', pid: state.pid };
}
