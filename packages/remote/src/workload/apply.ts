import type {
  ManagedAdmissionClaim,
  ManagedAdmissionDecision,
} from "@llamactl/core/residency/admission";
import type { MeasuredEnvelope } from "@llamactl/core/resources/memory";
import type { spawn as nodeSpawn } from "node:child_process";

import { server as serverMod, target as targetMod } from "@llamactl/core";
import { ENGINES } from "@llamactl/core/engines";
import {
  computeModelHostSpecHash,
  readModelHostState,
  removeModelHostState,
  writeModelHostState,
} from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { omitUndefined } from "@llamactl/core/object";
import {
  appendFleetJournal,
  chooseBestNode,
  defaultAggregatorDbPath,
  defaultFleetJournalPath,
  type FleetPlacementEntry,
  type FleetTransitionEntry,
  getLatestPerNode,
  makePlacementDecision,
  openAggregatorDb,
  projectAdmissionHeadroom,
  scoreNodes,
} from "@llamactl/fleet-supervisor";
import { basename } from "node:path";

import type { GatewayDispatch } from "./gateway-handlers/types.js";
import type { NodeRunResidency } from "./noderun-schema.js";
import type { ModelRun, ModelRunStatus, ModelRunWorker } from "./schema.js";

import {
  type AdmissionResult,
  computeNodeBudget,
  declaredModelHostMemoryGiB,
  defaultNodeBudgetGiB,
  estimateModelHostMemoryGiB,
  modelHostAdmissionChargeGiB,
  type TargetAdmissionAuthority,
  type TargetAdmissionClaimHandle,
} from "./admission.js";
import {
  LOCAL_NODE_ID,
  modelHostBindRefusal,
  type ModelHostManifest,
  ModelHostManifestSchema,
  specForEngine,
  specForHash,
} from "./modelhost-schema.js";
import { saveModelHost } from "./modelhost-store.js";
import { withNodeLock } from "./node-mutex.js";
import { ModelRunSchema } from "./schema.js";
import {
  defaultWorkloadsDir,
  listAnyWorkloadsForAdmission,
  listWorkloads,
  loadWorkloadByNameAny,
  saveWorkload,
} from "./store.js";

/**
 * Structural subset of `NodeClient` that `applyOne` actually touches.
 * Declared here so the workload layer doesn't force its consumers
 * (router.ts, the CLI) to pass the full typed `NodeClient` — both
 * `clientForNode` inside the router and the CLI's pinned client
 * satisfy this narrower shape, which eliminates an unsafe `as any`
 * cast at the router boundary.
 */

type SubscribeCallbacks = {
  onData: (e: unknown) => void;
  onError: (err: unknown) => void;
  onComplete: () => void;
};
type Unsubscribable = { unsubscribe?: () => void };

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "LLAMACTL_MODELS_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_BIN",
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
      /** Present on agents new enough to report port ownership; absent on
       *  older agents, so consumers treat undefined as "unknown". */
      listenerPid?: number | null;
      foreign?: boolean;
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
    query(input: { workload: string }): Promise<{
      state: string;
      pid?: number | null;
      specHash?: string;
      identityUnknown?: boolean;
    }>;
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
        | "LLAMA_CPP_BIN-unset"
        | "LLAMA_CPP_BIN-missing"
        | "rpc-server-missing"
        | "rpc-server-not-executable";
      hint?: string;
    }>;
  };
  resolveTarget?: {
    query(input: string): Promise<string | null>;
  };
  /** Node-reported facts; memBytes sizes remote ModelRun/ModelHost
   *  admission budgets when no explicit budget resolves. Served by every
   *  real client through the router's nodeFacts procedure. */
  nodeFacts?: {
    query(): Promise<{ memBytes: number | null }>;
  };
}

export type ApplyAction = "unchanged" | "started" | "restarted" | "pending";

export interface ApplyEvent {
  type:
    | "stop"
    | "start"
    | "started"
    | "skipped"
    | "worker-start"
    | "worker-ready"
    | "worker-preflight"
    | "gateway-pending"
    | "evict-failed";
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
  /** Resolve the node's memory budget for admission control. Returning
   *  undefined means "no explicit budget"; the caller sizes it itself. */
  getNodeBudgetGiB?: (nodeName: string) => number | undefined;
  /** Bubble up per-workload progress events for logging. */
  onEvent?: (event: ApplyEvent) => void;
  /** Map a node name to a stable identity for port-collision detection across node aliases. */
  resolveNodeIdentity?: (nodeName: string) => string | null;
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
    /** Nodes whose latest snapshot is older than this many ms are excluded. Default 150000 (5× 30s tick). staleCutoffMs <= 0 disables filtering. */
    staleCutoffMs?: number;
  };
  /** #277 DF-04 opt-in: measured calibration envelopes in ModelHost budget
   *  admission. Absent => charging is unchanged. Synchronous so the default
   *  path gains no await; no production caller passes it yet. */
  residencyAdmission?: {
    getNodeResidencyPolicy: (nodeName: string) => NodeRunResidency | null | undefined;
    getMeasuredEnvelope: (manifest: ModelHostManifest) => MeasuredEnvelope | null | undefined;
  };
}

interface PlacementContext {
  manifest: ModelRun;
  dbPath: string;
  journalPath: string;
  headroomMinMb: number;
  modelFilePenaltyMb: number;
  staleCutoffMs?: number;
}

function shouldAutoPlace(manifest: ModelRun): boolean {
  return manifest.spec.node === "auto" && manifest.spec.placement !== "pinned";
}

function runPlacement(
  context: PlacementContext,
): { ok: true; manifest: ModelRun; decision: FleetPlacementEntry } | { ok: false; error: string } {
  let db;
  try {
    db = openAggregatorDb(context.dbPath);
    // staleCutoffMs <= 0 disables filtering (callers that need all nodes, e.g. debug paths).
    // Default 150000ms = 5× the 30s supervisor tick — keeps stale snapshots out of placement.
    const effectiveCutoffMs = context.staleCutoffMs ?? 150_000;
    const freshAfterTs =
      effectiveCutoffMs > 0 ? new Date(Date.now() - effectiveCutoffMs).toISOString() : undefined;
    const rows = getLatestPerNode(db, freshAfterTs !== undefined ? { freshAfterTs } : undefined);
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
      kind: "fleet-placement",
      ts: new Date().toISOString(),
      node: best,
      decision: {
        ...decision,
        chosenNode: best,
      },
    };
    const transition: FleetTransitionEntry = {
      kind: "fleet-transition",
      ts: entry.ts,
      node: best,
      subject: context.manifest.metadata.name,
      subjectKind: "workload",
      signal: "placement",
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
  | { ok: true; kind: "ModelRun"; manifest: ModelRun; result: ApplyResult }
  | {
      // M7: ModelHost outcome carries only the desired-state manifest.
      // Observed status lives in the runtime sidecar (writeModelHostState),
      // not in the persisted YAML or on this outcome.
      ok: true;
      kind: "ModelHost";
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

async function resolveDesiredRel(
  target: ModelRun["spec"]["target"],
  client: WorkloadClient,
): Promise<string> {
  if (target.kind !== "alias") return target.value;

  const resolved =
    client.resolveTarget !== undefined ? await client.resolveTarget.query(target.value) : null;
  if (resolved !== null) return resolved;

  const local = targetMod.resolveTarget(target.value);
  return local ?? target.value;
}

/**
 * The coordinator's effective extraArgs: user args plus the --rpc flag
 * when this workload has workers. The server.rel / extraArgs comparison
 * uses the composed form so a diff between "with --rpc" and "without"
 * triggers a restart.
 */
function desiredArgsFor(manifest: ModelRun): string[] {
  const workers = manifest.spec.workers;
  if (workers.length === 0) return manifest.spec.extraArgs;
  return [
    ...manifest.spec.extraArgs,
    "--rpc",
    workers.map((w) => `${w.rpcHost}:${String(w.rpcPort)}`).join(","),
  ];
}

function specDigestFor(manifest: ModelRun, desiredArgs: readonly string[]): string {
  return JSON.stringify([manifest.spec.target.kind, manifest.spec.target.value, desiredArgs]);
}

function normalizeLoopbackHost(host: string | undefined): string {
  return host === "::1" ? "127.0.0.1" : (host ?? "127.0.0.1");
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function sanitizeChildEnv(
  parent: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
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
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function validateModelHostAdmission(
  manifest: ModelHostManifest,
  opts: Omit<ApplyManifestOptions, "manifest">,
): { ok: false; error: string } | null {
  const declaredGiB = declaredModelHostMemoryGiB(manifest);
  if (opts.supervisor && declaredGiB) {
    const projected = projectAdmissionHeadroom({
      currentFreeGiB: opts.supervisor.currentFreeGiB,
      expectedMemoryGiB: declaredGiB,
      headroomMinGiB: opts.supervisor.headroomMinGiB,
      ...(opts.supervisor.safetyFactor !== undefined
        ? { safetyFactor: opts.supervisor.safetyFactor }
        : {}),
    });
    if (!projected.allowed) {
      return { ok: false, error: projected.reason };
    }
  }
  const engine = ENGINES[manifest.spec.engine];
  if (manifest.spec.node === "local") {
    const validation = engine.validateSpec(specForEngine(manifest.spec));
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
  }
  return null;
}

/**
 * Extract a refusal reason when a stop mutation RESOLVED with `{ok:false}` —
 * distinct from a transport error: the remote answered but could not prove
 * the recorded pid's identity, so the record may still be ours.
 */
function refusedStopReason(outcome: unknown): string | null {
  if (typeof outcome !== "object" || outcome === null) return null;
  const ok = (outcome as { ok?: unknown }).ok;
  if (ok !== false) return null;
  const error = (outcome as { error?: unknown }).error;
  return typeof error === "string" ? error : "stop refused";
}

async function disableModelHost(
  manifest: ModelHostManifest,
  client: WorkloadClient,
  resolved: ReturnType<typeof resolveEnv>,
): Promise<ApplyManifestOutcome> {
  try {
    const outcome = await client.modelHostStop.mutate({ workload: manifest.metadata.name });
    // A refused stop keeps the sidecar: deleting it here would orphan a
    // possibly-live process that no later reconcile could identify.
    const refused = refusedStopReason(outcome);
    if (refused !== null) {
      return { ok: false, error: `modelHostStop refused: ${refused}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `modelHostStop failed: ${message}` };
  }
  // Idempotent cleanup: sweep any local sidecar (including pre-a6cab9e
  // leaks for remote workloads) before signaling disable.
  removeModelHostState({ name: manifest.metadata.name }, resolved);
  return {
    ok: true,
    kind: "ModelHost",
    manifest,
    pid: null,
    endpoint: `http://${formatHostForUrl(manifest.spec.endpoint.host)}:${String(manifest.spec.endpoint.port)}`,
  };
}

const NODE_FACTS_TIMEOUT_MS = 10_000;

async function resolveModelHostBudgetGiB(
  manifest: ModelHostManifest,
  opts: Omit<ApplyManifestOptions, "manifest">,
  client: WorkloadClient,
): Promise<number> {
  const explicit = opts.getNodeBudgetGiB?.(manifest.spec.node);
  if (explicit !== undefined) return explicit;
  if (manifest.spec.node === LOCAL_NODE_ID) return defaultNodeBudgetGiB();
  // A black-holed node must not stall admission: absent, rejected or
  // timed-out facts all fall back to the controller's own RAM.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, NODE_FACTS_TIMEOUT_MS);
    });
    const query = client.nodeFacts?.query() ?? Promise.resolve(null);
    const facts = await Promise.race([query.catch(() => null), timeout]);
    return defaultNodeBudgetGiB(undefined, facts?.memBytes ?? null);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function admitModelHostBudget(
  manifest: ModelHostManifest,
  opts: Omit<ApplyManifestOptions, "manifest">,
  resolved: ReturnType<typeof resolveEnv>,
  firstHostedModel: ModelHostManifest["spec"]["hostedModels"][number],
  budget: number,
): { ok: false; error: string } | null {
  const workloadsDir = opts.workloadsDir ?? defaultWorkloadsDir(opts.env);
  const livingManifests = listAnyWorkloadsForAdmission(workloadsDir, resolved)
    .filter((m) => m.metadata.name !== manifest.metadata.name)
    .filter((m) => m.spec.node === manifest.spec.node)
    .filter((m) => m.spec.enabled);
  const estimateGiB = estimateModelHostMemoryGiB(manifest, resolved);
  let expectedMemoryGiB = estimateGiB;
  if (opts.residencyAdmission !== undefined) {
    const policy = opts.residencyAdmission.getNodeResidencyPolicy(manifest.spec.node);
    const policyPresent = policy !== null && policy !== undefined;
    const envelope = policyPresent
      ? opts.residencyAdmission.getMeasuredEnvelope(manifest)
      : undefined;
    expectedMemoryGiB = modelHostAdmissionChargeGiB({
      estimateGiB,
      residencyPolicyPresent: policyPresent,
      envelope,
    });
  }
  const admit = computeNodeBudget({
    nodeName: manifest.spec.node,
    nodeBudgetGiB: budget,
    livingManifests,
    incoming: {
      apiVersion: manifest.apiVersion,
      kind: "ModelRun",
      metadata: { name: manifest.metadata.name, labels: {}, annotations: {} },
      spec: {
        node: manifest.spec.node,
        enabled: manifest.spec.enabled,
        target: { kind: "rel", value: firstHostedModel.rel },
        extraArgs: manifest.spec.extraArgs,
        workers: [],
        restartPolicy: manifest.spec.restartPolicy,
        timeoutSeconds: manifest.spec.timeoutSeconds,
        gateway: false,
        allowExternalBind: false,
        ...(expectedMemoryGiB !== null ? { resources: { expectedMemoryGiB } } : {}),
      },
    },
    forceAdmit: false,
    supportsForceAdmit: false,
  });
  if (!admit.ok) {
    return { ok: false, error: admit.reason };
  }
  return null;
}

async function startModelHostProcess(
  client: WorkloadClient,
  manifest: ModelHostManifest,
): Promise<
  { ok: false; error: string } | { ok: true; status: { state: string; pid?: number | null } }
> {
  const timeoutMs = manifest.spec.timeoutSeconds * 1000;
  // Wire contract: metadata.annotations are controller-side markers
  // (eviction intent) that older strict remote agents — router.ts's
  // modelHostStartInput parses the manifest with
  // ModelHostManifestSchema.optional() — reject as unknown keys, so the
  // manifest sent on the wire is a copy with annotations removed.
  const { annotations: _wireAnnotations, ...wireMetadata } = manifest.metadata;
  const wireManifest: ModelHostManifest = { ...manifest, metadata: wireMetadata };
  let sub: Unsubscribable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    type StartResult =
      | { ok: true; error?: string; pid?: number | null; state?: string | null }
      | { ok: false; error: string };
    const startResult = await new Promise<StartResult | null>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("modelHostStart timed out"));
      }, timeoutMs);
      let done: StartResult | null = null;
      sub = client.modelHostStart.subscribe(
        {
          workload: manifest.metadata.name,
          timeoutSeconds: manifest.spec.timeoutSeconds,
          manifest: wireManifest,
        },
        {
          onData: (evt: unknown) => {
            const e = evt as { type?: string; result?: unknown };
            if (e.type === "done") done = e.result as StartResult;
          },
          onError: (err: unknown) => {
            if (timer) clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
          onComplete: () => {
            if (timer) clearTimeout(timer);
            resolve(done);
          },
        },
      );
    }).catch(
      (err: unknown): StartResult => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    if (!startResult?.ok) {
      return { ok: false, error: startResult?.error ?? "modelHostStart failed" };
    }

    if (typeof startResult.pid === "number" && typeof startResult.state === "string") {
      return { ok: true, status: { state: startResult.state, pid: startResult.pid } };
    }
    return {
      ok: true,
      status: await client.modelHostStatus.query({ workload: manifest.metadata.name }),
    };
  } finally {
    if (timer) clearTimeout(timer);
    sub?.unsubscribe?.();
  }
}

function writeModelHostSidecar(
  manifest: ModelHostManifest,
  status: { state: string; pid?: number | null },
  resolved: ReturnType<typeof resolveEnv>,
  rel: string,
): void {
  const modelAliases = Array.from(new Set([rel, basename(rel)]));
  const existing = readModelHostState({ name: manifest.metadata.name }, resolved);
  // Only write the local sidecar when this controller owns the process
  // (spec.node === 'local'). For remote nodes the remote dispatcher owns
  // state; writing here would leak a stale entry into local consumers
  // (probe, openai-proxy routing, workloadEpoch). Also require a real
  // pid — without one the sidecar liveness/teardown semantics are wrong.
  if (manifest.spec.node === LOCAL_NODE_ID && typeof status.pid === "number" && status.pid > 0) {
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: manifest.spec.engine,
        pid: status.pid,
        host: manifest.spec.endpoint.host,
        port: manifest.spec.endpoint.port,
        modelAliases,
        startedAt: new Date().toISOString(),
        slotSavePath: existing?.pid === status.pid ? (existing.slotSavePath ?? null) : null,
        specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
        // This sidecar replaces the one launchModelHost wrote, so identity
        // fields must be carried or stop and status lose the fork identity.
        ...(manifest.spec.binaryNames !== undefined
          ? { binaryNames: [...manifest.spec.binaryNames] }
          : {}),
      },
      { name: manifest.metadata.name },
      resolved,
    );
  }
}

async function applyModelHostManifest(
  manifest: ModelHostManifest,
  opts: Omit<ApplyManifestOptions, "manifest">,
): Promise<ApplyManifestOutcome> {
  const invalid = validateModelHostAdmission(manifest, opts);
  if (invalid) return invalid;

  const resolved = resolveEnv(opts.env);
  if (!opts.getClient) {
    return { ok: false, error: `missing getClient for node ${manifest.spec.node}` };
  }
  const client = opts.getClient(manifest.spec.node);

  if (!manifest.spec.enabled) {
    return await disableModelHost(manifest, client, resolved);
  }

  // Refuse the exposed bind before budget + start. Disabling an already
  // exposed host must keep working, so this sits after the disable branch.
  const bindRefusal = modelHostBindRefusal(manifest);
  if (bindRefusal !== null) {
    return { ok: false, error: bindRefusal };
  }

  const firstHostedModel = manifest.spec.hostedModels[0];
  if (!firstHostedModel) {
    return { ok: false, error: `ModelHost ${manifest.metadata.name} has no hosted models` };
  }
  const budget = await resolveModelHostBudgetGiB(manifest, opts, client);
  const rejected = admitModelHostBudget(manifest, opts, resolved, firstHostedModel, budget);
  if (rejected) return rejected;

  const started = await startModelHostProcess(client, manifest);
  if (!started.ok) return { ok: false, error: started.error };

  writeModelHostSidecar(manifest, started.status, resolved, firstHostedModel.rel);

  return {
    ok: true,
    kind: "ModelHost",
    manifest,
    pid: started.status.pid ?? null,
    endpoint: `http://${formatHostForUrl(manifest.spec.endpoint.host)}:${String(manifest.spec.endpoint.port)}`,
  };
}

export async function applyOneModelHost(
  manifest: ModelHostManifest,
  getClient: (nodeName: string) => WorkloadClient,
  onEvent?: (e: ApplyEvent) => void,
  opts?: {
    env?: NodeJS.ProcessEnv;
    workloadsDir?: string;
    getNodeBudgetGiB?: (nodeName: string) => number | undefined;
    supervisor?: {
      currentFreeGiB: number;
      headroomMinGiB: number;
      safetyFactor?: number;
    };
    residencyAdmission?: {
      getNodeResidencyPolicy: (nodeName: string) => NodeRunResidency | null | undefined;
      getMeasuredEnvelope: (manifest: ModelHostManifest) => MeasuredEnvelope | null | undefined;
    };
  },
): Promise<ApplyManifestOutcome> {
  return await applyModelHostManifest(manifest, {
    getClient,
    ...omitUndefined({ onEvent }),
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
    ...(opts?.workloadsDir !== undefined ? { workloadsDir: opts.workloadsDir } : {}),
    ...(opts?.getNodeBudgetGiB !== undefined ? { getNodeBudgetGiB: opts.getNodeBudgetGiB } : {}),
    ...(opts?.supervisor !== undefined ? { supervisor: opts.supervisor } : {}),
    ...(opts?.residencyAdmission !== undefined
      ? { residencyAdmission: opts.residencyAdmission }
      : {}),
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (workers.length === 0) return { ok: true };
  onEvent?.({
    type: "worker-preflight",
    message: `preflight: checking rpc-server on ${String(workers.length)} worker node(s)`,
  });
  const results = await Promise.all(
    workers.map(async (w) => {
      try {
        const wc = getClient(w.node);
        const r = await wc.rpcServerDoctor.query({});
        return {
          node: w.node,
          result: r,
        };
      } catch (err) {
        // Treat dispatcher / network failures as a preflight failure
        // so the operator sees the node name. Wrapping into the same
        // doctor shape keeps the composed error uniform.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          node: w.node,
          result: {
            ok: false,
            reason: "doctor-call-failed",
            hint: `could not reach ${w.node}: ${msg}`,
          },
        };
      }
    }),
  );
  const failures = results.filter((r) => !r.result.ok);
  if (failures.length === 0) return { ok: true };
  const lines = failures.map((f) => {
    const reason = f.result.reason ?? "unknown";
    const hint = f.result.hint ?? "(no hint)";
    return `  - ${f.node}: ${reason}\n    ${hint}`;
  });
  return {
    ok: false,
    error:
      `rpc-server not available on ${String(failures.length)} worker node(s):\n` + lines.join("\n"),
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
    return { rpcList: "", error: preflight.error };
  }
  const endpoints: string[] = [];
  for (const worker of workers) {
    onEvent?.({
      type: "worker-start",
      message: `worker ${worker.node}: starting rpc-server on ${worker.rpcHost}:${String(worker.rpcPort)}`,
    });
    const wc = getClient(worker.node);
    // Stop any prior rpc-server on that node; ignore errors.
    try {
      await wc.rpcServerStop.mutate({ graceSeconds: 2 });
    } catch {
      // Best-effort cleanup before starting the requested worker.
    }
    let sub: Unsubscribable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started: { ok: boolean; endpoint: string; error?: string } | null = null;
    try {
      started = await new Promise<{ ok: boolean; endpoint: string; error?: string } | null>(
        (resolve, reject) => {
          timer = setTimeout(
            () => {
              reject(new Error(`rpc-server start timeout on ${worker.node}`));
            },
            (worker.timeoutSeconds + 5) * 1000,
          );
          let done: { ok: boolean; endpoint: string; error?: string } | null = null;
          sub = wc.rpcServerStart.subscribe(
            {
              host: "0.0.0.0",
              port: worker.rpcPort,
              ...(worker.extraArgs.length > 0 ? { extraArgs: worker.extraArgs } : {}),
              timeoutSeconds: worker.timeoutSeconds,
            },
            {
              onData: (e: unknown) => {
                const evt = e as { type?: string; result?: unknown };
                if (evt.type === "done") done = evt.result as typeof done;
              },
              onError: (err: unknown) => {
                if (timer) clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
              },
              onComplete: () => {
                if (timer) clearTimeout(timer);
                resolve(done);
              },
            },
          );
        },
      ).catch((err: unknown): { ok: false; endpoint: string; error: string } => ({
        ok: false,
        endpoint: "",
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (timer) clearTimeout(timer);
      sub?.unsubscribe?.();
    }
    if (!started?.ok) {
      return {
        rpcList: "",
        error: `worker ${worker.node}: ${started?.error ?? "rpc-server failed to start"}`,
      };
    }
    onEvent?.({
      type: "worker-ready",
      message: `worker ${worker.node}: ready on ${worker.rpcHost}:${String(worker.rpcPort)}`,
    });
    endpoints.push(`${worker.rpcHost}:${String(worker.rpcPort)}`);
  }
  return { rpcList: endpoints.join(",") };
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

interface ApplyOneOpts {
  workloadsDir?: string;
  /** Env used to resolve the runtime layout when projecting ModelHosts
   *  into the admission accounting — same forwarding contract the
   *  ModelHost apply path already honors. */
  env?: NodeJS.ProcessEnv;
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
  listManifests?: (dir?: string) => ModelRun[];
  /** May be async so a caller can size a remote node from its reported memory. */
  getNodeBudgetGiB?: (nodeName: string) => number | undefined | Promise<number | undefined>;
  /** Opt-in target-owned pending admission (DF-01 #274, E-1 slice).
   *  Inactive unless supplied. Not wired into the router, reconciler,
   *  CLI or ModelHost paths — only a caller that passes an authority
   *  explicitly gets claim evaluation. The ledger charges the living
   *  manifests from the same admission set as resident claims, so
   *  committed capacity counts against the target budget alongside
   *  pending claims. LIMITATION: resident and
   *  uncertain claims are absorbing until the "admission before
   *  destructive replacement with verified release" gate lands, so
   *  under this option a crashed or reconfigured runtimeKey is refused
   *  (AlreadyResident / WorkloadBusy) rather than restarted. */
  targetAdmission?: TargetAdmissionAuthority;
  /**
   * #520 active-session protection: consulted before any eviction stops a
   * workload. Opt-in and inert unless supplied. NON-FENCING: it narrows
   * but does not close the race with a concurrent acquire; fencing is
   * deferred to the #278 lease composition. */
  sessionGate?: SessionUnloadGate;
  /** Shared deadline per verified evict victim covering its status read,
   * stop and release check before the apply fails. Default 15_000
   * (15 seconds). */
  evictStopTimeoutMs?: number;
  /** How long an evicted-by marker keeps its victim suppressed while the
   *  owning replacement is missing or not yet confirmed. The reconciler
   *  forwards its evictionGraceMs so the guard and this check share one
   *  rule. Defaults to EVICTION_INTENT_GRACE_MS. */
  evictionGraceMs?: number;
}

interface SessionUnloadGate {
  checkUnload(workload: string): { ok: true } | { ok: false; sessions?: readonly string[] };
}

type ServerStatusSnapshot = Awaited<ReturnType<WorkloadClient["serverStatus"]["query"]>>;

function gatewayPendingResult(
  manifest: ModelRun,
  onEvent: ((e: ApplyEvent) => void) | undefined,
): ApplyResult {
  const now = new Date().toISOString();
  const msg =
    `gateway workload targeting '${manifest.spec.node}': ` +
    `no gateway dispatcher provided — manifest validated but no upstream mutation performed`;
  onEvent?.({ type: "gateway-pending", message: `${manifest.metadata.name}: ${msg}` });
  return {
    action: "pending",
    statusSection: {
      phase: "Pending",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "GatewayRegistrationPending",
          message: msg,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

async function stopDisabledWorkload(
  manifest: ModelRun,
  client: WorkloadClient,
  onEvent: ((e: ApplyEvent) => void) | undefined,
): Promise<ApplyResult> {
  const now = new Date().toISOString();
  const status = await client.serverStatus.query({ workload: manifest.metadata.name });
  if (status.state === "up") {
    onEvent?.({ type: "stop", message: `${manifest.metadata.name}: stopping disabled server` });
    await client.serverStop.mutate({ workload: manifest.metadata.name, graceSeconds: 5 });
  }
  return {
    action: "unchanged",
    statusSection: {
      phase: "Stopped",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "True",
          reason: "Disabled",
          lastTransitionTime: now,
        },
      ],
    },
  };
}

function checkPortCollision(
  manifest: ModelRun,
  opts: ApplyOneOpts | undefined,
): ApplyResult | null {
  const desired = manifest.spec.endpoint;
  if (desired?.port === undefined) return null;
  const workloadsDir = opts?.workloadsDir ?? defaultWorkloadsDir(opts?.env);
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
    .filter((m) => m.spec.enabled);
  for (const other of others) {
    if (
      other.status?.phase === "Failed" &&
      other.status.conditions[0]?.reason === "PortCollision"
    ) {
      continue;
    }
    const o = other.spec.endpoint;
    if (o?.port === undefined) continue;
    if (o.port !== desired.port) continue;
    const dHost = normalizeLoopbackHost(desired.host);
    const oHost = normalizeLoopbackHost(o.host);
    const hostCollides = dHost === oHost || dHost === "0.0.0.0" || oHost === "0.0.0.0";
    if (hostCollides) {
      const now = new Date().toISOString();
      return {
        action: "pending",
        error: `port collision: ${other.metadata.name} already claims ${oHost}:${String(o.port)} on node ${manifest.spec.node}`,
        statusSection: {
          phase: "Failed",
          serverPid: null,
          endpoint: null,
          lastTransitionTime: now,
          conditions: [
            {
              type: "Applied",
              status: "False",
              reason: "PortCollision",
              message: `port ${String(desired.port)} already claimed by ${other.metadata.name}`,
              lastTransitionTime: now,
            },
          ],
        },
      };
    }
  }
  return null;
}

export const EVICTED_BY_ANNOTATION = "llamactl.io/evicted-by";
export const EVICTED_AT_ANNOTATION = "llamactl.io/evicted-at";
export const EVICTION_INTENT_GRACE_MS = 15 * 60_000;

export function parseEvictTargets(manifest: ModelRun): string[] {
  return (manifest.metadata.annotations["llamactl.io/evict"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Whether the replacement still owns the victim's suppression. Within the
 * grace window the replacement may simply not be saved yet (apply -f
 * writes the victim markers before the replacement manifest lands), so
 * a missing replacement still holds; once the grace expires the hold
 * requires a live replacement that still names this victim in its evict
 * list.
 */
export function replacementHoldsEviction(
  replacement: ModelRun | ModelHostManifest | undefined,
  withinGrace: boolean,
  namesVictim: boolean,
): boolean {
  const enabled = replacement?.spec.enabled === true;
  if (withinGrace) return replacement === undefined || enabled;
  return replacement !== undefined && enabled && namesVictim;
}

/**
 * The name on the victim's evicted-by marker when that hold is still
 * live, or null when the marker is absent or lapsed. Shares the
 * reconciler guard's rule so an apply never overwrites a hold the
 * resurrection guard would still honour.
 */
function liveEvictionOwner(
  victim: { metadata: { name: string; annotations?: Record<string, string> | undefined } },
  workloadsDir: string,
  nowMs: number,
  graceMs: number,
): string | null {
  const annotations = victim.metadata.annotations;
  const ownerName = annotations?.[EVICTED_BY_ANNOTATION];
  if (ownerName === undefined) return null;
  const evictedAt = annotations?.[EVICTED_AT_ANNOTATION];
  const atMs = evictedAt === undefined ? Number.NaN : Date.parse(evictedAt);
  const withinGrace = !Number.isNaN(atMs) && nowMs - atMs < graceMs;
  let owner: ModelRun | ModelHostManifest | undefined;
  try {
    owner = loadWorkloadByNameAny(ownerName, workloadsDir);
  } catch {
    owner = undefined;
  }
  const namesVictim =
    owner?.kind === "ModelRun" && parseEvictTargets(owner).includes(victim.metadata.name);
  return replacementHoldsEviction(owner, withinGrace, namesVictim) ? ownerName : null;
}

class EvictDeadlineError extends Error {}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new EvictDeadlineError(`deadline ${String(ms)}ms exceeded`));
      }, ms);
    });
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const DEFAULT_EVICT_STOP_TIMEOUT_MS = 15_000;

type EvictFailureReason =
  | "EvictStatusUnknown"
  | "EvictTargetForeign"
  | "EvictStopRefused"
  | "EvictStopFailed"
  | "EvictStopTimedOut"
  | "EvictReleaseUnverified"
  | "EvictIntentUnpersisted"
  | "EvictIntentHeld"
  | "EvictCapacityUnverified";

interface EvictStopFailure {
  ok: false;
  target: string;
  reason: EvictFailureReason;
  message: string;
}

type EvictStopResult = { ok: true } | EvictStopFailure;

function evictStopFailure(
  manifest: ModelRun,
  target: string,
  reason: EvictFailureReason,
  detail: string,
): EvictStopFailure {
  return {
    ok: false,
    target,
    reason,
    message: `${manifest.metadata.name}: eviction of '${target}' failed (${reason}): ${detail}`,
  };
}

type EvictVictimKind = "ModelRun" | "ModelHost";

/** Pre-stop probe outcome for one verified evict victim. */
type EvictVictimProbe =
  | { kind: "down" }
  | { kind: "ready" }
  | { kind: "failed"; failure: EvictStopFailure };

/**
 * Per-kind victim adapter for the verified-eviction teardown (#275
 * slice 3). Every method runs inside the caller's shared remainingMs
 * deadline. ModelRun: an already-down victim skips the stop, a `foreign`
 * listener fails before any stop, and release is proven by a non-up
 * serverStatus. ModelHost: statusModelHost cannot see the
 * modelhost.starting record, so modelHostStop is issued even when
 * status says Stopped — it is identity-verified, never signals a
 * recycled pid, and reports {ok:true,pid:null} on stale records.
 */
const EVICT_VICTIM_OPS: Record<
  EvictVictimKind,
  {
    probe(
      manifest: ModelRun,
      client: WorkloadClient,
      target: string,
      remainingMs: () => number,
    ): Promise<EvictVictimProbe>;
    stop(
      manifest: ModelRun,
      client: WorkloadClient,
      target: string,
      remainingMs: () => number,
    ): Promise<EvictStopFailure | null>;
    verify(
      manifest: ModelRun,
      client: WorkloadClient,
      target: string,
      remainingMs: () => number,
    ): Promise<EvictStopFailure | null>;
  }
> = {
  ModelRun: {
    probe: async (manifest, client, target, remainingMs) => {
      let status: ServerStatusSnapshot;
      try {
        status = await withDeadline(client.serverStatus.query({ workload: target }), remainingMs());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          kind: "failed",
          failure: evictStopFailure(manifest, target, "EvictStatusUnknown", message),
        };
      }
      if (status.state !== "up") return { kind: "down" };
      if (status.foreign === true) {
        return {
          kind: "failed",
          failure: evictStopFailure(
            manifest,
            target,
            "EvictTargetForeign",
            "the recorded server's listener pid is foreign to this workload",
          ),
        };
      }
      return { kind: "ready" };
    },
    stop: async (manifest, client, target, remainingMs) => {
      const stopResult = await withDeadline(
        client.serverStop.mutate({ workload: target, graceSeconds: 5 }),
        remainingMs(),
      );
      const stopped = (stopResult as { stopped?: boolean } | undefined)?.stopped;
      if (stopped === false) {
        return evictStopFailure(manifest, target, "EvictStopRefused", "refused to stop");
      }
      return null;
    },
    verify: async (manifest, client, target, remainingMs) => {
      const postStatus = await withDeadline(
        client.serverStatus.query({ workload: target }),
        remainingMs(),
      );
      if (postStatus.state === "up") {
        return evictStopFailure(manifest, target, "EvictReleaseUnverified", "still up after stop");
      }
      return null;
    },
  },
  ModelHost: {
    probe: async (manifest, client, target, remainingMs) => {
      let status: { state: string; identityUnknown?: boolean };
      try {
        status = await withDeadline(
          client.modelHostStatus.query({ workload: target }),
          remainingMs(),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          kind: "failed",
          failure: evictStopFailure(manifest, target, "EvictStatusUnknown", message),
        };
      }
      if (status.identityUnknown === true) {
        return {
          kind: "failed",
          failure: evictStopFailure(
            manifest,
            target,
            "EvictStatusUnknown",
            "modelHost status identity unknown",
          ),
        };
      }
      return { kind: "ready" };
    },
    stop: async (manifest, client, target, remainingMs) => {
      const outcome = await withDeadline(
        client.modelHostStop.mutate({ workload: target, graceSeconds: 5 }),
        remainingMs(),
      );
      const refused = refusedStopReason(outcome);
      if (refused !== null) {
        return evictStopFailure(manifest, target, "EvictStopRefused", refused);
      }
      return null;
    },
    verify: async (manifest, client, target, remainingMs) => {
      const post = await withDeadline(
        client.modelHostStatus.query({ workload: target }),
        remainingMs(),
      );
      if (post.state === "Running" || post.identityUnknown === true) {
        return evictStopFailure(
          manifest,
          target,
          "EvictReleaseUnverified",
          "still running after stop",
        );
      }
      return null;
    },
  },
};

/** Stops one victim that was observed up and verifies its release.
 * Returns null once the victim is confirmed down. */
async function stopAndVerifyEvictTarget(
  manifest: ModelRun,
  client: WorkloadClient,
  target: string,
  kind: EvictVictimKind,
  remainingMs: () => number,
): Promise<EvictStopFailure | null> {
  const ops = EVICT_VICTIM_OPS[kind];
  try {
    const stopFailure = await ops.stop(manifest, client, target, remainingMs);
    if (stopFailure !== null) return stopFailure;
    return await ops.verify(manifest, client, target, remainingMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = err instanceof EvictDeadlineError ? "EvictStopTimedOut" : "EvictStopFailed";
    return evictStopFailure(manifest, target, reason, message);
  }
}

/**
 * Persist the durable eviction intent for one verified victim before its
 * first status read or stop RPC. The marker is what the reconcile guard
 * keys on: it suppresses the victim's resurrection until the replacement
 * lands or the grace expires, and the apply's exit rollback releases it
 * when this pass fails. An already-down victim keeps the marker too —
 * it was still evicted by this replacement. A marker still owned by a
 * different live replacement is refused rather than overwritten — this
 * apply must never claim, or later release, another replacement's hold.
 * Any failure to record the intent fails the victim before any stop,
 * since an unmarked stop would let the reconciler resurrect the victim
 * underneath the replacement.
 */
function persistEvictIntent(
  manifest: ModelRun,
  target: string,
  workloadsDir: string,
  now: string,
  claimedTargets: Set<string>,
  graceMs: number,
): EvictStopFailure | null {
  try {
    const victim = loadWorkloadByNameAny(target, workloadsDir);
    if (victim.metadata.name !== target) {
      throw new Error(`manifest declares metadata.name '${victim.metadata.name}', not '${target}'`);
    }
    const owner = victim.metadata.annotations?.[EVICTED_BY_ANNOTATION];
    if (owner !== manifest.metadata.name) {
      // A live foreign hold belongs to another replacement: overwriting
      // it would let this apply's rollback erase a hold it never owned.
      const holder = liveEvictionOwner(victim, workloadsDir, Date.parse(now), graceMs);
      if (holder !== null) {
        return evictStopFailure(
          manifest,
          target,
          "EvictIntentHeld",
          `'${target}' is already held by eviction owner '${holder}'`,
        );
      }
      const annotations = {
        ...victim.metadata.annotations,
        [EVICTED_BY_ANNOTATION]: manifest.metadata.name,
        [EVICTED_AT_ANNOTATION]: now,
      };
      if (victim.kind === "ModelHost") {
        saveModelHost({ ...victim, metadata: { ...victim.metadata, annotations } }, workloadsDir);
      } else {
        saveWorkload({ ...victim, metadata: { ...victim.metadata, annotations } }, workloadsDir);
      }
    }
    claimedTargets.add(target);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return evictStopFailure(manifest, target, "EvictIntentUnpersisted", message);
  }
}

async function stopEvictTargets(
  ctx: ConvergeServerContext,
  verifiedTargets: readonly string[],
  lifecycle: ClaimLifecycle,
  timeoutMs: number,
): Promise<EvictStopResult | null> {
  const { manifest, client, onEvent, opts, now, evictionClaims, evictKinds } = ctx;
  const workloadsDir = opts?.workloadsDir ?? defaultWorkloadsDir(opts?.env);
  const graceMs = opts?.evictionGraceMs ?? EVICTION_INTENT_GRACE_MS;
  for (const target of verifiedTargets) {
    const intent = persistEvictIntent(manifest, target, workloadsDir, now, evictionClaims, graceMs);
    if (intent !== null) return intent;
    const deadlineAt = Date.now() + timeoutMs;
    const remainingMs = (): number => Math.max(0, deadlineAt - Date.now());
    const kind = evictKinds.get(target) ?? "ModelRun";
    const ops = EVICT_VICTIM_OPS[kind];
    const probe = await ops.probe(manifest, client, target, remainingMs);
    if (probe.kind === "failed") return probe.failure;
    if (probe.kind === "down") {
      onEvent?.({
        type: "skipped",
        message: `${manifest.metadata.name}: eviction target ${target} already stopped`,
      });
      continue;
    }
    onEvent?.({ type: "stop", message: `${manifest.metadata.name}: evicting ${target}` });
    lifecycle.destructive = true;
    const failure = await stopAndVerifyEvictTarget(manifest, client, target, kind, remainingMs);
    if (failure !== null) return failure;
  }
  return null;
}

interface ConvergeServerContext {
  manifest: ModelRun;
  client: WorkloadClient;
  getClient: (nodeName: string) => WorkloadClient;
  onEvent: ((e: ApplyEvent) => void) | undefined;
  opts: ApplyOneOpts | undefined;
  now: string;
  status: ServerStatusSnapshot;
  matches: boolean;
  desiredArgs: string[];
  evictTargets: string[];
  /** Verified kind of each evict victim, recorded by
   *  authorizeEvictTargets so the teardown adapter picks the right
   *  status/stop procedures. */
  evictKinds: Map<string, "ModelRun" | "ModelHost">;
  /** Evict victims whose marker this apply persisted or reaffirmed;
   *  failure rollback releases exactly these holds. */
  evictionClaims: Set<string>;
}

/** Map a node name to a stable physical identity when a resolver is
 *  supplied, so admission counts aliases of the same node consistently
 *  with the port-collision preflight. Falls back to name equality. */
function nodeIdentityMatcher(
  opts: ApplyOneOpts | undefined,
  nodeName: string,
): (otherNode: string) => boolean {
  const resolveIdent = opts?.resolveNodeIdentity;
  const desiredIdentity = resolveIdent?.(nodeName) ?? null;
  return (otherNode: string): boolean => {
    if (otherNode === nodeName) return true;
    if (!resolveIdent || !desiredIdentity) return false;
    const otherIdentity = resolveIdent(otherNode);
    return otherIdentity !== null && otherIdentity === desiredIdentity;
  };
}

/**
 * Resolve the finite admission budget for a ModelRun target (DF-01).
 * An explicit budget (NodeRun spec.budget.memoryGiB via the caller's
 * resolver) wins. Otherwise a local target uses local physical capacity
 * and a remote target uses its verified nodeFacts memory. Returns null
 * when neither is available — callers must refuse rather than substitute
 * Infinity or the controller's own RAM for a remote target.
 */
async function resolveAdmissionBudgetGiB(
  nodeName: string,
  client: WorkloadClient,
  getNodeBudgetGiB: ApplyOneOpts["getNodeBudgetGiB"],
  hasDeclaredReservations: boolean,
): Promise<number | null> {
  const explicit = await getNodeBudgetGiB?.(nodeName);
  if (explicit !== undefined) return explicit;
  if (nodeName === LOCAL_NODE_ID) return defaultNodeBudgetGiB();
  if (!hasDeclaredReservations) return null;
  if (!client.nodeFacts) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, NODE_FACTS_TIMEOUT_MS);
    });
    const facts = await Promise.race([client.nodeFacts.query().catch(() => null), timeout]);
    const memBytes = facts?.memBytes;
    if (typeof memBytes === "number" && Number.isFinite(memBytes) && memBytes > 0) {
      return defaultNodeBudgetGiB(undefined, memBytes);
    }
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isMissingManifestError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("workload manifest not found");
}

/**
 * An evict target frees capacity only when it is a *verified* ModelRun or
 * ModelHost in the store (DF-01A / DF-02 slice 3). An unreadable manifest
 * could be either kind — it may not be credited as freed capacity or
 * stopped by this path, so the apply is refused before any teardown.
 * Ambiguous identities are refused with the same precedence: more than
 * one stored manifest claiming the target name, or a canonical
 * `<target>.yaml` whose metadata.name disagrees with the target, means
 * the freed capacity cannot be attributed to one victim. Ownership is
 * verified too — a target whose spec.node is not verifiably the incoming
 * manifest's node is refused, since the credit would apply to a
 * different node's budget. A genuinely missing manifest is the legacy
 * already-gone victim (e.g. a stale evict annotation surviving its
 * victim's delete): it is a no-op skip — nothing is resident to stop,
 * and since it is absent from the store it grants no capacity credit
 * either. Each verified target's kind is recorded on the context so the
 * teardown stage picks the matching status/stop procedures.
 */
function authorizeEvictTargets(
  ctx: ConvergeServerContext,
  workloadsDir: string,
): { ok: true; verified: Set<string> } | { ok: false; result: ApplyResult } {
  const { manifest, opts, evictTargets, now } = ctx;
  const verified = new Set<string>();
  const claimCounts = new Map<string, number>();
  for (const m of listAnyWorkloadsForAdmission(workloadsDir, resolveEnv(opts?.env))) {
    claimCounts.set(m.metadata.name, (claimCounts.get(m.metadata.name) ?? 0) + 1);
  }
  const sameNode = nodeIdentityMatcher(opts, manifest.spec.node);
  for (const target of evictTargets) {
    const check = checkEvictTarget(
      ctx,
      target,
      workloadsDir,
      claimCounts.get(target) ?? 0,
      sameNode,
    );
    if (check.status === "refused") return { ok: false, result: check.result };
    if (check.status === "verified") {
      verified.add(target);
      ctx.evictKinds.set(target, check.kind);
    }
  }
  return { ok: true, verified };
}

/**
 * Verify one evict target for `authorizeEvictTargets`: the stored
 * manifest must parse (either kind), declare the requested name, live
 * on the incoming manifest's node, and pass the session gate. A parsed
 * ModelHost is a verifiable victim — its kind rides along on the
 * verified result so the teardown stage picks the ModelHost status/stop
 * procedures. Anything unreadable keeps EvictKindUnsupported.
 */
function checkEvictTarget(
  ctx: ConvergeServerContext,
  target: string,
  workloadsDir: string,
  claimCount: number,
  sameNode: (other: string) => boolean,
):
  | { status: "verified"; kind: "ModelRun" | "ModelHost" }
  | { status: "skip" }
  | { status: "refused"; result: ApplyResult } {
  const { manifest } = ctx;
  if (claimCount > 1) {
    return {
      status: "refused",
      result: evictRefusalResult(
        ctx,
        target,
        "more than one stored manifest claims this name, so the freed capacity cannot be attributed to a single victim",
        "EvictAmbiguousIdentity",
      ),
    };
  }
  let loaded: ModelRun | ModelHostManifest;
  try {
    loaded = loadWorkloadByNameAny(target, workloadsDir);
  } catch (err) {
    if (isMissingManifestError(err)) return { status: "skip" };
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "refused",
      result: evictRefusalResult(
        ctx,
        target,
        `it could not be read to confirm its kind (${message})`,
        "EvictKindUnsupported",
      ),
    };
  }
  if (loaded.metadata.name !== target) {
    return {
      status: "refused",
      result: evictRefusalResult(
        ctx,
        target,
        `the canonical '${target}.yaml' manifest declares metadata.name '${loaded.metadata.name}'`,
        "EvictAmbiguousIdentity",
      ),
    };
  }
  if (!sameNode(loaded.spec.node)) {
    return {
      status: "refused",
      result: evictRefusalResult(
        ctx,
        target,
        `it is owned by node '${loaded.spec.node}', which is not verifiably the incoming manifest's node '${manifest.spec.node}'`,
        "EvictNodeUnverified",
      ),
    };
  }
  const gated = checkEvictSessionGate(ctx, target);
  if (gated) return { status: "refused", result: gated };
  return { status: "verified", kind: loaded.kind };
}

function checkEvictSessionGate(ctx: ConvergeServerContext, target: string): ApplyResult | null {
  const gate = ctx.opts?.sessionGate;
  if (gate === undefined) return null;
  let check: { ok: true } | { ok: false; sessions?: readonly string[] };
  try {
    check = gate.checkUnload(target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return evictRefusalResult(
      ctx,
      target,
      `session ownership could not be verified (${message})`,
      "EvictSessionUnknown",
    );
  }
  if (!check.ok) {
    const sessions = check.sessions ?? [];
    const why =
      sessions.length > 0
        ? `sessions ${sessions.join(", ")} are still active`
        : "an active session";
    return evictRefusalResult(ctx, target, why, "EvictSessionActive");
  }
  return null;
}

function recheckEvictSessionGates(
  ctx: ConvergeServerContext,
  verifiedTargets: readonly string[],
): ApplyResult | null {
  for (const target of verifiedTargets) {
    const refusal = checkEvictSessionGate(ctx, target);
    if (refusal !== null) return refusal;
  }
  return null;
}

function evictRefusalResult(
  ctx: ConvergeServerContext,
  target: string,
  why: string,
  reason: string,
): ApplyResult {
  const { now, status } = ctx;
  const error = `refusing to evict '${target}': ${why}; no eviction, stop, or start was attempted`;
  if (ctx.matches) {
    return {
      action: "unchanged",
      error,
      statusSection: {
        phase: "Running",
        serverPid: status.pid,
        endpoint: status.endpoint,
        lastTransitionTime: now,
        conditions: [
          { type: "Applied", status: "True", reason: "unchanged", lastTransitionTime: now },
          {
            type: "EvictRefused",
            status: "False",
            reason,
            message: error,
            lastTransitionTime: now,
          },
        ],
      },
    };
  }
  return {
    action: "pending",
    error,
    statusSection: {
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason,
          message: error,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

function evictFailureResult(
  ctx: ConvergeServerContext,
  target: string,
  message: string,
  reason: string,
): ApplyResult {
  const { now, status, matches } = ctx;
  const error = `eviction of '${target}' did not complete (${reason}): ${message}; replacement was not started`;
  if (ctx.matches) {
    return {
      action: "unchanged",
      error,
      statusSection: {
        phase: "Running",
        serverPid: status.pid,
        endpoint: status.endpoint,
        lastTransitionTime: now,
        conditions: [
          { type: "Applied", status: "True", reason: "unchanged", lastTransitionTime: now },
          {
            type: "EvictFailed",
            status: "False",
            reason,
            message: error,
            lastTransitionTime: now,
          },
        ],
      },
    };
  }
  return {
    action: "pending",
    error,
    statusSection: {
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason,
          message: error,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

function admissionConditionReason(
  kind: "unknown-budget" | "over-budget" | "invalid-reservation",
): string {
  if (kind === "unknown-budget") return "BudgetUnknown";
  if (kind === "invalid-reservation") return "ReservationInvalid";
  return "BudgetExceeded";
}

function admissionFailureResult(
  adm: Extract<AdmissionResult, { ok: false }>,
  now: string,
): ApplyResult {
  return {
    action: "pending",
    error: adm.reason,
    statusSection: {
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: admissionConditionReason(adm.kind),
          message: adm.reason,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

function preservedRunningWithBudgetRefusal(
  ctx: ConvergeServerContext,
  adm: Extract<AdmissionResult, { ok: false }>,
): ApplyResult {
  const { now, status } = ctx;
  return {
    action: "unchanged",
    statusSection: {
      phase: "Running",
      serverPid: status.pid,
      endpoint: status.endpoint,
      lastTransitionTime: now,
      conditions: [
        { type: "Applied", status: "True", reason: "unchanged", lastTransitionTime: now },
        {
          type: "BudgetRefused",
          status: "False",
          reason: admissionConditionReason(adm.kind),
          message: adm.reason,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

/**
 * The living-manifest set admission charges against the node budget:
 * every stored workload on the same node that is enabled, minus the
 * incoming manifest itself and minus verified evict victims (their
 * capacity is being freed by this apply). Shared by the pre-teardown
 * admission check and the post-eviction capacity re-check so both see
 * the same filter.
 */
function admissionLivingManifests(
  ctx: ConvergeServerContext,
  verified: ReadonlySet<string>,
): { living: ModelRun[]; sameNode: (otherNode: string) => boolean } {
  const { manifest, opts } = ctx;
  const workloadsDir = opts?.workloadsDir ?? defaultWorkloadsDir(opts?.env);
  const listManifests: (dir?: string) => ModelRun[] =
    opts?.listManifests ??
    ((dir?: string): ModelRun[] =>
      listAnyWorkloadsForAdmission(dir ?? workloadsDir, resolveEnv(opts?.env)));
  const sameNode = nodeIdentityMatcher(opts, manifest.spec.node);
  const living = listManifests(opts?.workloadsDir).filter(
    (m) =>
      m.metadata.name !== manifest.metadata.name &&
      sameNode(m.spec.node) &&
      m.spec.enabled &&
      !verified.has(m.metadata.name),
  );
  return { living, sameNode };
}

/**
 * Post-eviction capacity re-check (DF-02): after every verified victim
 * is down, re-list the living manifests — a concurrent apply may have
 * claimed the freed budget while the stops were in flight — and rerun
 * the same finite-budget computation against the already-resolved
 * adm.budget. Returns the refusal reason, or null when the replacement
 * still fits.
 */
function recheckEvictionCapacity(
  ctx: ConvergeServerContext,
  adm: Extract<AdmissionResult, { ok: true }>,
  verified: ReadonlySet<string>,
): string | null {
  const { manifest } = ctx;
  const { living, sameNode } = admissionLivingManifests(ctx, verified);
  const forceAdmit = manifest.metadata.annotations["llamactl.io/force-admit"] === "true";
  const recheck = computeNodeBudget({
    nodeName: manifest.spec.node,
    nodeBudgetGiB: adm.budget,
    livingManifests: living,
    incoming: manifest,
    forceAdmit,
    sameNode,
  });
  return recheck.ok ? null : recheck.reason;
}

async function admitServerBudget(ctx: ConvergeServerContext): Promise<
  | {
      ok: true;
      adm: Extract<AdmissionResult, { ok: true }>;
      verified: Set<string>;
      living: ModelRun[];
    }
  | {
      ok: false;
      adm?: Extract<AdmissionResult, { ok: false }>;
      result: ApplyResult;
    }
> {
  const { manifest, opts, now } = ctx;
  const workloadsDir = opts?.workloadsDir ?? defaultWorkloadsDir(opts?.env);
  const eviction = authorizeEvictTargets(ctx, workloadsDir);
  if (!eviction.ok) return { ok: false, result: eviction.result };
  const verified = eviction.verified;
  const { living, sameNode } = admissionLivingManifests(ctx, verified);
  const incomingMemory = manifest.spec.resources?.expectedMemoryGiB ?? 0;
  const hasDeclaredReservations =
    incomingMemory > 0 || living.some((m) => (m.spec.resources?.expectedMemoryGiB ?? 0) > 0);
  const budget = await resolveAdmissionBudgetGiB(
    manifest.spec.node,
    ctx.client,
    opts?.getNodeBudgetGiB,
    hasDeclaredReservations,
  );
  const forceAdmit = manifest.metadata.annotations["llamactl.io/force-admit"] === "true";
  const adm = computeNodeBudget({
    nodeName: manifest.spec.node,
    nodeBudgetGiB: budget,
    livingManifests: living,
    incoming: manifest,
    forceAdmit,
    sameNode,
  });
  if (!adm.ok) {
    return { ok: false, adm, result: admissionFailureResult(adm, now) };
  }
  return { ok: true, adm, verified, living };
}

function failedApplyResult(action: ApplyAction, error: string, when: string): ApplyResult {
  return {
    action,
    statusSection: {
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: when,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: action,
          message: error,
          lastTransitionTime: when,
        },
      ],
    },
    error,
  };
}

async function startCoordinator(
  client: WorkloadClient,
  manifest: ModelRun,
  desiredArgs: string[],
): Promise<StartDone | null> {
  let sub: Unsubscribable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<StartDone | null>((resolve, reject) => {
      timer = setTimeout(
        () => {
          reject(new Error("serverStart timed out"));
        },
        (manifest.spec.timeoutSeconds + 5) * 1000,
      );
      let done: StartDone | null = null;
      sub = client.serverStart.subscribe(
        {
          workload: manifest.metadata.name,
          target: manifest.spec.target.value,
          ...(desiredArgs.length > 0 ? { extraArgs: desiredArgs } : {}),
          ...(manifest.spec.allowExternalBind ? { allowExternalBind: true } : {}),
          ...(manifest.spec.endpoint
            ? {
                endpoint: {
                  ...(manifest.spec.endpoint.host !== undefined
                    ? { host: manifest.spec.endpoint.host }
                    : {}),
                  ...(manifest.spec.endpoint.port !== undefined
                    ? { port: manifest.spec.endpoint.port }
                    : {}),
                },
              }
            : {}),
          ...(manifest.spec.binary ? { binary: manifest.spec.binary } : {}),
          timeoutSeconds: manifest.spec.timeoutSeconds,
        },
        {
          onData: (evt: unknown) => {
            const e = evt as { type?: string; result?: unknown };
            if (e.type === "done") done = e.result as StartDone;
          },
          onError: (err: unknown) => {
            if (timer) clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
          onComplete: () => {
            if (timer) clearTimeout(timer);
            resolve(done);
          },
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    sub?.unsubscribe?.();
  }
}

/**
 * The node refuses a bad bind only at serverStart, after eviction and the mismatched-server stop
 * have already run, so a start that would be refused is failed here while nothing has been torn
 * down. Without spec.endpoint.host the node's LLAMA_CPP_HOST decides the bind; only the node can
 * refuse that. A matching workload starts nothing, so its live server keeps its Running report.
 */
function refuseHostBindBeforeTeardown(ctx: ConvergeServerContext): ApplyResult | null {
  if (ctx.matches) return null;
  const refusal = serverMod.hostBindRefusal(
    ctx.desiredArgs,
    ctx.manifest.spec.endpoint?.host,
    ctx.manifest.spec.allowExternalBind,
  );
  return refusal === null ? null : failedApplyResult("unchanged", refusal, ctx.now);
}

/**
 * Decide what a failed admission means for the caller (DF-01A). A no-op
 * apply of an already-matching running server keeps Running with its pid
 * and carries an attributable BudgetRefused condition — healthy work is
 * not mislabeled because accounting can't currently prove the budget.
 * A matching workload that also requested eviction is still a no-op for
 * the running server, so the same preservation applies, but the refused
 * eviction request is reported as an error on the preserved result.
 * Anything that would actually tear work down (a start, a restart) fails
 * closed.
 */
function admissionRejection(
  ctx: ConvergeServerContext,
  admission: Extract<Awaited<ReturnType<typeof admitServerBudget>>, { ok: false }>,
): ApplyResult {
  if (ctx.matches && admission.adm) {
    const preserved = preservedRunningWithBudgetRefusal(ctx, admission.adm);
    if (ctx.evictTargets.length === 0) return preserved;
    return {
      ...preserved,
      error: `requested eviction of '${ctx.evictTargets.join("', '")}' was refused: ${admission.adm.reason}; no eviction, stop, or start was attempted`,
    };
  }
  return admission.result;
}

function targetAdmissionRefusal(
  decision: Exclude<ManagedAdmissionDecision, { kind: "admit" }>,
  targetIdentity: string,
  budgetGiB: number | null,
  now: string,
): ApplyResult {
  const reason =
    decision.kind === "refuse"
      ? decision.reason
      : decision.kind === "join-pending"
        ? "AdmissionPending"
        : "AlreadyResident";
  const detail =
    decision.kind === "refuse"
      ? decision.detail
      : decision.kind === "join-pending"
        ? `target '${targetIdentity}' already has pending claim ${decision.claimId}`
        : `target '${targetIdentity}' already has resident claim ${decision.claimId}`;
  const budgetText = budgetGiB === null ? "unknown" : `${budgetGiB.toFixed(1)} GiB`;
  const error = `target admission refused for '${targetIdentity}' (budget ${budgetText}): ${detail}`;
  return {
    action: "pending",
    error,
    statusSection: {
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason,
          message: error,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

type TargetClaim =
  | { kind: "inactive" }
  | { kind: "refused"; result: ApplyResult }
  | { kind: "claimed"; handle: TargetAdmissionClaimHandle | null };

/**
 * Target-owned pending admission (DF-01 #274, E-1 slice): claim the
 * target's budget after the finite-budget and bind checks pass but
 * before any teardown, so two in-flight applies cannot both fit one
 * target. Opt-in via ApplyOneOpts.targetAdmission; the force-admit
 * annotation does not reach it.
 */
function claimTargetAdmission(
  ctx: ConvergeServerContext,
  adm: Extract<AdmissionResult, { ok: true }>,
  living: readonly ModelRun[],
): TargetClaim {
  const targetAdmission = ctx.opts?.targetAdmission;
  if (!targetAdmission || ctx.matches) return { kind: "inactive" };
  const { manifest, desiredArgs, now } = ctx;
  const targetIdentity = ctx.opts?.resolveNodeIdentity?.(manifest.spec.node) ?? manifest.spec.node;
  // The ledger charges committed manifests together with pending claims:
  // the same living set the finite-budget check saw is projected into
  // resident claims so concurrent applies cannot both fit one target.
  const livingClaims: ManagedAdmissionClaim[] = living.map((m) => ({
    claimId: `store:${m.metadata.name}`,
    runtimeKey: m.metadata.name,
    specDigest: specDigestFor(m, desiredArgsFor(m)),
    state: "resident",
    allocationGiB: m.spec.resources?.expectedMemoryGiB,
    kind: "ModelRun",
  }));
  const { decision, handle } = targetAdmission.tryClaim({
    targetIdentity,
    runtimeKey: manifest.metadata.name,
    specDigest: specDigestFor(manifest, desiredArgs),
    kind: "ModelRun",
    allocationGiB: manifest.spec.resources?.expectedMemoryGiB,
    budgetGiB: adm.budget ?? undefined,
    living: livingClaims,
  });
  if (decision.kind === "admit") return { kind: "claimed", handle };
  return {
    kind: "refused",
    result: targetAdmissionRefusal(decision, targetIdentity, adm.budget, now),
  };
}

/**
 * Tracks how far the post-claim section got: `destructive` flips once
 * teardown may already have run (verified evictions, the
 * mismatched-server stop, worker starts) and `startInvoked` once the
 * coordinator subscribe is imminent.
 */
interface ClaimLifecycle {
  destructive: boolean;
  startInvoked: boolean;
}

async function startClaimedServer(
  ctx: ConvergeServerContext,
  action: ApplyAction,
  adm: Extract<AdmissionResult, { ok: true }>,
  handle: TargetAdmissionClaimHandle | null,
  lifecycle: ClaimLifecycle,
): Promise<ApplyResult> {
  const { manifest, client, getClient, onEvent, now, desiredArgs } = ctx;
  const workers = manifest.spec.workers;
  if (workers.length > 0) {
    lifecycle.destructive = true;
    const wres = await startWorkers(workers, getClient, onEvent);
    if (wres.error) {
      // Already inside `workers.length > 0`; stop the partially-started workers
      // before returning so a worker-start failure is all-or-nothing.
      await stopWorkers(workers, getClient);
      handle?.releaseUnstarted();
      return failedApplyResult(action, wres.error, new Date().toISOString());
    }
  }

  onEvent?.({
    type: "start",
    message: `${manifest.metadata.name}: starting ${manifest.spec.target.value}`,
  });
  lifecycle.startInvoked = true;
  const startResult = await startCoordinator(client, manifest, desiredArgs);

  if (!startResult?.ok) {
    const err = startResult?.error ?? "serverStart failed";
    if (workers.length > 0) await stopWorkers(workers, getClient);
    handle?.markUncertain();
    return failedApplyResult(action, err, now);
  }

  handle?.markResident();

  onEvent?.({
    type: "started",
    message: `${manifest.metadata.name}: ready at ${startResult.endpoint} pid=${String(startResult.pid ?? "?")}`,
  });

  return {
    action,
    statusSection: {
      phase: "Running",
      serverPid: startResult.pid,
      endpoint: startResult.endpoint,
      lastTransitionTime: now,
      conditions: [
        { type: "Applied", status: "True", reason: action, lastTransitionTime: now },
        {
          type: "BudgetReserved",
          status: "True",
          message: `node reserves ${adm.reservedAfter.toFixed(1)} / ${adm.budget === null ? "unknown" : adm.budget.toFixed(1)} GiB`,
          lastTransitionTime: now,
        },
      ],
    },
  };
}

async function convergeClaimedServer(
  ctx: ConvergeServerContext,
  adm: Extract<AdmissionResult, { ok: true }>,
  verified: ReadonlySet<string>,
  handle: TargetAdmissionClaimHandle | null,
  lifecycle: ClaimLifecycle,
): Promise<ApplyResult> {
  const { manifest, client, onEvent, now, status, matches, evictTargets } = ctx;
  // Evict only AFTER admission succeeds and from INSIDE the node lock.
  // Eviction is destructive: stopping the victims for a workload that
  // is then rejected (budget/admission fail) would tear down running
  // servers to make room for a server that never starts. The budget
  // computation already excludes evictTargets from `living`, so an
  // admitted workload has accounted for the freed capacity here.
  const verifiedTargets = evictTargets.filter((t) => verified.has(t));
  // #520: a session can appear between authorization and teardown. This
  // re-check is synchronous — no await between it and the first stop —
  // so nothing destructive has run yet and the finally releases the claim.
  const gateRefusal = recheckEvictSessionGates(ctx, verifiedTargets);
  if (gateRefusal !== null) return gateRefusal;
  const timeoutMs = ctx.opts?.evictStopTimeoutMs ?? DEFAULT_EVICT_STOP_TIMEOUT_MS;
  const evictFailure = await stopEvictTargets(ctx, verifiedTargets, lifecycle, timeoutMs);
  if (evictFailure !== null && !evictFailure.ok) {
    onEvent?.({ type: "evict-failed", message: evictFailure.message });
    return evictFailureResult(ctx, evictFailure.target, evictFailure.message, evictFailure.reason);
  }

  if (matches) {
    onEvent?.({
      type: "skipped",
      message: `${manifest.metadata.name}: already running (${manifest.spec.target.value})`,
    });
    return {
      action: "unchanged",
      statusSection: {
        phase: "Running",
        serverPid: status.pid,
        endpoint: status.endpoint,
        lastTransitionTime: now,
        conditions: [
          { type: "Applied", status: "True", reason: "unchanged", lastTransitionTime: now },
        ],
      },
    };
  }

  // The victims are verified down but the world may have moved while the
  // stops were in flight — another apply can have landed a new resident
  // in the freed budget. Re-check capacity against a fresh manifest list
  // before tearing down the mismatched self or starting the replacement;
  // the claim's finally marks it uncertain because destructive work ran.
  if (verifiedTargets.length > 0) {
    const capacityError = recheckEvictionCapacity(ctx, adm, verified);
    if (capacityError !== null) {
      const message = `capacity re-check after evicting ${verifiedTargets.join(", ")} failed: ${capacityError}`;
      onEvent?.({ type: "evict-failed", message });
      return evictFailureResult(
        ctx,
        verifiedTargets.join(", "),
        capacityError,
        "EvictCapacityUnverified",
      );
    }
  }

  let action: ApplyAction;
  if (status.state === "up") {
    onEvent?.({ type: "stop", message: `${manifest.metadata.name}: stopping mismatched server` });
    lifecycle.destructive = true;
    await client.serverStop.mutate({ workload: manifest.metadata.name, graceSeconds: 5 });
    action = "restarted";
  } else {
    action = "started";
  }

  return await startClaimedServer(ctx, action, adm, handle, lifecycle);
}

/**
 * DF-02 rollback: when a replacement apply does not reach Running, release
 * the eviction markers this apply's eviction stage persisted or
 * reaffirmed so the reconciler's normal budget-checked admission can
 * recover the victims — a stored replacement that crashed and now fails
 * its restart must still free its victims. A failure before that stage
 * (budget, bind or session-gate refusals) never reaches persist, so every
 * prior hold stays untouched: the still-running replacement owns it, and
 * a foreign owner's marker is never this apply's to clear. Missing or
 * unreadable victims are skipped and save failures are collected; the
 * clear itself never throws.
 */
function clearEvictionMarkers(
  manifest: ModelRun,
  opts: ApplyOneOpts | undefined,
  claimedTargets: ReadonlySet<string>,
): { released: string[]; problems: string[] } {
  const workloadsDir = opts?.workloadsDir ?? defaultWorkloadsDir(opts?.env);
  const released: string[] = [];
  const problems: string[] = [];
  for (const target of parseEvictTargets(manifest)) {
    if (!claimedTargets.has(target)) continue;
    const outcome = releaseClaimedMarker(target, manifest.metadata.name, workloadsDir);
    if (outcome.released) released.push(target);
    if (outcome.problem !== undefined) problems.push(outcome.problem);
  }
  return { released, problems };
}

/** Clear one claimed victim's marker; `problem` carries a save failure. */
function releaseClaimedMarker(
  target: string,
  ownerName: string,
  workloadsDir: string,
): { released: boolean; problem?: string } {
  let victim: ModelRun | ModelHostManifest;
  try {
    victim = loadWorkloadByNameAny(target, workloadsDir);
  } catch {
    return { released: false };
  }
  if (victim.metadata.name !== target) {
    return { released: false };
  }
  if (victim.metadata.annotations?.[EVICTED_BY_ANNOTATION] !== ownerName) {
    return { released: false };
  }
  const source: Record<string, string> = victim.metadata.annotations ?? {};
  const {
    [EVICTED_BY_ANNOTATION]: _evictedBy,
    [EVICTED_AT_ANNOTATION]: _evictedAt,
    ...annotations
  } = source;
  try {
    if (victim.kind === "ModelHost") {
      const { annotations: _stale, ...hostMetadata } = victim.metadata;
      // ModelHost annotations are optional: drop the key entirely when
      // nothing remains rather than leave `annotations: {}` behind.
      saveModelHost(
        {
          ...victim,
          metadata:
            Object.keys(annotations).length > 0 ? { ...hostMetadata, annotations } : hostMetadata,
        },
        workloadsDir,
      );
    } else {
      saveWorkload({ ...victim, metadata: { ...victim.metadata, annotations } }, workloadsDir);
    }
    return { released: true };
  } catch (err) {
    return {
      released: false,
      problem: `'${target}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function applyEvictionRollback(
  result: ApplyResult,
  manifest: ModelRun,
  opts: ApplyOneOpts | undefined,
  claimedTargets: ReadonlySet<string>,
): ApplyResult {
  const { released, problems } = clearEvictionMarkers(manifest, opts, claimedTargets);
  const notes: string[] = [];
  if (released.length > 0) {
    notes.push(`released eviction intent on ${released.map((n) => `'${n}'`).join(", ")}`);
  }
  for (const problem of problems) {
    notes.push(`failed to release eviction intent on ${problem}`);
  }
  if (notes.length === 0) return result;
  const note = notes.join("; ");
  return { ...result, error: result.error !== undefined ? `${result.error}; ${note}` : note };
}

async function convergeServerUnderLock(ctx: ConvergeServerContext): Promise<ApplyResult> {
  const admission = await admitServerBudget(ctx);
  if (!admission.ok) return admissionRejection(ctx, admission);
  const adm = admission.adm;
  const verified = admission.verified;
  const living = admission.living;

  const bindRefusal = refuseHostBindBeforeTeardown(ctx);
  if (bindRefusal !== null) return bindRefusal;

  const claim = claimTargetAdmission(ctx, adm, living);
  if (claim.kind === "refused") return claim.result;
  const handle = claim.kind === "claimed" ? claim.handle : null;

  // An admitted claim must leave `pending` on every exit path: a throw
  // between the claim and the terminal transition marks the claim
  // uncertain once anything destructive ran, and releases it otherwise.
  const lifecycle: ClaimLifecycle = { destructive: false, startInvoked: false };
  try {
    return await convergeClaimedServer(ctx, adm, verified, handle, lifecycle);
  } finally {
    if (handle !== null && handle.state() === "pending") {
      if (lifecycle.destructive || lifecycle.startInvoked) {
        handle.markUncertain();
      } else {
        handle.releaseUnstarted();
      }
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
  opts?: ApplyOneOpts,
): Promise<ApplyResult> {
  if (manifest.spec.gateway) {
    if (gatewayDispatch) {
      const dispatched = await gatewayDispatch({
        manifest,
        getClient,
        ...omitUndefined({ onEvent }),
      });
      // `null` from the dispatcher is the agent-gateway fallthrough
      // sentinel — spec.gateway:true pointed at an agent-kind node
      // runs through the regular serverStart path below.
      if (dispatched !== null) return dispatched;
    } else {
      return gatewayPendingResult(manifest, onEvent);
    }
  }
  const client = getClient(manifest.spec.node);
  if (!manifest.spec.enabled) {
    return await stopDisabledWorkload(manifest, client, onEvent);
  }
  const collision = checkPortCollision(manifest, opts);
  if (collision) return collision;

  const status = await client.serverStatus.query({ workload: manifest.metadata.name });

  const desiredRel = await resolveDesiredRel(manifest.spec.target, client);
  const desiredEndpoint = manifest.spec.endpoint;
  const desiredArgs = desiredArgsFor(manifest);
  const liveRel = status.rel;
  const liveArgs = status.extraArgs;
  const running = status.state === "up";
  const endpointMatches =
    (desiredEndpoint?.host === undefined || (status.host ?? null) === desiredEndpoint.host) &&
    (desiredEndpoint?.port === undefined || (status.port ?? null) === desiredEndpoint.port);
  const binaryMatches = !manifest.spec.binary || (status.binary ?? null) === manifest.spec.binary;
  const matches =
    running &&
    liveRel === desiredRel &&
    sameExtraArgs(liveArgs, desiredArgs) &&
    endpointMatches &&
    binaryMatches;

  const now = new Date().toISOString();
  const evictTargets = parseEvictTargets(manifest);
  const evictionClaims = new Set<string>();

  return await withNodeLock(manifest.spec.node, async () => {
    const ctx: ConvergeServerContext = {
      manifest,
      client,
      getClient,
      onEvent,
      opts,
      now,
      status,
      matches,
      desiredArgs,
      evictTargets,
      evictKinds: new Map(),
      evictionClaims,
    };
    let result: ApplyResult;
    try {
      result = await convergeServerUnderLock(ctx);
    } catch (err) {
      clearEvictionMarkers(manifest, opts, evictionClaims);
      throw err;
    }
    if (result.error === undefined && result.statusSection.phase === "Running") {
      return result;
    }
    return applyEvictionRollback(result, manifest, opts, evictionClaims);
  });
}

async function applyModelRunManifest(opts: ApplyManifestOptions): Promise<ApplyManifestOutcome> {
  const parsed = ModelRunSchema.safeParse(opts.manifest);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  let manifest = parsed.data;
  if (shouldAutoPlace(manifest)) {
    const placement = runPlacement({
      manifest,
      dbPath: opts.placement?.dbPath ?? defaultAggregatorDbPath(),
      journalPath: opts.placement?.journalPath ?? defaultFleetJournalPath(),
      headroomMinMb: opts.placement?.headroomMinMb ?? 512,
      modelFilePenaltyMb: opts.placement?.modelFilePenaltyMb ?? 128,
      ...(opts.placement?.staleCutoffMs !== undefined
        ? { staleCutoffMs: opts.placement.staleCutoffMs }
        : {}),
    });
    if (!placement.ok) return { ok: false, error: placement.error };
    manifest = placement.manifest;
  }
  if (!opts.getClient) {
    return { ok: false, error: "applyManifest requires getClient for ModelRun manifests" };
  }
  const result = await applyOne(manifest, opts.getClient, opts.onEvent, undefined, {
    ...omitUndefined({ workloadsDir: opts.workloadsDir }),
    ...omitUndefined({ env: opts.env }),
    ...omitUndefined({ getNodeBudgetGiB: opts.getNodeBudgetGiB }),
    ...(opts.resolveNodeIdentity !== undefined
      ? { resolveNodeIdentity: opts.resolveNodeIdentity }
      : {}),
  });
  if (result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: true, kind: "ModelRun", manifest, result };
}

export async function applyManifest(opts: ApplyManifestOptions): Promise<ApplyManifestOutcome> {
  const kind = manifestKind(opts.manifest);
  if (kind === "ModelRun") {
    return await applyModelRunManifest(opts);
  }
  if (kind === "ModelHost") {
    const parsed = ModelHostManifestSchema.safeParse(opts.manifest);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return await applyModelHostManifest(parsed.data, opts);
  }
  return { ok: false, error: `unsupported manifest kind: ${kind ?? "unknown"}` };
}
