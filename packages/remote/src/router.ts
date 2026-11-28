import type { ClusterNode, Config, User } from "@llamactl/core/config/schema";
import type { LocalRoute } from "@llamactl/core/workloadRuntime";

import {
  autotune as autotuneMod,
  bench,
  candidateTest as candidateMod,
  catalog,
  discovery,
  env as envMod,
  keepAlive as keepAliveMod,
  lmstudio as lmstudioMod,
  MACHINE_PROFILES,
  type MachineProfile,
  nodeFacts as nodeFactsMod,
  presets,
  pull,
  recommendations,
  rpcServer as rpcServerMod,
  SAFETY_TIERS,
  serverLogs as serverLogsMod,
  server as serverMod,
  target as targetMod,
  uninstall as uninstallMod,
  workloadRuntime as workloadRuntimeMod,
} from "@llamactl/core";
import { decodeBootstrap } from "@llamactl/core/config/agent-config";
import { nonEmpty } from "@llamactl/core/config/env";
import * as kubecfg from "@llamactl/core/config/kubeconfig";
import { ENGINES } from "@llamactl/core/engines";
import {
  modelhostPidFile,
  modelhostStateFile,
  readModelHostState,
} from "@llamactl/core/engines/state";
import { omitUndefined } from "@llamactl/core/object";
import { probeEndpointOwnership } from "@llamactl/core/probe";
import { DEFAULT_RESIDENCY_POLICY } from "@llamactl/core/residency/admission";
import {
  type LocalEngineForwarder,
  withLocalEngineBody,
} from "@llamactl/core/residency/engine-forwarder";
import {
  getResidencyLeaseRegistry,
  type ResidencyAuditEntry,
  type ResidencySnapshot,
} from "@llamactl/core/residency/leases";
import { hasManagedRuntimeMarker } from "@llamactl/core/residency/managed-runtime";
import { currentSessionRefcounts } from "@llamactl/core/residency/sessions";
import {
  type CostJournalEntry,
  decideGuardianAction,
  defaultCostGuardianConfigPath,
  defaultCostJournalPath,
  emptyCostGuardianConfig,
  loadCostGuardianConfig,
} from "@llamactl/policy";
import {
  type AiProvider,
  createOpenAICompatProvider,
  type OpenAICompatUsageObservation,
  projectUsageRecordV2ToV1,
  type UnifiedAiRequest,
  type UnifiedAiResponse,
  type UnifiedStreamEvent,
  type UsageRecordV2,
} from "@novaproto/contracts";
import {
  computeCostSnapshot,
  createLlmExecutor,
  DEFAULT_ALLOWLIST,
  type PlannerExecutor,
  type PlannerToolDescriptor,
  runPlanner,
  stubPlannerExecutor,
} from "@novaproto/mcp";
import { appendUsageBackground } from "@novaproto/mcp-shared";
import { createTRPCClient } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { CompositeApplyEvent } from "./composite/types.js";
import type { ManagedStopProof } from "./residency/admission-authority.js";
import type {
  CommitLaunchReadiness,
  ManagedApplyBudget,
  ManagedLaunchAdmission,
} from "./residency/managed-launch-admission.js";
import type { IdleProfileWindow, OwnerAdmissionPause } from "./residency/owner-activity.js";
import type { Release, RequestAdmission } from "./residency/request-admission.js";
import type { RuntimeBackend } from "./runtime/backend.js";
import type { RuntimeKind } from "./runtime/factory.js";
import type { NodeRunResidency } from "./workload/noderun-schema.js";

import * as benchScheduleMod from "./bench/schedule.js";
import * as benchScheduleLoopMod from "./bench/scheduleLoop.js";
import { type CallerSubscriptionHandlers, subscribeViaCaller } from "./client/caller-subscribe.js";
import { buildPinnedLinks } from "./client/links.js";
import { inferenceRpcRouter } from "./inference/procedures.js";
import * as infraInstallMod from "./infra/install.js";
import * as infraLayoutMod from "./infra/layout.js";
import * as infraServicesMod from "./infra/services.js";
import { readOpsChatAudit } from "./ops-chat/audit.js";
import {
  auditOpsChatToolRun,
  dispatchOpsChatTool,
  KNOWN_OPS_CHAT_TOOLS,
} from "./ops-chat/dispatch.js";
import { deleteSession } from "./ops-chat/sessions/delete.js";
import { sessionEventBus } from "./ops-chat/sessions/event-bus.js";
import { isTerminal, type JournalEvent } from "./ops-chat/sessions/journal-schema.js";
import { readJournal } from "./ops-chat/sessions/journal.js";
import { getSessionSummary, listSessions } from "./ops-chat/sessions/list.js";
import { createRagAdapter } from "./rag/index.js";
import { resolveRagNode } from "./rag/resolve.js";
import {
  applyResidencyProfile,
  cancelResidencyProfileOperation,
  type ProfileExecutionGuard,
  residencyApplyProfileRefusal,
  type ResidencyApplyProfileResult,
  type ResidencyCancelOperationResult,
} from "./residency/apply-profile.js";
import { residencyGroupLabelOf } from "./residency/coordinator.js";
import {
  type DirectLifecycleOpts,
  type DirectLifecycleOutcome,
  exclusiveGroupLaunchRefusal,
  runDirectResidencyStart,
  runDirectResidencyStop,
  runInResidencySwitchScope,
} from "./residency/direct-lifecycle.js";
import {
  type ForceUnloadKind,
  type ForceUnloadResult,
  type ForceUnloadStop,
  forceUnloadWorkload,
  releaseResidencySession,
  type ReleaseSessionResult,
} from "./residency/force-unload.js";
import {
  controlManagedResidency,
  enterManagedOperatorAction,
  RESIDENCY_CALIBRATION_KEY_TOOL,
  RESIDENCY_CONTROL_TOOL,
  residencyCalibrationKeyInput,
  residencyControlInput,
  type ResidencyControlResult,
} from "./residency/managed-operator-control.js";
import { readManagedProfileSelection } from "./residency/managed-profile-selection.js";
import { collectOmlxNativeStatus } from "./residency/omlx-capability.js";
import {
  buildIdleEvictionSnapshot,
  buildResidencyPlan,
  buildResidencyStatus,
  collectResidencyObservations,
  effectiveResidencyPolicy,
  type IdleEvictKind,
  type IdleEvictResult,
  type IdleEvictRow,
  type IdleEvictStopResult,
  mergeResidencyLeaseAudit,
  type ResidencyPlan,
  runIdleEviction,
} from "./residency/procedures.js";
import { captureProfileDesired, type ProfileDesiredSnapshot } from "./residency/profile-desired.js";
import {
  managedProfileMutationSchema,
  profileMutationSchema,
  RESIDENCY_APPLY_PROFILE_TOOL,
} from "./residency/profile-protocol.js";
import { recoverAbandonedProfileIntentsOnNode } from "./residency/recovery.js";
import { fenceWorkloadStop, reopenWorkloadAfterLoad } from "./residency/stop-fence.js";
import {
  defaultResidencyStorePath,
  readResidencyLeaseAudit,
  readResidencyStoreSnapshot,
} from "./residency/store.js";
import { readFleetSnapshotOrLocalRoutes } from "./routes/fleet.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "./safe-fs.js";
import { searchLogs } from "./search/logs.js";
import { resolveDefaultRagNode } from "./search/rag-node.js";
import { searchSessions } from "./search/sessions.js";
import { acquireChatSlot, admissionTrpcError } from "./server/chat-admission.js";
import { ownerExecutionStatus } from "./server/metrics.js";
import {
  pinModelHostStartup,
  startModelHost,
  type StartModelHostResult,
  statusModelHost,
  statusModelHostForProbe,
  stopModelHost,
  type StopModelHostResult,
} from "./server/modelhost.js";
import {
  defaultNodeBudgetGiB,
  estimateModelHostMemoryGiB,
  estimateWorkloadMemoryGiB,
} from "./workload/admission.js";
import * as workloadApplyMod from "./workload/apply.js";
import { CompositeOwnershipSchema } from "./workload/gateway-catalog/schema.js";
import { inferenceObservations } from "./workload/inference-observations.js";
import { liveLockHolder } from "./workload/lock.js";
import {
  LOCAL_NODE_ID,
  modelHostBindRefusal,
  type ModelHostManifest,
  ModelHostManifestSchema,
  ModelHostReadinessSchema,
  normalizeReadiness,
  specForEngine,
} from "./workload/modelhost-schema.js";
import * as modelHostStoreMod from "./workload/modelhost-store.js";
import * as nodeRunStoreMod from "./workload/noderun-store.js";
import * as reconcileLoopMod from "./workload/reconcileLoop.js";
import {
  type ModelRun,
  ModelRunSchema,
  ModelRunSpecSchema,
  type ModelRunStatus,
} from "./workload/schema.js";
import * as workloadStoreMod from "./workload/store.js";

// #216: when a local ModelHost is applied through the router and a live
// controller holds the workloads dir, validate + persist the manifest and
// return without spawning so the controller's reconciler starts the engine
// under its own service. Returns null when the in-process path should run
// unchanged (disabled, remote node, no controller, or same pid).
type HandoffResult = {
  action: "handed-off";
  path: string;
  controllerPid: number;
  name: string;
  node: string;
  status: {
    phase: "Pending";
    serverPid: null;
    endpoint: null;
    lastTransitionTime: string;
    conditions: {
      type: "Applied";
      status: "True";
      reason: "handed-off";
      lastTransitionTime: string;
    }[];
  };
};

function assertManagedApplyOwnsDirectory(workloadsDir: string): void {
  const owner = liveLockHolder(workloadsDir);
  if (owner === null || owner === process.pid) return;
  throw new TRPCError({
    code: "CONFLICT",
    message: "ManagedControllerActive: an independent controller owns the workload directory",
  });
}

function clientForApply(
  cfg: Config,
  managed: ManagedLaunchAdmission | undefined,
  ownsNode: boolean,
  signal?: AbortSignal,
): (nodeName: string) => WorkloadNodeClient {
  return (nodeName) =>
    ownsNode && managed?.ownsNode?.(nodeName) === true
      ? localCallerProxy(managed, signal, true)
      : clientForNode(cfg, nodeName, managed);
}

function handoffLocalModelHost(manifest: unknown, workloadsDir: string): HandoffResult | null {
  const parsed = ModelHostManifestSchema.safeParse(manifest);
  if (!parsed.success) return null;
  const m = parsed.data;
  if (m.spec.node !== LOCAL_NODE_ID || !m.spec.enabled) return null;
  const pid = liveLockHolder(workloadsDir);
  if (pid === null || pid === process.pid) return null;
  const bindRefusal = modelHostBindRefusal(m);
  if (bindRefusal) {
    throw new TRPCError({ code: "BAD_REQUEST", message: bindRefusal });
  }
  const engine = ENGINES[m.spec.engine];
  const validation = engine.validateSpec(specForEngine(m.spec));
  if (!validation.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: validation.error });
  }
  const path = modelHostStoreMod.saveModelHost(m, workloadsDir);
  const now = new Date().toISOString();
  return {
    action: "handed-off",
    path,
    controllerPid: pid,
    name: m.metadata.name,
    node: m.spec.node,
    status: {
      phase: "Pending",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [
        {
          type: "Applied",
          status: "True",
          reason: "handed-off",
          lastTransitionTime: now,
        },
      ],
    },
  };
}

const mutateConfigLocked = (path: string, fn: (cfg: Config) => Config): Config => {
  return kubecfg.mutateConfig(path, fn);
};

/**
 * Router↔client circular-type escape hatch — the `AppRouter → NodeClient
 * → AppRouter` alias is unresolvable in TypeScript, so router.ts never
 * imports `NodeClient` from `./client/node-client.js`. Instead we route
 * workload forwarding through `WorkloadClient` (defined in
 * `./workload/apply.js`), which is structurally narrower than
 * `NodeClient` and carries no AppRouter reference.
 *
 * Same pattern applies elsewhere: if a router procedure ever needs to
 * call another tRPC client (remote or caller-proxy), give it a
 * hand-rolled structural interface. Importing the typed `NodeClient`
 * is always a cycle.
 */
/**
 * Union of every structural-client shape router.ts currently needs.
 * As new in-process orchestrators arrive (bench scheduler,
 * workload reconciler, …), their narrow client interface is added
 * to this intersection — the underlying runtime (`localCallerProxy`
 * or pinned tRPC) satisfies everything structurally, so this is a
 * pure type-level accumulator.
 */
type WorkloadNodeClient = workloadApplyMod.WorkloadClient & benchScheduleLoopMod.BenchClient;

/**
 * Build a tRPC-client-shaped proxy over the invoking agent's local caller so
 * local workload ops can reuse the same `.query/.mutate/.subscribe`
 * surface as the remote tRPC client. Mirrors the proxy wrapper in
 * `client/node-client.ts` but lives here to avoid the AppRouter cycle.
 */
function localCallerProxy(
  managedLaunchAdmission?: ManagedLaunchAdmission,
  parentSignal?: AbortSignal,
  ownerStopIntent = false,
): WorkloadNodeClient {
  const ctx: AgentRouterContext = {
    ...(managedLaunchAdmission === undefined ? {} : { managedLaunchAdmission }),
    ...(ownerStopIntent ? { ownerStopIntent: true } : {}),
  };
  // Deferred reference — at runtime `router` exists by the time the
  // helper is invoked from within a procedure body, even though at
  // module-load time the declaration below is still being evaluated.
  const getCaller = (signal?: AbortSignal): Record<string, (...a: unknown[]) => unknown> => {
    const combined =
      signal !== undefined && parentSignal !== undefined
        ? AbortSignal.any([signal, parentSignal])
        : (signal ?? parentSignal);
    return router.createCaller(
      ctx,
      combined ? { signal: combined } : undefined,
    ) as unknown as Record<string, (...a: unknown[]) => unknown>;
  };
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      const invoke = (...args: unknown[]): unknown => {
        const caller = getCaller();
        const fn = caller[prop];
        if (typeof fn !== "function") throw new Error(`unknown procedure '${prop}'`);
        return fn(...args);
      };
      // An in-proc caller hands back the subscription's async iterable and
      // never calls tRPC client handlers; bridge them so apply/reconcile/bench
      // callers waiting on onData/onComplete see the stream.
      const subscribe = (
        input: unknown,
        handlers: CallerSubscriptionHandlers,
      ): { unsubscribe: () => void } => subscribeViaCaller(getCaller, prop, input, handlers);
      return { query: invoke, mutate: invoke, subscribe };
    },
  };
  return new Proxy({}, handler) as unknown as WorkloadNodeClient;
}

/**
 * Bridge a callback-driven async worker into a tRPC v11 async-generator
 * subscription. Every `emit(ev)` becomes a yielded value; the generator
 * completes when `runner` resolves and throws when it rejects. Client
 * disconnects (`clientSignal.aborted`) propagate into `runner`'s signal
 * so in-flight work cancels cleanly.
 */
async function* bridgeEventStream<T>(
  clientSignal: AbortSignal | undefined,
  runner: (emit: (evt: T) => void, signal: AbortSignal) => Promise<void>,
): AsyncGenerator<T, void, unknown> {
  const controller = new AbortController();
  const onClientAbort = (): void => {
    controller.abort();
  };
  clientSignal?.addEventListener("abort", onClientAbort);
  if (clientSignal?.aborted === true) onClientAbort();

  const queue: T[] = [];
  const state: { finished: boolean; err: Error | null } = { finished: false, err: null };
  let wake: (() => void) | null = null;
  const drain = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const run = (async (): Promise<void> => {
    try {
      await runner((ev) => {
        queue.push(ev);
        drain();
      }, controller.signal);
    } catch (e) {
      state.err = e instanceof Error ? e : new Error(String(e));
    } finally {
      state.finished = true;
      drain();
    }
  })();

  try {
    while (!state.finished || queue.length > 0) {
      if (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (state.err) throw state.err;
  } finally {
    clientSignal?.removeEventListener("abort", onClientAbort);
    controller.abort();
    await run.catch(() => undefined);
  }
}

/**
 * Default per-node deadline for the fan-out in `workloadList` (FIX [6]).
 * One black-holed or unreachable node used to hang the WHOLE list
 * response forever, because each per-node `serverStatus` query was
 * awaited with no deadline. 5s is generous for a healthy node yet
 * bounds the worst case for a dead one.
 */
const WORKLOAD_LIST_NODE_TIMEOUT_MS = 5000;

/**
 * Race a per-node `serverStatus` query against a deadline so a single
 * unreachable node cannot block the aggregate list. On timeout this
 * REJECTS (rather than resolving a sentinel) so the caller's existing
 * catch maps it to `phase: "Unreachable"` — the node is reported as
 * unreachable, never silently dropped. The losing timer is cleared on
 * the success path so it can't keep the event loop alive.
 */
export async function queryServerStatusWithTimeout<T>(
  query: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`node status query timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([query(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function clientForNode(
  cfg: Config,
  nodeName: string,
  managedLaunchAdmission?: ManagedLaunchAdmission,
): WorkloadNodeClient {
  const resolved = kubecfg.resolveNode(cfg, nodeName);
  if (resolved.node.endpoint.startsWith("inproc://")) {
    return localCallerProxy(managedLaunchAdmission);
  }
  const token = kubecfg.resolveToken(resolved.user);
  const trpc = createTRPCClient({
    links: buildPinnedLinks(resolved.node, token),
  });
  return trpc as unknown as WorkloadNodeClient;
}

/**
 * #239: the explicit NodeRun budget for a node, keyed by NodeRun metadata.name like the
 * reconciler and the CLI's nodeRunBudgetLookup. Undefined when no NodeRun has that name or
 * it sets no spec.budget, so admission keeps its own fallback.
 */
function nodeRunBudgetGiB(nodeName: string, workloadsDir: string): number | undefined {
  const nodeRuns = nodeRunStoreMod.listNodeRuns(workloadsDir);
  return nodeRuns.find((n) => n.metadata.name === nodeName)?.spec.budget?.memoryGiB;
}

/**
 * Part of #519: the NodeRun spec.residency for a node, keyed by NodeRun metadata.name.
 * Its safetyMarginRatio sizes the computed admission fallback budget. Undefined
 * when no NodeRun has that name or it sets no residency, so admission keeps its
 * own 0.75 default.
 */
function nodeRunResidency(nodeName: string, workloadsDir: string): NodeRunResidency | undefined {
  const nodeRuns = nodeRunStoreMod.listNodeRuns(workloadsDir);
  return nodeRuns.find((n) => n.metadata.name === nodeName)?.spec.residency;
}

async function applyProfileWorkload(
  node: string,
  workloadsDir: string,
  manifest: unknown,
  managed: ManagedLaunchAdmission | undefined,
  signal: AbortSignal | undefined,
): Promise<workloadApplyMod.ApplyManifestOutcome> {
  const cfg = kubecfg.loadConfig();
  const apply = async (
    owned: boolean,
    budget?: ManagedApplyBudget,
  ): Promise<workloadApplyMod.ApplyManifestOutcome> => {
    if (managed !== undefined && !owned) return { ok: false, error: "ManagedOwnerRequired" };
    return await runInResidencySwitchScope(
      async () =>
        await workloadApplyMod.applyManifest({
          manifest,
          getClient: (nodeName) =>
            nodeName === node || managed?.ownsNode?.(nodeName) === true
              ? localCallerProxy(managed, signal)
              : clientForNode(cfg, nodeName),
          getNodeBudgetGiB: (nodeName) => nodeRunBudgetGiB(nodeName, workloadsDir),
          getNodeResidency: (nodeName) => nodeRunResidency(nodeName, workloadsDir),
          ...(budget === undefined ? {} : { managedBudget: budget }),
        }),
    );
  };
  return managed?.withDesiredManifest === undefined
    ? await apply(false)
    : await managed.withDesiredManifest(manifest, apply);
}

const controlStartTerminal = z.object({
  ok: z.boolean(),
  pid: z.number().nullable(),
  error: z.string().optional(),
});

function controlFailure(error: string | undefined, fallback: string): string {
  const reason = error?.split(":", 1)[0];
  return reason !== undefined && CONTROL_OUTCOME_CODES.has(reason) ? reason : fallback;
}

const CONTROL_OUTCOME_CODES = new Set([
  "AuthorityUnavailable",
  "BudgetExceeded",
  "BudgetUnknown",
  "DrainInProgress",
  "LeasesActive",
  "SessionsActive",
  "SessionsUnknown",
  "ManagedInferenceUnresolved",
  "ManagedOwnerRequired",
  "ManagedSpecUnknown",
  "ManagedSpecChanged",
  "ManagedLaunchPending",
  "ManagedRuntimeResident",
  "ManagedReadyUnverified",
  "ManagedStopGenerationUnverified",
  "ManagedStopReleaseUnverified",
  "ManagedReplacementRequiresProfile",
  "LaunchCanceled",
  "NodeBusy",
  "TransitionUnavailable",
]);

async function controlStartOutcome(
  events: AsyncIterable<unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for await (const event of events) {
    if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "done")
      continue;
    const parsed = controlStartTerminal.safeParse("result" in event ? event.result : undefined);
    if (!parsed.success) break;
    return parsed.data.ok && parsed.data.pid !== null
      ? { ok: true }
      : { ok: false, reason: controlFailure(parsed.data.error, "LoadUnconfirmed") };
  }
  return { ok: false, reason: "LoadUnconfirmed" };
}

async function dispatchManagedControl(
  ctx: AgentRouterContext,
  signal: AbortSignal | undefined,
  action: "load" | "unload",
  manifest: ModelRun | ModelHostManifest,
  drainTimeoutMs: number | undefined,
): Promise<{ ok: true } | { ok: false; reason: string; activeCount?: number }> {
  const workload = manifest.metadata.name;
  const caller = router.createCaller(
    {
      ...ctx,
      ownerStopIntent: true,
      ...(drainTimeoutMs === undefined
        ? {}
        : { ownerStopWait: { timeoutMs: drainTimeoutMs, signal } }),
    },
    omitUndefined({ signal }),
  );
  if (action === "load") {
    const events =
      manifest.kind === "ModelHost"
        ? await caller.modelHostStart({ workload, manifest })
        : await caller.serverStart(workloadApplyMod.modelRunStartInvocation(manifest));
    return await controlStartOutcome(events);
  }
  if (manifest.kind === "ModelHost") {
    const stopped = await caller.modelHostStop({ workload });
    if (stopped.ok) return { ok: true };
    return { ok: false, reason: controlStopFailure(signal, stopped.error) };
  }
  const stopped = await caller.serverStop({ workload });
  if (stopped.stopped) return { ok: true };
  if (signal?.aborted === true) return { ok: false, reason: "ControlCanceled" };
  if (stopped.refused !== undefined) {
    return {
      ok: false,
      reason: stopped.refused.reason,
      activeCount: stopped.refused.active.length,
    };
  }
  return { ok: false, reason: controlFailure(stopped.managedRefusal, "UnloadUnconfirmed") };
}

function controlStopFailure(signal: AbortSignal | undefined, error: string | undefined): string {
  return signal?.aborted === true ? "ControlCanceled" : controlFailure(error, "UnloadUnconfirmed");
}

function profileOwner(
  node: string,
  managed: ManagedLaunchAdmission | undefined,
): ManagedLaunchAdmission | undefined {
  return managed?.ownsNode?.(node) === true ? managed : undefined;
}

function wetProfileRefusal(
  node: string,
  to: string,
  from: string | null,
  workloadsDir: string,
  managed: ManagedLaunchAdmission | undefined,
): ResidencyApplyProfileResult | undefined {
  const rawNode = process.env["LLAMACTL_NODE_NAME"]?.trim() ?? "";
  const servingNode = managed === undefined ? (rawNode === "" ? null : rawNode) : node;
  if (managed === undefined && hasManagedRuntimeMarker(envMod.resolveEnv().LOCAL_AI_RUNTIME_DIR)) {
    return residencyApplyProfileRefusal({
      reason: "ManagedOwnerRequired",
      detail: "send the profile to its owner agent",
      node,
      to,
      from,
    });
  }
  if (servingNode !== node) {
    return residencyApplyProfileRefusal({
      reason: "NotServingNode",
      detail: `node ${node} is not served by this process (serving ${String(servingNode)})`,
      node,
      to,
      from,
    });
  }
  const controllerPid = liveLockHolder(workloadsDir);
  return controllerPid === null
    ? undefined
    : residencyApplyProfileRefusal({
        reason: "ControllerActive",
        detail: `a residency controller is live on ${node} (pid ${String(controllerPid)}); persist-suppression is deferred to the controller`,
        node,
        to,
        from,
        controllerPid,
      });
}

type ProfileMutationInput = {
  node: string;
  to: string;
  from?: string | undefined;
  dryRun: boolean;
  confirm: boolean;
};

export async function runIdleProfileMutation(
  node: string,
  window: IdleProfileWindow,
  managed: ManagedLaunchAdmission,
  tryPause: () => OwnerAdmissionPause | undefined,
  trackSettlement: (settled: Promise<void>) => void,
): Promise<ResidencyApplyProfileResult> {
  const { from, to, signal } = window;
  const refuse = (reason: string, detail: string): ResidencyApplyProfileResult =>
    residencyApplyProfileRefusal({ node, from, to, reason, detail });
  if (signal.aborted) return refuse("IdleProfileCanceled", "the maintenance window ended");
  if (from.trim() === "" || to.trim() === "" || from === to) {
    return refuse("IdleProfileInvalid", "a window requires distinct source and target profiles");
  }
  const pause = tryPause();
  if (pause === undefined) return refuse("OwnerNotIdle", "no exclusive idle ingress proof");
  const actuators = new Set<Promise<unknown>>();
  let didActuate = false;
  try {
    const guard: ProfileExecutionGuard = {
      signal: AbortSignal.any([signal, pause.signal]),
      check: () =>
        signal.aborted || !pause.isCurrent() ? "IdleProfileAuthorizationLost" : undefined,
      didActuate: () => didActuate,
      trackActuator: (actuator) => {
        didActuate = true;
        actuators.add(actuator);
        const settled = (): void => {
          actuators.delete(actuator);
        };
        void actuator.then(settled, settled);
      },
    };
    return await runProfileMutation(
      { node, from, to, dryRun: false, confirm: true },
      managed,
      guard,
    );
  } finally {
    // A step deadline can return a durable unknown while its actuator is still settling.
    if (actuators.size === 0) pause.release();
    else
      trackSettlement(
        Promise.allSettled(actuators).then(() => {
          pause.release();
        }),
      );
  }
}

async function runProfileMutation(
  input: ProfileMutationInput,
  admission: ManagedLaunchAdmission | undefined,
  guard?: ProfileExecutionGuard,
): Promise<ResidencyApplyProfileResult> {
  if (!input.dryRun && !input.confirm) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "residency apply-profile: confirm: true is required when dryRun is false",
    });
  }
  const managed = profileOwner(input.node, admission);
  const node = managed?.ownerNodeId ?? input.node;
  if (guard !== undefined && managed === undefined) {
    return residencyApplyProfileRefusal({
      reason: "ManagedOwnerRequired",
      detail: "an idle switch requires its owner coordinator",
      node,
      from: input.from ?? null,
      to: input.to,
    });
  }
  if (input.dryRun || managed === undefined)
    return await applyProfileMutation(input, node, managed);

  const leave = enterManagedOperatorAction(node, "profile");
  if (leave === undefined) {
    return residencyApplyProfileRefusal({
      reason: "NodeBusy",
      detail: "a manual residency operation owns this node",
      node,
      from: input.from ?? null,
      to: input.to,
    });
  }
  try {
    return await applyProfileMutation(input, node, managed, guard);
  } finally {
    leave();
  }
}

function managedProfilePredecessor(
  storePath: string,
  node: string,
  input: ProfileMutationInput,
): { operationId: string | null } | { refusal: ResidencyApplyProfileResult } {
  const selection = readManagedProfileSelection(storePath, node);
  const refuse = (reason: string, detail: string): { refusal: ResidencyApplyProfileResult } => ({
    refusal: residencyApplyProfileRefusal({
      node,
      from: input.from ?? null,
      to: input.to,
      reason,
      detail,
      dryRun: input.dryRun,
    }),
  });

  if (selection.kind === "switching")
    return refuse("NodeBusy", "a managed profile switch is active");
  if (selection.kind === "unknown")
    return refuse("ManagedProfileUnverified", "the owner cannot verify its selected profile");
  if (
    input.from !== undefined &&
    (selection.kind !== "selected" || input.from !== selection.profile)
  )
    return refuse(
      "ProfileSelectionChanged",
      "the requested source profile is not the verified selection",
    );

  return { operationId: selection.kind === "selected" ? selection.operationId : null };
}

async function applyProfileMutation(
  input: ProfileMutationInput,
  node: string,
  managed: ManagedLaunchAdmission | undefined,
  guard?: ProfileExecutionGuard,
): Promise<ResidencyApplyProfileResult> {
  const workloadsDir = workloadStoreMod.defaultWorkloadsDir();
  const storePath = defaultResidencyStorePath();
  if (!input.dryRun) {
    const refusal = wetProfileRefusal(node, input.to, input.from ?? null, workloadsDir, managed);
    if (refusal !== undefined) return refusal;
    recoverAbandonedProfileIntentsOnNode(storePath, node);
  }
  const prior =
    managed === undefined ? undefined : managedProfilePredecessor(storePath, node, input);
  if (prior !== undefined && "refusal" in prior) return prior.refusal;
  const { plan, desired } = residencyPlanFor({ ...input, managed }, workloadsDir);
  return await applyResidencyProfile({
    plan,
    desired,
    dryRun: input.dryRun,
    storePath,
    workloadsDir,
    registry: getResidencyLeaseRegistry(),
    ...(guard === undefined ? {} : { guard }),
    node,
    to: input.to,
    from: input.from ?? null,
    ...(managed === undefined ? {} : { managedLaunchAdmission: managed }),
    ...(prior === undefined ? {} : { expectedManagedProfileOperationId: prior.operationId }),
    applyModelRun: (manifest, signal) =>
      applyProfileWorkload(node, workloadsDir, manifest, managed, signal),
  });
}

function profileManifest<T extends { spec: { node: string } }>(
  manifest: T,
  node: string,
  managed: ManagedLaunchAdmission | undefined,
): T {
  return managed?.ownsNode?.(manifest.spec.node) === true
    ? { ...manifest, spec: { ...manifest.spec, node } }
    : manifest;
}

function residencyPlanFor(
  input: {
    node: string;
    to: string;
    from?: string | undefined;
    managed?: ManagedLaunchAdmission | undefined;
  },
  workloadsDir = workloadStoreMod.defaultWorkloadsDir(),
): { plan: ResidencyPlan; desired: ProfileDesiredSnapshot } {
  const managed = profileOwner(input.node, input.managed);
  const nodeName = managed?.ownerNodeId ?? input.node;
  const nodeRuns = nodeRunStoreMod.listNodeRuns(workloadsDir);
  const node = nodeRuns.find((n) => n.metadata.name === nodeName);
  const declared = node?.spec.budget?.memoryGiB;
  const rawNodeName = process.env["LLAMACTL_NODE_NAME"]?.trim() ?? "";
  const servingNode = managed === undefined ? (rawNodeName === "" ? null : rawNodeName) : nodeName;
  const resolved = envMod.resolveEnv();
  const rawHosts = modelHostStoreMod.listModelHosts(workloadsDir);
  const rawRuns = workloadStoreMod.listWorkloads(workloadsDir);
  const modelHosts = rawHosts.map((manifest) => profileManifest(manifest, nodeName, managed));
  const observations = collectResidencyObservations({
    node: nodeName,
    servingNode,
    modelRuns: rawRuns.map((manifest) => profileManifest(manifest, nodeName, managed)),
    modelHosts,
    modelHostStatus: (name) => statusModelHost({ key: { name } }),
    observeManaged: managed?.observeProfileWorkload,
    estimateModelRunGiB: (manifest) => estimateWorkloadMemoryGiB(manifest, resolved),
    estimateModelHostGiB: (manifest) => estimateModelHostMemoryGiB(manifest, resolved),
  });
  const plan = buildResidencyPlan({
    node: nodeName,
    to: input.to,
    from: input.from ?? null,
    nowMs: Date.now(),
    servingNode,
    budgetGiB: defaultNodeBudgetGiB(declared, undefined, node?.spec.residency),
    budgetSource: typeof declared === "number" ? "noderun" : "computed",
    modelRuns: observations.modelRuns,
    modelHosts,
    observed: observations.observed,
    memoryGiB: observations.memoryGiB,
    store: readResidencyStoreSnapshot(defaultResidencyStorePath()),
    residency: node?.spec.residency ?? null,
  });
  return {
    plan,
    desired: captureProfileDesired(nodeName, node, rawRuns, rawHosts, managed?.ownsNode),
  };
}

// Resolves the direct-start/stop residency group: an inline manifest's label
// wins (it may differ from the store), else the stored ModelHost's label. A
// load failure means no group, so a deleted manifest never aborts the dep.
function directResidencyGroup(
  workload: string,
  labels: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const fromInput = labels !== undefined ? residencyGroupLabelOf(labels) : undefined;
  if (fromInput !== undefined) {
    return fromInput;
  }
  try {
    return residencyGroupLabelOf(modelHostStoreMod.loadModelHostByName(workload).metadata.labels);
  } catch {
    return undefined;
  }
}

// Resolves the direct ModelRun residency group from the stored ModelRun's
// label (the agent-side `llamactl.io/residency-group`); a load failure means
// no group, so a deleted manifest never aborts the dep.
function directModelRunGroup(workload: string): string | undefined {
  try {
    return residencyGroupLabelOf(workloadStoreMod.loadWorkloadByName(workload).metadata.labels);
  } catch {
    return undefined;
  }
}

type KeepAliveWorkloadProvenDownDeps = {
  readState?: () => ReturnType<typeof keepAliveMod.readKeepAliveState>;
  readRecord?: () => ReturnType<typeof keepAliveMod.readKeepAliveRecord>;
  isServerProvenDown?: (name: string) => boolean;
};

// Proves a crash-left keep-alive workload down (#517): a keep-alive target has
// no ModelRun or ModelHost manifest, so its identity comes from the
// keep-alive files instead. The state file must still name that target (a
// stale file left by another target proves nothing), its recorded supervisor
// pid must be absent or provably gone, and the engine must be proven down.
// Anything that throws fails closed.
export function keepAliveWorkloadProvenDown(
  model: string,
  deps: KeepAliveWorkloadProvenDownDeps = {},
): boolean {
  try {
    const readState =
      deps.readState ??
      ((): ReturnType<typeof keepAliveMod.readKeepAliveState> => keepAliveMod.readKeepAliveState());
    const readRecord =
      deps.readRecord ??
      ((): ReturnType<typeof keepAliveMod.readKeepAliveRecord> =>
        keepAliveMod.readKeepAliveRecord());
    const serverDown =
      deps.isServerProvenDown ??
      ((name: string): boolean => serverMod.isServerProvenDown({ name }));
    if (readState()?.target !== model) {
      return false;
    }
    const { pid, verdict } = readRecord();
    if (!(pid === null || verdict === "dead" || verdict === "reused")) {
      return false;
    }
    return serverDown(model);
  } catch {
    return false;
  }
}

// Identifies an unstored ModelRun (#517): a run the agent started through
// `serverStart` with no manifest in its own workloads dir (the manifest lives on
// the host that ran workloadApply/expose) still records a lifecycle row under its
// workload name, and `startServer`'s `llama-server.state` sidecar written under
// that key is what makes the name a ModelRun. A key that also carries ModelHost
// runtime files, or one the keep-alive state names, is not an unstored run —
// `keepAliveWorkloadProvenDown` owns that proof, which additionally requires the
// supervisor to be gone. A throw fails closed.
function unstoredModelRunRecorded(model: string): boolean {
  try {
    const key = { name: model };
    if (serverMod.readServerState(key) === null) return false;
    const resolved = envMod.resolveEnv();
    if (
      existsSync(modelhostPidFile(resolved, key)) ||
      existsSync(modelhostStateFile(resolved, key))
    ) {
      return false;
    }
    return keepAliveMod.readKeepAliveState()?.target !== model;
  } catch {
    return false;
  }
}

// A peer is proven down only when it is a known ModelHost whose recorded-pid
// status reads Stopped without an unresolved identity, a known ModelRun (stored,
// or unstored and identified by its server sidecar) that has no recorded pid file
// or whose recorded pid verifies `dead` or `reused` against its pid file using the
// stopServer identity check, or a crash-left keep-alive workload. A live pid, or
// an unverifiable one, fails closed. Also used by agent boot recovery for the
// orphan lifecycle sweep (Part of #517).
export function directWorkloadProvenDown(model: string): boolean {
  if (modelHostStoreMod.listModelHosts().some((host) => host.metadata.name === model)) {
    const status = statusModelHost({ key: { name: model } });
    return status.state === "Stopped" && status.identityUnknown !== true;
  }
  if (
    workloadStoreMod.listWorkloads().some((run) => run.metadata.name === model) ||
    unstoredModelRunRecorded(model)
  ) {
    return serverMod.isServerProvenDown({ name: model });
  }
  return keepAliveWorkloadProvenDown(model);
}

function directResidencyOpts(
  workload: string,
  labels: Readonly<Record<string, string>> | undefined,
): DirectLifecycleOpts {
  return {
    storePath: defaultResidencyStorePath(),
    group: directResidencyGroup(workload, labels),
    isProvenDown: directWorkloadProvenDown,
    isRunning: (model) => statusModelHost({ key: { name: model } }).state === "Running",
    log: (line): void => {
      process.stderr.write(line);
    },
  };
}

function directModelRunOpts(workload: string): DirectLifecycleOpts {
  return {
    storePath: defaultResidencyStorePath(),
    group: directModelRunGroup(workload),
    isProvenDown: directWorkloadProvenDown,
    isRunning: (model) => serverMod.readServerPid({ name: model }) !== null,
    log: (line): void => {
      process.stderr.write(line);
    },
  };
}

// The catalog residencyGroup of the rel resolveTarget returns for a ModelRun
// start's target (#517); an unresolvable target, an uncatalogued rel or a
// throwing resolver means no group, so a start never aborts on it.
function catalogTargetGroup(target: string): string | undefined {
  try {
    const rel = targetMod.resolveTarget(target);
    return rel === null ? undefined : catalog.findByRel(rel)?.residencyGroup;
  } catch {
    return undefined;
  }
}

// Start-side ModelRun opts (#517): the stored ModelRun's residency-group label
// wins, even one naming an undeclared group; an unlabelled or unstored ModelRun
// falls back to the catalog group of its start target, the order the
// admit-measure gate uses.
function directModelRunStartOpts(
  workload: string,
  target: string,
  pinnedRel?: string,
): DirectLifecycleOpts {
  const opts = directModelRunOpts(workload);
  if (opts.group !== undefined) return opts;
  return {
    ...opts,
    group:
      pinnedRel === undefined
        ? catalogTargetGroup(target)
        : catalog.findByRel(pinnedRel)?.residencyGroup,
  };
}

/**
 * Read-only exclusive-group gate for an agent-side bench launch (#517). Resolves
 * `<target>` with `resolveTarget`, reads the rel's `residencyGroup` and delegates
 * to `exclusiveGroupLaunchRefusal` with the local store, using the rel as the
 * refusal id. An unresolvable target or a rel with no catalog row returns null, so
 * the bench launches as before; a node with no store file launches as before.
 */
function benchLaunchRefusal(target: string): string | null {
  const rel = targetMod.resolveTarget(target);
  if (rel === null) return null;
  const entry = catalog.findByRel(rel);
  if (!entry) return null;
  return exclusiveGroupLaunchRefusal({
    id: rel,
    group: entry.residencyGroup,
    storePath: defaultResidencyStorePath(),
  });
}

/**
 * Read-only, unfenced pre-spawn gate for the agent keep-alive supervisor launch
 * (#517), mirroring the CLI's `keepAliveLaunchRefusal` (#813). Resolves
 * `<target>` with `resolveTarget`, reads the rel's `residencyGroup` and delegates
 * to `exclusiveGroupLaunchRefusal` with the local store, using the rel as the
 * refusal id and `ignoreModel: target`, because the worker records its row under
 * that target and the fenced start that follows adopts or walks it. Callers run
 * this after their duplicate-supervisor checks, so ignoring that row never hides
 * a live supervisor. An unresolvable target, an uncatalogued rel, or a missing
 * store file returns null, so the supervisor spawns as before.
 */
function keepAliveStartRefusal(target: string): string | null {
  const rel = targetMod.resolveTarget(target);
  if (rel === null) return null;
  const entry = catalog.findByRel(rel);
  if (!entry) return null;
  return exclusiveGroupLaunchRefusal({
    id: rel,
    group: entry.residencyGroup,
    storePath: defaultResidencyStorePath(),
    ignoreModel: target,
  });
}

// The fenced ModelRun/ModelHost stop the idle-evict mutation drives (#519): a
// verified stop commits the unload, an active lease or session refuses before any
// process is touched. It mirrors the fence the serverStop/modelHostStop operator
// procedures run (the lifecycle walk plus lease drain) so an eviction cannot drift
// from an operator stop; those procedures keep their own inline call sites because
// the #741 lifecycle contract pins them.
async function fencedModelRunStop(workload: string): Promise<serverMod.StopServerResult> {
  return await fenceWorkloadStop<serverMod.StopServerResult>({
    workload,
    stop: async () => {
      const outcome = await runDirectResidencyStop<{
        ok: boolean;
        error?: string;
        stop: serverMod.StopServerResult;
      }>(
        workload,
        async () => {
          const stop = await serverMod.stopServer({ key: { name: workload } });
          return {
            ok: stop.stopped,
            ...(stop.stopped ? {} : { error: "stop did not confirm process removal" }),
            stop,
          };
        },
        directModelRunOpts(workload),
      );
      return outcome.ran ? outcome.result.stop : { stopped: false, pid: null, killed: false };
    },
    isVerifiedStop: (r) => r.stopped,
    refuse: (refused) => ({ stopped: false, pid: null, killed: false, refused }),
  });
}

async function fencedModelHostStop(workload: string): Promise<StopModelHostResult> {
  return await fenceWorkloadStop<StopModelHostResult>({
    workload,
    stop: async () => {
      const outcome = await runDirectResidencyStop<StopModelHostResult>(
        workload,
        () => stopModelHost({ key: { name: workload } }),
        directResidencyOpts(workload, undefined),
      );
      return outcome.ran ? outcome.result : { ok: false, pid: null, error: outcome.detail };
    },
    isVerifiedStop: (r) => r.ok,
    refuse: (f) => ({ ok: false, pid: null, error: `${f.reason}: ${f.active.join(", ")}` }),
  });
}

// Projects a fenced stop result into the idle-evict `stop` closure contract
// (#519): the refused fence detail becomes the StopRefused reason so the operator
// row carries why the stop was refused (e.g. "SessionsActive: s1").
function modelRunStopOutcome(result: serverMod.StopServerResult): IdleEvictStopResult {
  if (result.stopped) {
    return { stopped: true };
  }
  const refused = result.refused;
  if (refused !== undefined) {
    return { stopped: false, detail: `${refused.reason}: ${refused.active.join(", ")}` };
  }
  return { stopped: false, detail: "stop did not confirm process removal" };
}

function modelHostStopOutcome(result: StopModelHostResult): IdleEvictStopResult {
  return result.ok
    ? { stopped: true }
    : { stopped: false, ...(result.error !== undefined ? { detail: result.error } : {}) };
}

// The lease probe the idle-evict snapshot and pre-stop re-check read (#519). It
// carries `audit` only so buildIdleEvictionSnapshot's registry type is satisfied;
// neither the snapshot builder nor runIdleEviction calls it. A null registry is
// passed through so the section reports the eviction cannot confirm idle.
type IdleEvictLeaseProbe = Pick<
  NonNullable<ReturnType<typeof getResidencyLeaseRegistry>>,
  "snapshot" | "lastActivityAtMs" | "audit"
>;

function idleEvictLeaseProbe(): IdleEvictLeaseProbe | null {
  const registry = getResidencyLeaseRegistry();
  if (registry === null) {
    return null;
  }
  const activityRead = registry.lastActivityAtMs;
  return {
    snapshot: (workload: string) => registry.snapshot(workload),
    audit: () => registry.audit(),
    ...(activityRead !== undefined
      ? { lastActivityAtMs: (workload: string): number => activityRead.call(registry, workload) }
      : {}),
  };
}

async function evictIdleStop(workload: string, kind: IdleEvictKind): Promise<IdleEvictStopResult> {
  return kind === "modelhost"
    ? modelHostStopOutcome(await fencedModelHostStop(workload))
    : modelRunStopOutcome(await fencedModelRunStop(workload));
}

function idleEvictKindMap(): Map<string, IdleEvictKind> {
  const kinds = new Map<string, IdleEvictKind>();
  for (const host of modelHostStoreMod.listModelHosts()) {
    kinds.set(host.metadata.name, "modelhost");
  }
  for (const run of workloadStoreMod.listWorkloads()) {
    kinds.set(run.metadata.name, "modelrun");
  }
  return kinds;
}

// A dry run reports would-evict rows without a kind (the snapshot has none); the
// operator output labels them, so the kind is attached from the node manifests.
function attachIdleEvictKind(row: IdleEvictRow, kinds: Map<string, IdleEvictKind>): IdleEvictRow {
  const kind = kinds.get(row.workload);
  return kind === undefined ? row : { ...row, kind };
}

type ServerStartInput = z.infer<typeof ServerStartInputSchema>;

// Builds the optional endpoint override field by field (exactOptionalProperty-
// Types): only host/port that the caller actually set are present, matching the
// shape startServer expects at the live serverStart call.
function serverStartEndpointOverride(
  endpoint: ServerStartInput["endpoint"],
): { host?: string; port?: number } | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  return {
    ...(endpoint.host !== undefined ? { host: endpoint.host } : {}),
    ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
  };
}

export function serverStartOptions(
  input: ServerStartInput,
  sig?: AbortSignal,
  emit?: (e: serverMod.ServerEvent) => void,
): serverMod.StartServerOptions {
  const readiness = normalizeReadiness(input.readiness);
  const endpointOverride = serverStartEndpointOverride(input.endpoint);
  return {
    key: { name: input.workload },
    target: input.target,
    ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}),
    ...(input.allowExternalBind !== undefined
      ? { allowExternalBind: input.allowExternalBind }
      : {}),
    ...(endpointOverride !== undefined ? { endpoint: endpointOverride } : {}),
    ...(input.binary !== undefined ? { binary: input.binary } : {}),
    ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    ...(input.skipTuned !== undefined ? { skipTuned: input.skipTuned } : {}),
    ...(input.restart !== undefined ? { restart: input.restart } : {}),
    ...(readiness !== undefined ? { readiness } : {}),
    ...(sig === undefined ? {} : { signal: sig }),
    ...(emit === undefined ? {} : { onEvent: emit }),
  };
}

export async function runModelRunStart(
  input: ServerStartInput,
  signal: AbortSignal,
  emit: (event: serverMod.ServerEvent) => void,
  managed: ManagedLaunchAdmission | undefined,
  cold?: { effectiveSpecDigest: string; stillCurrent: () => boolean },
): Promise<DirectLifecycleOutcome<serverMod.StartServerResult>> {
  const opts = serverStartOptions(input, signal, (event) => {
    if (managed === undefined || event.type !== "ready") emit(event);
  });
  if (managed === undefined) {
    if (cold !== undefined) return { ran: false, detail: "ManagedOwnerRequired" };
    return await runDirectResidencyStart(
      input.workload,
      () => serverMod.startServer(opts),
      directModelRunStartOpts(input.workload, input.target),
    );
  }
  if (signal.aborted) return { ran: false, detail: "LaunchCanceled" };
  if (input.restart === true) return { ran: false, detail: "ManagedRestartUnavailable" };
  const prepared = serverMod.prepareManagedServerStart(opts);
  if ("result" in prepared) return { ran: true, result: prepared.result };
  if (cold !== undefined && prepared.effectiveSpecDigest !== cold.effectiveSpecDigest) {
    return { ran: false, detail: "ColdPlanChanged" };
  }
  const lifecycle = directModelRunStartOpts(input.workload, input.target, prepared.launch.rel);
  const request = {
    kind: "ModelRun" as const,
    runtimeKey: input.workload,
    launch: input,
    effectiveLaunch: prepared.launch,
    effectiveSpecDigest: prepared.effectiveSpecDigest,
  };
  return await managed.run(request, signal, (commitReadiness, checkSpawn) => {
    const detail = prepared.artifactRefusal();
    return detail === undefined
      ? runDirectResidencyStart(
          input.workload,
          () =>
            (cold?.stillCurrent() ?? true)
              ? prepared.start(commitReadiness, () => {
                  if (signal.aborted) return "LaunchCanceled";
                  if (cold !== undefined && !cold.stillCurrent()) return "ColdPlanChanged";
                  return checkSpawn?.();
                })
              : Promise.resolve(serverStartRefusal(input, "ColdPlanChanged")),
          lifecycle,
        )
      : Promise.resolve({ ran: false, detail });
  });
}

// A lifecycle refusal never ran the engine, so the done event still carries a
// full StartServerResult shape: ok false, null pid, the env-derived endpoints
// (honouring the endpoint override), no tuned profile, no retry, and the
// refusal detail as the error.
function serverStartRefusal(input: ServerStartInput, detail: string): serverMod.StartServerResult {
  const override = serverStartEndpointOverride(input.endpoint);
  return {
    ok: false,
    pid: null,
    endpoint: serverMod.endpoint(envMod.resolveEnv(), override),
    advertisedEndpoint: serverMod.advertisedEndpoint(envMod.resolveEnv(), override),
    tunedProfile: null,
    retried: false,
    error: detail,
  };
}

function runOwnedStop<T>(managed: ManagedLaunchAdmission | undefined, run: () => T): T {
  return managed?.runOwnedLifecycle === undefined ? run() : managed.runOwnedLifecycle(run);
}

function managedLocalRuntime(): boolean {
  return hasManagedRuntimeMarker(envMod.resolveEnv().LOCAL_AI_RUNTIME_DIR);
}

function refuseLegacyManagedMutation(reason: string): void {
  if (managedLocalRuntime()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: reason });
}

function stopReleased(proof: ManagedStopProof | undefined, pid: number | null): boolean {
  return proof === undefined || (pid !== null && proof.release(pid).kind === "released");
}

function stopTransitionRefusal(detail: string): serverMod.StopServerResult {
  const base = { stopped: false, pid: null, killed: false };
  return detail === "TransitionUnavailable" || detail === "NodeBusy"
    ? { ...base, managedRefusal: detail }
    : base;
}

type ServerStopRefusalShape = { reason?: unknown; active?: unknown };
type ServerStopDeleteOutcome = {
  stopped?: unknown;
  refused?: ServerStopRefusalShape | null;
};

function serverStopDeleteRefusal(node: string, refused: ServerStopRefusalShape): string {
  const active = Array.isArray(refused.active) ? refused.active.join(", ") : "";
  return `serverStop on ${node} refused (${String(refused.reason)}: ${active}); manifest preserved`;
}

async function stopRunWorkersForDelete(
  cfg: Config,
  workers: ModelRun["spec"]["workers"],
  stops: string[],
): Promise<void> {
  for (const worker of [...workers].reverse()) {
    try {
      const wc = clientForNode(cfg, worker.node);
      await wc.rpcServerStop.mutate({ graceSeconds: 3 });
      stops.push(`stopped rpc-server on ${worker.node}`);
    } catch (err) {
      stops.push(`warning: worker ${worker.node}: ${(err as Error).message}`);
    }
  }
}

/**
 * Stop a ModelRun's server + workers before workloadDelete. Returns a refusal
 * message when the coordinator's serverStop reports `stopped: false` — the
 * remote could not prove the recorded pid's identity (or the residency lease
 * fence refused, #278), and deleting the manifest would orphan a possibly-live
 * process nobody could find later.
 */
async function stopWorkloadForDelete(manifest: ModelRun, stops: string[]): Promise<string | null> {
  const cfg = kubecfg.loadConfig();
  try {
    const client = clientForNode(cfg, manifest.spec.node);
    const status = await queryServerStatusWithTimeout(
      () => client.serverStatus.query({ workload: manifest.metadata.name }),
      WORKLOAD_LIST_NODE_TIMEOUT_MS,
    );
    if (status.state === "up" && status.rel === manifest.spec.target.value) {
      const stopOutcome = (await client.serverStop.mutate({
        workload: manifest.metadata.name,
        graceSeconds: 5,
      })) as ServerStopDeleteOutcome | null;
      if (stopOutcome !== null && stopOutcome.stopped === false) {
        if (typeof stopOutcome.refused === "object" && stopOutcome.refused !== null) {
          return serverStopDeleteRefusal(manifest.spec.node, stopOutcome.refused);
        }
        return `serverStop on ${manifest.spec.node} refused (pid identity unverifiable); manifest preserved`;
      }
      stops.push(`stopped llama-server on ${manifest.spec.node}`);
    }
  } catch (err) {
    stops.push(`warning: coordinator ${manifest.spec.node}: ${(err as Error).message}`);
  }
  await stopRunWorkersForDelete(cfg, manifest.spec.workers, stops);
  return null;
}

/**
 * Stop a ModelHost before workloadDelete and drop its local runtime dir, as
 * `llamactl delete workload` does. Returns a refusal message when the node
 * reports `ok: false` — it could not prove the recorded pid's identity, so
 * deleting the manifest and runtime state would orphan the host.
 */
async function stopModelHostForDelete(
  manifest: ModelHostManifest,
  stops: string[],
): Promise<string | null> {
  try {
    const client = clientForNode(kubecfg.loadConfig(), manifest.spec.node);
    const outcome = (await client.modelHostStop.mutate({
      workload: manifest.metadata.name,
    })) as { ok?: unknown; error?: unknown } | null;
    if (outcome !== null && outcome.ok === false) {
      const reason = typeof outcome.error === "string" ? outcome.error : "stop refused";
      return `modelHostStop on ${manifest.spec.node} refused (${reason}); manifest and runtime state preserved`;
    }
    stops.push(`stopped modelhost on ${manifest.spec.node}`);
  } catch (err) {
    stops.push(`warning: node ${manifest.spec.node}: ${(err as Error).message}`);
  }
  rmSync(
    workloadRuntimeMod.workloadRuntimeDir(envMod.resolveEnv(), { name: manifest.metadata.name }),
    { recursive: true, force: true },
  );
  return null;
}

/**
 * Resolve the planner's LLM provider from a fleet node. Mirrors the
 * chatStream path: inproc→local llama-server, everything else goes
 * through `providerForNode` (which handles agent/gateway/cloud).
 */
async function resolvePlannerProvider(nodeId: string): Promise<AiProvider> {
  const cfg = kubecfg.loadConfig();
  const resolved = kubecfg.resolveNode(cfg, nodeId);
  if (resolved.node.endpoint === "inproc://local") {
    const { env: envMod } = await import("@llamactl/core");
    const rEnv = envMod.resolveEnv();
    return createOpenAICompatProvider({
      name: "local",
      baseUrl: `http://${rEnv.LLAMA_CPP_HOST}:${rEnv.LLAMA_CPP_PORT}/v1`,
      apiKey: "local",
    });
  }
  const { providerForNode } = await import("./providers/factory.js");
  return providerForNode({ node: resolved.node, user: resolved.user, cfg });
}

/**
 * Resolve `nodeName` from kubeconfig and assert it carries a RAG
 * binding. Throws `TRPCError('BAD_REQUEST')` when the node isn't a
 * RAG node — every ragX procedure uses this up-front so callers get
 * a predictable error shape instead of an adapter-layer exception.
 */

/**
 * Lazy-initialized runtime backends shared by every composite
 * procedure, cached per-kind so a mixed fleet (one composite on
 * docker, another on kubernetes) doesn't pay the construction cost
 * twice. Instantiation is deferred until first use so
 * `router.ts`-at-load-time never fails on hosts without a working
 * daemon / kubeconfig — the first `compositeApply` /
 * `compositeDestroy` call for a given kind is what triggers the
 * backend's construction.
 *
 * Kind resolution precedence (highest wins):
 *   1. `manifest.spec.runtime` — operator-declared per composite.
 *   2. `LLAMACTL_RUNTIME_BACKEND` env var — host-level fallback.
 *   3. `'docker'` — v1 default (every operator has a Docker socket).
 *
 * Tests that need to inject a fake backend go through `composite-
 * apply.test.ts` (which calls `applyComposite` directly with a
 * synthetic `RuntimeBackend`). The router-level tests stay on the
 * dry-run path so they never touch this helper.
 */
const _compositeRuntimes = new Map<RuntimeKind, RuntimeBackend>();

function resolveCompositeRuntimeKind(requested?: RuntimeKind): RuntimeKind {
  if (requested) return requested;
  const envHint = process.env["LLAMACTL_RUNTIME_BACKEND"]?.trim();
  if (envHint === "kubernetes") return "kubernetes";
  if (envHint === "docker") return "docker";
  return "docker";
}

async function getCompositeRuntime(kind: RuntimeKind = "docker"): Promise<RuntimeBackend> {
  const cached = _compositeRuntimes.get(kind);
  if (cached) return cached;
  const { createRuntimeBackend } = await import("./runtime/factory.js");
  const backend = createRuntimeBackend({ kind });
  _compositeRuntimes.set(kind, backend);
  return backend;
}

/**
 * #519 review seam for the compositeApply wet run: a router-level test needs a
 * controlled composite runtime and node client (nodeFacts memory is what sizes
 * the residency budget) to assert NodeRun budget/residency admission without a
 * Docker daemon or a live agent. `null` is the production default, so the wet
 * block resolves to `getCompositeRuntime` / `clientForNode` verbatim unless a
 * test installs overrides.
 */
type CompositeApplyTargets = {
  runtime?: RuntimeBackend;
  workloadClient?: (nodeName: string) => workloadApplyMod.WorkloadClient;
};
let _compositeApplyTargets: CompositeApplyTargets | null = null;

export function __setCompositeApplyTargetsForTests(targets: CompositeApplyTargets | null): void {
  _compositeApplyTargets = targets;
}

async function compositeRuntimeForApply(kind: RuntimeKind): Promise<RuntimeBackend> {
  const override = _compositeApplyTargets?.runtime;
  if (override !== undefined) return override;
  return await getCompositeRuntime(kind);
}

function compositeWorkloadClientForApply(): (nodeName: string) => workloadApplyMod.WorkloadClient {
  const override = _compositeApplyTargets?.workloadClient;
  if (override !== undefined) return override;
  return (nodeName) => clientForNode(kubecfg.loadConfig(), nodeName);
}

/**
 * Planner tool descriptors the server always advertises, regardless of
 * what the caller (UI, CLI, MCP client) supplies via `input.tools`.
 * These are tools whose "reach" spans multiple individual procedures —
 * the LLM planner needs to know about them up-front so it can emit a
 * single-step plan that replaces a multi-step decomposition.
 *
 * Phase 6 scope: `llamactl.composite.apply`. A Composite manifest
 * bundles services, workloads, RAG nodes, and gateway registrations
 * into one atomic unit with an internal dependency DAG — the LLM
 * reaches for this when the operator describes a stack rather than a
 * single component. Dispatch routing is Phase 5's responsibility in
 * `ops-chat/dispatch.ts`; this registration layer never executes the
 * tool, only teaches the planner it exists.
 */
export const BUILT_IN_PLANNER_TOOLS: readonly PlannerToolDescriptor[] = [
  {
    name: "llamactl.composite.apply",
    description:
      'Apply a Composite manifest that declares a full stack in one atomic unit — models + gateways + RAG nodes + supporting services (chroma, pgvector, and future database/nginx/redis backends) — with a dependency DAG and rollback on failure. PREFER this tool over multiple individual tool calls (llamactl.workload.apply + llamactl.rag.store + supporting-service setup) when the operator describes a multi-component setup (three or more interacting pieces). The manifest is a YAML string; the applier topologically orders components, spawns containers via Docker for runtime:"docker" services (external-runtime services are assumed up), wires RAG node endpoints from backing services, and registers everything atomically. For single-model or single-service asks, prefer the narrower individual tool instead.',
    inputSchema: {
      type: "object",
      required: ["manifestYaml"],
      properties: {
        manifestYaml: {
          type: "string",
          minLength: 1,
          description:
            "The full Composite YAML manifest (apiVersion: llamactl/v1, kind: Composite). Includes services, workloads, ragNodes, gateways, and optional dependencies edges inside `spec`.",
        },
        dryRun: {
          type: "boolean",
          default: false,
          description:
            "When true, return the would-apply plan + topological order without hitting the backend. Use this on the first emission of the step so the operator can review the DAG before wet-run.",
        },
      },
    },
    tier: "mutation-dry-run-safe",
  },
  {
    name: "llamactl.workload.apply",
    description:
      "Apply a single ModelRun or ModelHost manifest (YAML) to its target node — validate, run admission, place + start the server, and persist the manifest. This is the narrow single-workload tool the composite.apply guidance points to: prefer it for single-model or single-service asks instead of wrapping one model in a Composite. `dryRun` validates and reports the parsed kind/name/node without applying.",
    inputSchema: {
      type: "object",
      required: ["yaml"],
      properties: {
        yaml: {
          type: "string",
          minLength: 1,
          description:
            "The full ModelRun or ModelHost YAML manifest (apiVersion: llamactl/v1). Includes spec.node + spec.target.",
        },
        dryRun: {
          type: "boolean",
          default: false,
          description:
            "When true, validate the manifest and report kind/name/node without applying. Use on first emission so the operator can review before wet-run.",
        },
      },
    },
    tier: "mutation-dry-run-safe",
  },
];

/**
 * Merge caller-supplied planner tools with the server-side built-ins.
 * Caller entries take precedence on name collision so an explicit
 * override from the UI keeps working if we ever need to redefine a
 * built-in description at call site. Built-ins not present in the
 * caller list are appended at the end so they appear last in the
 * prompt's AVAILABLE TOOLS block — the LLM still sees them, but
 * caller-supplied tools keep their prompt ordering.
 */
export function mergePlannerTools(
  callerTools: PlannerToolDescriptor[],
  builtins: readonly PlannerToolDescriptor[],
): PlannerToolDescriptor[] {
  const seen = new Set(callerTools.map((t) => t.name));
  const out: PlannerToolDescriptor[] = [...callerTools];
  for (const t of builtins) {
    if (seen.has(t.name)) continue;
    out.push(t);
    seen.add(t.name);
  }
  return out;
}

type PullStreamEvent =
  | pull.PullEvent
  | { type: "done"; result: pull.PullFileResult }
  | { type: "done-candidate"; result: pull.PullCandidateResult };

type BenchStreamEvent =
  | bench.BenchEvent
  | { type: "done-preset"; result: bench.BenchPresetResult }
  | { type: "done-vision"; result: bench.BenchVisionResult };

type ServerStartEvent =
  | serverMod.ServerEvent
  | { type: "done"; result: serverMod.StartServerResult };

type CandidateStreamEvent =
  | candidateMod.CandidateTestEvent
  | { type: "done-candidate-test"; result: candidateMod.CandidateTestResult };

// Plain JSON serialisation — the core read surface returns POJOs only
// (strings, numbers, arrays, nested objects). We'd swap in superjson if
// we started returning Date/Map/Set, but electron-trpc v0.7 doesn't pass
// a transformer through ipcLink, so this keeps the pipeline uncomplicated.
export interface AgentRouterContext {
  fleetJournalPath?: string;
  /** #306: route source override for the fleetSnapshot local-routes fallback, like fleetJournalPath. Production leaves it unset. */
  fleetLocalRoutes?: () => LocalRoute[];
  /** #521: runner for kind:"suite" bench schedules — the CLI injects a
   *  runPerfSuite bridge; the agent server leaves it unset so suite
   *  schedules record "no suite runner configured". */
  benchSuiteRunner?: benchScheduleLoopMod.BenchSuiteRunner;
  /** #281 DF-08: the shared chat admission the local chatComplete/chatStream
   *  branches count against. Set only by the agent's requestContext (reached
   *  over /trpc and the tunnel); in-process callers such as the RAG via-forward
   *  pass none because they already hold the outer HTTP slot. */
  chatAdmission?: RequestAdmission;
  managedLaunchAdmission?: ManagedLaunchAdmission;
  ownerStopIntent?: true;
  ownerStopWait?: { timeoutMs: number; signal: AbortSignal | undefined };
}

const t = initTRPC.context<AgentRouterContext>().create();

// Path-safe identifier for infra `pkg` and `version` inputs. These
// values flow into filesystem joins (mkdir, symlink, rmSync) inside
// the local infra directory; any caller-controlled traversal must be
// refused at the schema boundary. The character class forbids slashes
// and backslashes (so '..' followed by a separator can't appear), and
// the refine step rejects the literal '.' / '..' / '~' which are the
// only single-token escape values still permitted by the regex.
const infraIdentifier = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.+-]+$/, "must match /^[A-Za-z0-9_.+-]+$/")
  .refine((s) => s !== "." && s !== ".." && s !== "~", "reserved name");

const modelHostStatusInput = z.object({
  workload: ModelHostManifestSchema.shape.metadata.shape.name,
  includeListener: z.boolean().optional(),
  probeOrigin: z.url().max(2048).optional(),
});
const modelHostStopInput = z.object({
  workload: z.string().min(1),
  graceSeconds: z.number().int().positive().max(60).optional(),
});
const modelHostStartInput = z.object({
  workload: z.string().min(1),
  timeoutSeconds: z.number().int().positive().max(600).optional(),
  manifest: ModelHostManifestSchema.optional(),
  restart: z.boolean().optional(),
});

/**
 * Reach a remote agent's /trpc/nodeFacts endpoint using a pinned TLS
 * cert and bearer token, returning the parsed facts. Inlined here so
 * router.ts doesn't pull createRemoteNodeClient from ./client/ (that
 * module imports AppRouter, which depends on router.ts — TypeScript
 * refuses to resolve the circular alias).
 */
async function probeNodeFacts(opts: {
  url: string;
  token: string;
  certificate: string | null;
  certificateFingerprint: string | null;
  tlsServerName?: string;
}): Promise<nodeFactsMod.NodeFacts> {
  const { fingerprintsEqual, computeFingerprint } = await import("./server/tls.js");
  if (opts.certificate && opts.certificateFingerprint) {
    const actual = computeFingerprint(opts.certificate);
    if (!fingerprintsEqual(actual, opts.certificateFingerprint)) {
      throw new Error(
        `certificate fingerprint mismatch: expected ${opts.certificateFingerprint}, got ${actual}`,
      );
    }
  }
  const ca = opts.certificate;
  const res = await fetch(
    `${opts.url}/trpc/nodeFacts?input=${encodeURIComponent(JSON.stringify({}))}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${opts.token}` },
      ...(ca ? ({ tls: { ca, serverName: opts.tlsServerName } } as Record<string, unknown>) : {}),
    },
  );
  if (!res.ok) {
    throw new Error(
      `probe HTTP ${String(res.status)}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
    );
  }
  // tRPC v11 GET-procedure responses wrap the payload as { result: { data: ... } }.
  const body = (await res.json()) as { result?: { data?: nodeFactsMod.NodeFacts } };
  if (!body.result?.data) {
    throw new Error("probe response missing result.data");
  }
  return body.result.data;
}

type NodeTestResult =
  | { ok: true; facts: nodeFactsMod.NodeFacts | null }
  | { ok: false; error: string };

/**
 * For provider-kind nodes, confirm the upstream actually carries that
 * provider's models — a gateway reporting healthy doesn't prove the
 * specific provider is alive. Returns a failure result when the model
 * catalog lacks the provider, or null when the probe should pass.
 */
async function verifyProviderModelPresence(
  provider: AiProvider,
  node: ClusterNode,
): Promise<NodeTestResult | null> {
  if (!provider.listModels) return null;
  try {
    const models = await provider.listModels();
    const binding = node.provider;
    if (!binding) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `provider node '${node.name}' missing provider binding`,
      });
    }
    const hit = models.some((m) => m.owned_by === binding.providerName);
    if (!hit) {
      return {
        ok: false,
        error: `provider '${binding.providerName}' not present in gateway's model catalog`,
      };
    }
  } catch {
    // If listModels fails, fall back to the gateway's
    // health. Not ideal but not worth failing the probe.
  }
  return null;
}

/**
 * Gateway + provider kinds don't have nodeFacts (no llamactl agent
 * behind them). Probe via the OpenAI-compat adapter's healthCheck —
 * cheap `/v1/models` call that confirms the upstream answers and, for
 * provider kind, that at least one model claims `owned_by === providerName`.
 */
async function probeGatewayNodeHealth(opts: {
  node: ClusterNode;
  user: User;
  cfg: Config;
  kind: "gateway" | "provider";
}): Promise<NodeTestResult> {
  const { providerForNode } = await import("./providers/factory.js");
  try {
    const provider = providerForNode({ node: opts.node, user: opts.user, cfg: opts.cfg });
    const health = await provider.healthCheck?.();
    if (!health) return { ok: true, facts: null };
    if (health.state !== "healthy" && health.state !== "degraded") {
      return { ok: false, error: health.error ?? `state=${health.state}` };
    }
    if (opts.kind === "provider") {
      const missing = await verifyProviderModelPresence(provider, opts.node);
      if (missing) return missing;
    }
    return { ok: true, facts: null };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Extract the assistant text from a non-streaming response choice —
 * the content union flattens to the displayable string (text blocks
 * concatenated, non-text dropped) for the single synthetic chunk a
 * non-streaming provider produces.
 */
function responseContentText(
  content: UnifiedAiResponse["choices"][number]["message"]["content"] | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("");
}

/**
 * Drive a provider's streamResponse, yielding each event until the
 * stream ends or the signal aborts. Providers without a streaming
 * method fall back to `createResponse`: the response's real content
 * goes out as one synthetic chunk, then a `done` marked
 * `completion: 'upstream'` — never a content-less done that would
 * read as a completed-but-empty stream.
 */
async function* streamNodeChatEvents(
  provider: AiProvider,
  request: UnifiedAiRequest,
  signal: AbortSignal | undefined,
): AsyncGenerator<UnifiedStreamEvent> {
  const stream = provider.streamResponse?.(request, signal);
  if (!stream) {
    const response = await provider.createResponse(request, {
      ...(signal !== undefined ? { signal } : {}),
    });
    const choice = response.choices[0];
    yield {
      type: "chunk",
      chunk: {
        id: response.id,
        object: "chat.completion.chunk",
        model: response.model,
        created: response.created,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: responseContentText(choice?.message.content),
            },
            finish_reason: choice?.finish_reason ?? null,
          },
        ],
      },
    };
    yield {
      type: "done",
      finish_reason: choice?.finish_reason ?? "stop",
      completion: "upstream",
    };
    return;
  }
  for await (const ev of stream) {
    if (signal?.aborted) break;
    yield ev;
  }
}

function localChatEngineFetch(forward: LocalEngineForwarder, timeoutMs: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method !== "POST") return fetch(input, init);
    const target = input instanceof Request ? input.url : String(input);
    const admitted = forward({
      target,
      body: typeof init.body === "string" ? init.body : null,
      clientSignal: init.signal ?? new AbortController().signal,
      deadlineMs: Date.now() + timeoutMs,
      principal: { bearer: null },
      send: (signal, body, transport = fetch) => {
        const engine = {
          ...withLocalEngineBody(init, body),
          signal,
          redirect: "error" as const,
          timeout: false,
        };
        return transport(input, engine);
      },
    });
    return admitted ?? fetch(input, init);
  }) as typeof fetch;
}

/**
 * Drive the local inproc://local chat stream: the OpenAI-compat adapter
 * pointed at the in-process llama-server's HTTP endpoint, with usage
 * recorded under the "local" pricing key.
 */
async function* localNodeChatEvents(
  request: UnifiedAiRequest,
  usageRoute: string | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<UnifiedStreamEvent> {
  const { env: envMod, openaiProxy } = await import("@llamactl/core");
  const { createOpenAICompatProvider } = await import("@novaproto/contracts");
  const rEnv = envMod.resolveEnv();
  const { getLocalEngineForwarder } = await import("@llamactl/core/residency/engine-forwarder");
  const forward = getLocalEngineForwarder();
  const provider = createOpenAICompatProvider({
    ...(forward === undefined
      ? {}
      : {
          fetch: localChatEngineFetch(
            (dispatch) =>
              forward({
                ...dispatch,
                ...openaiProxy.bindLocalEngineWorkload(dispatch.target, rEnv),
              }),
            openaiProxy.upstreamTimeoutMs(),
          ),
        }),
    name: "local",
    baseUrl: `http://${rEnv.LLAMA_CPP_HOST}:${rEnv.LLAMA_CPP_PORT}/v1`,
    apiKey: "local",
    onUsageObservation: (snapshot) => {
      recordChatUsageObservation(snapshot, "local", usageRoute);
    },
  });
  yield* streamNodeChatEvents(provider, request, signal);
}

/**
 * #281 DF-08: the admitted chatComplete path for the inproc://local
 * branch. The slot spans dispatch through body consumption; a non-ok
 * upstream body is cancelled so nothing streams after the throw, and a
 * forward that rejects still releases exactly once through the finally.
 */
async function admittedLocalChatComplete(
  admission: RequestAdmission,
  body: string,
  signal: AbortSignal | undefined,
  usageRoute: string | undefined,
): Promise<UnifiedAiResponse> {
  const { dispatchProxyRequest } = await import("./proxy/create-proxy.js");
  let release: Release;
  try {
    release = await acquireChatSlot(admission, {
      bytes: Buffer.byteLength(body),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    throw admissionTrpcError(err);
  }
  try {
    const res = await dispatchProxyRequest(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `local chat ${String(res.status)}`,
      });
    }
    const response = (await res.json()) as UnifiedAiResponse;
    recordChatUsage(response, "local", usageRoute);
    return response;
  } finally {
    release();
  }
}

/**
 * Stable identity key for a journal event, used to dedup a journal
 * replay against bus events buffered across the read-then-subscribe gap
 * (FIX [5]). Every event is `appendJournalEvent`-ed (JSON.stringify'd,
 * Zod-reparsed) AND `publish`-ed from the same source object, so an
 * event can legitimately appear in both the journal snapshot and the
 * buffer. A key over the event's own keys SORTED makes the match
 * order-independent (Zod reparse may not preserve insertion order), so
 * the journal twin and the bus twin collapse to one delivery.
 */
function journalDedupKey(event: JournalEvent): string {
  return JSON.stringify(event, Object.keys(event).sort());
}

/**
 * Pre-attached bus subscription handed from `opsSessionWatch` to
 * `tailSessionEvents` so the live tail continues from the SAME listener
 * that buffered events across the read-then-subscribe gap (FIX [5]) —
 * no second subscribe, no second gap. `buffer` is the shared queue the
 * caller's listener keeps pushing onto; `setWake` lets the generator
 * install its park-resolver into that listener.
 */
interface PreSubscribedTail {
  buffer: JournalEvent[];
  off: () => void;
  setWake: (wake: () => void) => void;
}

/**
 * Live-tail a session's event bus: park until the publisher pushes
 * events, drain the queue in arrival order, and stop on a terminal
 * event or when the subscriber disconnects.
 *
 * The park is woken by BOTH a bus push AND the request's abort signal
 * (FIX [4]) — without the abort wake, a park entered on an empty queue
 * would never resolve on disconnect, leaking the generator and its bus
 * listener until the process exits. The bus subscription + abort
 * handler are always released in the `finally`.
 */
export async function* tailSessionEvents(
  sessionId: string,
  signal: AbortSignal | undefined,
  preSubscribed?: PreSubscribedTail,
): AsyncGenerator<JournalEvent> {
  const queue: JournalEvent[] = preSubscribed ? preSubscribed.buffer : [];
  let resolve: (() => void) | null = null;
  const wake = (): void => {
    resolve?.();
  };
  const off = preSubscribed
    ? preSubscribed.off
    : sessionEventBus.subscribe(sessionId, (event) => {
        queue.push(event);
        wake();
      });
  preSubscribed?.setWake(wake);

  const onAbort = (): void => {
    wake();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Already aborted before the first park: drain finally, stop.
    while (!signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
        // An abort-driven wake leaves the queue empty; fall through to
        // the while guard, which exits.
        if (signal?.aborted) break;
      }
      const terminal = yield* drainQueue(queue);
      if (terminal) return;
    }
  } finally {
    off();
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Yield every queued event in arrival order, returning true the moment
 * a terminal event is yielded (so the caller stops the stream). Pulled
 * out of `tailSessionEvents` to keep that generator's branching below
 * the cognitive-complexity gate.
 */
function* drainQueue(queue: JournalEvent[]): Generator<JournalEvent, boolean> {
  while (queue.length > 0) {
    const ev = queue.shift();
    if (ev === undefined) continue;
    yield ev;
    if (isTerminal(ev)) return true;
  }
  return false;
}

/**
 * Yield the persisted journal, recording each event's dedup key in
 * `seen`. Returns "aborted" if the request signal fired, "terminal" if
 * a terminal event was reached (caller stops), else "open".
 */
function* replayJournal(
  persisted: JournalEvent[],
  seen: Set<string>,
  signal: AbortSignal | undefined,
): Generator<JournalEvent, "aborted" | "terminal" | "open"> {
  for (const e of persisted) {
    if (signal?.aborted) return "aborted";
    seen.add(journalDedupKey(e));
    yield e;
    if (isTerminal(e)) return "terminal";
  }
  return "open";
}

/**
 * No-live-channel tail: the producer already finished (or never
 * started), so nothing more will be published. Yield whatever the
 * buffer caught in the read→subscribe gap (deduped against the journal
 * via `seen`), then emit a terminal `aborted` only if neither the
 * journal nor the buffer carried a terminal — so a hung client still
 * gets a stream-ending event.
 */
function* drainGapBuffer(
  buffer: JournalEvent[],
  seen: Set<string>,
  signal: AbortSignal | undefined,
): Generator<JournalEvent> {
  let sawTerminal = false;
  for (const e of buffer) {
    const key = journalDedupKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    if (signal?.aborted) return;
    yield e;
    if (isTerminal(e)) {
      sawTerminal = true;
      break;
    }
  }
  if (!sawTerminal) {
    yield { type: "aborted", ts: new Date().toISOString(), reason: "signal" };
  }
}

/**
 * Dedup `buffer` against the journal (`seen`) IN PLACE so the array
 * identity is preserved — the bus listener keeps pushing live events
 * onto this same `buffer`, which is what `tailSessionEvents` drains. A
 * fresh filtered copy would orphan every post-handoff event.
 */
function dedupBufferInPlace(buffer: JournalEvent[], seen: Set<string>): void {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    if (e === undefined) continue;
    const key = journalDedupKey(e);
    if (seen.has(key)) buffer.splice(i, 1);
    else seen.add(key);
  }
}

/**
 * FIX [5] — close the read-then-subscribe race in `opsSessionWatch`.
 * Previously the journal was read FIRST and the bus subscribed only
 * inside `tailSessionEvents`, so an event published in the gap between
 * the snapshot and the subscribe (loop-executor appends THEN publishes)
 * was lost forever — a terminal `done` in that window hung the client.
 *
 * Subscribe FIRST so every publish from now on is buffered, THEN read
 * the journal, replay it, and either drain the gap buffer (no live
 * channel) or hand the already-attached subscription to
 * `tailSessionEvents` for the live tail — deduping the buffer against
 * the journal so nothing in the gap is dropped or delivered twice.
 */
async function* watchSession(
  sessionId: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<JournalEvent> {
  const buffer: JournalEvent[] = [];
  let wake: (() => void) | null = null;
  const off = sessionEventBus.subscribe(sessionId, (event) => {
    buffer.push(event);
    wake?.();
  });
  let handedOff = false;
  try {
    const persisted = await readJournal(sessionId);
    const seen = new Set<string>();
    const replay = yield* replayJournal(persisted, seen, signal);
    if (replay !== "open") return;

    if (!sessionEventBus.hasChannel(sessionId)) {
      yield* drainGapBuffer(buffer, seen, signal);
      return;
    }

    dedupBufferInPlace(buffer, seen);
    handedOff = true;
    yield* tailSessionEvents(sessionId, signal, {
      buffer,
      off,
      setWake: (w) => {
        wake = w;
      },
    });
  } finally {
    // tailSessionEvents owns `off` once handed off; otherwise we must
    // release the bus subscription ourselves.
    if (!handedOff) off();
  }
}

/**
 * Best-effort usage telemetry for a non-streaming chat completion.
 * The cost corpus (~/.llamactl/usage/*.jsonl) that the Cost dashboard,
 * cost-guardian, and project budgets all read had zero writers — every
 * spend number was derived from an empty well. Append one UsageRecord
 * per completion via the fire-and-forget background writer, deferred
 * past the response with queueMicrotask so a slow disk can't add
 * latency to the user's request. Records nothing when the upstream
 * returned no usage block. Streaming (`chatStream`) usage capture goes
 * through `recordChatUsageObservation` via the adapter's
 * onUsageObservation hook.
 */
export function recordChatUsage(
  response: {
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    model: string;
    latencyMs?: number | undefined;
  },
  provider: string,
  route?: string,
): void {
  const usage = response.usage;
  if (!usage) return;
  queueMicrotask(() => {
    appendUsageBackground({
      record: {
        ts: new Date().toISOString(),
        provider,
        model: response.model,
        kind: "chat",
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        latency_ms: response.latencyMs ?? 0,
        ...(route ? { route } : {}),
      },
    });
  });
}

/**
 * Streaming sibling of `recordChatUsage`, rebuilt on the nova 0.2.0
 * provenance surface. The OpenAI-compat adapter fires
 * `onUsageObservation` exactly once per attempt with a
 * `UsageObservationV1` — `source: 'observed'` carrying only the counts
 * the upstream actually sent, or `source: 'unknown'` carrying none.
 * We build the `UsageRecordV2` in memory and append ONLY the non-null
 * result of `projectUsageRecordV2ToV1`: one V1 row per fully-observed
 * attempt, no row for unknown or partially-observed usage, never a V2
 * row in the V1 corpus.
 *
 * The snapshot's `provider` is the ADAPTER name (= node.name), NOT the
 * canonical pricing-key kind, so the caller passes the canonical
 * `provider` separately — mirroring how `chatComplete` derives it.
 * Fire-and-forget through the same background writer; the call already
 * sits inside the adapter's swallowing `fireObservation`, and
 * `appendUsageBackground` never throws either.
 */
export function recordChatUsageObservation(
  snapshot: OpenAICompatUsageObservation,
  provider: string,
  route?: string,
): void {
  const v2: UsageRecordV2 = {
    v: 2,
    ts: new Date().toISOString(),
    provider,
    model: snapshot.model,
    kind: snapshot.kind,
    latency_ms: snapshot.latency_ms,
    observation: snapshot.observation,
    ...(snapshot.request_id !== undefined ? { request_id: snapshot.request_id } : {}),
    ...(snapshot.attempt_id !== undefined ? { attempt_id: snapshot.attempt_id } : {}),
    ...(route !== undefined ? { route } : {}),
  };
  const v1 = projectUsageRecordV2ToV1(v2);
  // Partial or non-observed usage is the absence of evidence — it
  // must not become a zero-filled or fabricated row.
  if (v1 === null) return;
  appendUsageBackground({ record: v1 });
}

/**
 * Projects a `/v1/models` body onto the nodeModels return shape.
 * Pure, no IO. Without the declared opt-in only `models` is returned;
 * with it, `declared` and `unavailable` are carried through, collapsing
 * to `[]` when an older peer omits them (#280 DF-07).
 */
export function projectModelsBody(
  body: unknown,
  includeDeclared: boolean,
): { models: unknown[]; declared?: unknown[]; unavailable?: unknown[] } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const models = Array.isArray(b["data"]) ? b["data"] : [];
  if (!includeDeclared) return { models };
  return {
    models,
    declared: Array.isArray(b["declared"]) ? b["declared"] : [],
    unavailable: Array.isArray(b["unavailable"]) ? b["unavailable"] : [],
  };
}

/**
 * #220: serverStart's input. Hoisted from the inline object so the RPC
 * surface keeps a declared `readiness` probe (the same strict ModelHost
 * shape) and rejects a malformed one, instead of silently stripping it.
 */
export const ServerStartInputSchema = z.object({
  workload: z.string().min(1),
  target: z.string().min(1),
  extraArgs: z.array(z.string()).optional(),
  allowExternalBind: z.boolean().optional(),
  endpoint: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
  binary: z.string().optional(),
  timeoutSeconds: z.number().int().positive().max(600).optional(),
  skipTuned: z.boolean().optional(),
  restart: z.boolean().optional(),
  readiness: ModelHostReadinessSchema.optional(),
});

function parseWorkloadInput(yaml: string): unknown {
  try {
    return workloadStoreMod.parseManifestYaml(yaml);
  } catch (err) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid workload manifest: ${(err as Error).message}`,
    });
  }
}

type AgentWorkloadApplyResult =
  | HandoffResult
  | {
      action: workloadApplyMod.ApplyAction | "stopped";
      path: string | null;
      status: ModelRunStatus;
      name: string;
      node: string;
    };

async function withManagedManualMutation<T>(
  node: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (node === undefined) return await run();
  const leave = enterManagedOperatorAction(node, "manual");
  if (leave === undefined) throw new TRPCError({ code: "CONFLICT", message: "NodeBusy" });
  try {
    return await run();
  } finally {
    leave();
  }
}

async function applyAgentWorkload(
  managed: ManagedLaunchAdmission | undefined,
  signal: AbortSignal | undefined,
  readManifest: (workloadsDir: string) => unknown,
): Promise<AgentWorkloadApplyResult> {
  const workloadsDir = workloadStoreMod.defaultWorkloadsDir();
  // applyOne's NodeClient type pulls AppRouter → NodeClient → AppRouter
  // at the type level. clientForNode returns a structurally-compatible
  // surface (serverStatus/serverStop/rpcServerStop + the subscription
  // helpers for serverStart/rpcServerStart arrive from the pinned tRPC
  // client on the remote path; local path wraps core directly).
  // `WorkloadClient` was widened from `NodeClient` precisely so this
  // callsite no longer needs an `as any` escape.
  //
  // Serialize list-check-save under a per-directory in-process mutex
  // so two concurrent `workloadApply` mutations can't both pass the
  // port-collision preflight and both write. Cross-process callers
  // (`acquireLock`) are coordinated separately by the file lock.
  //
  // #216: when a local ModelHost is handed off to a live controller,
  // the engine would otherwise land in the caller's cgroup (e.g. a
  // desktop-app terminal scope), outside the controller unit's
  // OOMScoreAdjust and limits. Validate the spec, persist, and return
  // without spawning so the controller's reconciler starts it under
  // its own service on the next pass.
  const scope =
    managed?.withDesiredManifest ??
    (async <T>(
      _input: unknown,
      apply: (ownsNode: boolean, budget?: ManagedApplyBudget) => Promise<T>,
    ): Promise<T> => await apply(false));
  const interlockNode =
    managed?.setNativeOmlxResidency === undefined ? undefined : managed.ownerNodeId;
  return await withManagedManualMutation(interlockNode, () =>
    workloadStoreMod.withWorkloadsMutex(workloadsDir, async () => {
      const manifest = readManifest(workloadsDir);
      const cfg = kubecfg.loadConfig();
      return await scope(manifest, async (ownsNode, budget) => {
        if (!ownsNode) refuseLegacyManagedMutation("ManagedOwnerRequired");
        if (ownsNode) assertManagedApplyOwnsDirectory(workloadsDir);
        const handoffResult = ownsNode ? null : handoffLocalModelHost(manifest, workloadsDir);
        if (handoffResult) return handoffResult;
        const result = await workloadApplyMod.applyManifest({
          manifest,
          getClient: clientForApply(cfg, managed, ownsNode, signal),
          getNodeBudgetGiB: (nodeName) => nodeRunBudgetGiB(nodeName, workloadsDir),
          ...(budget === undefined ? {} : { managedBudget: budget }),
          getNodeResidency: (nodeName) => nodeRunResidency(nodeName, workloadsDir),
        });
        if (!result.ok) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error });
        }
        if (result.kind === "ModelRun") {
          const persisted: ModelRun = {
            ...result.manifest,
            status: result.result.statusSection,
          };
          const savedPath = workloadStoreMod.saveWorkload(persisted, workloadsDir);
          return {
            action: result.result.action,
            path: savedPath,
            status: result.result.statusSection,
            name: result.manifest.metadata.name,
            node: result.manifest.spec.node,
          };
        }
        const disabled = ownsNode && !result.manifest.spec.enabled;
        const action = disabled ? "stopped" : "started";
        const savedPath = disabled
          ? modelHostStoreMod.saveModelHost(result.manifest, workloadsDir)
          : null;
        return {
          action,
          path: savedPath,
          status: {
            phase: disabled ? "Stopped" : "Running",
            serverPid: result.pid,
            endpoint: result.endpoint,
            lastTransitionTime: new Date().toISOString(),
            conditions: [
              {
                type: "Applied",
                status: "True",
                reason: action,
                lastTransitionTime: new Date().toISOString(),
              },
            ],
          },
          name: result.manifest.metadata.name,
          node: result.manifest.spec.node,
        };
      });
    }),
  );
}

function readOwnedWorkloadToggle(
  dir: string,
  ownsNode: (node: string) => boolean,
  workload: string,
  enabled: boolean,
): ModelRun | ModelHostManifest {
  let manifest: ModelRun | ModelHostManifest;
  try {
    manifest = workloadStoreMod.loadWorkloadByNameAny(workload, dir);
  } catch {
    throw new TRPCError({ code: "NOT_FOUND", message: "WorkloadUnavailable" });
  }
  if (manifest.metadata.name !== workload || !ownsNode(manifest.spec.node)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ManagedNodeIdentityMismatch" });
  }
  manifest.spec.enabled = enabled;
  return manifest;
}

export const router = t.router({
  env: t.procedure.query(() => envMod.resolveEnv()),

  nodeFacts: t.procedure.query(() => nodeFactsMod.collectNodeFacts()),

  inferenceObservations: t.procedure.query(() => inferenceObservations()),

  fleetSnapshot: t.procedure
    .input(z.object({ include: z.array(z.string()).optional() }).optional())
    .query(({ ctx, input }) =>
      readFleetSnapshotOrLocalRoutes(
        {
          ...(ctx.fleetJournalPath !== undefined ? { journalPath: ctx.fleetJournalPath } : {}),
          ...(ctx.fleetLocalRoutes !== undefined ? { localRoutes: ctx.fleetLocalRoutes } : {}),
        },
        input?.include?.includes("local-routes") === true,
      ),
    ),

  // ---- node management (kubeconfig + reachability) ----------------------

  nodeList: t.procedure.query(async () => {
    const cfg = kubecfg.loadConfig();
    const ctx = kubecfg.currentContext(cfg);
    const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
    const { resolveNodeKind } = await import("@llamactl/core/config/schema");
    const { synthesizeProviderNodes } = await import("./config/provider-nodes.js");
    // Provider-kind virtual nodes derived from sirius-providers.yaml
    // for each gateway. Synthesized fresh on every read — no cache.
    const synthetic = synthesizeProviderNodes(cfg);
    const persisted = (cluster?.nodes ?? []).map((n) => ({
      ...n,
      effectiveKind: resolveNodeKind(n),
    }));
    const virtual = synthetic.map((n) => ({
      ...n,
      effectiveKind: "provider" as const,
    }));
    return {
      context: ctx.name,
      cluster: ctx.cluster,
      defaultNode: ctx.defaultNode,
      nodes: [...persisted, ...virtual],
    };
  }),

  nodeTest: t.procedure.input(z.object({ name: z.string().min(1) })).query(async ({ input }) => {
    const cfg = kubecfg.loadConfig();
    const resolved = kubecfg.resolveNode(cfg, input.name);
    const { resolveNodeKind } = await import("@llamactl/core/config/schema");
    const kind = resolveNodeKind(resolved.node);
    const node = resolved.node;

    if (kind === "gateway" || kind === "provider") {
      return await probeGatewayNodeHealth({ node, user: resolved.user, cfg, kind });
    }

    const token = kubecfg.resolveToken(resolved.user);
    if (node.endpoint.startsWith("inproc://")) {
      return { ok: true as const, facts: nodeFactsMod.collectNodeFacts() };
    }
    try {
      const facts = await probeNodeFacts({
        url: node.endpoint,
        token,
        certificate: node.certificate ?? null,
        certificateFingerprint: node.certificateFingerprint ?? null,
        ...(node.tlsServerName !== undefined ? { tlsServerName: node.tlsServerName } : {}),
      });
      return { ok: true as const, facts };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }),

  nodeAdd: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        bootstrap: z.string().min(1),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const decoded = decodeBootstrap(input.bootstrap);
      const force = input.force ?? false;

      if (!force) {
        try {
          await probeNodeFacts({
            url: decoded.url,
            token: decoded.token,
            certificate: decoded.certificate,
            certificateFingerprint: decoded.fingerprint,
          });
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `reachability check failed: ${(err as Error).message}`,
          });
        }
      }

      const cfgPath = kubecfg.defaultConfigPath();
      mutateConfigLocked(cfgPath, (cfg: Config) => {
        const ctx = kubecfg.currentContext(cfg);
        const withUser = {
          ...cfg,
          users: cfg.users.map((u) => (u.name === ctx.user ? { ...u, token: decoded.token } : u)),
        };
        const entry: ClusterNode = {
          name: input.name,
          endpoint: decoded.url,
          certificateFingerprint: decoded.fingerprint,
          certificate: decoded.certificate,
        };
        return kubecfg.upsertNode(withUser, ctx.cluster, entry);
      });
      return { ok: true as const, name: input.name, endpoint: decoded.url };
    }),

  nodeRemove: t.procedure.input(z.object({ name: z.string().min(1) })).mutation(({ input }) => {
    const cfgPath = kubecfg.defaultConfigPath();
    mutateConfigLocked(cfgPath, (cfg: Config) => {
      const ctx = kubecfg.currentContext(cfg);
      return kubecfg.removeNode(cfg, ctx.cluster, input.name);
    });
    return { ok: true as const };
  }),

  nodeSetDefault: t.procedure.input(z.object({ name: z.string().min(1) })).mutation(({ input }) => {
    const cfgPath = kubecfg.defaultConfigPath();
    const next = mutateConfigLocked(cfgPath, (cfg: Config) =>
      kubecfg.setDefaultNode(cfg, input.name),
    );
    const ctx = kubecfg.currentContext(next);
    return { ok: true as const, defaultNode: ctx.defaultNode };
  }),

  /**
   * Register a cloud-provider node. Unlike `nodeAdd` (which bootstraps
   * a remote agent via a bearer-token blob), this stores a pointer to
   * an external OpenAI-compatible API — the raw key stays out of
   * kubeconfig by living behind an env var or file path
   * (`$OPENAI_API_KEY`, `~/.llamactl/keys/openai`, …).
   */
  nodeAddCloud: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        provider: z.enum([
          "openai",
          "anthropic",
          "together",
          "groq",
          "mistral",
          "openai-compatible",
          "sirius",
          "embersynth",
        ]),
        baseUrl: z.url().optional(),
        // Optional: sirius-gateway / local dev endpoints may be
        // unauthenticated. When absent the adapter omits the
        // Authorization header.
        apiKeyRef: z.string().optional(),
        displayName: z.string().optional(),
        /**
         * Skip the `/v1/models` reachability probe and persist the
         * binding unverified. Useful when registering a node that
         * isn't online yet (e.g. composite plan authored before the
         * backing container is up). Mirrors `nodeAdd`'s `--force`.
         */
        skipProbe: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { defaultCloudBinding, providerForCloudNode } = await import("./providers/factory.js");
      const cfgPath = kubecfg.defaultConfigPath();
      const binding = defaultCloudBinding(input.provider, input.apiKeyRef ?? "", {
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      });
      // `defaultCloudBinding` persists apiKeyRef as an empty string
      // when the caller omitted it; drop the field entirely so the
      // stored node matches the "anonymous" semantics.
      if (!input.apiKeyRef) delete (binding as { apiKeyRef?: string }).apiKeyRef;
      if (!binding.baseUrl) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "baseUrl is required for openai-compatible provider",
        });
      }
      // Probe BEFORE taking the kubeconfig lock — an in-lock await
      // would extend the critical section across a network round-trip
      // and let a concurrent bootstrap registration land inside it and
      // then get silently erased when we finally save.
      if (!input.skipProbe) {
        try {
          const provider = providerForCloudNode({
            name: input.name,
            endpoint: "",
            kind: "gateway",
            cloud: binding,
          });
          const health = await provider.healthCheck?.();
          // Registration is a one-shot correctness check — any
          // non-healthy result means the binding can't serve traffic
          // right now, and operators should know immediately.
          // `degraded` covers all 4xx including 401 (bad key) and 404
          // (wrong base URL); `unhealthy` covers 5xx + network errors
          // and thrown exceptions from the provider adapter.
          if (health && health.state !== "healthy") {
            throw new Error(health.error ?? `cloud node health check returned ${health.state}`);
          }
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `cloud node probe failed: ${(err as Error).message}`,
          });
        }
      }
      mutateConfigLocked(cfgPath, (cfg: Config) => {
        const ctx = kubecfg.currentContext(cfg);
        return kubecfg.upsertNode(cfg, ctx.cluster, {
          name: input.name,
          endpoint: "",
          kind: "gateway",
          cloud: binding,
        });
      });
      return { ok: true as const, name: input.name, baseUrl: binding.baseUrl };
    }),

  /**
   * Update the embedder binding on a RAG node in place. `embedder:
   * null` clears the binding (pgvector falls back to caller-supplied
   * vectors); `embedder: { node, model }` sets a new delegated
   * embedder. `embedder: undefined` is a no-op — callers that want to
   * leave the binding alone simply omit the field. The RAG adapter
   * resolves the embedder lazily on each `ragSearch` / `ragStore`, so
   * the next call after this mutation picks up the change without
   * needing an adapter restart.
   */
  nodeUpdateRagBinding: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        embedder: z
          .object({
            node: z.string().min(1),
            model: z.string().min(1),
            // G4: explicit endpoint override for embedders not reachable
            // through the kubeconfig's advertised node URL.
            baseUrl: z.url().optional(),
            // G4: unified secret ref for bearer auth on the override.
            apiKeyRef: z.string().min(1).optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      const cfgPath = kubecfg.defaultConfigPath();
      // No-op fast path: when the caller doesn't specify an embedder
      // at all we don't need the write lock — just read + report.
      if (input.embedder === undefined) {
        const cfg = kubecfg.loadConfig(cfgPath);
        const resolved = kubecfg.resolveNode(cfg, input.node);
        if (!resolved.node.rag) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `node '${input.node}' is not a RAG node`,
          });
        }
        return {
          ok: true as const,
          node: input.node,
          embedder: resolved.node.rag.embedder ?? null,
        };
      }
      let embedderResult: typeof input.embedder = null;
      mutateConfigLocked(cfgPath, (cfg: Config) => {
        const ctx = kubecfg.currentContext(cfg);
        const resolved = kubecfg.resolveNode(cfg, input.node);
        if (!resolved.node.rag) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `node '${input.node}' is not a RAG node`,
          });
        }
        const nextRag = { ...resolved.node.rag };
        if (input.embedder === null) {
          delete nextRag.embedder;
        } else {
          nextRag.embedder = input.embedder;
        }
        embedderResult = nextRag.embedder ?? null;
        return kubecfg.upsertNode(cfg, ctx.cluster, {
          ...resolved.node,
          rag: nextRag,
        });
      });
      return {
        ok: true as const,
        node: input.node,
        embedder: embedderResult,
      };
    }),

  // ---- chat (Nova-typed) ---------------------------------------------

  /**
   * Non-streaming chat completion against a node's provider (cloud
   * adapter or the agent's `/v1` gateway). Returns the full
   * `UnifiedAiResponse` — identical shape whether the node is a
   * local agent, remote agent, or cloud provider.
   *
   * Streaming lives in `chatStream`.
   */
  chatComplete: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        request: z.looseObject({
          model: z.string(),
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([z.string(), z.array(z.unknown()), z.null()]),
            }),
          ),
          temperature: z.number().optional(),
          max_tokens: z.number().int().positive().optional(),
          providerOptions: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const {
        resolveProjectNodeTarget,
        appendProjectRoutingJournal,
        packRouteForUsage,
        makeProjectBudgetChecker,
      } = await import("./config/project-routing.js");
      const route = await resolveProjectNodeTarget(input.node, {
        checkBudget: makeProjectBudgetChecker(),
      });
      if (route.decision) {
        await appendProjectRoutingJournal(route.decision);
      }
      // Attribute the spend to the project + task-kind that routed it, so
      // the budget the next request reads is fed by the calls it governs.
      const usageRoute = route.decision ? packRouteForUsage(route.decision) : undefined;
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, route.node);
      if (resolved.node.endpoint === "inproc://local") {
        // Local agent — short-circuit through the shared proxy dispatch;
        // it is the legacy openaiProxy call unless LLAMACTL_UNIFIED_PROXY=1.
        // #281 DF-08: with a shared admission on the context (the agent's
        // requestContext sets it for /trpc and tunnel-relayed calls) the
        // dispatch is counted against the chat cap; a refusal is a typed
        // TRPCError and never retries on another model. In-process callers
        // like the RAG via-forward pass none: they hold the outer slot.
        const { dispatchProxyRequest } = await import("./proxy/create-proxy.js");
        const admission = ctx.chatAdmission;
        if (admission !== undefined) {
          return await admittedLocalChatComplete(
            admission,
            JSON.stringify({ ...input.request, stream: false }),
            signal,
            usageRoute,
          );
        }
        const req = new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input.request, stream: false }),
          ...(signal !== undefined ? { signal } : {}),
        });
        const res = await dispatchProxyRequest(req);
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `local chat ${String(res.status)}`,
          });
        }
        const response = (await res.json()) as UnifiedAiResponse;
        recordChatUsage(response, "local", usageRoute);
        return response;
      }
      const { providerForNode } = await import("./providers/factory.js");

      const provider = providerForNode({ node: resolved.node, user: resolved.user, cfg });
      const response = await provider.createResponse(input.request as UnifiedAiRequest, {
        ...(signal !== undefined ? { signal } : {}),
      });
      recordChatUsage(
        response,
        resolved.node.cloud?.provider ?? resolved.node.provider?.providerName ?? "local",
        usageRoute,
      );
      return response;
    }),

  /**
   * Streaming chat completion. Yields `UnifiedStreamEvent` values from
   * Nova — chunks, tool calls, errors, and a final `done` event —
   * bridged back through the dispatcher's subscription transport.
   */
  chatStream: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        request: z.looseObject({
          model: z.string(),
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([z.string(), z.array(z.unknown()), z.null()]),
            }),
          ),
          temperature: z.number().optional(),
          max_tokens: z.number().int().positive().optional(),
          providerOptions: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .subscription(async function* ({ ctx, input, signal }) {
      const {
        resolveProjectNodeTarget,
        appendProjectRoutingJournal,
        packRouteForUsage,
        makeProjectBudgetChecker,
      } = await import("./config/project-routing.js");
      const route = await resolveProjectNodeTarget(input.node, {
        checkBudget: makeProjectBudgetChecker(),
      });
      if (route.decision) {
        await appendProjectRoutingJournal(route.decision);
      }
      // Attribute the spend to the project + task-kind that routed it, so
      // the budget the next request reads is fed by the calls it governs.
      const usageRoute = route.decision ? packRouteForUsage(route.decision) : undefined;
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, route.node);
      const { providerForNode } = await import("./providers/factory.js");
      // Local-inproc agent: same OpenAI-compat adapter, but pointed at
      // the in-process llama-server's HTTP endpoint (not the
      // sentinel). resolveEnv() gives us LLAMA_CPP_HOST/PORT.
      if (resolved.node.endpoint === "inproc://local") {
        // #281 DF-08: with a shared admission on the context (the agent's
        // requestContext sets it for /trpc and tunnel-relayed calls) the
        // slot is held for the whole stream lifetime; a refusal is a typed
        // TRPCError, never a retry on another model. In-process callers
        // pass none: they hold the outer slot.
        const admission = ctx.chatAdmission;
        if (admission !== undefined) {
          let release: Release;
          try {
            release = await acquireChatSlot(admission, {
              bytes: Buffer.byteLength(JSON.stringify(input.request)),
              ...(signal !== undefined ? { signal } : {}),
            });
          } catch (err) {
            throw admissionTrpcError(err);
          }
          try {
            yield* localNodeChatEvents(input.request as UnifiedAiRequest, usageRoute, signal);
          } finally {
            release();
          }
          return;
        }
        yield* localNodeChatEvents(input.request as UnifiedAiRequest, usageRoute, signal);
        return;
      }

      // snapshot.provider is the adapter name (= node.name); map it to
      // the canonical pricing-key kind the way chatComplete does before
      // writing the UsageRecord. The observation fires exactly once per
      // attempt with the last usage frame's counts (upstream must honor
      // stream_options: { include_usage: true }); partial or absent
      // usage records nothing rather than a zero-filled row.
      const canonicalProvider =
        resolved.node.cloud?.provider ?? resolved.node.provider?.providerName ?? "local";
      const provider = providerForNode({
        node: resolved.node,
        user: resolved.user,
        cfg,
        onUsageObservation: (snapshot) => {
          recordChatUsageObservation(snapshot, canonicalProvider, usageRoute);
        },
      });
      yield* streamNodeChatEvents(provider, input.request as UnifiedAiRequest, signal);
    }),

  /**
   * List the models a node exposes — works for both agent and cloud
   * kinds via their respective `AiProvider.listModels()` impl. Used
   * by the aggregate `/v1/models` surface and the chat UI's model
   * picker.
   */
  nodeModels: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        include: z.array(z.enum(["declared"])).optional(),
      }),
    )
    .query(async ({ input }) => {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.name);
      const includeDeclared = input.include?.includes("declared") ?? false;
      const declaredExtras = includeDeclared ? { declared: [], unavailable: [] } : {};
      const { resolveNodeKind } = await import("@llamactl/core/config/schema");
      const kind = resolveNodeKind(resolved.node);
      if (kind === "provider") {
        // Scope to the parent gateway's catalog, filtered by
        // `owned_by === providerName`. Sirius tags each model with
        // the provider that serves it, so this is the natural
        // narrowing for the chat UI's picker.
        const binding = resolved.node.provider;
        if (!binding) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `provider node '${resolved.node.name}' missing provider binding`,
          });
        }
        const parent = cfg.clusters
          .find((c) => c.name === kubecfg.currentContext(cfg).cluster)
          ?.nodes.find((n) => n.name === binding.gateway);
        if (!parent) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `parent gateway '${binding.gateway}' not found`,
          });
        }
        const { providerForCloudNode } = await import("./providers/factory.js");
        const gatewayProvider = providerForCloudNode(parent);
        const all = (await gatewayProvider.listModels?.()) ?? [];
        const filtered = all.filter(
          (m) => (m as { owned_by?: string }).owned_by === binding.providerName,
        );
        return {
          node: input.name,
          kind,
          models: filtered,
          ...declaredExtras,
        };
      }
      if (kind === "gateway" || kind === "cloud") {
        // Cloud-direct and gateway-style cloud nodes both carry a
        // `cloud` binding with a base URL + API key ref. The
        // OpenAI-compat provider factory handles both identically
        // — it opens an openai-compat client at that base URL with
        // the resolved API key and scrapes /v1/models. We forward
        // the effective kind so the chat UI can render the right
        // label without round-tripping.
        const { providerForCloudNode } = await import("./providers/factory.js");
        const provider = providerForCloudNode(resolved.node);
        const models = (await provider.listModels?.()) ?? [];
        return {
          node: input.name,
          kind,
          models,
          ...declaredExtras,
        };
      }
      // Agent path — tRPC to the agent's nodeModels-via-openaiProxy.
      // Reuse the existing forwarding shape: local caller or pinned
      // client via clientForNode, then call openaiProxy's /v1/models
      // through the agent's /v1 HTTP surface. For simplicity today,
      // inline a call through the pinned-fetch path when remote,
      // and use the core readiness-gated listing directly when local.
      if (resolved.node.endpoint.startsWith("inproc://")) {
        // Stands in for the agent's /v1/models, so it must apply the same
        // ModelHost readiness gate: a warming host is hidden here exactly
        // as it is on a remote agent (#220). Chat routing applies its own
        // cached readiness gate in openaiProxy's servingRouteForModel (#280).
        const { openaiProxy } = await import("@llamactl/core");
        const full = await openaiProxy.listServingOpenAIModels();
        return { node: input.name, kind, ...projectModelsBody(full, includeDeclared) };
      }
      // Remote agent: scrape its /v1/models endpoint via pinned fetch.
      const token = kubecfg.resolveToken(resolved.user);
      const { makePinnedFetch } = await import("./client/links.js");
      const pinned = makePinnedFetch(resolved.node);
      const r = await pinned(
        `${resolved.node.endpoint}/v1/models${includeDeclared ? "?include=declared" : ""}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (!r.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `remote /v1/models ${String(r.status)}`,
        });
      }
      return { node: input.name, kind, ...projectModelsBody(await r.json(), includeDeclared) };
    }),

  /**
   * Bundle everything a user needs to point an external OpenAI client
   * at a node's built-in gateway: base URL, bearer token, and (for
   * self-signed setups) the CA PEM + fingerprint. Sensitive — exposes
   * the raw token — so the renderer calls this on-demand when the user
   * opens the "OpenAI config" panel, not eagerly with `nodeList`.
   */
  nodeOpenAIConfig: t.procedure.input(z.object({ name: z.string().min(1) })).query(({ input }) => {
    const cfg = kubecfg.loadConfig();
    const resolved = kubecfg.resolveNode(cfg, input.name);
    const token = kubecfg.resolveToken(resolved.user);
    return {
      node: input.name,
      baseUrl: `${resolved.node.endpoint}/v1`,
      apiKey: token,
      caCertPem: resolved.node.certificate ?? null,
      caFingerprint: resolved.node.certificateFingerprint ?? null,
    };
  }),

  /**
   * Broadcast-listen for llamactl agents on the local network.
   * Deduplicates against the current kubeconfig so already-registered
   * nodes are flagged and new candidates surface cleanly. Pure
   * discovery — it doesn't reveal or receive any bearer tokens, so
   * the user still has to paste a bootstrap blob to finish registration.
   */
  nodeDiscover: t.procedure
    .input(z.object({ timeoutMs: z.number().int().positive().max(10000).optional() }).optional())
    .query(async ({ input }) => {
      const { discoverAgents } = await import("./server/mdns.js");
      const found = await discoverAgents(input?.timeoutMs ?? 2500);
      const cfg = kubecfg.loadConfig();
      const cluster = cfg.clusters.find((c) => c.name === kubecfg.currentContext(cfg).cluster);
      const existingFingerprints = new Set(
        (cluster?.nodes ?? [])
          .map((n) => n.certificateFingerprint)
          .filter((fp): fp is string => typeof fp === "string" && fp.length > 0),
      );
      return found.map((svc) => ({
        name: svc.name,
        nodeName: svc.nodeName,
        host: svc.host,
        port: svc.port,
        addresses: svc.addresses,
        version: svc.version,
        fingerprint: svc.fingerprint,
        url: `https://${svc.host}:${String(svc.port)}`,
        alreadyRegistered: svc.fingerprint ? existingFingerprints.has(svc.fingerprint) : false,
      }));
    }),

  // ---- workload management --------------------------------------------

  /**
   * Resolved directory scanned for `ModelRun` manifests. Mirrors the
   * same cascade the store uses server-side (respects
   * `$LLAMACTL_WORKLOADS_DIR` override, then `$DEV_STORAGE`, then the
   * production `~/.llamactl` default). The UI reads this to render the
   * subheader "Declarative ModelRun manifests (<path>/*.yaml)" so
   * hermetic audits show the profile path instead of the user's real
   * home dir.
   */
  workloadsDir: t.procedure.query(() => ({
    dir: workloadStoreMod.defaultWorkloadsDir(),
  })),

  workloadList: t.procedure.query(async () => {
    const manifests = workloadStoreMod.listWorkloads();
    const cfg = kubecfg.loadConfig();
    const rows = await Promise.all(
      manifests.map(async (manifest) => {
        const nodeName = manifest.spec.node;
        let phase: "Running" | "Stopped" | "Mismatch" | "Unreachable" | "Foreign" = "Stopped";
        let endpoint: string | null = null;
        let statePid: number | null = null;
        let listenerPid: number | null = null;
        try {
          const client = clientForNode(cfg, nodeName);
          // FIX [6] — per-node deadline. Without it, one black-holed
          // node hangs the entire list. A timeout rejects and lands in
          // the catch below, so the slow node is marked Unreachable
          // alongside the other nodes' real data, not dropped.
          const status = await queryServerStatusWithTimeout(
            () => client.serverStatus.query({ workload: manifest.metadata.name }),
            WORKLOAD_LIST_NODE_TIMEOUT_MS,
          );
          const desired = manifest.spec.target.value;
          statePid = status.pid;
          listenerPid = status.listenerPid ?? null;
          // `foreign` first: an endpoint answering under a pid llamactl
          // did not record is a squatter, not a Running workload — the
          // proxy already dropped the route, so Running would lie.
          if (status.foreign) phase = "Foreign";
          else if (status.state === "up" && status.rel === desired) phase = "Running";
          else if (status.state === "up" && status.rel !== desired) phase = "Mismatch";
          endpoint = status.advertisedEndpoint ?? status.endpoint;
        } catch {
          phase = "Unreachable";
        }
        const workers = manifest.spec.workers;
        return {
          name: manifest.metadata.name,
          kind: "ModelRun" as const,
          node: nodeName,
          rel: manifest.spec.target.value,
          phase,
          endpoint,
          statePid,
          listenerPid,
          status: manifest.status ?? null,
          /**
           * E.4 — multi-node summary. `workerCount` powers a badge on
           * the list row; `workerNodes` is handy for quick tooltips
           * without a second roundtrip. The full per-worker detail
           * (rpcHost, rpcPort, timeoutSeconds, extraArgs) lives in the
           * manifest and is fetched via `workloadDescribe` when the
           * operator opens the drawer. Keeps list response cheap.
           */
          workerCount: workers.length,
          workerNodes: workers.map((w) => w.node),
        };
      }),
    );
    // ModelHosts (oMLX etc.) live in the same workloads dir but a
    // separate store. They were previously invisible to this list —
    // and to nodeBudget — even though admission counts them. Surface
    // them with the same row shape, discriminated by `kind`.
    const hostRows = await Promise.all(
      modelHostStoreMod.listModelHosts().map(async (manifest) => {
        const workload = manifest.metadata.name;
        const node = manifest.spec.node;
        const ep = manifest.spec.endpoint;
        const hosted = manifest.spec.hostedModels[0];
        if (!hosted) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `ModelHost '${manifest.metadata.name}' has no hosted models`,
          });
        }
        let phase: "Running" | "Stopped" | "Foreign" | "Unreachable" = "Unreachable";
        let statePid: number | null = null;
        let listenerPid: number | null = null;
        let runtime: ReturnType<typeof statusModelHost>["runtime"];
        try {
          const status = await queryServerStatusWithTimeout(
            () =>
              clientForNode(cfg, node).modelHostStatus.query({ workload, includeListener: true }),
            WORKLOAD_LIST_NODE_TIMEOUT_MS,
          );
          phase = status.foreign ? "Foreign" : status.state === "Running" ? "Running" : "Stopped";
          statePid = status.state === "Running" ? (status.pid ?? null) : null;
          listenerPid = status.listenerPid ?? null;
          runtime = status.runtime;
        } catch {
          phase = "Unreachable";
        }
        return {
          name: manifest.metadata.name,
          kind: "ModelHost" as const,
          node: manifest.spec.node,
          rel: hosted.rel,
          phase,
          endpoint: `http://${ep.host}:${String(ep.port)}`,
          statePid,
          listenerPid,
          status: runtime ? { ...runtime, phase } : null,
          workerCount: 0,
          workerNodes: [] as string[],
        };
      }),
    );
    return [...rows, ...hostRows];
  }),

  workloadDescribe: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const manifest = workloadStoreMod.loadWorkloadByNameAny(input.name);
      const cfg = kubecfg.loadConfig();
      let liveStatus: unknown;
      try {
        const client = clientForNode(cfg, manifest.spec.node);
        const workload = manifest.metadata.name;
        liveStatus = await queryServerStatusWithTimeout<unknown>(
          () =>
            manifest.kind === "ModelHost"
              ? client.modelHostStatus.query({ workload })
              : client.serverStatus.query({ workload }),
          WORKLOAD_LIST_NODE_TIMEOUT_MS,
        );
      } catch (err) {
        liveStatus = { error: (err as Error).message };
      }
      return {
        manifest,
        liveStatus,
        controllerPid: liveLockHolder(workloadStoreMod.defaultWorkloadsDir()),
      };
    }),

  nodeBudget: t.procedure.input(z.object({ node: z.string().min(1) })).query(({ input }) => {
    const nodeRuns = nodeRunStoreMod.listNodeRuns();
    const node = nodeRuns.find((n: (typeof nodeRuns)[number]) => n.metadata.name === input.node);
    const budget = defaultNodeBudgetGiB(
      node?.spec.budget?.memoryGiB,
      undefined,
      node?.spec.residency,
    );
    const resolved = envMod.resolveEnv();
    const runRows = workloadStoreMod
      .listWorkloads()
      .filter((m) => m.spec.node === input.node)
      .map((manifest) => ({
        name: manifest.metadata.name,
        kind: "ModelRun" as const,
        enabled: manifest.spec.enabled,
        expectedMemoryGiB: manifest.spec.resources?.expectedMemoryGiB ?? null,
        endpoint: manifest.spec.endpoint
          ? `${manifest.spec.endpoint.host ?? "127.0.0.1"}:${String(manifest.spec.endpoint.port)}`
          : null,
        phase: manifest.status?.phase ?? "Pending",
      }));
    // ModelHosts are charged against the same node budget by admission
    // (listAnyWorkloadsForAdmission), but were omitted here — so
    // `reserved` under-reported and the rollup silently disagreed with
    // what `apply` actually enforces. Count them with the admission
    // estimator so the two views match.
    const hostRows = modelHostStoreMod
      .listModelHosts()
      .filter((h) => h.spec.node === input.node)
      .map((manifest) => ({
        name: manifest.metadata.name,
        kind: "ModelHost" as const,
        enabled: manifest.spec.enabled,
        expectedMemoryGiB: estimateModelHostMemoryGiB(manifest, resolved),
        endpoint: `${manifest.spec.endpoint.host}:${String(manifest.spec.endpoint.port)}`,
        phase: statusModelHost({ key: { name: manifest.metadata.name } }).state,
      }));
    const workloads = [...runRows, ...hostRows].sort((a, b) => a.name.localeCompare(b.name));
    const reserved = workloads
      .filter((w) => w.enabled)
      .reduce((sum, w) => sum + (w.expectedMemoryGiB ?? 0), 0);
    // Part of #519: a computed budget is the total memory of *this* process's
    // machine times the effective ratio, so it is the named node's own RAM only
    // when that node's agent is the one answering.
    const ratioKnob = effectiveResidencyPolicy(node?.spec.residency).knobs.find(
      (k) => k.name === "safetyMarginRatio",
    );
    return {
      budget,
      budgetSource:
        typeof node?.spec.budget?.memoryGiB === "number"
          ? ("noderun" as const)
          : ("computed" as const),
      safetyMarginRatio: {
        value: ratioKnob?.value ?? DEFAULT_RESIDENCY_POLICY.safetyMarginRatio,
        defaulted: ratioKnob?.defaulted ?? true,
      },
      reserved,
      workloads,
    };
  }),

  // Read-only residency status. nodeRun/policy/budget reflect the NodeRun
  // manifest matched by `node`; the store and leases sections are always this
  // serving process's own state (scope "serving-process"), never `node`'s
  // coordinator state. The lease registry is per serving process, so it is not
  // filtered by node — the same scope as the store echo. The omlxNative section
  // probes each oMLX ModelHost on `node` only when `node` is this serving
  // process's own identity; status latency on the serving node is bounded by
  // OMLX_STATUS_PROBE_TIMEOUT_MS per call while a host's capability is still
  // unknown, because unknown is not cached. The idleEviction section is an
  // advisory read-out of the NodeRun idle-evict window against this serving
  // process's ready lifecycle rows and lease activity (forwarded through the
  // registry's lastActivityAtMs read-out), only when `node` is the serving node;
  // nothing is evicted or slept. The ranking section is a read-only read-out of
  // the residentPreference and cold-load ranking inputs (the resident set and
  // drain charges as the unified proxy's ranker sees them), reported only on
  // the serving node with the unified proxy on; it never ranks anything.
  residencyStatus: t.procedure
    .input(z.object({ node: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const owner = profileOwner(input.node, ctx.managedLaunchAdmission);
      const ownerNode = owner?.ownerNodeId ?? input.node;
      const nodeRuns = nodeRunStoreMod.listNodeRuns();
      const node = nodeRuns.find((n) => n.metadata.name === ownerNode);
      const declared = node?.spec.budget?.memoryGiB;
      const leaseRegistry = getResidencyLeaseRegistry();
      const rawNodeName = process.env["LLAMACTL_NODE_NAME"]?.trim() ?? "";
      const servingNode =
        owner === undefined ? (rawNodeName === "" ? null : rawNodeName) : input.node;
      // The store keeps the audit across a process restart, but a sink write can
      // fail quietly (a locked store hits the short busy timeout and core swallows
      // the error), so the live in-memory audit may hold entries the store lacks.
      // Status therefore merges the two: persisted rows plus any live entries not
      // already persisted, in chronological order; snapshot stays live.
      // auditCount is the merged count. A null registry reads no store for audit:
      // with no registry the leases section is "unavailable". The
      // `lastActivityAtMs` read-out is forwarded only when the installed registry
      // has it, so a registry without the method yields an audit source without it
      // and the idleEviction section reports unknown activity.
      const activityRead = leaseRegistry?.lastActivityAtMs;
      const auditSource =
        leaseRegistry === null
          ? null
          : {
              snapshot: (workload: string): ResidencySnapshot => leaseRegistry.snapshot(workload),
              audit: (): ResidencyAuditEntry[] =>
                mergeResidencyLeaseAudit(
                  readResidencyLeaseAudit(defaultResidencyStorePath()),
                  leaseRegistry.audit(),
                ),
              ...(activityRead !== undefined
                ? {
                    lastActivityAtMs: (workload: string): number =>
                      activityRead.call(leaseRegistry, workload),
                  }
                : {}),
            };
      const leaseWorkloads =
        leaseRegistry === null
          ? []
          : [
              ...workloadStoreMod.listWorkloads().map((m) => m.metadata.name),
              ...modelHostStoreMod.listModelHosts().map((h) => h.metadata.name),
            ];
      const { unifiedProxyEnabled } = await import("./proxy/create-proxy.js");
      const status = buildResidencyStatus({
        node: input.node,
        nodeRun: node,
        nodeRuns: nodeRuns,
        budgetGiB: defaultNodeBudgetGiB(declared, undefined, node?.spec.residency),
        budgetSource: typeof declared === "number" ? "noderun" : "computed",
        store: readResidencyStoreSnapshot(defaultResidencyStorePath()),
        leaseRegistry: auditSource,
        leaseWorkloads,
        servingNode,
        unifiedProxy: unifiedProxyEnabled(),
        omlxNative: await collectOmlxNativeStatus({
          node: input.node,
          servingNode,
          hosts: modelHostStoreMod.listModelHosts(),
          ...(owner?.ownsNode === undefined ? {} : { ownsNode: owner.ownsNode }),
          readOwned: owner?.readOwnedOmlxStatus,
        }),
        sessionRegistry: currentSessionRefcounts(),
      });
      const managed = owner?.readStatus?.();
      return {
        ...status,
        ...(managed === undefined
          ? {}
          : { managed: { ...managed, execution: ownerExecutionStatus() } }),
      };
    }),

  // Read-only residency plan: a dry-run profile switch, never a mutation.
  // ModelRun state is the recorded phase; ModelHost state is pid-level and
  // maps to "starting", not ready-probed. The store and pid status apply only
  // when node === LLAMACTL_NODE_NAME; otherwise storeAppliesToNode:false means
  // the in-flight state for `node` was not observed here. Failed/Pending
  // workloads fail closed as UnknownState.
  residencyCalibrationKey: t.procedure
    .input(residencyCalibrationKeyInput)
    .query(({ ctx, input }) => {
      const owner = profileOwner(input.node, ctx.managedLaunchAdmission);
      if (owner === undefined) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ManagedOwnerRequired" });
      }
      const calibration = owner.readCalibration?.(input.workload);
      if (calibration === undefined) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "ManagedCalibrationIdentityUnavailable",
        });
      }
      return calibration;
    }),

  residencyPlan: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        to: z.string().min(1),
        from: z.string().min(1).optional(),
      }),
    )
    .query(
      ({ ctx, input }) => residencyPlanFor({ ...input, managed: ctx.managedLaunchAdmission }).plan,
    ),

  residencyControl: t.procedure.input(residencyControlInput).mutation(
    async ({ ctx, input, signal }): Promise<ResidencyControlResult> =>
      await controlManagedResidency(input, {
        managed: ctx.managedLaunchAdmission,
        registry: getResidencyLeaseRegistry(),
        workloadsDir: workloadStoreMod.defaultWorkloadsDir(),
        signal,
        execute: (action, manifest) =>
          dispatchManagedControl(
            omitUndefined(ctx),
            signal,
            action,
            manifest,
            input.drainTimeoutMs,
          ),
      }),
  ),

  // Older agents already accept this procedure's wet request shape.
  residencyApplyProfile: t.procedure
    .input(profileMutationSchema)
    .mutation(async ({ ctx, input }): Promise<ResidencyApplyProfileResult> => {
      const managed = profileOwner(input.node, ctx.managedLaunchAdmission);
      if (!input.dryRun && managed !== undefined) {
        return residencyApplyProfileRefusal({
          node: managed.ownerNodeId ?? input.node,
          to: input.to,
          from: input.from ?? null,
          reason: "ManagedProfileProtocolRequired",
          detail: "use the versioned managed profile procedure on the authenticated owner",
        });
      }
      return await runProfileMutation(input, managed);
    }),

  residencyApplyManagedProfile: t.procedure
    .input(managedProfileMutationSchema)
    .mutation(async ({ ctx, input }): Promise<ResidencyApplyProfileResult> => {
      const managed = profileOwner(input.node, ctx.managedLaunchAdmission);
      if (managed === undefined) {
        return {
          ...residencyApplyProfileRefusal({
            node: input.node,
            to: input.to,
            from: input.from ?? null,
            reason: "ManagedOwnerRequired",
            detail: "send the managed profile to its owner agent",
          }),
          dryRun: input.dryRun,
        };
      }
      return await runProfileMutation(input, managed);
    }),

  // #284 (DF-11): request cancellation of an in-flight profile switch by
  // operationId. The id comes from residencyApplyProfile (operationId /
  // busy.operationId / inFlightOperationId) or residency status. The cancel is
  // process-local: it aborts only a switch whose controller is registered in
  // this serving process. `cancel-requested` means the abort was delivered; it
  // is not the recorded outcome, which the switch writes when it reaches a step
  // boundary.
  residencyCancelOperation: t.procedure
    .input(z.object({ operationId: z.string().min(1), confirm: z.literal(true) }))
    .mutation(
      ({ input }): ResidencyCancelOperationResult =>
        cancelResidencyProfileOperation({
          operationId: input.operationId,
          storePath: defaultResidencyStorePath(),
        }),
    ),

  // #519: operator-triggered idle eviction on the serving node. A bare { node }
  // call is a dry run reporting the idle-evict window and the would-evict rows
  // without touching anything; { node, targets } re-checks each target against
  // the live lease registry and stops it through the same fenced path serverStop/
  // modelHostStop use (lifecycle walk plus lease drain), reporting skipped rather
  // than throwing when the stop cannot complete. With the session registry
  // installed, a session-bound workload is skipped SessionsActive in both runs
  // and a throwing registry SessionsUnknown (#520). Disabled/off-node/unavailable
  // snapshots come back ok:false and stop nothing. The durable idle hold is
  // stamped and released by the CLI around this call.
  residencyEvictIdle: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        targets: z
          .array(z.object({ workload: z.string().min(1), kind: z.enum(["modelrun", "modelhost"]) }))
          .optional(),
      }),
    )
    .mutation(async ({ input }): Promise<IdleEvictResult> => {
      if (input.targets !== undefined) {
        refuseLegacyManagedMutation("ManagedIdleEvictionRequiresOwner");
      }
      const rawNodeName = process.env["LLAMACTL_NODE_NAME"]?.trim() ?? "";
      const servingNode = rawNodeName === "" ? null : rawNodeName;
      const nodeRun = nodeRunStoreMod.listNodeRuns().find((n) => n.metadata.name === input.node);
      const leaseProbe = idleEvictLeaseProbe();
      const nowMs = Date.now();
      const idleEviction = buildIdleEvictionSnapshot({
        residency: nodeRun?.spec.residency,
        servingNode,
        node: input.node,
        store: readResidencyStoreSnapshot(defaultResidencyStorePath()),
        leaseRegistry: leaseProbe,
        nowMs,
      });
      const result = await runIdleEviction({
        idleEviction,
        leaseRegistry: leaseProbe,
        sessions: currentSessionRefcounts(),
        nowMs,
        targets: input.targets ?? null,
        stop: (workload, kind) => evictIdleStop(workload, kind),
      });
      if (!result.ok || !result.dryRun) {
        return result;
      }
      const kinds = idleEvictKindMap();
      return {
        ...result,
        rows: result.rows.map((row) =>
          row.action === "would-evict" ? attachIdleEvictKind(row, kinds) : row,
        ),
      };
    }),

  workloadApply: t.procedure
    .input(z.object({ yaml: z.string().min(1) }))
    .mutation(({ ctx, input, signal }) =>
      applyAgentWorkload(ctx.managedLaunchAdmission, signal, () => parseWorkloadInput(input.yaml)),
    ),

  managedWorkloadApply: t.procedure.input(z.object({ yaml: z.string().min(1) })).mutation(
    async ({
      ctx,
      input,
      signal,
    }): Promise<{
      action: string;
      path: string | null;
      status: unknown;
      name: string;
      node: string;
    }> => {
      const managed = ctx.managedLaunchAdmission;
      if (managed?.withDesiredManifest === undefined || managed.ownsNode === undefined) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ManagedOwnerRequired" });
      }
      const raw = workloadStoreMod.parseManifestYaml(input.yaml);
      const run = ModelRunSchema.safeParse(raw);
      const host = ModelHostManifestSchema.safeParse(raw);
      const manifest = run.success ? run.data : host.success ? host.data : undefined;
      if (manifest === undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "ModelRun or ModelHost required" });
      }
      if (!managed.ownsNode(manifest.spec.node)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "ManagedNodeIdentityMismatch",
        });
      }
      return await router
        .createCaller({ managedLaunchAdmission: managed }, signal ? { signal } : undefined)
        .workloadApply(input);
    },
  ),

  managedWorkloadSetEnabled: t.procedure
    .input(
      z.strictObject({
        workload: ModelHostManifestSchema.shape.metadata.shape.name,
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const managed = ctx.managedLaunchAdmission;
      const ownsNode = managed?.ownsNode;
      if (managed?.withDesiredManifest === undefined || ownsNode === undefined) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ManagedOwnerRequired" });
      }
      return await applyAgentWorkload(managed, signal, (dir) =>
        readOwnedWorkloadToggle(dir, ownsNode, input.workload, input.enabled),
      );
    }),

  modelHostNativeResidency: t.procedure
    .input(
      z.strictObject({
        workload: ModelHostManifestSchema.shape.metadata.shape.name,
        action: z.enum(["park", "resume"]),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      signal?.throwIfAborted();
      const owner = ctx.managedLaunchAdmission;
      const set = owner?.setNativeOmlxResidency;
      const node = owner?.ownerNodeId;
      if (set === undefined || node === undefined) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "ManagedNativeOmlxOwnerUnavailable",
        });
      }
      return await withManagedManualMutation(node, async () => {
        const outcome = await set(input.workload, input.action);
        if (outcome === undefined) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "ManagedNativeOmlxOwnerUnavailable",
          });
        }
        return outcome;
      });
    }),

  modelHostStatus: t.procedure.input(modelHostStatusInput).query(async ({ input, ctx }) => {
    const key = { name: input.workload };
    if (input.probeOrigin !== undefined) {
      return await statusModelHostForProbe(
        { key, probeOrigin: input.probeOrigin },
        ctx.managedLaunchAdmission?.verifyParkedOmlxProbe,
      );
    }
    const status = statusModelHost({ key });
    if (input.includeListener !== true) return status;
    const state = readModelHostState(key);
    if (state === null) return status;

    const { listenerPid, reachable } = await probeEndpointOwnership(state.host, state.port);
    const foreign =
      reachable &&
      (status.state !== "Running" || (listenerPid !== null && listenerPid !== status.pid));
    return { ...status, listenerPid, foreign };
  }),

  modelHostStop: t.procedure.input(modelHostStopInput).mutation(
    async ({ ctx, input }): Promise<StopModelHostResult> =>
      !ctx.ownerStopIntent && managedLocalRuntime()
        ? { ok: false, pid: null, error: "ManagedStopIntentRequired" }
        : await fenceWorkloadStop<StopModelHostResult>({
            workload: input.workload,
            ...(ctx.ownerStopWait === undefined ? {} : { wait: ctx.ownerStopWait }),
            stop: async () => {
              const managed = ctx.managedLaunchAdmission;
              const proof = managed?.prepareStopRelease?.(input.workload, "ModelHost");
              if (managed !== undefined && proof === undefined) {
                return { ok: false, pid: null, error: "ManagedStopGenerationUnverified" };
              }
              const outcome = await runDirectResidencyStop<StopModelHostResult>(
                input.workload,
                async () => {
                  const stopped = await runOwnedStop(managed, () =>
                    stopModelHost({
                      key: { name: input.workload },
                      ...(input.graceSeconds !== undefined
                        ? { graceSeconds: input.graceSeconds }
                        : {}),
                      ...(proof === undefined
                        ? {}
                        : { identity: { verifyGeneration: proof.verifyGeneration } }),
                    }),
                  );
                  return stopped.ok && !stopReleased(proof, stopped.pid)
                    ? { ok: false, pid: stopped.pid, error: "ManagedStopReleaseUnverified" }
                    : stopped;
                },
                {
                  ...directResidencyOpts(input.workload, undefined),
                  requireVerifiedStopJournal: managed !== undefined && managedLocalRuntime(),
                },
              );
              return outcome.ran ? outcome.result : { ok: false, pid: null, error: outcome.detail };
            },
            isVerifiedStop: (r) => r.ok,
            refuse: (f) => ({ ok: false, pid: null, error: `${f.reason}: ${f.active.join(", ")}` }),
          }),
  ),

  modelHostStart: t.procedure.input(modelHostStartInput).subscription(async function* ({
    ctx,
    input,
    signal,
  }) {
    yield* bridgeEventStream(signal ?? new AbortController().signal, async (emit, subSignal) => {
      const managed = ctx.managedLaunchAdmission;
      const pinned =
        managed === undefined || input.manifest === undefined
          ? undefined
          : pinModelHostStartup(input.manifest);
      const manifest = pinned?.manifest ?? input.manifest;
      const start = (
        commitReadiness?: CommitLaunchReadiness,
        checkSpawn?: () => string | undefined,
      ): Promise<DirectLifecycleOutcome<StartModelHostResult>> =>
        runDirectResidencyStart<StartModelHostResult>(
          input.workload,
          () =>
            startModelHost({
              key: { name: input.workload },
              ...(input.timeoutSeconds !== undefined
                ? { timeoutSeconds: input.timeoutSeconds }
                : {}),
              ...(manifest === undefined ? {} : { manifest }),
              ...(pinned === undefined ? {} : { env: pinned.env }),
              ...(input.restart !== undefined ? { restart: input.restart } : {}),
              signal: subSignal,
              ...(commitReadiness === undefined ? {} : { commitReadiness }),
              ...(checkSpawn === undefined ? {} : { checkSpawn }),
              onEvent: (event) => {
                // Readiness is provisional until the managed claim commits.
                if (
                  managed !== undefined &&
                  typeof event === "object" &&
                  event !== null &&
                  "type" in event &&
                  event.type === "done"
                )
                  return;
                emit(event);
              },
            }),
          directResidencyOpts(input.workload, manifest?.metadata.labels),
        );
      const outcome =
        managed === undefined
          ? await start()
          : await managed.run(
              {
                kind: "ModelHost",
                runtimeKey: input.workload,
                launch: input,
                ...(pinned === undefined
                  ? {}
                  : {
                      effectiveSpecDigest: pinned.effectiveSpecDigest,
                      effectiveLaunch: pinned.effectiveLaunch,
                    }),
              },
              subSignal,
              start,
            );
      if (outcome.ran) {
        reopenWorkloadAfterLoad(input.workload, outcome.result.ok);
        if (managed !== undefined) emit({ type: "done", result: outcome.result });
      } else {
        emit({ type: "done", result: { ok: false, pid: null, error: outcome.detail } });
      }
    });
  }),

  workloadDelete: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        keepRunning: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return await workloadStoreMod.withWorkloadsMutex(
        workloadStoreMod.defaultWorkloadsDir(),
        async () => {
          const manifest = workloadStoreMod.loadWorkloadByNameAny(input.name);
          const stops: string[] = [];
          if (managedLocalRuntime()) {
            return {
              ok: false,
              name: input.name,
              stops,
              error: "ManagedWorkloadRetirementRequired",
            };
          }
          if (!input.keepRunning) {
            const refused =
              manifest.kind === "ModelHost"
                ? await stopModelHostForDelete(manifest, stops)
                : await stopWorkloadForDelete(manifest, stops);
            if (refused !== null) {
              return { ok: false, name: input.name, stops, error: refused };
            }
          }
          const removed = workloadStoreMod.deleteWorkload(input.name);
          return { ok: removed, name: input.name, stops };
        },
      );
    }),

  workloadValidate: t.procedure.input(z.object({ yaml: z.string().min(1) })).query(({ input }) => {
    try {
      const parsed = workloadStoreMod.parseManifestYaml(input.yaml);
      if (!parsed || typeof parsed !== "object") {
        return { ok: false as const, error: "invalid workload manifest: expected a YAML mapping" };
      }
      const kind = (parsed as { kind?: unknown }).kind;
      if (kind === "ModelRun") {
        const parsedRun = ModelRunSchema.safeParse(parsed);
        if (!parsedRun.success) {
          return { ok: false as const, error: parsedRun.error.message };
        }
        return { ok: true as const, manifest: parsedRun.data };
      }
      if (kind === "ModelHost") {
        const parsedHost = ModelHostManifestSchema.safeParse(parsed);
        if (!parsedHost.success) {
          return { ok: false as const, error: parsedHost.error.message };
        }
        return { ok: true as const, manifest: parsedHost.data };
      }
      return {
        ok: false as const,
        error: `unsupported workload kind: ${typeof kind === "string" ? kind : "missing"}`,
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }),

  // Export the spec schema shape so the UI can build default manifests
  // from a model + node without re-declaring the whole zod graph.
  // We only return the JSON string of a template here; the real schema
  // is still validated inside workloadApply.
  // ---- reconciler loop (auto-heal) ------------------------------------

  reconcilerStatus: t.procedure.query(() => reconcileLoopMod.reconcileLoopStatus()),

  reconcilerEvents: t.procedure.query(() => reconcileLoopMod.reconcileLoopEvents()),

  reconcilerStart: t.procedure
    .input(
      z
        .object({
          intervalSeconds: z.number().int().positive().min(5).max(600).optional(),
        })
        .optional(),
    )
    .mutation(({ input }) => {
      refuseLegacyManagedMutation("ManagedControllerOwnerConflict");
      const cfg = kubecfg.loadConfig();
      const resolveNodeIdentity = (n: string): string | null => {
        try {
          return kubecfg.resolveNode(cfg, n).node.endpoint || null;
        } catch {
          return null;
        }
      };
      reconcileLoopMod.startReconcileLoop({
        intervalMs: (input?.intervalSeconds ?? 10) * 1000,
        getClient: (nodeName) => clientForNode(cfg, nodeName),
        resolveNodeIdentity,
      });
      return reconcileLoopMod.reconcileLoopStatus();
    }),

  reconcilerStop: t.procedure.mutation(() => {
    reconcileLoopMod.stopReconcileLoop();
    return reconcileLoopMod.reconcileLoopStatus();
  }),

  reconcilerKick: t.procedure.mutation(async () => {
    refuseLegacyManagedMutation("ManagedControllerOwnerConflict");
    const cfg = kubecfg.loadConfig();
    const resolveNodeIdentity = (n: string): string | null => {
      try {
        return kubecfg.resolveNode(cfg, n).node.endpoint || null;
      } catch {
        return null;
      }
    };
    await reconcileLoopMod.kickReconcileLoop({
      getClient: (nodeName) => clientForNode(cfg, nodeName),
      resolveNodeIdentity,
    });
    return reconcileLoopMod.reconcileLoopStatus();
  }),

  // ---- bench scheduler ------------------------------------------------

  benchScheduleList: t.procedure.query(() => benchScheduleMod.loadSchedules()),

  benchScheduleAdd: t.procedure
    .input(
      z.object({
        id: z.string().min(1),
        node: z.string().min(1),
        rel: z.string().min(1),
        mode: z.enum(["auto", "text", "vision"]).optional(),
        intervalSeconds: z
          .number()
          .int()
          .min(60)
          .max(30 * 24 * 3600),
        kind: z.enum(["preset", "suite"]).optional(),
        suite: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._-]*$/)
          .optional(),
        engine: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._-]*$/)
          .optional(),
        slots: z.number().int().positive().optional(),
        quant: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
          .max(64)
          .optional(),
        ctx: z.number().int().positive().optional(),
        flags: z.array(z.string().regex(/^\S+$/)).min(1).max(256).optional(),
        hfRevision: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      const path = benchScheduleMod.defaultScheduleFilePath();
      const existing = benchScheduleMod.loadSchedules(path);
      const next = benchScheduleMod.addSchedule(existing, {
        id: input.id,
        node: input.node,
        rel: input.rel,
        mode: input.mode ?? "auto",
        intervalSeconds: input.intervalSeconds,
        enabled: true,
        kind: input.kind,
        suite: input.suite,
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.slots !== undefined ? { slots: input.slots } : {}),
        ...(input.quant !== undefined ? { quant: input.quant } : {}),
        ...(input.ctx !== undefined ? { ctx: input.ctx } : {}),
        ...(input.flags !== undefined ? { flags: input.flags } : {}),
        ...(input.hfRevision !== undefined ? { hfRevision: input.hfRevision } : {}),
      });
      benchScheduleMod.saveSchedules(next, path);
      return next;
    }),

  benchScheduleRemove: t.procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      const path = benchScheduleMod.defaultScheduleFilePath();
      const next = benchScheduleMod.removeSchedule(benchScheduleMod.loadSchedules(path), input.id);
      benchScheduleMod.saveSchedules(next, path);
      return next;
    }),

  benchScheduleToggle: t.procedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ input }) => {
      const path = benchScheduleMod.defaultScheduleFilePath();
      const next = benchScheduleMod.updateSchedule(benchScheduleMod.loadSchedules(path), input.id, {
        enabled: input.enabled,
      });
      benchScheduleMod.saveSchedules(next, path);
      return next;
    }),

  benchSchedulerStatus: t.procedure.query(() => benchScheduleLoopMod.benchSchedulerStatus()),

  benchSchedulerStart: t.procedure
    .input(
      z
        .object({
          tickIntervalSeconds: z.number().int().min(30).max(3600).optional(),
        })
        .optional(),
    )
    .mutation(({ input, ctx }) => {
      const cfg = kubecfg.loadConfig();
      benchScheduleLoopMod.startBenchScheduler({
        tickIntervalMs: (input?.tickIntervalSeconds ?? 60) * 1000,
        getClient: (nodeName) => clientForNode(cfg, nodeName),
        ...(ctx.benchSuiteRunner !== undefined ? { runSuite: ctx.benchSuiteRunner } : {}),
      });
      return benchScheduleLoopMod.benchSchedulerStatus();
    }),

  benchSchedulerStop: t.procedure.mutation(() => {
    benchScheduleLoopMod.stopBenchScheduler();
    return benchScheduleLoopMod.benchSchedulerStatus();
  }),

  benchSchedulerKick: t.procedure.mutation(async ({ ctx }) => {
    const cfg = kubecfg.loadConfig();
    await benchScheduleLoopMod.kickBenchScheduler((nodeName) => clientForNode(cfg, nodeName), {
      ...(ctx.benchSuiteRunner !== undefined ? { runSuite: ctx.benchSuiteRunner } : {}),
    });
    return benchScheduleLoopMod.benchSchedulerStatus();
  }),

  workloadTemplate: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        node: z.string().min(1),
        target: z.string().min(1),
        targetKind: z.enum(["rel", "alias"]).default("rel"),
        extraArgs: z.array(z.string()).default([]),
        timeoutSeconds: z.number().int().positive().default(60),
      }),
    )
    .query(({ input }) => {
      const spec = ModelRunSpecSchema.parse({
        node: input.node,
        target: { kind: input.targetKind, value: input.target },
        extraArgs: input.extraArgs,
        timeoutSeconds: input.timeoutSeconds,
      });
      const manifest: ModelRun = {
        apiVersion: "llamactl/v1",
        kind: "ModelRun",
        metadata: { name: input.name, labels: {}, annotations: {} },
        spec,
      };
      return manifest;
    }),

  // ---- infra package management -----------------------------------
  // Operates on the local agent's infra directory
  // (<DEV_STORAGE|~/.llamactl>/infra/). Central calls these via the
  // dispatcher to install/activate/remove llama-cpp / embersynth /
  // sirius on a specific node.

  infraList: t.procedure.query(() => infraLayoutMod.listInstalledInfra()),

  infraCurrent: t.procedure
    .input(z.object({ pkg: infraIdentifier }))
    .query(({ input }) => infraLayoutMod.resolveCurrentVersion(input.pkg)),

  infraInstall: t.procedure
    .input(
      z.object({
        pkg: infraIdentifier,
        version: infraIdentifier,
        tarballUrl: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        activate: z.boolean().default(true),
        skipIfPresent: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input }) => {
      return await infraInstallMod.installInfraPackage({
        pkg: input.pkg,
        version: input.version,
        tarballUrl: input.tarballUrl,
        sha256: input.sha256,
        activate: input.activate,
        skipIfPresent: input.skipIfPresent,
      });
    }),

  infraActivate: t.procedure
    .input(z.object({ pkg: infraIdentifier, version: infraIdentifier }))
    .mutation(({ input }) => {
      infraLayoutMod.activateInfraVersion(input.pkg, input.version);
      return { ok: true as const };
    }),

  infraUninstall: t.procedure
    .input(
      z.object({
        pkg: infraIdentifier,
        version: infraIdentifier.optional(),
      }),
    )
    .mutation(({ input }) => {
      if (input.version) {
        const removed = infraLayoutMod.removeInfraVersion(input.pkg, input.version);
        return { ok: true as const, mode: "version" as const, removed };
      }
      const removed = infraLayoutMod.removeInfraPackage(input.pkg);
      return { ok: true as const, mode: "package" as const, removed };
    }),

  // Service lifecycle — drives launchd/systemd for supervised pkgs
  // (embersynth, sirius). llama-cpp is a binary, not a service, so
  // these procs return a clear error when called on a pkg without a
  // unit file on disk.
  infraServiceWriteUnit: t.procedure
    .input(
      z.object({
        pkg: infraIdentifier,
        env: z.record(z.string(), z.string()).default({}),
        args: z.array(z.string()).default([]),
      }),
    )
    .mutation(({ input }) => {
      const base = infraLayoutMod.defaultInfraDir();
      const logDir = infraServicesMod.defaultInfraLogsDir();
      const written = infraServicesMod.writeServiceUnit({
        pkg: input.pkg,
        infraBase: base,
        logDir,
        env: input.env,
        args: input.args,
      });
      return { ok: true as const, ...written };
    }),

  infraServiceLifecycle: t.procedure
    .input(
      z.object({
        pkg: infraIdentifier,
        action: z.enum(["start", "stop", "reload", "status"]),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await infraServicesMod.runServiceLifecycle({
        pkg: input.pkg,
        action: input.action,
      });
      return {
        ok: result.code === 0,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        host: result.host,
        label: result.label,
      };
    }),

  catalogList: t.procedure
    .input(z.enum(["all", "builtin", "custom"]).default("all"))
    .query(({ input }) => {
      // Mirror the CLI's `catalog status` signal: a row is "installed"
      // when the GGUF exists under $LLAMA_CPP_MODELS. The renderer uses
      // this to gate the Uninstall action, which is a no-op otherwise.
      const resolved = envMod.resolveEnv();
      return catalog.listCatalog(input).map((entry) => ({
        ...entry,
        installed: existsSync(join(resolved.LLAMA_CPP_MODELS, entry.rel)),
      }));
    }),

  catalogStatus: t.procedure.input(z.string().min(1)).query(async ({ input }) => {
    const entry = catalog.findByRel(input);
    // Class resolution intentionally lives in the renderer's dedicated
    // inspector view later; for now surface the catalog row + quant.
    return {
      rel: input,
      entry,
      quant: (await import("@llamactl/core")).quant.quantFromRel(input),
    };
  }),

  benchShow: t.procedure.input(z.string().min(1)).query(({ input }) => {
    const resolved = envMod.resolveEnv();
    const rows = bench.readBenchProfiles(bench.benchProfileFile(resolved));
    const machine = bench.machineLabel(resolved);
    const mode = bench.defaultModeForRel(input, resolved);
    const ctx = resolved.LLAMA_CPP_GEMMA_CTX_SIZE;
    const build = ""; // resolved by caller if they care
    const latest = bench.findLatestProfile(rows, {
      machine,
      rel: input,
      mode,
      ctx,
      build,
    });
    if (latest) return { kind: "current" as const, row: latest };
    const legacy = bench.findLegacyProfile(rows, input);
    if (legacy) return { kind: "legacy" as const, row: legacy };
    return { kind: "none" as const };
  }),

  benchCompare: t.procedure
    .input(
      z
        .object({
          classFilter: z.string().optional(),
          scopeFilter: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) =>
      bench.benchCompare({
        classFilter: (input?.classFilter ?? "all") as
          | "multimodal"
          | "reasoning"
          | "general"
          | "custom"
          | "all",
        scopeFilter: input?.scopeFilter ?? "all",
      }),
    ),

  recommendations: t.procedure.input(z.string().default("current")).query(async ({ input }) => {
    const profiles = recommendations.expandRequestedProfile(input);
    const out = [] as {
      profile: MachineProfile;
      rows: recommendations.RecommendationRow[];
    }[];
    for (const profile of profiles) {
      const rows = await recommendations.recommendationsWithHf(profile);
      out.push({ profile, rows });
    }
    return out;
  }),

  promotions: t.procedure.query(() => {
    const resolved = envMod.resolveEnv();
    return presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
  }),

  promote: t.procedure
    .input(
      z.object({
        profile: z.enum(MACHINE_PROFILES),
        preset: z.enum(presets.PRESET_NAMES),
        rel: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      try {
        presets.writePresetOverride(input.profile, input.preset, input.rel);
      } catch (err) {
        if (err instanceof presets.ExperimentalPresetPromotionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
      const resolved = envMod.resolveEnv();
      return presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
    }),

  promoteDelete: t.procedure
    .input(
      z.object({
        profile: z.enum(MACHINE_PROFILES),
        preset: z.enum(presets.PRESET_NAMES),
      }),
    )
    .mutation(({ input }) => {
      presets.deletePresetOverride(input.profile, input.preset);
      const resolved = envMod.resolveEnv();
      return presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
    }),

  serverStatus: t.procedure
    .input(z.object({ workload: z.string().min(1) }))
    .query(async ({ input }) => await serverMod.serverStatus({ name: input.workload })),

  serverLogs: t.procedure
    .input(
      z.object({
        workload: z.string().min(1),
        lines: z.number().int().min(0).max(1000).optional(),
        follow: z.boolean().optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<serverLogsMod.LogLineEvent>(signal, (emit, sig) =>
        serverLogsMod.tailServerLog({
          key: { name: input.workload },
          ...(input.lines !== undefined ? { lines: input.lines } : {}),
          ...(input.follow !== undefined ? { follow: input.follow } : {}),
          signal: sig,
          onLine: emit,
        }),
      );
    }),

  serverStop: t.procedure
    .input(
      z.object({
        workload: z.string().min(1),
        graceSeconds: z.number().int().positive().max(60).optional(),
      }),
    )
    .mutation(
      async ({ ctx, input }): Promise<serverMod.StopServerResult> =>
        !ctx.ownerStopIntent && managedLocalRuntime()
          ? {
              stopped: false,
              pid: null,
              killed: false,
              managedRefusal: "ManagedStopIntentRequired",
            }
          : await fenceWorkloadStop<serverMod.StopServerResult>({
              workload: input.workload,
              ...(ctx.ownerStopWait === undefined ? {} : { wait: ctx.ownerStopWait }),
              stop: async () => {
                const managed = ctx.managedLaunchAdmission;
                const proof = managed?.prepareStopRelease?.(input.workload, "ModelRun");
                if (managed !== undefined && proof === undefined) {
                  return {
                    stopped: false,
                    pid: null,
                    killed: false,
                    managedRefusal: "ManagedStopGenerationUnverified",
                  };
                }
                const outcome = await runDirectResidencyStop<{
                  ok: boolean;
                  error?: string;
                  stop: serverMod.StopServerResult;
                }>(
                  input.workload,
                  async () => {
                    const stopped = await runOwnedStop(managed, () =>
                      serverMod.stopServer({
                        key: { name: input.workload },
                        ...(input.graceSeconds !== undefined
                          ? { graceSeconds: input.graceSeconds }
                          : {}),
                        ...(proof === undefined
                          ? {}
                          : { identity: { verifyGeneration: proof.verifyGeneration } }),
                      }),
                    );
                    const stop: serverMod.StopServerResult =
                      stopped.stopped && !stopReleased(proof, stopped.pid)
                        ? {
                            ...stopped,
                            stopped: false,
                            managedRefusal: "ManagedStopReleaseUnverified",
                          }
                        : stopped;
                    return {
                      ok: stop.stopped,
                      ...(stop.stopped ? {} : { error: "stop did not confirm process removal" }),
                      stop,
                    };
                  },
                  {
                    ...directModelRunOpts(input.workload),
                    requireVerifiedStopJournal: managed !== undefined && managedLocalRuntime(),
                  },
                );
                return outcome.ran ? outcome.result.stop : stopTransitionRefusal(outcome.detail);
              },
              isVerifiedStop: (r) => r.stopped,
              refuse: (refused) => ({ stopped: false, pid: null, killed: false, refused }),
            }),
    ),

  // DF-05 (#278): explicit operator override of the stop fence. Unlike
  // serverStop/modelHostStop this never routes through fenceWorkloadStop: it
  // revokes held leases via the fencing drain token instead of refusing.
  // `confirm: true` is required (z.literal) and the unload is audited as
  // "operator: <reason>". An idle unload (no leases held) writes no audit row.
  // #517: the engine stop now rides runDirectResidencyStop, so a confirmed
  // force-unload drives its residency_states row down the fenced walk after
  // commitUnload; an unconfirmed one keeps the row occupying.
  residencyForceUnload: t.procedure
    .input(
      z.object({
        workload: z.string().min(1),
        reason: z.string().trim().min(1).max(200),
        confirm: z.literal(true),
      }),
    )
    .mutation(async ({ input }): Promise<ForceUnloadResult> => {
      refuseLegacyManagedMutation("ManagedForceUnloadRequiresOwner");
      const name = input.workload;
      const kind: ForceUnloadKind | null = workloadStoreMod
        .listWorkloads()
        .some((m) => m.metadata.name === name)
        ? "modelrun"
        : modelHostStoreMod.listModelHosts().some((h) => h.metadata.name === name)
          ? "modelhost"
          : null;
      const registry = getResidencyLeaseRegistry();
      // The wrapper never refuses a stop: forceUnloadWorkload calls stop() only
      // after commitUnload, so the engine still stops while the fence drains and
      // the row is recorded (a store-less node runs unrecorded, never creating
      // the store). A thrown dep is recorded failed and rethrown here; the
      // existing try/catch in forceUnloadWorkload maps it to StopFailed. An
      // unconfirmed stop keeps the row occupying and is logged by the wrapper.
      const stop: ForceUnloadStop =
        kind === "modelhost"
          ? async (): Promise<{ stopped: boolean; detail?: string }> => {
              const outcome = await runDirectResidencyStop<StopModelHostResult>(
                name,
                () => stopModelHost({ key: { name } }),
                directResidencyOpts(name, undefined),
              );
              const r = outcome.ran
                ? outcome.result
                : { ok: false, pid: null, error: outcome.detail };
              return {
                stopped: r.ok,
                ...(r.error !== undefined ? { detail: r.error } : {}),
              };
            }
          : async (): Promise<{ stopped: boolean; detail?: string }> => {
              const outcome = await runDirectResidencyStop<{
                ok: boolean;
                error?: string;
                stop: serverMod.StopServerResult;
              }>(
                name,
                async () => {
                  const s = await serverMod.stopServer({ key: { name } });
                  return {
                    ok: s.stopped,
                    ...(s.stopped ? {} : { error: "stop did not confirm process removal" }),
                    stop: s,
                  };
                },
                directModelRunOpts(name),
              );
              const stopped = outcome.ran && outcome.result.ok;
              return stopped
                ? { stopped }
                : {
                    stopped,
                    ...(outcome.ran && outcome.result.error !== undefined
                      ? { detail: outcome.result.error }
                      : {}),
                  };
            };
      return await forceUnloadWorkload({
        workload: name,
        reason: input.reason,
        kind,
        registry,
        stop,
      });
    }),

  // #520: per-session explicit release. Unlike residencyForceUnload this
  // never drains, revokes leases or stops anything — it drops only the
  // session binding, so the DF-05 leases of in-flight requests stay held.
  // The sessionId bounds match openaiProxy's MAX_SESSION_ID_LENGTH /
  // SESSION_ID_PATTERN.
  residencyReleaseSession: t.procedure
    .input(
      z.object({
        sessionId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        force: z.boolean().optional(),
        confirm: z.literal(true),
      }),
    )
    .mutation(
      ({ input }): ReleaseSessionResult =>
        releaseResidencySession({ sessionId: input.sessionId, force: input.force === true }),
    ),

  serverStart: t.procedure.input(ServerStartInputSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }) {
    yield* bridgeEventStream<ServerStartEvent>(signal, async (emit, sig) => {
      const managed = ctx.managedLaunchAdmission;
      const outcome = await runModelRunStart(input, sig, emit, managed);
      const result = outcome.ran ? outcome.result : serverStartRefusal(input, outcome.detail);
      if (managed !== undefined && result.ok && result.pid !== null) {
        emit({ type: "ready", pid: result.pid, endpoint: result.endpoint });
      }
      emit({ type: "done", result });
    });
  }),

  lmstudioScan: t.procedure
    .input(z.object({ root: z.string().optional() }).optional())
    .query(({ input }) =>
      lmstudioMod.scanLMStudio({ ...(input?.root !== undefined ? { root: input.root } : {}) }),
    ),

  lmstudioPlan: t.procedure
    .input(
      z
        .object({
          root: z.string().optional(),
          link: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const plan = lmstudioMod.planImport({
        ...(input?.root !== undefined ? { root: input.root } : {}),
        ...(input?.link !== undefined ? { link: input.link } : {}),
      });
      // Surface the resolver's canonical default so the UI can show it
      // as a placeholder without recomputing paths client-side. Under
      // $LLAMACTL_TEST_PROFILE this re-roots to the profile-scoped dir.
      return { ...plan, defaultRoot: lmstudioMod.defaultLMStudioRoot() };
    }),

  lmstudioImport: t.procedure
    .input(
      z.object({
        root: z.string().optional(),
        link: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) =>
      lmstudioMod.applyImport({
        ...(input.root !== undefined ? { root: input.root } : {}),
        ...(input.link !== undefined ? { link: input.link } : {}),
        apply: true,
      }),
    ),

  keepAliveStatus: t.procedure.query(() => keepAliveMod.keepAliveStatus()),

  rpcServerStatus: t.procedure.query(async () => await rpcServerMod.rpcServerStatus()),

  /**
   * Preflight check for tensor-parallel apply. Fires before any
   * `rpcServerStart` call in `applyOne` → `startWorkers` and surfaces
   * a structured reason + build hint when `$LLAMA_CPP_BIN/rpc-server`
   * is missing (stock llama.cpp builds lack it — it only lands with
   * `-DGGML_RPC=ON`). Also available interactively as the
   * `llamactl agent rpc-doctor --node <name>` CLI.
   */
  rpcServerDoctor: t.procedure
    .input(z.object({}))
    .query(() => rpcServerMod.checkRpcServerAvailable()),

  rpcServerStop: t.procedure
    .input(z.object({ graceSeconds: z.number().int().positive().max(60).optional() }).optional())
    .mutation(
      async ({ input }) =>
        await rpcServerMod.stopRpcServer({
          ...(input?.graceSeconds !== undefined ? { graceSeconds: input.graceSeconds } : {}),
        }),
    ),

  rpcServerStart: t.procedure
    .input(
      z.object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535),
        modelPath: z.string().optional(),
        extraArgs: z.array(z.string()).optional(),
        timeoutSeconds: z.number().int().positive().max(300).optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      type RpcEvent =
        | rpcServerMod.RpcServerEvent
        | { type: "done"; result: rpcServerMod.StartRpcServerResult };
      yield* bridgeEventStream<RpcEvent>(signal, async (emit, sig) => {
        const result = await rpcServerMod.startRpcServer({
          port: input.port,
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.modelPath !== undefined ? { modelPath: input.modelPath } : {}),
          ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}),
          ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
          signal: sig,
          onEvent: emit,
        });
        emit({ type: "done", result });
      });
    }),

  // #520: `llamactl keep-alive stop` on remote and local dispatch now runs
  // through the same node stop fence as serverStop. A held lease refuses first
  // (LeasesActive/DrainInProgress), then a bound session refuses
  // (SessionsActive/SessionsUnknown), and the refusal applies whether or not
  // a supervisor is tracked, so stale tracking files are not cleaned while a
  // session is bound. The fence never releases sessions; the override is
  // `residency force-unload`. With no lease registry installed the result is
  // byte-identical to the unfenced call.
  keepAliveStop: t.procedure
    .input(
      z.object({
        workload: z.string().min(1),
        graceSeconds: z.number().int().positive().max(60).optional(),
      }),
    )
    .mutation(
      async ({ input }) =>
        await fenceWorkloadStop<keepAliveMod.StopKeepAliveResult>({
          workload: input.workload,
          stop: () =>
            keepAliveMod.stopKeepAlive({
              key: { name: input.workload },
              ...(input.graceSeconds !== undefined ? { graceSeconds: input.graceSeconds } : {}),
            }),
          // A null pid means no supervisor was tracked and stopKeepAlive
          // never ran stopServer, so committing the unload would mark a
          // separately started live server unloaded.
          isVerifiedStop: (r) => r.stopped && r.pid !== null,
          refuse: (refused) => ({ stopped: false, pid: null, killed: false, refused }),
        }),
    ),

  keepAliveStart: t.procedure
    .input(z.object({ target: z.string().min(1) }))
    .mutation(async ({ input }) => {
      // Spawn a detached `llamactl keep-alive worker <target>` child by
      // shelling out to `bun` with the CLI entry. Matches what
      // \`llamactl keep-alive start\` does from a shell session.
      const { spawn } = await import("node:child_process");
      const { join } = await import("node:path");
      const resolved = envMod.resolveEnv();
      const existing = keepAliveMod.readKeepAliveRecord(resolved);
      if (existing.pid !== null && existing.verdict === "alive") {
        return {
          ok: false,
          pid: existing.pid,
          error: `keep-alive already running (pid=${String(existing.pid)})`,
        };
      }
      // An unverifiable record must not be treated as absent: a second
      // supervisor would compete with a process we cannot rule out as ours.
      if (existing.pid !== null && existing.verdict === "unknown") {
        return {
          ok: false,
          pid: existing.pid,
          error: `pid identity unknown for recorded keep-alive pid ${String(existing.pid)} — refusing to start a duplicate`,
        };
      }
      const groupRefusal = keepAliveStartRefusal(input.target);
      if (groupRefusal !== null) {
        return { ok: false, pid: null, error: `keep-alive start: ${groupRefusal}` };
      }
      const llamactlHome =
        process.env["LLAMACTL_HOME"] ?? join(resolved.DEV_STORAGE, "repos", "personal", "llamactl");
      const entry = join(llamactlHome, "packages", "cli", "src", "bin.ts");
      const child = spawn("bun", [entry, "keep-alive", "worker", input.target], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
      const startedAt = Date.now();
      let pid: number | null = null;
      while (Date.now() - startedAt < 2000) {
        pid = keepAliveMod.readKeepAlivePid(resolved);
        if (pid !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        ok: pid !== null,
        pid,
        error: pid === null ? "supervisor did not register a PID within 2s" : undefined,
      };
    }),

  candidateTestRun: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().optional(),
        profile: z.string().optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<CandidateStreamEvent>(signal, async (emit, sig) => {
        const result = await candidateMod.candidateTest({
          repo: input.repo,
          ...(input.file !== undefined ? { file: input.file } : {}),
          ...(input.profile !== undefined ? { profile: input.profile } : {}),
          signal: sig,
          onEvent: emit,
          launchRefusal: benchLaunchRefusal,
        });
        if ("error" in result) throw new Error(result.error);
        emit({ type: "done-candidate-test", result });
      });
    }),

  uninstall: t.procedure
    .input(
      z.object({
        rel: z.string().min(1),
        force: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      // Surface the structured report as-is. `code` is 0 on success,
      // non-zero on refusal (e.g. non-candidate scope without --force),
      // with `error` carrying the human message the CLI prints.
      return uninstallMod.uninstall({
        rel: input.rel,
        ...(input.force !== undefined ? { force: input.force } : {}),
      });
    }),

  autotuneAfterPull: t.procedure
    .input(
      z.object({
        rel: z.string().min(1),
        wasMissing: z.boolean(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      type TuneEvent =
        | bench.BenchEvent
        | { type: "done-tune"; result: autotuneMod.MaybeTuneAfterPullResult };
      yield* bridgeEventStream<TuneEvent>(signal, async (emit, sig) => {
        const result = await autotuneMod.maybeTuneAfterPull({
          rel: input.rel,
          wasMissing: input.wasMissing,
          signal: sig,
          onEvent: emit,
          launchRefusal: benchLaunchRefusal,
        });
        emit({ type: "done-tune", result });
      });
    }),

  pullFile: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().min(1),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<PullStreamEvent>(signal, async (emit, sig) => {
        const result = await pull.pullRepoFile({
          repo: input.repo,
          file: input.file,
          signal: sig,
          onEvent: emit,
        });
        emit({ type: "done", result });
      });
    }),

  benchHistory: t.procedure
    .input(
      z
        .object({
          rel: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const resolved = envMod.resolveEnv();
      const rows = bench.readBenchHistory(bench.benchHistoryFile(resolved));
      const limit = input?.limit ?? 50;
      const filter = input?.rel;
      const merged = [
        ...rows.current.map((r) => ({
          updated_at: r.updated_at,
          machine: r.machine,
          rel: r.rel,
          mode: r.mode,
          ctx: r.ctx,
          build: r.build,
          profile: r.profile,
          gen_ts: r.gen_ts,
          prompt_ts: r.prompt_ts,
          launch_args: r.launch_args,
          kind: "current" as const,
        })),
        ...rows.legacy.map((r) => ({
          updated_at: r.updated_at,
          machine: "legacy",
          rel: r.rel,
          mode: "legacy",
          ctx: "legacy",
          build: "legacy",
          profile: r.profile,
          gen_ts: r.gen_ts,
          prompt_ts: r.prompt_ts,
          launch_args: r.launch_args,
          kind: "legacy" as const,
        })),
      ];
      const filtered = filter ? merged.filter((r) => r.rel === filter) : merged;
      filtered.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return filtered.slice(-limit);
    }),

  benchVisionRows: t.procedure.query(() => {
    const resolved = envMod.resolveEnv();
    return bench.readBenchVision(bench.benchVisionFile(resolved));
  }),

  benchPresetRun: t.procedure
    .input(
      z.object({
        target: z.string().min(1),
        mode: z.enum(["auto", "text", "vision"]).optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<BenchStreamEvent>(signal, async (emit, sig) => {
        const refusal = benchLaunchRefusal(input.target);
        if (refusal !== null) throw new Error(refusal);
        const result = await bench.benchPreset({
          target: input.target,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          signal: sig,
          onEvent: emit,
        });
        if ("error" in result) throw new Error(result.error);
        emit({ type: "done-preset", result });
      });
    }),

  benchVisionRun: t.procedure
    .input(z.object({ target: z.string().min(1) }))
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<BenchStreamEvent>(signal, async (emit, sig) => {
        const refusal = benchLaunchRefusal(input.target);
        if (refusal !== null) throw new Error(refusal);
        const result = await bench.benchVision({
          target: input.target,
          signal: sig,
          onEvent: emit,
        });
        if ("error" in result) throw new Error(result.error);
        emit({ type: "done-vision", result });
      });
    }),

  pullCandidate: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().optional(),
        profile: z.string().optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<PullStreamEvent>(signal, async (emit, sig) => {
        const result = await pull.pullCandidate({
          repo: input.repo,
          ...(input.file !== undefined ? { file: input.file } : {}),
          ...(input.profile !== undefined ? { profile: input.profile } : {}),
          signal: sig,
          onEvent: emit,
        });
        if ("error" in result) throw new Error(result.error);
        emit({ type: "done-candidate", result });
      });
    }),

  discover: t.procedure
    .input(
      z
        .object({
          filter: z.string().optional(),
          profile: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(
      async ({ input }) =>
        await discovery.discover({
          ...(input?.filter !== undefined ? { filter: input.filter } : {}),
          ...(input?.profile !== undefined ? { requestedProfile: input.profile } : {}),
          ...(input?.limit !== undefined ? { limit: input.limit } : {}),
        }),
    ),

  resolveTarget: t.procedure.input(z.string()).query(({ input }) => targetMod.resolveTarget(input)),

  /**
   * LLM-backed operator planner. Translates a natural-language goal
   * into a validated PlanSchema-shaped sequence of MCP tool calls.
   * Defaults to the canned stub executor so the Electron view renders
   * something useful out of the box; `mode: 'llm'` + a model + an
   * API key env name drives a real OpenAI-compat call. The renderer
   * seeds the tool catalog because the planner is deliberately
   * harness-agnostic.
   */
  operatorPlan: t.procedure
    .input(
      z.object({
        goal: z.string().min(1),
        context: z.string().optional(),
        nodeId: z.string().optional(),
        model: z.string().optional(),
        tools: z
          .array(
            z.object({
              name: z.string().min(1),
              description: z.string(),
              tier: z.enum(SAFETY_TIERS),
            }),
          )
          .optional(),
        /**
         * Optional multi-turn history. Each entry captures a prior
         * operator-plan exchange: the user's goal/refinement, and a
         * short summary of the plan the assistant returned. The router
         * folds these into the `context` string before handing off to
         * `runPlanner`, so the underlying planner stays history-unaware
         * and continues to accept a single flat string.
         */
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              text: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      let executor: PlannerExecutor = stubPlannerExecutor;
      if (input.nodeId) {
        if (!input.model) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "model is required when nodeId is set",
          });
        }
        const provider = await resolvePlannerProvider(input.nodeId);
        executor = createLlmExecutor({ provider, model: input.model });
      }
      const callerTools: PlannerToolDescriptor[] = (input.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: "object" },
        tier: t.tier,
      }));
      // Merge caller-supplied tools with server-side built-ins (e.g.
      // composite.apply). Caller wins on name collision so UI-defined
      // descriptions can override defaults if ever needed. Phase 5's
      // ops-chat dispatch routes composite.apply plan steps to the
      // `compositeApply` tRPC procedure — this layer only teaches the
      // planner that the tool exists and when to prefer it.
      const plannerTools = mergePlannerTools(callerTools, BUILT_IN_PLANNER_TOOLS);

      // Fold history into the context string so the planner sees the
      // ongoing conversation. Keep the formatting deterministic — one
      // line per role, trimmed — so stub mode still produces stable
      // plans and the LLM executor gets a clean chat transcript.
      const history = input.history ?? [];
      const transcript = history
        .map((turn) => `${turn.role}: ${turn.text.trim()}`)
        .filter((line) => line.length > `user:`.length)
        .join("\n");
      const userContext = input.context?.trim() ?? "";
      const mergedContext = [transcript, userContext].filter((s) => s.length > 0).join("\n\n");

      const result = await runPlanner({
        goal: input.goal,
        context: mergedContext,
        tools: plannerTools,
        executor,
        allowlist: DEFAULT_ALLOWLIST,
      });
      return result;
    }),

  /**
   * Cost dashboard — snapshot.
   *
   * Aggregates the local `~/.llamactl/usage/*.jsonl` corpus into the
   * same per-provider / per-model rollup the `nova.ops.cost.snapshot`
   * MCP tool produces, but over direct function call — no MCP hop.
   * The Electron dashboard polls this on a user-selected window.
   */
  costSnapshot: t.procedure
    .input(
      z
        .object({
          days: z.number().int().positive().max(90).default(7),
        })
        .default({ days: 7 }),
    )
    .query(({ input }) => {
      return computeCostSnapshot({ days: input.days });
    }),

  /**
   * Cost dashboard — guardian status.
   *
   * Loads the cost-guardian YAML config (defaults if absent), runs one
   * snapshot for daily (1-day) + weekly (7-day) windows, and asks the
   * pure decision function what tier the current spend crosses. Never
   * mutates — the dashboard reads this to show the gauge + tier badge.
   */
  costGuardianStatus: t.procedure.query(() => {
    const configPath = defaultCostGuardianConfigPath();
    const config = existsSync(configPath)
      ? loadCostGuardianConfig(configPath)
      : emptyCostGuardianConfig();
    const daily = computeCostSnapshot({ days: 1 });
    const weekly = computeCostSnapshot({ days: 7 });
    const decision = decideGuardianAction({
      config,
      daily: { snapshot: daily },
      weekly: { snapshot: weekly },
    });
    return {
      config: {
        budget: config.budget,
        thresholds: config.thresholds,
        hasWebhook: Boolean(config.webhook_url),
        autoForcePrivate: config.auto_force_private,
        autoDeregister: config.auto_deregister,
      },
      decision,
      daily,
      weekly,
    };
  }),

  /**
   * Cost dashboard — journal tail.
   *
   * Reads the cost-guardian JSONL journal and returns the last `limit`
   * entries (newest first). Empty array when the journal file doesn't
   * exist yet — the dashboard shows a "no ticks recorded" empty state
   * rather than erroring.
   */
  costJournalTail: t.procedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(({ input }) => {
      const path = defaultCostJournalPath();
      if (!existsSync(path)) return { entries: [] as CostJournalEntry[], path };
      const body = readFileSync(path, "utf8");
      const lines = body.split("\n").filter((l) => l.trim().length > 0);
      const entries: CostJournalEntry[] = [];
      for (const l of lines.slice(-input.limit).reverse()) {
        try {
          entries.push(JSON.parse(l) as CostJournalEntry);
        } catch {
          // skip malformed
        }
      }
      return { entries, path };
    }),

  /**
   * K.6 — Save a pipeline as an MCP tool stub.
   *
   * Writes a JSON file to `~/.llamactl/mcp/pipelines/<slug>.json`
   * (override via `LLAMACTL_MCP_PIPELINES_DIR`). The stub records the
   * pipeline's stages verbatim; `@llamactl/mcp` picks these up at
   * boot and mounts them as pre-registered tools named
   * `llamactl.pipeline.<slug>` that take a single `input` string.
   *
   * Purely declarative — the mcp server interprets the file, llamactl
   * here only persists it.
   */
  pipelineExportMcp: t.procedure
    .input(
      z.object({
        name: z
          .string()
          .min(1)
          .max(80)
          .describe("Human-friendly pipeline name; slugified for the file basename."),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("Short description surfaced to MCP clients."),
        stages: z
          .array(
            z.object({
              node: z.string().min(1),
              model: z.string().min(1),
              systemPrompt: z.string().default(""),
              capabilities: z.array(z.string()).default([]),
            }),
          )
          .min(1, "pipeline must have at least one stage"),
        overwrite: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) => {
      const slug =
        input.name
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")
          .replaceAll(/^-+|-+$/g, "") || `pipeline-${Date.now().toString(36)}`;
      // Cascade: override > DEV_STORAGE (honours hermetic audits and
      // the resolver's test-profile re-root seeded in Electron main)
      // > production default under the operator's homedir.
      const devStorage = nonEmpty(process.env["DEV_STORAGE"]);
      const baseDir =
        nonEmpty(process.env["LLAMACTL_MCP_PIPELINES_DIR"]) ??
        (devStorage
          ? join(devStorage, "mcp", "pipelines")
          : join(homedir(), ".llamactl", "mcp", "pipelines"));
      const outPath = join(baseDir, `${slug}.json`);
      if (!input.overwrite && existsSync(outPath)) {
        return {
          ok: false as const,
          path: outPath,
          slug,
          reason: "exists",
          message: `${outPath} already exists. Pass overwrite:true to replace.`,
        };
      }
      const stub = {
        apiVersion: "llamactl/v1" as const,
        kind: "PipelineTool" as const,
        name: `llamactl.pipeline.${slug}`,
        title: input.name,
        description:
          input.description ??
          `Multi-stage pipeline with ${String(input.stages.length)} stage${input.stages.length === 1 ? "" : "s"}.`,
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "Initial user content" },
          },
          required: ["input"],
        },
        stages: input.stages,
      };
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(stub, null, 2) + "\n", "utf8");
      return {
        ok: true as const,
        path: outPath,
        slug,
        toolName: stub.name,
        stageCount: input.stages.length,
      };
    }),

  /**
   * N.4 — Ops Chat tool dispatch.
   *
   * Takes an MCP-style tool name + arguments and runs the equivalent
   * tRPC procedure via `createCaller` (in-proc, no HTTP). Every call
   * appends one audit entry to `~/.llamactl/ops-chat/audit.jsonl`
   * (override via `LLAMACTL_OPS_CHAT_AUDIT`). Supported tools are
   * enumerated in `KNOWN_OPS_CHAT_TOOLS`; anything else returns a
   * structured `unknown_tool` error without throwing.
   */
  opsChatTools: t.procedure.query(() => ({
    tools: KNOWN_OPS_CHAT_TOOLS,
  })),

  operatorRunTool: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        dryRun: z.boolean().optional(),
        sessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input, signal }) => {
      const residencyMutation =
        input.name === RESIDENCY_CONTROL_TOOL || input.name === RESIDENCY_APPLY_PROFILE_TOOL;
      const dryRun = input.dryRun ?? residencyMutation;
      const ownerScoped = residencyMutation || input.name === RESIDENCY_CALIBRATION_KEY_TOOL;
      const caller = ownerScoped
        ? router.createCaller(omitUndefined(ctx), signal === undefined ? undefined : { signal })
        : router.createCaller({});
      const dispatched = await dispatchOpsChatTool(caller, {
        name: input.name,
        arguments: input.arguments,
        dryRun,
      });
      auditOpsChatToolRun({
        tool: input.name,
        arguments: input.arguments,
        dryRun,
        ok: dispatched.ok,
        durationMs: dispatched.durationMs,
        ...(dispatched.ok
          ? {}
          : {
              errorCode: dispatched.error?.code ?? "dispatch_error",
              errorMessage: dispatched.error?.message ?? "(no message)",
            }),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      });
      return dispatched;
    }),

  opsSessionList: t.procedure
    .input(
      z.object({
        limit: z.number().int().positive().max(200).default(50),
        cursor: z.string().optional(),
        status: z.enum(["live", "done", "refused", "aborted"]).optional(),
      }),
    )
    .query(({ input }) =>
      listSessions({
        limit: input.limit,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      }),
    ),

  opsSessionGet: t.procedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        tail: z.number().int().positive().max(500).default(50),
      }),
    )
    .query(async ({ input }) => {
      const summary = await getSessionSummary(input.sessionId);
      const events = await readJournal(input.sessionId);
      return { summary, recentEvents: events.slice(-input.tail) };
    }),

  opsSessionWatch: t.procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(({ input, signal }) => watchSession(input.sessionId, signal)),

  opsSessionDelete: t.procedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await deleteSession(input.sessionId);
      return { ok: true as const };
    }),

  opsChatAuditTail: t.procedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(100),
        })
        .default({ limit: 100 }),
    )
    .query(({ input }) => readOpsChatAudit({ limit: input.limit })),

  /**
   * N.4 Phase 1 — streaming Ops Chat loop.
   *
   * The subscription calls `runPlanner` per iteration, emits one
   * step at a time as `plan_proposed`, and blocks each iteration
   * until the caller posts an outcome via
   * `operatorSubmitStepOutcome`. Re-planning uses the accumulated
   * outcome transcript as additional context so the model can
   * adapt (retry on failure, pivot when a tool returns unexpected
   * data, terminate early when the goal is met).
   *
   * The one-shot `operatorPlan` mutation above is preserved for CLI
   * callers that just want a plan back without the approval loop.
   */
  operatorChatStream: t.procedure
    .input(
      z.object({
        goal: z.string().min(1),
        context: z.string().optional(),
        nodeId: z.string().optional(),
        model: z.string().optional(),
        tools: z
          .array(
            z.object({
              name: z.string().min(1),
              description: z.string(),
              tier: z.enum(SAFETY_TIERS),
            }),
          )
          .optional(),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              text: z.string(),
            }),
          )
          .optional(),
        maxIterations: z.number().int().positive().max(20).optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const { runLoopExecutor } = await import("./ops-chat/loop-executor.js");
      let executor: PlannerExecutor = stubPlannerExecutor;
      if (input.nodeId) {
        if (!input.model) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "model is required when nodeId is set",
          });
        }
        const provider = await resolvePlannerProvider(input.nodeId);
        executor = createLlmExecutor({ provider, model: input.model });
      }
      const callerTools: PlannerToolDescriptor[] = (input.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: "object" },
        tier: tool.tier,
      }));
      const plannerTools = mergePlannerTools(callerTools, BUILT_IN_PLANNER_TOOLS);
      const stream = runLoopExecutor({
        goal: input.goal,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.history !== undefined ? { history: input.history } : {}),
        tools: plannerTools,
        executor,
        allowlist: DEFAULT_ALLOWLIST,
        ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      for await (const event of stream) {
        if (signal?.aborted) break;
        yield event;
      }
    }),

  /**
   * Companion mutation to `operatorChatStream`. The caller runs the
   * proposed tool (via `operatorRunTool`), summarizes the outcome,
   * and posts it back here so the streaming loop's pending Deferred
   * resolves. Returns `{ ok: false, reason: 'stale' }` if the
   * session is gone or the stepId no longer matches — safe to
   * retry with an updated stepId.
   */
  operatorSubmitStepOutcome: t.procedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        stepId: z.string().min(1),
        ok: z.boolean(),
        summary: z.string(),
        abort: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { submitOutcome } = await import("./ops-chat/loop-executor.js");
      const delivered = submitOutcome({
        sessionId: input.sessionId,
        stepId: input.stepId,
        ok: input.ok,
        summary: input.summary,
        abort: input.abort,
      });
      return delivered
        ? ({ ok: true as const } as const)
        : ({ ok: false as const, reason: "stale" as const } as const);
    }),

  // ---- RAG (retrieval) --------------------------------------------------
  //
  // Each procedure opens a RetrievalProvider per call and closes it in
  // `finally`. Pooling is a follow-up (see rag-nodes.md Phase 4). The
  // adapter factory dispatches on `node.rag.provider`; nodes without
  // `kind: 'rag'` fail fast with BAD_REQUEST.

  ragSearch: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        query: z.string().min(1),
        topK: z.number().int().positive().max(100).default(10),
        filter: z.record(z.string(), z.unknown()).optional(),
        collection: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const { node, cfg } = resolveRagNode(input.node);
      const { createRagAdapter } = await import("./rag/index.js");
      const adapter = await createRagAdapter(node, { config: cfg });
      try {
        return await adapter.search({
          query: input.query,
          topK: input.topK,
          filter: input.filter,
          collection: input.collection,
        });
      } finally {
        await adapter.close();
      }
    }),

  ragStore: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        documents: z
          .array(
            z.object({
              id: z.string().min(1),
              content: z.string(),
              metadata: z.record(z.string(), z.unknown()).optional(),
              vector: z.array(z.number()).optional(),
            }),
          )
          .min(1),
        collection: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { node, cfg } = resolveRagNode(input.node);
      const { createRagAdapter } = await import("./rag/index.js");
      const adapter = await createRagAdapter(node, { config: cfg });
      try {
        return await adapter.store({
          documents: input.documents,
          collection: input.collection,
        });
      } finally {
        await adapter.close();
      }
    }),

  ragDelete: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        ids: z.array(z.string().min(1)).min(1),
        collection: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { node, cfg } = resolveRagNode(input.node);
      const { createRagAdapter } = await import("./rag/index.js");
      const adapter = await createRagAdapter(node, { config: cfg });
      try {
        return await adapter.delete({
          ids: input.ids,
          collection: input.collection,
        });
      } finally {
        await adapter.close();
      }
    }),

  ragListCollections: t.procedure
    .input(z.object({ node: z.string().min(1) }))
    .query(async ({ input }) => {
      const { node, cfg } = resolveRagNode(input.node);
      const { createRagAdapter } = await import("./rag/index.js");
      const adapter = await createRagAdapter(node, { config: cfg });
      try {
        return await adapter.listCollections();
      } finally {
        await adapter.close();
      }
    }),

  // ---- RAG ingestion pipelines (declarative fetch → chunk → embed → store) ----
  //
  // Thin tRPC shims over the `rag/pipeline/` runtime + store. One
  // directory per pipeline under $DEV_STORAGE/rag-pipelines/<name>/
  // holds {spec.yaml, journal.jsonl, state.json}. The runtime is the
  // source of truth; these procedures are the operator surfaces
  // (CLI + MCP + Electron).

  ragPipelineApply: t.procedure
    .input(
      z.object({
        manifestYaml: z.string().min(1),
        ownership: CompositeOwnershipSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { parse: parseYaml } = await import("yaml");
      const { RagPipelineManifestSchema } = await import("./rag/pipeline/index.js");
      const { applyPipeline } = await import("./rag/pipeline/store.js");
      let parsedYaml: unknown;
      try {
        parsedYaml = parseYaml(input.manifestYaml);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `RagPipeline manifest is not valid YAML: ${(err as Error).message}`,
        });
      }
      const parsed = RagPipelineManifestSchema.safeParse(parsedYaml);
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `invalid RagPipeline manifest: ${JSON.stringify(parsed.error.issues)}`,
        });
      }
      const result = applyPipeline(
        parsed.data,
        input.ownership ? { ownership: input.ownership } : {},
      );
      if (!result.ok) {
        // Composite-aware callers (ownership provided) need to interpret
        // the structured conflict to translate it into Pending status.
        // Operator CLI/UI callers (no ownership) keep the prior throwing
        // wire shape so existing tests + bash flows are unchanged.
        if (input.ownership) {
          return {
            ok: false as const,
            name: parsed.data.metadata.name,
            conflict: result.conflict,
          };
        }
        throw new TRPCError({
          code: "CONFLICT",
          message:
            result.conflict.kind === "name"
              ? `pipeline name conflict: ${result.conflict.name} (existing owner: ${result.conflict.existingOwner})`
              : `pipeline shape conflict: ${result.conflict.name} (${result.conflict.reason})`,
        });
      }
      return {
        ok: true as const,
        name: parsed.data.metadata.name,
        path: result.path,
        created: result.changed,
      };
    }),

  ragPipelineRun: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { loadPipeline, writeLastRun, journalPathFor } =
        await import("./rag/pipeline/store.js");
      const { runPipeline } = await import("./rag/pipeline/index.js");
      const manifest = loadPipeline(input.name);
      if (!manifest) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `rag pipeline '${input.name}' not found — run \`llamactl rag pipeline list\` to see registered names`,
        });
      }
      const summary = await runPipeline({
        manifest,
        journalPath: journalPathFor(input.name),
        dryRun: input.dryRun,
      });
      if (!input.dryRun) {
        writeLastRun(input.name, summary);
      }
      return { ok: true as const, summary, dryRun: input.dryRun };
    }),

  ragPipelineList: t.procedure.query(async () => {
    const { listPipelines } = await import("./rag/pipeline/store.js");
    return { pipelines: listPipelines() };
  }),

  ragPipelineRunning: t.procedure.query(async () => {
    // Liveness signal for the Electron Pipelines tab. Mirrors the
    // composites module's `currentRun()` pattern — in-memory event
    // bus, no disk persistence. When the agent crashes mid-run the
    // in-memory signal is lost; `detectOrphanedRuns` scans each
    // pipeline's journal tail for an unpaired `run-started` and
    // surfaces those entries with `stale: true` so the UI can warn
    // without mistaking them for a live run.
    const { pipelineEvents } = await import("./rag/pipeline/event-bus.js");
    const { detectOrphanedRuns } = await import("./rag/pipeline/orphan.js");
    const liveNames = pipelineEvents.allRunning();
    const running = liveNames
      .map((name) => pipelineEvents.currentRun(name))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({
        name: r.name,
        startedAt: r.startedAt,
        sources: r.sources,
        stale: false,
      }));
    const liveSet = new Set(liveNames);
    for (const orphan of detectOrphanedRuns()) {
      if (liveSet.has(orphan.name)) continue; // live signal wins
      running.push({
        name: orphan.name,
        startedAt: orphan.startedAt,
        sources: orphan.sources,
        stale: true,
      });
    }
    return { ok: true as const, running };
  }),

  ragPipelineGet: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const { loadPipeline } = await import("./rag/pipeline/store.js");
      const manifest = loadPipeline(input.name);
      if (!manifest) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `rag pipeline '${input.name}' not found`,
        });
      }
      return { manifest };
    }),

  ragPipelineRemove: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        compositeName: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { removePipeline } = await import("./rag/pipeline/store.js");
      // Composite-aware path: ref-counted removal. Conflicts surface in
      // the response body so the composite handler can translate them
      // to Pending. Operator CLI/UI path (no compositeName) keeps the
      // prior `{ ok, removed }` shape — `removePipeline(name)` legacy
      // overload returns boolean.
      if (input.compositeName) {
        const r = removePipeline(input.name, { compositeName: input.compositeName });
        if (!r.ok) {
          return { ok: false as const, name: input.name, conflict: r.conflict };
        }
        return { ok: true as const, deleted: r.deleted };
      }
      const removed = removePipeline(input.name);
      return { ok: true as const, removed };
    }),

  ragBench: t.procedure
    .input(z.object({ manifestYaml: z.string().min(1) }))
    .mutation(async ({ input }) => {
      // Retrieval quality gate. Takes a `RagBench` manifest,
      // walks each query through `ragSearch`, scores hits against
      // expected doc IDs / substrings, and returns a report. No
      // disk writes — the report is the whole product.
      const { parse: parseYaml } = await import("yaml");
      const { RagBenchManifestSchema, runRagBench } = await import("./rag/bench.js");
      let parsedYaml: unknown;
      try {
        parsedYaml = parseYaml(input.manifestYaml);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `RagBench manifest is not valid YAML: ${(err as Error).message}`,
        });
      }
      const parsed = RagBenchManifestSchema.safeParse(parsedYaml);
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `invalid RagBench manifest: ${JSON.stringify(parsed.error.issues)}`,
        });
      }
      // Self-call `ragSearch` via the router caller so the bench
      // routes through the same adapter open/close path operators
      // already use. Keeps behavior identical to Knowledge-module
      // queries — no divergence from what the operator sees in the
      // Query tab.
      const caller = router.createCaller({});
      const report = await runRagBench({
        manifest: parsed.data,
        search: (req) => caller.ragSearch(req),
      });
      return report;
    }),

  ragPipelineDraft: t.procedure
    .input(
      z.object({
        description: z.string().default(""),
        availableRagNodes: z.array(z.string()).optional(),
        defaultRagNode: z.string().optional(),
        nameOverride: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const { draftPipeline } = await import("./rag/pipeline/index.js");
      const ctx: Parameters<typeof draftPipeline>[1] = {};
      if (input.availableRagNodes) ctx.availableRagNodes = input.availableRagNodes;
      if (input.defaultRagNode !== undefined) ctx.defaultRagNode = input.defaultRagNode;
      if (input.nameOverride !== undefined) ctx.nameOverride = input.nameOverride;
      const { yaml, manifest, warnings } = draftPipeline(input.description, ctx);
      return { ok: true as const, yaml, manifest, warnings };
    }),

  ragPipelineLogs: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        tail: z.number().int().min(1).max(10_000).default(200),
      }),
    )
    .query(async ({ input }) => {
      const { journalPathFor } = await import("./rag/pipeline/store.js");
      const { existsSync, readFileSync } = await import("node:fs");
      const path = journalPathFor(input.name);
      if (!existsSync(path)) {
        return { ok: true as const, path, entries: [] as Record<string, unknown>[] };
      }
      // Lines are ~hundreds of bytes each; for N=200 (default) we load
      // the full file, split, tail. If journals grow to millions of
      // lines we'll want a seek-to-tail reader; v1 is plenty.
      const raw = readFileSync(path, "utf8");
      const all = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const tail = all.slice(Math.max(0, all.length - input.tail));
      const entries: Record<string, unknown>[] = [];
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed && typeof parsed === "object") {
            entries.push(parsed as Record<string, unknown>);
          }
        } catch {
          // Malformed line — skip; runtime's dedupe tolerance is the
          // guide.
        }
      }
      return { ok: true as const, path, entries };
    }),

  // ---- Project resources (local filesystem project + routing policy) ----
  //
  // Phase 2 of trifold-orchestrating-engelbart.md. A project is a
  // first-class llamactl resource: a path + optional RAG target + a
  // task-kind → routing-target map. Projects live in a dedicated
  // YAML (`~/.llamactl/projects.yaml` by default) so the kubeconfig
  // stays lean and projects version independently.
  //
  // The routing target is validated as a string only — resolution
  // happens later in the router's chat dispatch hook. `projectIndex`
  // auto-generates a RagPipeline manifest from `spec.rag` and
  // delegates to `ragPipelineApply`, so project indexing reuses the
  // entire R1–R3 ingestion stack with no duplicated runtime code.

  projectApply: t.procedure
    .input(z.object({ manifestYaml: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { parse: parseYaml } = await import("yaml");
      const {
        ProjectSchema,
        loadProjects,
        saveProjects,
        upsertProject,
        defaultProjectsPath,
        withProjectsMutex,
      } = await import("./config/projects.js");
      let parsedYaml: unknown;
      try {
        parsedYaml = parseYaml(input.manifestYaml);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Project manifest is not valid YAML: ${(err as Error).message}`,
        });
      }
      const parsed = ProjectSchema.safeParse(parsedYaml);
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `invalid Project manifest: ${JSON.stringify(parsed.error.issues)}`,
        });
      }
      const path = defaultProjectsPath();
      return await withProjectsMutex(() => {
        const existing = loadProjects(path);
        const created = !existing.some((p) => p.metadata.name === parsed.data.metadata.name);
        const next = upsertProject(existing, parsed.data);
        saveProjects(next, path);
        return {
          ok: true as const,
          name: parsed.data.metadata.name,
          path,
          created,
        };
      });
    }),

  projectList: t.procedure.query(async () => {
    const { loadProjects } = await import("./config/projects.js");
    const projects = loadProjects();
    return { ok: true as const, projects };
  }),

  projectGet: t.procedure.input(z.object({ name: z.string().min(1) })).query(async ({ input }) => {
    const { loadProjects } = await import("./config/projects.js");
    const projects = loadProjects();
    const project = projects.find((p) => p.metadata.name === input.name);
    if (!project) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `project '${input.name}' not found — run \`llamactl project list\` to see registered names`,
      });
    }
    return { ok: true as const, project };
  }),

  projectRemove: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { loadProjects, saveProjects, removeProject, defaultProjectsPath, withProjectsMutex } =
        await import("./config/projects.js");
      const path = defaultProjectsPath();
      return await withProjectsMutex(() => {
        const existing = loadProjects(path);
        const next = removeProject(existing, input.name);
        const removed = next.length !== existing.length;
        if (removed) saveProjects(next, path);
        // Mirrors ragPipelineRemove semantics: we never touch the
        // already-indexed data in the rag node. Re-indexing requires
        // an explicit `llamactl project index <name>` after re-adding.
        return { ok: true as const, removed };
      });
    }),

  projectIndex: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { loadProjects } = await import("./config/projects.js");
      const { stringify: stringifyYaml } = await import("yaml");
      const projects = loadProjects();
      const project = projects.find((p) => p.metadata.name === input.name);
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `project '${input.name}' not found`,
        });
      }
      if (!project.spec.rag) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `project '${input.name}' has no spec.rag — declare { node, collection } before indexing`,
        });
      }
      // Auto-generate a RagPipeline manifest. Pipeline name is
      // `project-<projectName>` so operators can distinguish
      // project-owned pipelines from free-standing ones in
      // `llamactl rag pipeline list`.
      const pipelineName = `project-${project.metadata.name}`;
      const source: Record<string, unknown> = {
        kind: "filesystem",
        root: project.spec.path,
        glob: project.spec.rag.docsGlob,
      };
      const tag: Record<string, string> = { project: project.metadata.name };
      if (project.spec.purpose) tag["purpose"] = project.spec.purpose;
      source["tag"] = tag;
      const pipelineManifest: Record<string, unknown> = {
        apiVersion: "llamactl/v1",
        kind: "RagPipeline",
        metadata: { name: pipelineName },
        spec: {
          destination: {
            ragNode: project.spec.rag.node,
            collection: project.spec.rag.collection,
          },
          sources: [source],
          transforms: [
            {
              kind: "markdown-chunk",
              chunk_size: 800,
              overlap: 150,
              preserve_headings: true,
            },
          ],
          on_duplicate: "replace",
          ...(project.spec.rag.schedule ? { schedule: project.spec.rag.schedule } : {}),
        },
      };
      // Delegate to the existing ragPipelineApply procedure via a
      // local caller — reuses the R1–R3 validation + store code
      // without duplicating any ingestion logic here. The narrow
      // `ApplyResult` type breaks the `router → caller → router`
      // inference cycle; the underlying procedure returns a superset.
      interface ApplyResult {
        ok: true;
        name: string;
        path: string;
        created: boolean;
      }
      const caller = router.createCaller({});
      const res = (await caller.ragPipelineApply({
        manifestYaml: stringifyYaml(pipelineManifest),
      })) as ApplyResult;
      return {
        ok: true as const,
        pipelineName,
        path: res.path,
        created: res.created,
      };
    }),

  projectResolveRouting: t.procedure
    .input(
      z.object({
        project: z.string().min(1),
        taskKind: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      const { loadProjects, resolveProjectRouting } = await import("./config/projects.js");
      const projects = loadProjects();
      const project = projects.find((p) => p.metadata.name === input.project);
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `project '${input.project}' not found`,
        });
      }
      const { target, matched } = resolveProjectRouting(project, input.taskKind);
      return {
        ok: true as const,
        project: input.project,
        taskKind: input.taskKind,
        target,
        matched,
        // Additive field for Phase 3 callers — existing consumers
        // that destructure {ok, target, matched} keep working.
        reason: matched ? ("matched" as const) : ("fallback-default" as const),
      };
    }),

  /**
   * Full-resolution preview that mirrors the in-dispatch routing
   * path — parses a `project:<name>/<taskKind>` node name and
   * returns the rewritten target + decision record WITHOUT
   * journaling or firing the chat. The Electron routing-decisions
   * strip uses this for live lookups when the operator hovers over
   * a task kind in the Project detail page.
   */
  projectRoutePreview: t.procedure
    .input(z.object({ node: z.string().min(1) }))
    .query(async ({ input }) => {
      const { resolveProjectNodeTarget, makeProjectBudgetChecker } =
        await import("./config/project-routing.js");
      const route = await resolveProjectNodeTarget(input.node, {
        checkBudget: makeProjectBudgetChecker(),
      });
      return { ok: true as const, ...route };
    }),

  /**
   * Tail the project-routing decision journal. Powers the Electron
   * Projects module's "where did my AI go" strip. Default tail=200
   * entries from `$LLAMACTL_PROJECT_ROUTING_JOURNAL || ~/.llamactl/
   * project-routing.jsonl`; malformed lines are silently dropped
   * the same way ragPipelineLogs handles journal corruption.
   */
  projectRoutingJournal: t.procedure
    .input(
      z.object({
        tail: z.number().int().min(1).max(10_000).default(200),
        /** Optional project-name filter. Decisions are journaled
         *  without structural sorting, so the filter keeps the
         *  tail window relevant when many projects share the
         *  same journal. */
        project: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const { defaultProjectRoutingJournalPath } = await import("./config/project-routing.js");
      const { existsSync, readFileSync } = await import("node:fs");
      const path = defaultProjectRoutingJournalPath();
      if (!existsSync(path)) {
        return { ok: true as const, path, entries: [] as Record<string, unknown>[] };
      }
      const raw = readFileSync(path, "utf8");
      const all = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const entries: Record<string, unknown>[] = [];
      for (const line of all) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object") continue;
          if (input.project) {
            const entry = parsed as { project?: unknown };
            if (entry.project !== input.project) continue;
          }
          entries.push(parsed as Record<string, unknown>);
        } catch {
          /* malformed line — skip */
        }
      }
      const tailed = entries.slice(Math.max(0, entries.length - input.tail));
      return { ok: true as const, path, entries: tailed };
    }),

  // ---- Composite (multi-component apply) --------------------------------
  //
  // Phase 5 of composite-infra.md — tRPC surface for the composite
  // applier. Each procedure is a thin caller shim over `applyComposite`
  // / `destroyComposite` / the `store.ts` YAML helpers, mirroring the
  // MCP `llamactl.composite.*` tools 1:1 so ops-chat + external MCP
  // clients + the Electron module share one code path.

  compositeApply: t.procedure
    .input(
      z.object({
        manifestYaml: z.string().min(1),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { parseComposite } = await import("./composite/store.js");
      const { topologicalOrder, impliedEdges } = await import("./composite/dag.js");
      let manifest;
      try {
        manifest = parseComposite(input.manifestYaml);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `invalid composite manifest: ${(err as Error).message}`,
        });
      }
      if (input.dryRun) {
        const order = topologicalOrder(manifest.spec);
        const implied = impliedEdges(manifest.spec);
        return {
          dryRun: true as const,
          manifest,
          order,
          impliedEdges: implied,
        };
      }
      // Wet run — drive the applier through the shared backend and
      // publish every event onto the in-memory bus so concurrent
      // `compositeStatus` subscribers can stream live progress.
      const { applyComposite } = await import("./composite/apply.js");
      const { compositeEvents } = await import("./composite/event-bus.js");
      const name = manifest.metadata.name;
      compositeEvents.startRun(name);
      try {
        const kind = resolveCompositeRuntimeKind(manifest.spec.runtime);
        const backend = await compositeRuntimeForApply(kind);
        const workloadsDir = workloadStoreMod.defaultWorkloadsDir();
        const result = await applyComposite({
          manifest,
          backend,
          getWorkloadClient: compositeWorkloadClientForApply(),
          onEvent: (e) => {
            compositeEvents.emit(name, e);
          },
          getNodeBudgetGiB: (nodeName) => nodeRunBudgetGiB(nodeName, workloadsDir),
          getNodeResidency: (nodeName) => nodeRunResidency(nodeName, workloadsDir),
        });
        return { dryRun: false as const, ...result };
      } catch (err) {
        // any failure (runtime-resolution or applier) synthesizes done so
        // compositeStatus subscribers drain instead of hanging forever.
        compositeEvents.emit(name, { type: "done", ok: false });
        throw err;
      } finally {
        // Even on throw we want the bus to flip the run to `done` so
        // subscribers drain cleanly and the retention timer starts.
        compositeEvents.endRun(name);
      }
    }),

  compositeDestroy: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        dryRun: z.boolean().default(false),
        purgeVolumes: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { loadComposite, deleteComposite, saveComposite } =
        await import("./composite/store.js");
      const { topologicalOrder, reverseOrder } = await import("./composite/dag.js");
      const manifest = loadComposite(input.name);
      if (!manifest) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `composite '${input.name}' not found`,
        });
      }
      if (input.dryRun) {
        const wouldRemove = reverseOrder(topologicalOrder(manifest.spec));
        return {
          dryRun: true as const,
          name: input.name,
          wouldRemove,
          wouldPurgeVolumes: input.purgeVolumes,
        };
      }
      const { destroyComposite } = await import("./composite/apply.js");
      const kind = resolveCompositeRuntimeKind(manifest.spec.runtime);
      const backend = await getCompositeRuntime(kind);
      const result = await destroyComposite({
        manifest,
        backend,
        getWorkloadClient: (nodeName) => clientForNode(kubecfg.loadConfig(), nodeName),
        purgeVolumes: input.purgeVolumes,
      });
      // Best-effort cleanup of the on-disk YAML. Destroy is the only
      // place the file gets removed; apply-failures leave a status-
      // tagged record so operators can investigate. A stop-fence
      // refusal keeps the YAML so the destroy can be retried after
      // `residency release-session` or `residency force-unload` (#520).
      // The kept YAML records the partial destroy in its status: phase
      // Degraded, one Failed component per destroy error, so a retry is
      // explainable from `composite get`.
      if (result.manifestPreserved) {
        const appliedAt = manifest.status?.appliedAt;
        saveComposite({
          ...manifest,
          status: {
            phase: "Degraded",
            ...(appliedAt !== undefined ? { appliedAt } : {}),
            components: result.errors.map((e) => ({
              ref: e.ref,
              state: "Failed" as const,
              message: e.message,
            })),
          },
        });
      } else {
        deleteComposite(input.name);
      }
      return {
        dryRun: false as const,
        ok: result.ok,
        removed: result.removed,
        errors: result.errors,
        purgedVolumes: input.purgeVolumes,
        manifestPreserved: result.manifestPreserved,
      };
    }),

  compositeList: t.procedure.query(async () => {
    const { listComposites } = await import("./composite/store.js");
    return listComposites();
  }),

  compositeGet: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const { loadComposite } = await import("./composite/store.js");
      return loadComposite(input.name);
    }),

  /**
   * Subscription variant of compositeGet. Prefers the live in-memory
   * bus when a `compositeApply` is in-flight for this name: late
   * subscribers receive the replayed buffer + any future events up to
   * and including `done`. When no run is active (or the run has aged
   * out of the retention window), we fall back to synthesizing a
   * one-shot stream from the persisted `status` field on the YAML.
   */
  compositeStatus: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .subscription(({ input, signal }) => {
      const clientSignal = signal ?? new AbortController().signal;
      return bridgeEventStream<CompositeApplyEvent>(clientSignal, async (emit) => {
        const { compositeEvents } = await import("./composite/event-bus.js");
        const runBus = compositeEvents.currentRun(input.name);
        if (runBus && !runBus.done) {
          // Live path — replay the buffer + attach for future events.
          // The returned Promise resolves on the terminal `done` event
          // or when the client disconnects, whichever lands first.
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              clientSignal.removeEventListener("abort", finish);
              unsub();
              resolve();
            };
            const unsub = compositeEvents.subscribe(input.name, (e) => {
              emit(e);
              if (e.type === "done") {
                finish();
              }
            });
            clientSignal.addEventListener("abort", finish);
          });
          return;
        }
        // Fall back to the persisted-status synthesis path.
        const { loadComposite } = await import("./composite/store.js");
        const manifest = loadComposite(input.name);
        if (!manifest) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `composite '${input.name}' not found`,
          });
        }
        const status = manifest.status;
        if (status) {
          emit({ type: "phase", phase: status.phase });
          for (const c of status.components) {
            emit({ type: "component-start", ref: c.ref });
            if (c.state === "Ready") {
              emit({
                type: "component-ready",
                ref: c.ref,
                ...(c.message !== undefined && { message: c.message }),
              });
            } else if (c.state === "Failed") {
              emit({
                type: "component-failed",
                ref: c.ref,
                message: c.message ?? "component failed",
              });
            }
          }
          emit({
            type: "done",
            ok: status.phase === "Ready",
          });
        } else {
          // Manifest exists but was never applied — emit a pending
          // phase so the UI can render an empty state cleanly.
          emit({ type: "phase", phase: "Pending" });
          emit({ type: "done", ok: false });
        }
      });
    }),

  globalSearchRagStatus: t.procedure.query(async () => {
    const nodeName = resolveDefaultRagNode();
    if (!nodeName) {
      return { sessions: false, knowledge: false, logs: false, defaultNode: null };
    }
    try {
      const { node, cfg } = resolveRagNode(nodeName);
      const adapter = await createRagAdapter(node, { config: cfg });
      let cols: string[] = [];
      try {
        const resCol = await adapter.listCollections();
        cols = resCol.collections.map((c) => c.name);
      } finally {
        await adapter.close();
      }
      return {
        sessions: cols.includes("sessions"),
        knowledge: cols.includes("knowledge"),
        logs: cols.includes("logs"),
        defaultNode: nodeName,
      };
    } catch {
      return { sessions: false, knowledge: false, logs: false, defaultNode: null };
    }
  }),

  opsSessionSearch: t.procedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const hits = await searchSessions({ query: input.query, limit: 30 });
      return { hits };
    }),

  logsSearch: t.procedure.input(z.object({ query: z.string().min(1) })).query(async ({ input }) => {
    const hits = await searchLogs({
      query: input.query,
      files: [
        { label: "agent", path: "/tmp/llamactl-agent.log" },
        { label: "electron", path: "/tmp/llamactl-electron.log" },
      ],
      limit: 30,
    });
    return { hits };
  }),

  // P4.1 worker RPC (InferenceRpcV1); handlers live in inference/procedures.ts.
  inferenceRpc: inferenceRpcRouter,
});

export type AppRouter = typeof router;
