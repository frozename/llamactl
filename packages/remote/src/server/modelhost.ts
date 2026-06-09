import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { ENGINES } from '../../../core/src/engines/index.js';
import { computeModelHostSpecHash, readModelHostState, removeModelHostState, writeModelHostState } from '../../../core/src/engines/state.js';
import { resolveEnv } from '../../../core/src/env.js';
import {
  defaultReadProcessCommand,
  parseSlotSavePathFromCommand,
  resolveSlotSavePathArgs,
} from '../../../core/src/kvstore/index.js';
import { loadModelHostByName, saveModelHost } from '../workload/modelhost-store.js';
import { ModelHostManifestSchema, type ModelHostManifest } from '../workload/modelhost-schema.js';
import type { WorkloadKey } from '../../../core/src/workloadRuntime.js';
import type { EngineBootEnv } from '../../../core/src/engines/types.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  /**
   * Discover the pid of the process currently listening on an endpoint.
   * Used to ADOPT a live host that was (re)launched out-of-band (e.g. a
   * manual restart) so routing recovers without spawning a competitor.
   * Injectable for tests; defaults to an `lsof`-based lookup.
   */
  findListenerPid?: (endpoint: { host: string; port: number }) => Promise<number | null>;
  readProcessCommand?: (pid: number) => Promise<string | null> | string | null;
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
  specHash?: string;
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
  // MLX back-pressure gate: caps in-flight Metal command buffers per
  // stream. Set to a positive integer (e.g. "1") to enable the gate.
  // Unset means INT_MAX (gate disabled, single mutex acquisition fast
  // path). Tied to the per-stream gate added on top of issue #2670.
  'MLX_METAL_MAX_INFLIGHT_PER_STREAM',
  'MLX_METAL_BACKPRESSURE_TIMEOUT_SECS',
];

// Merge order: parent allowlist → engineOverrides → specEnv.
// spec.env wins on conflict so manifests can declaratively override
// both inherited host vars and engine-level boot overrides.
function sanitizeChildEnv(
  parent: NodeJS.ProcessEnv,
  engineOverrides: Record<string, string> | undefined,
  specEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  if (engineOverrides) {
    for (const [key, value] of Object.entries(engineOverrides)) out[key] = value;
  }
  if (specEnv) {
    for (const [key, value] of Object.entries(specEnv)) out[key] = value;
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

// Short probe window for adoption: a process already bound to the endpoint
// answers quickly, so we should not wait the full launch timeout to confirm.
const ADOPT_PROBE_TIMEOUT_MS = 3000;
// Hard cap on the listener-pid lookup. The reconcile host loop is serial, so
// a wedged lsof (stuck mount, fd contention) must never hang the whole pass.
const FIND_LISTENER_TIMEOUT_MS = 2000;

// Resolve lsof by absolute path: macOS ships it in /usr/sbin, which is NOT on
// the controller's launchd PATH — a bare `lsof` would ENOENT there and silently
// disable adoption in production. Fall back to a bare name only if neither
// canonical location exists (e.g. an unusual Linux layout on PATH).
function resolveLsofPath(): string {
  for (const candidate of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'lsof';
}

function defaultFindListenerPid(
  endpoint: { host: string; port: number },
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | null = null;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill('SIGKILL');
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), FIND_LISTENER_TIMEOUT_MS);
    try {
      // Constrain to the exact bind address so a process listening on a
      // different address of the same port (e.g. 0.0.0.0 / ::1) is not matched.
      child = nodeSpawn(
        resolveLsofPath(),
        ['-nP', `-iTCP@${endpoint.host}:${endpoint.port}`, '-sTCP:LISTEN', '-t'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let out = '';
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('error', () => finish(null));
      child.on('close', () => {
        const pid = out
          .split(/\s+/)
          .map((token) => Number.parseInt(token, 10))
          .find((value) => Number.isInteger(value) && value > 0);
        finish(pid ?? null);
      });
    } catch {
      finish(null);
    }
    if (signal) {
      if (signal.aborted) finish(null);
      else signal.addEventListener('abort', () => finish(null), { once: true });
    }
  });
}

// Given a live process (`livePid`) already bound to the endpoint, adopt it iff
// it is serving OUR model: re-record its pid so the proxy route recovers,
// rather than spawning a competitor that could not bind the held port. Returns
// null when the live process is not (yet) confirmable as ours — the caller then
// DEFERS rather than spawning, since a spawn cannot win a held port.
async function tryAdoptLiveHost(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  probeReady: NonNullable<StartModelHostOptions['probeReady']>,
  livePid: number,
): Promise<StartModelHostResult | null> {
  const endpoint = manifest.spec.endpoint;
  const readiness = await probeReady(endpoint, ADOPT_PROBE_TIMEOUT_MS).catch(() => ({
    ready: false,
    modelIds: [] as string[],
  }));
  if (!readiness.ready) return null;
  const rel = manifest.spec.hostedModels[0]!.rel;
  const aliases = new Set([rel, basename(rel)]);
  // Only adopt a process that advertises OUR model. Empty modelIds means we
  // cannot confirm ownership — refuse (the caller defers) rather than adopt an
  // unrelated squatter that happened to grab the freed port.
  if (
    readiness.modelIds.length === 0 ||
    !readiness.modelIds.some((id) => aliases.has(id) || aliases.has(basename(id)))
  ) {
    return null;
  }
  // TOCTOU: the listener may have exited between discovery and now.
  if (!isProcessAlive(livePid)) return null;
  const readProcessCommand = opts.readProcessCommand ?? defaultReadProcessCommand;
  const cmdline = await Promise.resolve(readProcessCommand(livePid)).catch(() => null);
  writeModelHostState(
    {
      kind: 'ModelHost',
      engine: manifest.spec.engine,
      pid: livePid,
      host: endpoint.host,
      port: endpoint.port,
      modelAliases: Array.from(aliases),
      startedAt: new Date().toISOString(),
      slotSavePath: typeof cmdline === 'string' ? parseSlotSavePathFromCommand(cmdline) : null,
      specHash: computeModelHostSpecHash(manifest.spec),
    },
    opts.key,
    resolved,
  );
  return { ok: true, pid: livePid };
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

  // Reap a prior live ModelHost for this workload before spawning a new one.
  // Without this, applying over a still-running host leaves the old process
  // holding the endpoint port: the new omlx fails to bind and exits, yet
  // probeReady is satisfied by the OLD listener, so we would record the new
  // child's already-dead pid — which listLocalRoutes then drops from routing.
  const priorState = readModelHostState(opts.key, resolved);
  if (priorState && isProcessAlive(priorState.pid)) {
    await engine.teardown(priorState.pid).catch(() => {});
  } else if (priorState) {
    // Recorded pid is dead but a sidecar exists. Decide adopt-vs-spawn on
    // listener PRESENCE, not on the short readiness window: if a live process
    // already owns the endpoint (an out-of-band relaunch — manual restart, or
    // a crash + external respawn), a fresh spawn cannot bind the held port, so
    // we must never fall through to it.
    const findListenerPid =
      opts.findListenerPid ?? ((endpoint) => defaultFindListenerPid(endpoint, opts.signal));
    const livePid = await findListenerPid(manifest.spec.endpoint).catch(() => null);
    if (livePid != null && isProcessAlive(livePid)) {
      const adopted = await tryAdoptLiveHost(
        manifest,
        opts,
        resolved,
        opts.probeReady ?? engine.probeReady,
        livePid,
      );
      if (adopted) {
        opts.onEvent?.({ type: 'done', result: adopted });
        return adopted;
      }
      // A live process owns the port but is not (yet) confirmable as ours
      // (still loading, or an unrelated process). Defer to the next reconcile
      // tick rather than spawn a competitor that would only fail to bind.
      const deferred: StartModelHostResult = {
        ok: false,
        pid: null,
        error: `endpoint ${manifest.spec.endpoint.host}:${manifest.spec.endpoint.port} is held by live pid ${livePid} that is not yet adoptable (readiness/model unconfirmed); deferring restart`,
      };
      opts.onEvent?.({ type: 'done', result: deferred });
      return deferred;
    }
    // No live listener — the port is free; fall through to a normal spawn.
  }

  const bootEnv: EngineBootEnv = {
    LLAMACTL_MODELS_DIR: env.LLAMACTL_MODELS_DIR,
    LLAMA_CPP_MODELS: env.LLAMA_CPP_MODELS,
    LLAMACTL_RUNTIME_DIR: env.LLAMACTL_RUNTIME_DIR,
    workloadName: opts.key.name,
  };

  const spawn = opts.spawn ?? nodeSpawn;
  const extraArgsResolved = resolveSlotSavePathArgs(manifest.spec.extraArgs, resolved.LOCAL_AI_RUNTIME_DIR, opts.key.name);
  spec.extraArgs = extraArgsResolved.args;
  let child: ChildProcess | null = null;
  try {
    await engine.prepareLaunch?.(spec, bootEnv);
    const launch = engine.buildBootCommand(spec, bootEnv);
    child = spawn(launch.binary, launch.args, {
      detached: true,
      stdio: 'ignore',
      env: sanitizeChildEnv(runtimeEnv, launch.envOverrides, manifest.spec.env),
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

    // The readiness probe can be satisfied by a DIFFERENT process already bound
    // to this endpoint (e.g. a prior omlx we did not reap). If our spawned child
    // has already exited, refuse to record its dead pid — recording it would make
    // listLocalRoutes drop the ModelHost from routing. exitCode is null while the
    // child runs and a number once it exits (undefined for test stubs → running).
    if (child.exitCode != null) {
      throw new Error(
        `modelhost child pid ${pid} exited before readiness (endpoint ${endpoint.host}:${endpoint.port} likely served by another process); refusing to record a stale pid`,
      );
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
        slotSavePath: extraArgsResolved.slotSavePath,
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
  // A sidecar whose recorded pid is no longer alive means the host died or was
  // replaced out-of-band. Report Stopped so the reconciler re-acts on it
  // (startModelHost then adopts a live listener or spawns afresh) instead of
  // trusting a stale pid forever — which the proxy route check would treat as
  // dead and silently drop.
  if (!isProcessAlive(state.pid)) return { state: 'Stopped' };
  return { state: 'Running', pid: state.pid, specHash: state.specHash };
}
