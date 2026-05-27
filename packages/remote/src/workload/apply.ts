import { spawn as nodeSpawn } from 'node:child_process';
import { ENGINES } from '../../../core/src/engines/index.js';
import { computeModelHostSpecHash, removeModelHostState, writeModelHostState } from '../../../core/src/engines/state.js';
import { resolveEnv } from '../../../core/src/env.js';
import {
  appendFleetJournal,
  makePlacementDecision,
  chooseBestNode,
  defaultAggregatorDbPath,
  defaultFleetJournalPath,
  type FleetTransitionEntry,
  getLatestPerNode,
  openAggregatorDb,
  projectAdmissionHeadroom,
  scoreNodes,
  type FleetPlacementEntry,
} from '@llamactl/fleet-supervisor';
import type { ModelRun, ModelRunStatus, ModelRunWorker } from './schema.js';
import { ModelRunSchema } from './schema.js';
import { LOCAL_NODE_ID, ModelHostManifestSchema, type ModelHostManifest } from './modelhost-schema.js';
import type { GatewayDispatch } from './gateway-handlers/types.js';
import { computeNodeBudget, defaultNodeBudgetGiB } from './admission.js';
import { defaultWorkloadsDir, listAnyWorkloadsForAdmission, listWorkloads } from './store.js';
import { withNodeLock } from './node-mutex.js';
import { basename } from 'node:path';

/**
 * Structural subset of `NodeClient` that `applyOne` actually touches.
 * Declared here so the workload layer doesn't force its consumers
 * (router.ts, the CLI) to pass the full typed `NodeClient` — both
 * `clientForNode` inside the router and the CLI's pinned client
 * satisfy this narrower shape, which eliminates an unsafe `as any`
 * cast at the router boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SubscribeCallbacks = { onData: (e: any) => void; onError: (err: any) => void; onComplete: () => void };
type Unsubscribable = { unsubscribe?: () => void };

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
];

export interface WorkloadClient {
  serverStatus: {
    query(input: { workload: string }): Promise<{
      state: string;
      rel: string | null;
      extraArgs: string[];
      pid: number | null;
      host: string | null;
      port: number | null;
      binary: string | null;
      endpoint: string;
      advertisedEndpoint?: string | null;
    }>;
  };
  serverStop: {
    mutate(input: { workload: string; graceSeconds?: number }): Promise<unknown>;
  };
  serverStart: {
    subscribe(
      input: {
        workload: string;
        target: string;
        extraArgs?: string[];
        allowExternalBind?: boolean;
        endpoint?: { host?: string; port?: number };
        binary?: string;
        timeoutSeconds?: number;
      },
      callbacks: SubscribeCallbacks,
    ): Unsubscribable;
  };
  modelHostStart: {
    subscribe(
      input: { workload: string; timeoutSeconds?: number; manifest?: ModelHostManifest },
      callbacks: SubscribeCallbacks,
    ): Unsubscribable;
  };
  modelHostStop: {
    mutate(input: { workload: string; graceSeconds?: number }): Promise<unknown>;
  };
  modelHostStatus: {
    query(input: { workload: string }): Promise<{ state: string; pid?: number | null; specHash?: string }>;
  };
  rpcServerStart: {
    subscribe(
      input: { host?: string; port: number; extraArgs?: string[]; timeoutSeconds?: number },
      callbacks: SubscribeCallbacks,
    ): Unsubscribable;
  };
  rpcServerStop: { mutate(input?: { graceSeconds?: number }): Promise<unknown> };
  rpcServerDoctor: {
    query(input?: Record<string, never>): Promise<{
      ok: boolean;
      path: string | null;
      llamaCppBin: string | null;
      reason?:
        | 'LLAMA_CPP_BIN-unset'
        | 'LLAMA_CPP_BIN-missing'
        | 'rpc-server-missing'
        | 'rpc-server-not-executable';
      hint?: string;
    }>;
  };
}

export type ApplyAction = 'unchanged' | 'started' | 'restarted' | 'pending';

export interface ApplyEvent {
  type:
    | 'stop'
    | 'start'
    | 'started'
    | 'skipped'
    | 'worker-start'
    | 'worker-ready'
    | 'worker-preflight'
    | 'gateway-pending';
  message: string;
}

export interface ApplyResult {
  action: ApplyAction;
  statusSection: ModelRunStatus;
  error?: string;
}

export interface ApplyManifestOptions {
  manifest: unknown;
  getClient?: (nodeName: string) => WorkloadClient;
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  /** Override the workloads directory; defaults to `defaultWorkloadsDir()`. */
  workloadsDir?: string;
  /** Resolve the node's memory budget for admission control. */
  getNodeBudgetGiB?: (nodeName: string) => number;
  /** Bubble up per-workload progress events for logging. */
  onEvent?: (event: ApplyEvent) => void;
  supervisor?: {
    currentFreeGiB: number;
    headroomMinGiB: number;
    safetyFactor?: number;
  };
  placement?: {
    dbPath?: string;
    journalPath?: string;
    headroomMinMb?: number;
    modelFilePenaltyMb?: number;
  };
}

interface PlacementContext {
  manifest: ModelRun;
  dbPath: string;
  journalPath: string;
  headroomMinMb: number;
  modelFilePenaltyMb: number;
}

function shouldAutoPlace(manifest: ModelRun): boolean {
  return manifest.spec.node === 'auto' && manifest.spec.placement !== 'pinned';
}

async function runPlacement(context: PlacementContext): Promise<
  { ok: true; manifest: ModelRun; decision: FleetPlacementEntry }
  | { ok: false; error: string }
> {
  let db;
  try {
    db = openAggregatorDb(context.dbPath);
    const rows = getLatestPerNode(db);
    const scores = scoreNodes(rows, {
      workload: context.manifest.metadata.name,
      targetModel: context.manifest.spec.target.value,
      expectedMemoryMb: (context.manifest.spec.resources?.expectedMemoryGiB ?? 0) * 1024,
      modelFilePenaltyMb: context.modelFilePenaltyMb,
      headroomMinMb: context.headroomMinMb,
    });
    const best = chooseBestNode(scores);
    if (!best) {
      return {
        ok: false,
        error: `no viable placement node for ${context.manifest.metadata.name}`,
      };
    }

    const decision = makePlacementDecision({
      workloadName: context.manifest.metadata.name,
      requestedNode: context.manifest.spec.node,
      expectedMemoryMb: (context.manifest.spec.resources?.expectedMemoryGiB ?? 0) * 1024,
      scores,
      headroomMinMb: context.headroomMinMb,
      modelFilePenaltyMb: context.modelFilePenaltyMb,
    });

    const entry: FleetPlacementEntry = {
      kind: 'fleet-placement',
      ts: new Date().toISOString(),
      node: best,
      decision: {
        ...decision,
        chosenNode: best,
      },
    };
    const transition: FleetTransitionEntry = {
      kind: 'fleet-transition',
      ts: entry.ts,
      node: best,
      subject: context.manifest.metadata.name,
      subjectKind: 'workload',
      signal: 'placement',
      from: context.manifest.spec.node,
      to: best,
    };

    appendFleetJournal(entry, context.journalPath);
    appendFleetJournal(transition, context.journalPath);
    return {
      ok: true,
      manifest: { ...context.manifest, spec: { ...context.manifest.spec, node: best } },
      decision: entry,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}

export type ApplyManifestOutcome =
  | { ok: true; kind: 'ModelRun'; manifest: ModelRun; result: ApplyResult }
  | {
      // M7: ModelHost outcome carries only the desired-state manifest.
      // Observed status lives in the runtime sidecar (writeModelHostState),
      // not in the persisted YAML or on this outcome.
      ok: true;
      kind: 'ModelHost';
      manifest: ModelHostManifest;
      pid: number | null;
      endpoint: string;
    }
  | { ok: false; error: string };

function sameExtraArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function normalizeLoopbackHost(host: string | undefined): string {
  return host === '::1' ? '127.0.0.1' : host ?? '127.0.0.1';
}

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

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

function manifestKind(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

async function applyModelHostManifest(
  manifest: ModelHostManifest,
  opts: Omit<ApplyManifestOptions, 'manifest'>,
): Promise<ApplyManifestOutcome> {
  if (opts.supervisor && manifest.spec.resources?.expectedMemoryGiB) {
    const projected = projectAdmissionHeadroom({
      currentFreeGiB: opts.supervisor.currentFreeGiB,
      expectedMemoryGiB: manifest.spec.resources.expectedMemoryGiB,
      headroomMinGiB: opts.supervisor.headroomMinGiB,
      safetyFactor: opts.supervisor.safetyFactor,
    });
    if (!projected.allowed) {
      return { ok: false, error: projected.reason };
    }
  }
  const engine = ENGINES[manifest.spec.engine];
  if (manifest.spec.node === 'local') {
    const validation = engine.validateSpec({
      engine: manifest.spec.engine,
      binary: manifest.spec.binary,
      endpoint: manifest.spec.endpoint,
      hostedModels: manifest.spec.hostedModels,
      resources: manifest.spec.resources,
      extraArgs: manifest.spec.extraArgs,
      timeoutSeconds: manifest.spec.timeoutSeconds,
    });
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
  }

  const resolved = resolveEnv(opts.env);
  const client = opts.getClient?.(manifest.spec.node);
  if (!client?.modelHostStart || !client.modelHostStatus) {
    return { ok: false, error: `missing modelHostStart on node ${manifest.spec.node}` };
  }

  if (manifest.spec.enabled === false) {
    if (client.modelHostStop) {
      try {
        await client.modelHostStop.mutate({ workload: manifest.metadata.name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `modelHostStop failed: ${message}` };
      }
    }
    // Idempotent cleanup: sweep any local sidecar (including pre-a6cab9e
    // leaks for remote workloads) before signaling disable.
    removeModelHostState({ name: manifest.metadata.name }, resolved);
    return {
      ok: true,
      kind: 'ModelHost',
      manifest,
      pid: null,
      endpoint: `http://${formatHostForUrl(manifest.spec.endpoint.host)}:${manifest.spec.endpoint.port}`,
    };
  }

  const budget = opts.getNodeBudgetGiB?.(manifest.spec.node) ?? defaultNodeBudgetGiB();
  const workloadsDir = opts.workloadsDir ?? defaultWorkloadsDir();
  const livingManifests = listAnyWorkloadsForAdmission(workloadsDir)
    .filter((m) => m.metadata.name !== manifest.metadata.name)
    .filter((m) => m.spec.node === manifest.spec.node)
    .filter((m) => m.spec.enabled !== false);
  const admit = computeNodeBudget({
    nodeName: manifest.spec.node,
    nodeBudgetGiB: budget,
    livingManifests,
    incoming: {
      apiVersion: manifest.apiVersion,
      kind: 'ModelRun',
      metadata: { name: manifest.metadata.name, labels: {}, annotations: {} },
      spec: {
        node: manifest.spec.node,
        enabled: manifest.spec.enabled,
        target: { kind: 'rel', value: manifest.spec.hostedModels[0]!.rel },
        extraArgs: manifest.spec.extraArgs,
        workers: [],
        restartPolicy: manifest.spec.restartPolicy,
        timeoutSeconds: manifest.spec.timeoutSeconds,
        gateway: false,
        allowExternalBind: false,
        ...(manifest.spec.resources ? { resources: manifest.spec.resources } : {}),
      },
    },
    forceAdmit: false,
  });
  if (!admit.ok) {
    return { ok: false, error: admit.reason };
  }

  const timeoutMs = (manifest.spec.timeoutSeconds ?? 60) * 1000;
  let sub: Unsubscribable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: { state: string; pid?: number | null };
  try {
    type StartResult =
      | { ok: true; error?: string; pid?: number | null; state?: string | null }
      | { ok: false; error: string };
    const startResult = await new Promise<StartResult | null>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('modelHostStart timed out')), timeoutMs);
      let done: StartResult | null = null;
      sub = client.modelHostStart.subscribe(
        {
          workload: manifest.metadata.name,
          timeoutSeconds: manifest.spec.timeoutSeconds,
          manifest,
        },
        {
          onData: (evt: unknown) => {
            const e = evt as { type?: string; result?: unknown };
            if (e.type === 'done') done = e.result as StartResult;
          },
          onError: (err: unknown) => {
            if (timer) clearTimeout(timer);
            reject(err as Error);
          },
          onComplete: () => {
            if (timer) clearTimeout(timer);
            resolve(done);
          },
        },
      );
    }).catch((err: unknown): StartResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

    if (!startResult?.ok) {
      return { ok: false, error: startResult?.error ?? 'modelHostStart failed' };
    }

    if (typeof startResult.pid === 'number' && typeof startResult.state === 'string') {
      status = {
        state: startResult.state,
        pid: startResult.pid,
      };
    } else {
      status = await client.modelHostStatus.query({ workload: manifest.metadata.name });
    }
  } finally {
    if (timer) clearTimeout(timer);
    sub?.unsubscribe?.();
  }

  const rel = manifest.spec.hostedModels[0]!.rel;
  const modelAliases = Array.from(new Set([rel, basename(rel)]));
  // Only write the local sidecar when this controller owns the process
  // (spec.node === 'local'). For remote nodes the remote dispatcher owns
  // state; writing here would leak a stale entry into local consumers
  // (probe, openai-proxy routing, workloadEpoch). Also require a real
  // pid — without one the sidecar liveness/teardown semantics are wrong.
  if (manifest.spec.node === LOCAL_NODE_ID && typeof status.pid === 'number' && status.pid > 0) {
    writeModelHostState(
      {
        kind: 'ModelHost',
        engine: manifest.spec.engine,
        pid: status.pid,
        host: manifest.spec.endpoint.host,
        port: manifest.spec.endpoint.port,
        modelAliases,
        startedAt: new Date().toISOString(),
        specHash: computeModelHostSpecHash(manifest.spec),
      },
      { name: manifest.metadata.name },
      resolved,
    );
  }

  return {
    ok: true,
    kind: 'ModelHost',
    manifest,
    pid: status.pid ?? null,
    endpoint: `http://${formatHostForUrl(manifest.spec.endpoint.host)}:${manifest.spec.endpoint.port}`,
  };
}

export async function applyOneModelHost(
  manifest: ModelHostManifest,
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
  opts?: {
    env?: NodeJS.ProcessEnv;
    workloadsDir?: string;
    getNodeBudgetGiB?: (nodeName: string) => number;
    supervisor?: {
      currentFreeGiB: number;
      headroomMinGiB: number;
      safetyFactor?: number;
    };
  },
): Promise<ApplyManifestOutcome> {
  return applyModelHostManifest(manifest, {
    getClient,
    onEvent,
    env: opts?.env,
    workloadsDir: opts?.workloadsDir,
    getNodeBudgetGiB: opts?.getNodeBudgetGiB,
    supervisor: opts?.supervisor,
  });
}

interface StartDone {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  error?: string;
}

/**
 * Apply-time preflight for tensor-parallel workloads. Before any
 * `rpcServerStart` spawn, ask each worker node's `rpcServerDoctor`
 * procedure whether `$LLAMA_CPP_BIN/rpc-server` is present and
 * executable. On any failure, return a composed multi-line error
 * naming every failing node + its reason + build hint so the operator
 * can fix all nodes in one pass rather than one-node-at-a-time ENOENT
 * surprises from the spawn path.
 *
 * Returns `{ ok: true }` on success so callers can proceed. Returns
 * `{ ok: false, ... }` with a human-readable `error` string built from
 * each failing node's reason and hint; apply.ts folds this into the
 * same `worker-preflight-failed` shape other worker failures use.
 *
 * Runs in parallel across workers — each doctor call is independent
 * and the preflight runs once per apply (not at tick time). No
 * retries here; if the operator just rebuilt llama.cpp, they'll
 * re-apply.
 */
async function preflightWorkers(
  workers: readonly ModelRunWorker[],
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  if (workers.length === 0) return { ok: true };
  onEvent?.({
    type: 'worker-preflight',
    message: `preflight: checking rpc-server on ${workers.length} worker node(s)`,
  });
  const results = await Promise.all(
    workers.map(async (w) => {
      try {
        const wc = getClient(w.node);
        const r = await wc.rpcServerDoctor.query({});
        return { node: w.node, result: r as {
          ok: boolean;
          reason?: string;
          hint?: string;
        } };
      } catch (err) {
        // Treat dispatcher / network failures as a preflight failure
        // so the operator sees the node name. Wrapping into the same
        // doctor shape keeps the composed error uniform.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          node: w.node,
          result: {
            ok: false,
            reason: 'doctor-call-failed',
            hint: `could not reach ${w.node}: ${msg}`,
          },
        };
      }
    }),
  );
  const failures = results.filter((r) => !r.result.ok);
  if (failures.length === 0) return { ok: true };
  const lines = failures.map((f) => {
    const reason = f.result.reason ?? 'unknown';
    const hint = f.result.hint ?? '(no hint)';
    return `  - ${f.node}: ${reason}\n    ${hint}`;
  });
  return {
    ok: false,
    error:
      `rpc-server not available on ${failures.length} worker node(s):\n` +
      lines.join('\n'),
  };
}

/** Fan out rpc-server starts across every worker in the spec. Returns
 *  "host:port,host:port,..." suitable for llama-server's --rpc flag. */
async function startWorkers(
  workers: readonly ModelRunWorker[],
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
): Promise<{ rpcList: string; error?: string }> {
  // Preflight: bail before the first rpcServerStart spawn when any
  // worker node lacks rpc-server. This replaces a raw ENOENT from the
  // core spawn wrapper with a composed error listing every failing
  // node + the cmake hint.
  const preflight = await preflightWorkers(workers, getClient, onEvent);
  if (!preflight.ok) {
    return { rpcList: '', error: preflight.error };
  }
  const endpoints: string[] = [];
  for (const worker of workers) {
    onEvent?.({
      type: 'worker-start',
      message: `worker ${worker.node}: starting rpc-server on ${worker.rpcHost}:${worker.rpcPort}`,
    });
    const wc = getClient(worker.node);
    // Stop any prior rpc-server on that node; ignore errors.
    try { await wc.rpcServerStop.mutate({ graceSeconds: 2 }); } catch {}
    const started = await new Promise<{ ok: boolean; endpoint: string; error?: string } | null>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`rpc-server start timeout on ${worker.node}`)),
          (worker.timeoutSeconds + 5) * 1000,
        );
        let done: { ok: boolean; endpoint: string; error?: string } | null = null;
        const sub = wc.rpcServerStart.subscribe(
          {
            host: '0.0.0.0',
            port: worker.rpcPort,
            ...(worker.extraArgs.length > 0 ? { extraArgs: worker.extraArgs } : {}),
            timeoutSeconds: worker.timeoutSeconds,
          },
          {
            onData: (e: unknown) => {
              const evt = e as { type?: string; result?: unknown };
              if (evt.type === 'done') done = evt.result as typeof done;
            },
            onError: (err: unknown) => { clearTimeout(timer); reject(err as Error); },
            onComplete: () => { clearTimeout(timer); resolve(done); },
          },
        );
        void sub;
      },
    );
    if (!started || !started.ok) {
      return {
        rpcList: '',
        error: `worker ${worker.node}: ${started?.error ?? 'rpc-server failed to start'}`,
      };
    }
    onEvent?.({
      type: 'worker-ready',
      message: `worker ${worker.node}: ready on ${worker.rpcHost}:${worker.rpcPort}`,
    });
    endpoints.push(`${worker.rpcHost}:${worker.rpcPort}`);
  }
  return { rpcList: endpoints.join(',') };
}

async function stopWorkers(
  workers: readonly ModelRunWorker[],
  getClient: (nodeName: string) => WorkloadClient,
): Promise<void> {
  // Reverse order mirrors start order — keeps logs easier to read.
  for (const worker of [...workers].reverse()) {
    try {
      const wc = getClient(worker.node);
      await wc.rpcServerStop.mutate({ graceSeconds: 3 });
    } catch {
      // best effort
    }
  }
}

/**
 * Diff one workload against the live status of its target node and
 * converge: stop the running server if the config differs, then start
 * the new spec. No-op when observed already matches desired.
 *
 * Shared by the CLI `apply` command and the controller reconciler so
 * both land the same restart semantics. When spec.workers is
 * non-empty, starts rpc-server on each worker first and appends
 * `--rpc host1:p1,host2:p2,...` to the coordinator's extraArgs.
 */
export async function applyOne(
  manifest: ModelRun,
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
  gatewayDispatch?: GatewayDispatch,
  opts?: {
    workloadsDir?: string;
    /**
     * Map a manifest's `spec.node` name to a stable identity (typically
     * the node's endpoint URL) so the port-collision preflight can
     * detect aliases — e.g. two manifests on `local` vs `mac-mini`
     * resolving to the same physical agent. Return `null` when the
     * name can't be resolved (e.g. operator typo'd the node); the
     * filter falls back to name-equality so a missing resolution
     * doesn't accidentally relax the check.
     */
    resolveNodeIdentity?: (nodeName: string) => string | null;
    listManifests?: () => ModelRun[];
    getNodeBudgetGiB?: (nodeName: string) => number;
  },
): Promise<ApplyResult> {
  if (manifest.spec.gateway) {
    if (gatewayDispatch) {
      const dispatched = await gatewayDispatch({ manifest, getClient, onEvent });
      // `null` from the dispatcher is the agent-gateway fallthrough
      // sentinel — spec.gateway:true pointed at an agent-kind node
      // runs through the regular serverStart path below.
      if (dispatched !== null) return dispatched;
    } else {
      const now = new Date().toISOString();
      const msg =
        `gateway workload targeting '${manifest.spec.node}': ` +
        `no gateway dispatcher provided — manifest validated but no upstream mutation performed`;
      onEvent?.({ type: 'gateway-pending', message: `${manifest.metadata.name}: ${msg}` });
      return {
        action: 'pending',
        statusSection: {
          phase: 'Pending',
          serverPid: null,
          endpoint: null,
          lastTransitionTime: now,
          conditions: [
            {
              type: 'Applied',
              status: 'False',
              reason: 'GatewayRegistrationPending',
              message: msg,
              lastTransitionTime: now,
            },
          ],
        },
      };
    }
  }
  const client = getClient(manifest.spec.node);
  if (manifest.spec.enabled === false) {
    const now = new Date().toISOString();
    const status = await client.serverStatus.query({ workload: manifest.metadata.name });
    if (status.state === 'up') {
      onEvent?.({ type: 'stop', message: `${manifest.metadata.name}: stopping disabled server` });
      await client.serverStop.mutate({ workload: manifest.metadata.name, graceSeconds: 5 });
    }
    return {
      action: 'unchanged',
      statusSection: {
        phase: 'Stopped',
        serverPid: null,
        endpoint: null,
        lastTransitionTime: now,
        conditions: [
          {
            type: 'Applied',
            status: 'True',
            reason: 'Disabled',
            lastTransitionTime: now,
          },
        ],
      },
    };
  }
  const desired = manifest.spec.endpoint;
  if (desired?.port !== undefined) {
    const workloadsDir = opts?.workloadsDir ?? defaultWorkloadsDir();
    const resolveIdent = opts?.resolveNodeIdentity;
    const desiredIdentity = resolveIdent?.(manifest.spec.node) ?? null;
    const sameNode = (otherNode: string): boolean => {
      if (otherNode === manifest.spec.node) return true;
      if (!resolveIdent || !desiredIdentity) return false;
      const otherIdentity = resolveIdent(otherNode);
      return otherIdentity !== null && otherIdentity === desiredIdentity;
    };
    const others = listWorkloads(workloadsDir)
      .filter((m) => m.metadata.name !== manifest.metadata.name)
      .filter((m) => sameNode(m.spec.node))
      .filter((m) => m.spec.enabled !== false);
    for (const other of others) {
      if (
        other.status?.phase === 'Failed' &&
        other.status.conditions[0]?.reason === 'PortCollision'
      ) {
        continue;
      }
      const o = other.spec.endpoint;
      if (o?.port === undefined) continue;
      if (o.port !== desired.port) continue;
      const dHost = normalizeLoopbackHost(desired.host);
      const oHost = normalizeLoopbackHost(o.host);
      const hostCollides =
        dHost === oHost || dHost === '0.0.0.0' || oHost === '0.0.0.0';
      if (hostCollides) {
        const now = new Date().toISOString();
        return {
          action: 'pending',
          error: `port collision: ${other.metadata.name} already claims ${oHost}:${o.port} on node ${manifest.spec.node}`,
          statusSection: {
            phase: 'Failed',
            serverPid: null,
            endpoint: null,
            lastTransitionTime: now,
            conditions: [
              {
                type: 'Applied',
                status: 'False',
                reason: 'PortCollision',
                message: `port ${desired.port} already claimed by ${other.metadata.name}`,
                lastTransitionTime: now,
              },
            ],
          },
        };
      }
    }
  }
  const status = await client.serverStatus.query({ workload: manifest.metadata.name });

  const desiredRel = manifest.spec.target.value;
  const desiredEndpoint = manifest.spec.endpoint;
  // Compose the effective extraArgs: user args + the --rpc flag if
  // this workload has workers. The coordinator's server.rel /
  // extraArgs comparison below uses the composed form so a diff
  // between "with --rpc" and "without" triggers a restart.
  let effectiveExtraArgs: string[] = manifest.spec.extraArgs;
  const workers = manifest.spec.workers;

  let rpcFlag: string[] = [];
  if (workers.length > 0) {
    rpcFlag = [
      '--rpc',
      workers.map((w) => `${w.rpcHost}:${w.rpcPort}`).join(','),
    ];
    effectiveExtraArgs = [...manifest.spec.extraArgs, ...rpcFlag];
  }
  const desiredArgs = effectiveExtraArgs;
  const liveRel = status.rel;
  const liveArgs = status.extraArgs ?? [];
  const running = status.state === 'up';
  const endpointMatches =
    !desiredEndpoint
    || ((status.host ?? null) === (desiredEndpoint.host ?? null)
      && (status.port ?? null) === (desiredEndpoint.port ?? null));
  const binaryMatches =
    !manifest.spec.binary || (status.binary ?? null) === manifest.spec.binary;
  const matches =
    running && liveRel === desiredRel && sameExtraArgs(liveArgs, desiredArgs) && endpointMatches && binaryMatches;

  const now = new Date().toISOString();
  const evictTargets = (manifest.metadata.annotations['llamactl.io/evict'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const target of evictTargets) {
    try {
      const targetStatus = await client.serverStatus.query({ workload: target });
      if (targetStatus.state !== 'up') {
        onEvent?.({ type: 'skipped', message: `${manifest.metadata.name}: eviction target ${target} already stopped` });
        continue;
      }
      onEvent?.({ type: 'stop', message: `${manifest.metadata.name}: evicting ${target}` });
      await client.serverStop.mutate({ workload: target, graceSeconds: 5 });
    } catch {
      onEvent?.({ type: 'skipped', message: `${manifest.metadata.name}: eviction target ${target} not found` });
    }
  }

  return await withNodeLock(manifest.spec.node, async () => {
    const listManifests = opts?.listManifests ?? (() => listWorkloads(opts?.workloadsDir));
    const living = listManifests().filter(
      (m) =>
        m.metadata.name !== manifest.metadata.name
        && m.spec.node === manifest.spec.node
        && m.spec.enabled !== false
        && !evictTargets.includes(m.metadata.name),
    );
    const budget = opts?.getNodeBudgetGiB?.(manifest.spec.node) ?? Number.POSITIVE_INFINITY;
    const forceAdmit = manifest.metadata.annotations['llamactl.io/force-admit'] === 'true';
    const adm = computeNodeBudget({
      nodeName: manifest.spec.node,
      nodeBudgetGiB: budget,
      livingManifests: living,
      incoming: manifest,
      forceAdmit,
    });
    if (!adm.ok) {
      return {
        action: 'pending',
        error: adm.reason,
        statusSection: {
          phase: 'Failed',
          serverPid: null,
          endpoint: null,
          lastTransitionTime: now,
          conditions: [
            {
              type: 'Applied',
              status: 'False',
              reason: 'BudgetExceeded',
              message: adm.reason,
              lastTransitionTime: now,
            },
          ],
        },
      };
    }

    if (matches) {
      onEvent?.({
        type: 'skipped',
        message: `${manifest.metadata.name}: already running (${desiredRel})`,
      });
      return {
        action: 'unchanged',
        statusSection: {
          phase: 'Running',
          serverPid: status.pid,
          endpoint: status.endpoint,
          lastTransitionTime: now,
          conditions: [
            { type: 'Applied', status: 'True', reason: 'unchanged', lastTransitionTime: now },
          ],
        },
      };
    }

    let action: ApplyAction;
    if (running) {
      onEvent?.({ type: 'stop', message: `${manifest.metadata.name}: stopping mismatched server` });
      await client.serverStop.mutate({ workload: manifest.metadata.name, graceSeconds: 5 });
      action = 'restarted';
    } else {
      action = 'started';
    }

    if (workers.length > 0) {
      const wres = await startWorkers(workers, getClient, onEvent);
      if (wres.error) {
        const when = new Date().toISOString();
        return {
          action,
          statusSection: {
            phase: 'Failed',
            serverPid: null,
            endpoint: null,
            lastTransitionTime: when,
            conditions: [
              {
                type: 'Applied',
                status: 'False',
                reason: action,
                message: wres.error,
                lastTransitionTime: when,
              },
            ],
          },
          error: wres.error,
        };
      }
    }

    onEvent?.({ type: 'start', message: `${manifest.metadata.name}: starting ${desiredRel}` });
    const startResult = await new Promise<StartDone | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('serverStart timed out')),
        (manifest.spec.timeoutSeconds + 5) * 1000,
      );
      let done: StartDone | null = null;
      const sub = client.serverStart.subscribe(
        {
          workload: manifest.metadata.name,
          target: desiredRel,
          ...(desiredArgs.length > 0 ? { extraArgs: desiredArgs } : {}),
          ...(manifest.spec.allowExternalBind ? { allowExternalBind: true } : {}),
          ...(manifest.spec.endpoint ? { endpoint: manifest.spec.endpoint } : {}),
          ...(manifest.spec.binary ? { binary: manifest.spec.binary } : {}),
          timeoutSeconds: manifest.spec.timeoutSeconds,
        },
        {
          onData: (evt: unknown) => {
            const e = evt as { type?: string; result?: unknown };
            if (e.type === 'done') done = e.result as StartDone;
          },
          onError: (err: unknown) => {
            clearTimeout(timer);
            reject(err as Error);
          },
          onComplete: () => {
            clearTimeout(timer);
            resolve(done);
          },
        },
      );
      void sub;
    });

    if (!startResult || !startResult.ok) {
      const err = startResult?.error ?? 'serverStart failed';
      if (workers.length > 0) await stopWorkers(workers, getClient);
      return {
        action,
        statusSection: {
          phase: 'Failed',
          serverPid: null,
          endpoint: null,
          lastTransitionTime: now,
          conditions: [
            { type: 'Applied', status: 'False', reason: action, message: err, lastTransitionTime: now },
          ],
        },
        error: err,
      };
    }

    onEvent?.({
      type: 'started',
      message: `${manifest.metadata.name}: ready at ${startResult.endpoint} pid=${startResult.pid ?? '?'}`,
    });

    return {
      action,
      statusSection: {
        phase: 'Running',
        serverPid: startResult.pid,
        endpoint: startResult.endpoint,
        lastTransitionTime: now,
        conditions: [
          { type: 'Applied', status: 'True', reason: action, lastTransitionTime: now },
          {
            type: 'BudgetReserved',
            status: 'True',
            message: `node reserves ${adm.reservedAfter.toFixed(1)} / ${adm.budget === Infinity ? 'unbounded' : adm.budget.toFixed(1)} GiB`,
            lastTransitionTime: now,
          },
        ],
      },
    };
  });
}

export async function applyManifest(
  opts: ApplyManifestOptions,
): Promise<ApplyManifestOutcome> {
  const kind = manifestKind(opts.manifest);
  if (kind === 'ModelRun') {
    const parsed = ModelRunSchema.safeParse(opts.manifest);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    let manifest = parsed.data;
    if (shouldAutoPlace(manifest)) {
      const placement = await runPlacement({
        manifest,
        dbPath: opts.placement?.dbPath ?? defaultAggregatorDbPath(),
        journalPath: opts.placement?.journalPath ?? defaultFleetJournalPath(),
        headroomMinMb: opts.placement?.headroomMinMb ?? 512,
        modelFilePenaltyMb: opts.placement?.modelFilePenaltyMb ?? 128,
      });
      if (!placement.ok) return { ok: false, error: placement.error };
      manifest = placement.manifest;
    }
    if (!opts.getClient) {
      return { ok: false, error: 'applyManifest requires getClient for ModelRun manifests' };
    }
    const result = await applyOne(manifest, opts.getClient);
    if (result.error) {
      return { ok: false, error: result.error };
    }
    return { ok: true, kind: 'ModelRun', manifest, result };
  }
  if (kind === 'ModelHost') {
    const parsed = ModelHostManifestSchema.safeParse(opts.manifest);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return await applyModelHostManifest(parsed.data, opts);
  }
  return { ok: false, error: `unsupported manifest kind: ${kind ?? 'unknown'}` };
}
