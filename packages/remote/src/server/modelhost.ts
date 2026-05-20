import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import { ENGINES } from '../../../core/src/engines/index.js';
import { computeModelHostSpecHash, readModelHostState, removeModelHostState, writeModelHostState } from '../../../core/src/engines/state.js';
import { resolveEnv } from '../../../core/src/env.js';
import { loadModelHostByName, saveModelHost } from '../workload/modelhost-store.js';
import { ModelHostManifestSchema, type ModelHostManifest } from '../workload/modelhost-schema.js';
import type { WorkloadKey } from '../../../core/src/workloadRuntime.js';
import type { EngineBootEnv } from '../../../core/src/engines/types.js';

export interface ModelHostSpawnResult {
  pid: number | null;
}

export interface StartModelHostOptions {
  key: WorkloadKey;
  timeoutSeconds?: number;
  manifest?: unknown;
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

const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'LLAMACTL_MODELS_DIR',
  'LLAMA_CPP_MODELS',
  'LLAMA_CPP_BIN',
  // Apple Metal GPU context-store timeout relaxation — workaround for
  // MLX issue #2670 (uncatchable abort() on Metal command-buffer errors
  // under high concurrency / multi-model load). Set to "1" in the host's
  // launchd plist to enable; harmless when unset.
  'AGX_RELAX_CDM_CTXSTORE_TIMEOUT',
];

function sanitizeChildEnv(parent: NodeJS.ProcessEnv, overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) out[key] = value;
  }
  return out;
}

function withRuntimeDir(env: NodeJS.ProcessEnv, runtimeDir?: string): NodeJS.ProcessEnv {
  if (!runtimeDir) return env;
  return { ...env, LOCAL_AI_RUNTIME_DIR: runtimeDir };
}

function buildModelHostSpec(manifest: ModelHostManifest) {
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
  const manifest = opts.manifest
    ? ModelHostManifestSchema.parse(opts.manifest)
    : loadModelHostByName(opts.key.name, opts.workloadsDir);
  if (manifest.metadata.name !== opts.key.name) {
    const result = {
      ok: false,
      pid: null,
      error: `modelHostStart workload mismatch: expected ${opts.key.name}, got ${manifest.metadata.name}`,
    };
    opts.onEvent?.({ type: 'done', result });
    return result;
  }
  if (opts.manifest) {
    saveModelHost(manifest, opts.workloadsDir);
  }
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

  const spawn = opts.spawn ?? nodeSpawn;
  let child: ChildProcess | null = null;
  try {
    await engine.prepareLaunch?.(spec, bootEnv);
    const launch = engine.buildBootCommand(spec, bootEnv);
    child = spawn(launch.binary, launch.args, {
      detached: true,
      stdio: 'ignore',
      env: sanitizeChildEnv(runtimeEnv, launch.envOverrides),
    });
    const pid = child.pid ?? null;
    if (pid === null) {
      throw new Error('failed to spawn modelhost process');
    }
    // Detach from the parent's reference count so subscription
    // teardown / generator cleanup cannot propagate a signal back
    // to the engine process. Mirrors core/src/server.ts:startServer
    // which uses the same detached + unref pattern for llama-server.
    // Optional chain: test mocks may return a plain {pid} stub.
    child.unref?.();

    const endpoint = manifest.spec.endpoint;
    const readiness = await (opts.probeReady ?? engine.probeReady)(endpoint, (opts.timeoutSeconds ?? manifest.spec.timeoutSeconds) * 1000);
    if (!readiness.ready) {
      throw new Error('modelhost failed readiness probe');
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
        specHash: computeModelHostSpecHash(manifest.spec),
      },
      opts.key,
      resolved,
    );
    const result = { ok: true, pid };
    opts.onEvent?.({ type: 'done', result });
    return result;
  } catch (error) {
    const pid = child?.pid ?? null;
    if (pid !== null) {
      await engine.teardown(pid).catch(() => {});
    }
    const message = error instanceof Error ? error.message : 'modelhost start failed';
    const result = { ok: false, pid: null, error: message };
    opts.onEvent?.({ type: 'done', result });
    return result;
  }
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
