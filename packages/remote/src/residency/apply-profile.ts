/**
 * #284 (DF-11): dry-run-by-default residency profile-switch mutation.
 *
 * `applyResidencyProfile` is the pure plan-execution core reached through the
 * router procedure, the CLI verb and the MCP tool. A dry run builds a report
 * from the plan alone and never opens the operation store; a wet run claims
 * the node-local operation fence, records the switch under model
 * `profile-switch:<node>` and runs the fenced executor. The wet run passes the
 * plan's resolved node budget (`plan.budgetGiB`, from the router's
 * `residencyPlanFor`) into the store so the reservation is budget-admitted; an
 * unknown budget keeps the pre-#276 behaviour and logs once to `args.log`. A
 * foreign fence, or any fence with a nonterminal `profile-switch:<node>` row,
 * is never claimed over. Fence and reservation are recorded in one IMMEDIATE
 * transaction before the executor can run steps. The wet run also passes
 * `operation.lifecycle` (the operation store plus a `groupOf` that reads the
 * `llamactl.io/residency-group` manifest label) into the executor, so each stop
 * and start drives its `residency_states` row, a corroborated exclusive-group
 * occupant refuses the start, and a stale same-group occupant is reconciled.
 *
 * `applyResidencyProfile` is wired (router procedure, CLI verb, MCP tool).
 * `cancelResidencyProfileOperation` aborts a switch this process owns at its
 * next step boundary; the abort is observed only at a boundary, so the switch
 * is recorded as `cancelled` only when it reaches one (a step already running
 * completes and can still succeed). The cancel is process-local: it reaches
 * only switches whose AbortController is registered in this serving process.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type { OkPlan } from "@llamactl/core/residency/planner";

import { server as serverMod } from "@llamactl/core";
import { randomUUID } from "node:crypto";

import type { ManagedLaunchAdmission } from "./managed-launch-admission.js";
import type { ResidencyPlan } from "./procedures.js";

import { existsSync } from "../safe-fs.js";
import { startModelHost, stopModelHost } from "../server/modelhost.js";
import { ModelRunSchema, type ModelRunStatus } from "../workload/schema.js";
import {
  listWorkloadNames,
  loadWorkloadByName,
  loadWorkloadByNameAny,
  saveWorkload,
  withWorkloadsMutex,
} from "../workload/store.js";
import { residencyGroupLabelOf } from "./coordinator.js";
import {
  managedProfileTargetState,
  withManagedProfilePermit,
} from "./managed-profile-selection.js";
import { isProfileDesiredCurrent, type ProfileDesiredSnapshot } from "./profile-desired.js";
import { profileOwnerIncarnation, RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "./profile-owner.js";
import {
  executeProfileSwitch,
  type ProfileSwitchExecutionReport,
  type ProfileSwitchExecutionStep,
  type ProfileSwitchExecutorDeps,
  profileSwitchOperationKey,
  profileSwitchOperationRefusal,
  profileSwitchReservationGiB,
  type ProfileSwitchStepOutcome,
} from "./profile-transition.js";
import { reopenWorkloadAfterLoad } from "./stop-fence.js";
import {
  type BeginOperationResult,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationOutcome,
  type ResidencyOperationRecord,
  type ResidencyOperationStore,
} from "./store.js";

// The one owner identity every operation-fence claim on the node-local store
// uses (only the incarnation differs). #279 DF-06 agent-boot recovery claims
// with it too, so a recovery claim never turns later apply-profile calls into
// a foreign-owner Busy.
export { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "./profile-owner.js";
const RESIDENCY_APPLY_PROFILE_DESIRED_REVISION = 0;

// Per-process registry (#693) of the AbortController behind each in-flight wet
// profile switch, keyed by the operationId recorded in the node-local store.
// `cancelResidencyProfileOperation` aborts through it; the entry is removed in
// the switch's finally. It is process-local: a switch begun by another serving
// process shares the store but not this map.
const inFlightSwitchControllers = new Map<string, AbortController>();

export function __residencyInFlightSwitchIdsForTests(): string[] {
  return [...inFlightSwitchControllers.keys()];
}

export type FenceIdentity = { ownerId: string; incarnation: string };

export type ResidencyApplyProfileStep = {
  action: string;
  workload: string;
  status: string;
  detail?: string;
};

export type ResidencyApplyProfileBusy = {
  reason: string;
  node: string;
  operationId: string;
  detail: string;
};

export type ResidencyApplyProfileRefusal = {
  reason: string;
  detail: string;
  retryAfterMs?: number;
  workloads?: string[];
};

export type ResidencyApplyProfileResult = {
  ok: boolean;
  outcome: ProfileSwitchExecutionReport["outcome"];
  dryRun: boolean;
  node: string | null;
  from: string | null;
  to: string | null;
  steps: ResidencyApplyProfileStep[];
  deferred: string[];
  busy?: ResidencyApplyProfileBusy;
  refusal?: ResidencyApplyProfileRefusal;
  operationId?: string | null;
  inFlightOperationId?: string | null;
  controllerPid?: number;
};

export type ResidencyCancelOperationOutcome =
  | "cancel-requested"
  | "not-found"
  | "already-terminal"
  | "not-owned-by-this-process";

export type ResidencyCancelOperationResult = {
  ok: boolean;
  outcome: ResidencyCancelOperationOutcome;
  operationId: string;
  detail: string;
  recordedOutcome?: ResidencyOperationOutcome | null;
};

export type ApplyResidencyProfileArgs = {
  plan: ResidencyPlan;
  desired?: ProfileDesiredSnapshot;
  dryRun: boolean;
  storePath: string;
  workloadsDir: string;
  registry: ResidencyLeases | null;
  fenceIdentity?: FenceIdentity;
  node?: string | null;
  to?: string | null;
  from?: string | null;
  applyModelRun?: (manifest: unknown, signal?: AbortSignal) => Promise<unknown>;
  managedLaunchAdmission?: ManagedLaunchAdmission;
  expectedManagedProfileOperationId?: string | null;
  // sink for a missing node budget and heartbeat failures; default stderr
  log?: (line: string) => void;
};

let stepsSeam: ProfileSwitchExecutorDeps | null = null;

export function __setResidencyApplyProfileStepsForTests(
  steps: ProfileSwitchExecutorDeps | null,
): void {
  stepsSeam = steps;
}

export function resolveResidencyApplyProfileSteps(
  factory: () => ProfileSwitchExecutorDeps,
): ProfileSwitchExecutorDeps {
  return stepsSeam ?? factory();
}

export function residencyApplyProfileRefusal(input: {
  reason: string;
  detail: string;
  node: string;
  to: string;
  from: string | null;
  controllerPid?: number;
  dryRun?: boolean;
}): ResidencyApplyProfileResult {
  return {
    ok: false,
    dryRun: input.dryRun ?? false,
    outcome: "refused",
    node: input.node,
    from: input.from,
    to: input.to,
    steps: [],
    deferred: [],
    refusal: { reason: input.reason, detail: input.detail },
    ...(input.controllerPid === undefined ? {} : { controllerPid: input.controllerPid }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultFenceIdentity(): FenceIdentity {
  return { ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER, incarnation: profileOwnerIncarnation() };
}

/**
 * A workload the profile switch stopped is recorded the way `workload/apply.ts`
 * records a stopped/disabled ModelRun: an `Applied`/`True` condition (the
 * stop was applied), never `Ready`/`True` — a stopped server is not ready.
 */
function stoppedStatus(iso: string): ModelRunStatus {
  return {
    phase: "Stopped",
    serverPid: null,
    endpoint: null,
    lastTransitionTime: iso,
    conditions: [
      {
        type: "Applied",
        status: "True",
        reason: "ResidencyProfileSwitch",
        lastTransitionTime: iso,
      },
    ],
  };
}

async function stopWorkload(
  workloadsDir: string,
  workload: string,
  managed?: ManagedLaunchAdmission,
): Promise<ProfileSwitchStepOutcome> {
  const manifest = loadWorkloadByNameAny(workload, workloadsDir);
  const release = managed?.prepareStopRelease?.(workload, manifest.kind);
  const withOwnership = managed?.runOwnedLifecycle;
  if (managed !== undefined && (release === undefined || withOwnership === undefined)) {
    return { ok: false, detail: `managed stop cannot prove the claim for ${workload}` };
  }
  if (manifest.kind === "ModelHost") {
    return await stopProfileHost(workload, withOwnership, release);
  }
  const stop = (): ReturnType<typeof serverMod.stopServer> =>
    serverMod.stopServer({
      key: { name: workload },
      ...(release === undefined
        ? {}
        : { identity: { verifyGeneration: release.verifyGeneration } }),
    });
  const result = await (withOwnership === undefined ? stop() : withOwnership(stop));
  if (!result.stopped) {
    return { ok: false, detail: `stop did not confirm process removal for ${workload}` };
  }
  if (release !== undefined && !claimReleased(result.pid, release)) {
    return unverifiedCapacity(workload);
  }
  const iso = new Date().toISOString();
  await withWorkloadsMutex(workloadsDir, () => {
    const fresh = loadWorkloadByName(workload, workloadsDir);
    saveWorkload({ ...fresh, status: stoppedStatus(iso) }, workloadsDir);
    return Promise.resolve();
  });
  reopenWorkloadAfterLoad(workload, true);
  return { ok: true };
}

async function stopProfileHost(
  workload: string,
  withOwnership: ManagedLaunchAdmission["runOwnedLifecycle"],
  release: ProfileStopProof | undefined,
): Promise<ProfileSwitchStepOutcome> {
  const stop = (): ReturnType<typeof stopModelHost> =>
    stopModelHost({
      key: { name: workload },
      ...(release === undefined
        ? {}
        : { identity: { verifyGeneration: release.verifyGeneration } }),
    });
  const stopped = await (withOwnership === undefined ? stop() : withOwnership(stop));
  if (!stopped.ok) return { ok: false, detail: stopped.error ?? "modelHost stop failed" };
  if (release !== undefined && !claimReleased(stopped.pid, release)) {
    return unverifiedCapacity(workload);
  }
  return { ok: true };
}

type ProfileStopProof = NonNullable<
  ReturnType<NonNullable<ManagedLaunchAdmission["prepareStopRelease"]>>
>;

function claimReleased(pid: number | null, release: ProfileStopProof): boolean {
  return pid !== null && release.release(pid).kind === "released";
}

function unverifiedCapacity(workload: string): ProfileSwitchStepOutcome {
  return { ok: false, detail: `managed stop could not verify capacity release for ${workload}` };
}

function applyOutcomeDetail(applied: Record<string, unknown>): string {
  const error = applied["error"];
  return typeof error === "string" ? error : "apply failed";
}

function persistApplyStatus(workloadsDir: string, applied: Record<string, unknown>): void {
  const result = applied["result"];
  const statusSection = isRecord(result) ? result["statusSection"] : undefined;
  const source = applied["manifest"];
  if (applied["kind"] !== "ModelRun" || statusSection === undefined || !isRecord(source)) {
    return;
  }
  const validated = ModelRunSchema.parse({ ...source, status: statusSection });
  saveWorkload(validated, workloadsDir);
}

async function startWorkload(
  workloadsDir: string,
  workload: string,
  opts: ProfileWorkloadSteps,
  signal?: AbortSignal,
): Promise<ProfileSwitchStepOutcome> {
  if (!listWorkloadNames(workloadsDir).includes(workload)) {
    return { ok: false, detail: `unknown workload ${workload}` };
  }
  const manifest = loadWorkloadByNameAny(workload, workloadsDir);
  if (!manifest.spec.enabled) return { ok: false, detail: `workload ${workload} is disabled` };
  if (manifest.kind === "ModelHost" && opts.managedLaunchAdmission === undefined) {
    const started = await startModelHost({ key: { name: workload } });
    return started.ok
      ? { ok: true }
      : { ok: false, detail: started.error ?? "modelHost start failed" };
  }
  const applied = await opts.applyModelRun(manifest, signal);
  if (!isRecord(applied)) {
    return { ok: false, detail: "apply returned a non-object result" };
  }
  if (applied["ok"] !== true) {
    return { ok: false, detail: applyOutcomeDetail(applied) };
  }
  await withWorkloadsMutex(workloadsDir, () => {
    persistApplyStatus(workloadsDir, applied);
    return Promise.resolve();
  });
  reopenWorkloadAfterLoad(workload, true);
  return { ok: true };
}

type ProfileWorkloadSteps = {
  workloadsDir: string;
  applyModelRun: NonNullable<ApplyResidencyProfileArgs["applyModelRun"]>;
  managedLaunchAdmission?: ManagedLaunchAdmission;
};

export function defaultResidencyApplyProfileSteps(
  opts: ProfileWorkloadSteps,
): ProfileSwitchExecutorDeps {
  return {
    stop: (workload) => stopWorkload(opts.workloadsDir, workload, opts.managedLaunchAdmission),
    start: (workload, ctx) => startWorkload(opts.workloadsDir, workload, opts, ctx?.signal),
  };
}

function mapStep(step: ProfileSwitchExecutionStep): ResidencyApplyProfileStep {
  return {
    action: step.action,
    workload: step.workload,
    status: step.status,
    ...(step.detail === undefined ? {} : { detail: step.detail }),
  };
}

function mapReport(report: ProfileSwitchExecutionReport): ResidencyApplyProfileResult {
  const refusal =
    report.refusal ??
    (report.busy === undefined
      ? undefined
      : { reason: report.busy.reason, detail: report.busy.detail });
  return {
    ok: report.ok,
    dryRun: report.dryRun,
    outcome: report.outcome,
    node: report.node,
    from: report.from,
    to: report.to,
    steps: report.steps.map((step) => mapStep(step)),
    deferred: [...report.deferred],
    ...(report.busy === undefined
      ? {}
      : {
          busy: {
            reason: report.busy.reason,
            node: report.busy.node,
            operationId: report.busy.operationId,
            detail: report.busy.detail,
          },
        }),
    ...(refusal === undefined ? {} : { refusal }),
    ...(report.operation === undefined ? {} : { operationId: report.operation.id }),
  };
}

function plannerRefusal(
  plan: Extract<ResidencyPlan, { ok: false }>,
  args: ApplyResidencyProfileArgs,
): ResidencyApplyProfileResult {
  const inFlight = plan.inFlightOperationId;
  return {
    ok: false,
    dryRun: args.dryRun,
    outcome: "refused",
    node: args.node ?? null,
    from: args.from ?? null,
    to: args.to ?? null,
    steps: [],
    deferred: [],
    refusal: {
      reason: plan.reason,
      detail: plan.detail,
      ...(typeof plan.retryAfterMs === "number" && Number.isFinite(plan.retryAfterMs)
        ? { retryAfterMs: plan.retryAfterMs }
        : {}),
      ...(plan.workloads.length > 0 ? { workloads: [...plan.workloads] } : {}),
    },
    ...(inFlight === null || inFlight === undefined ? {} : { inFlightOperationId: inFlight }),
  };
}

function nonterminalSwitchId(store: ResidencyOperationStore, node: string): string | null {
  const key = profileSwitchOperationKey(node);
  return store.listNonterminal().find((record) => record.model === key)?.operationId ?? null;
}

function inFlightBusy(plan: OkPlan, operationId: string): ResidencyApplyProfileResult {
  const detail = `profile switch already in flight on node ${plan.node}: operation ${operationId}`;
  return {
    ok: false,
    dryRun: false,
    outcome: "busy",
    node: plan.node,
    from: plan.from,
    to: plan.to,
    steps: [],
    deferred: [],
    busy: { reason: "Busy", node: plan.node, operationId, detail },
    refusal: { reason: "Busy", detail },
  };
}

async function runWetNoop(
  plan: OkPlan,
  steps: ProfileSwitchExecutorDeps,
  store: ResidencyOperationStore,
  identity: FenceIdentity,
): Promise<ResidencyApplyProfileResult> {
  const inFlight = nonterminalSwitchId(store, plan.node);
  if (inFlight !== null) {
    return inFlightBusy(plan, inFlight);
  }
  const current = store.currentFence();
  if (current !== null && current.ownerId !== identity.ownerId) {
    return inFlightBusy(plan, "unknown");
  }
  return mapReport(await executeProfileSwitch(plan, steps, { dryRun: false }));
}

function refusedProfileReservation(
  plan: OkPlan,
  registry: ResidencyLeases | null,
  refusal: Extract<ReturnType<ResidencyOperationStore["claimAndBeginOperation"]>, { ok: false }>,
): ResidencyApplyProfileResult {
  if (refusal.reason === "profile-selection-changed") {
    return residencyApplyProfileRefusal({
      node: plan.node,
      from: plan.from,
      to: plan.to,
      reason: "ProfileSelectionChanged",
      detail: "the owner committed a different selection after planning; replan the switch",
    });
  }
  return refusal.reason === "busy"
    ? inFlightBusy(plan, refusal.operationId ?? "unknown")
    : mapReport(profileSwitchOperationRefusal(plan, registry, refusal.reason));
}

async function runWet(
  plan: OkPlan,
  steps: ProfileSwitchExecutorDeps,
  args: ApplyResidencyProfileArgs,
): Promise<ResidencyApplyProfileResult> {
  const store = openResidencyOperationStore({
    path: args.storePath,
    requireExisting: args.managedLaunchAdmission !== undefined,
  });
  try {
    const identity = args.fenceIdentity ?? defaultFenceIdentity();
    const managed = args.managedLaunchAdmission !== undefined;
    if (plan.noop && !managed) {
      return await runWetNoop(plan, steps, store, identity);
    }

    const budgetGiB = plan.budgetGiB;
    const nodeBudgetGiB =
      budgetGiB !== null && Number.isFinite(budgetGiB) && budgetGiB >= 0 ? budgetGiB : undefined;
    const reservationGiB = profileSwitchReservationGiB(plan);
    let begun: ReturnType<ResidencyOperationStore["claimAndBeginOperation"]>;
    try {
      begun = store.claimAndBeginOperation(identity, {
        operationId: randomUUID(),
        model: profileSwitchOperationKey(plan.node),
        targetState: profileTargetState(plan.to, managed),
        desiredRevision: RESIDENCY_APPLY_PROFILE_DESIRED_REVISION,
        reservationGiB,
        nowMs: Date.now(),
        ...(nodeBudgetGiB === undefined ? {} : { nodeBudgetGiB }),
        expectedManagedProfileOperationId: args.expectedManagedProfileOperationId,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return mapReport(profileSwitchOperationRefusal(plan, args.registry, detail));
    }
    if (!begun.ok) return refusedProfileReservation(plan, args.registry, begun);
    if (nodeBudgetGiB === undefined) {
      logUnbudgetedSwitch(args, plan.node, reservationGiB);
    }
    return await runFencedSwitch(plan, steps, args, store, begun);
  } finally {
    store.close();
  }
}

function profileTargetState(profile: string, managed: boolean): string {
  return managed ? managedProfileTargetState(profile) : `profile:${profile}`;
}

function logUnbudgetedSwitch(
  args: ApplyResidencyProfileArgs,
  node: string,
  reservationGiB: number,
): void {
  try {
    applyProfileLog(args)(
      `[residency] profile-switch node budget unknown on node ${node}; reservation of ${String(reservationGiB)} GiB recorded without a budget check\n`,
    );
  } catch {
    // A diagnostic sink cannot strand the already reserved operation.
  }
}

function defaultApplyProfileLog(line: string): void {
  process.stderr.write(line);
}

// The exclusive residency group a workload belongs to, read from its manifest's
// `llamactl.io/residency-group` label. A missing manifest or an empty label is
// no group; the decorator then reconciles nothing and never passes group on a
// hop.
function residencyGroupOf(workloadsDir: string, workload: string): string | undefined {
  try {
    return residencyGroupLabelOf(loadWorkloadByNameAny(workload, workloadsDir).metadata.labels);
  } catch {
    return undefined;
  }
}

function applyProfileLog(args: ApplyResidencyProfileArgs): (line: string) => void {
  return args.log ?? defaultApplyProfileLog;
}

function commitProfileDispatch(
  store: ResidencyOperationStore,
  pending: Extract<BeginOperationResult, { ok: true }>,
): Extract<BeginOperationResult, { ok: true }> | { ok: false; reason: string } {
  if (!pending.created) return pending;
  const { operationId, fenceToken, version } = pending.record;
  const nowMs = Date.now();
  const input = { operationId, fenceToken, expectedVersion: version, nowMs };
  let reason: string;
  try {
    const result = store.commitReservation(input);
    if (result.ok) {
      return {
        ...pending,
        record: { ...pending.record, phase: "committed", version: version + 1, updatedAtMs: nowMs },
      };
    }
    reason = result.reason;
  } catch (error: unknown) {
    reason = error instanceof Error ? error.message : String(error);
  }
  try {
    store.finishOperation({ ...input, outcome: "failed", detail: reason });
  } catch {
    // An unsuccessful cleanup leaves the original phase and fence for recovery.
  }
  return { ok: false, reason };
}

function checkDesiredProfile(plan: OkPlan, args: ApplyResidencyProfileArgs): string | null {
  const desired = args.desired;
  if (desired === undefined) return null;
  return desired.node === plan.node &&
    isProfileDesiredCurrent(desired, args.workloadsDir, args.managedLaunchAdmission?.ownsNode)
    ? null
    : "desired inputs changed since profile planning; replan the switch";
}

function finishManagedNoop(
  plan: OkPlan,
  steps: ProfileSwitchExecutorDeps,
  args: ApplyResidencyProfileArgs,
  store: ResidencyOperationStore,
  record: ResidencyOperationRecord,
): ResidencyApplyProfileResult {
  const refusal = checkDesiredProfile(plan, args) ?? steps.beforeTeardown?.();
  const released = store.finishOperation({
    operationId: record.operationId,
    fenceToken: record.fenceToken,
    expectedVersion: record.version,
    nowMs: Date.now(),
    outcome: refusal === undefined ? "succeeded" : "failed",
    ...(refusal === undefined ? {} : { detail: refusal }),
  });
  if (refusal !== undefined || !released.ok) {
    return residencyApplyProfileRefusal({
      node: plan.node,
      from: plan.from,
      to: plan.to,
      reason: "ManagedProfileUnverified",
      detail: refusal ?? (released.ok ? "unable to publish profile" : released.reason),
    });
  }
  return {
    ok: true,
    dryRun: false,
    outcome: "noop",
    node: plan.node,
    from: plan.from,
    to: plan.to,
    steps: [],
    deferred: [],
    operationId: record.operationId,
  };
}

async function runFencedSwitch(
  plan: OkPlan,
  steps: ProfileSwitchExecutorDeps,
  args: ApplyResidencyProfileArgs,
  store: ResidencyOperationStore & ResidencyLifecycleStore,
  pending: Extract<BeginOperationResult, { ok: true }>,
): Promise<ResidencyApplyProfileResult> {
  const begun = commitProfileDispatch(store, pending);
  if (!begun.ok) return mapReport(profileSwitchOperationRefusal(plan, args.registry, begun.reason));
  const { operationId, fenceToken, desiredRevision } = begun.record;
  const managed = args.managedLaunchAdmission !== undefined;
  if (managed && plan.noop) return finishManagedNoop(plan, steps, args, store, begun.record);
  const controller = new AbortController();
  const log = applyProfileLog(args);
  inFlightSwitchControllers.set(operationId, controller);
  try {
    const execute = (): Promise<ProfileSwitchExecutionReport> =>
      executeProfileSwitch(plan, steps, {
        dryRun: false,
        registry: args.registry,
        signal: controller.signal,
        operation: {
          store,
          fenceToken,
          operationId,
          desiredRevision,
          begun,
          managed,
          log,
          ...(args.desired === undefined
            ? {}
            : { checkDesired: () => checkDesiredProfile(plan, args) }),
          lifecycle: {
            store,
            groupOf: (workload) => residencyGroupOf(args.workloadsDir, workload),
          },
        },
      });
    const report = await (managed
      ? withManagedProfilePermit({ operationId, fenceToken }, execute)
      : execute());
    const result = mapReport(report);
    return managed && report.ok && report.operation?.recorded !== true
      ? {
          ...result,
          ok: false,
          outcome: "failed",
          refusal: {
            reason: "ManagedProfileUnverified",
            detail: report.operation?.recordFailure ?? "unable to publish profile",
          },
        }
      : result;
  } finally {
    inFlightSwitchControllers.delete(operationId);
  }
}

function unavailableApplyModelRun(): Promise<unknown> {
  throw new Error("applyModelRun is required for a wet profile switch");
}

export async function applyResidencyProfile(
  args: ApplyResidencyProfileArgs,
): Promise<ResidencyApplyProfileResult> {
  if (!args.plan.ok) {
    return plannerRefusal(args.plan, args);
  }
  const plan = args.plan;
  const steps = resolveResidencyApplyProfileSteps(() =>
    defaultResidencyApplyProfileSteps({
      workloadsDir: args.workloadsDir,
      applyModelRun: args.applyModelRun ?? unavailableApplyModelRun,
      ...(args.managedLaunchAdmission === undefined
        ? {}
        : { managedLaunchAdmission: args.managedLaunchAdmission }),
    }),
  );
  if (args.dryRun) {
    return mapReport(
      await executeProfileSwitch(plan, steps, { dryRun: true, registry: args.registry }),
    );
  }
  const stale = checkDesiredProfile(plan, args);
  if (stale !== null) {
    return residencyApplyProfileRefusal({
      node: plan.node,
      to: plan.to,
      from: plan.from,
      reason: "DesiredStateChanged",
      detail: stale,
    });
  }
  const managed = args.managedLaunchAdmission;
  if (managed !== undefined) {
    const preflight = (): string | undefined => {
      if (args.registry === null) return "managed profiles require a target lease registry";
      if (managed.preflightProfile === undefined) return "managed profile preflight is unavailable";
      return managed.preflightProfile(plan);
    };
    const refusal = preflight();
    if (refusal !== undefined) {
      return residencyApplyProfileRefusal({
        reason: "ManagedProfilePreflight",
        detail: refusal,
        node: plan.node,
        from: plan.from,
        to: plan.to,
      });
    }
    return await runWet(plan, { ...steps, beforeTeardown: preflight }, args);
  }
  return await runWet(plan, steps, args);
}

type CancelStoreLookup = { absent: boolean; record: ResidencyOperationRecord | null };

function readCancelStoreRecord(storePath: string, operationId: string): CancelStoreLookup {
  if (!existsSync(storePath)) {
    return { absent: true, record: null };
  }
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return { absent: false, record: store.getOperation(operationId) };
  } finally {
    store.close();
  }
}

function alreadyTerminalResult(
  operationId: string,
  record: ResidencyOperationRecord,
): ResidencyCancelOperationResult {
  return {
    ok: false,
    outcome: "already-terminal",
    operationId,
    ...(record.outcome === null ? {} : { recordedOutcome: record.outcome }),
    detail: `operation ${operationId} is already terminal (outcome ${record.outcome ?? "unknown"})`,
  };
}

function cancelRequestedResult(operationId: string): ResidencyCancelOperationResult {
  return {
    ok: true,
    outcome: "cancel-requested",
    operationId,
    detail: `abort delivered to profile switch ${operationId}; it stops before its next step boundary (a step already running completes). The recorded outcome is on the operation: see residency status or the apply-profile result`,
  };
}

function notFoundResult(operationId: string): ResidencyCancelOperationResult {
  return {
    ok: false,
    outcome: "not-found",
    operationId,
    detail: `no residency operation ${operationId} in the node-local store`,
  };
}

function notOwnedResult(operationId: string): ResidencyCancelOperationResult {
  return {
    ok: false,
    outcome: "not-owned-by-this-process",
    operationId,
    detail: `operation ${operationId} is in flight but not owned by this serving process; cancel reaches only profile switches running in the process that serves this request (an agent serve process or one MCP server), so a switch run in-process by another CLI invocation cannot be cancelled here`,
  };
}

export function cancelResidencyProfileOperation(args: {
  operationId: string;
  storePath: string;
}): ResidencyCancelOperationResult {
  const { operationId, storePath } = args;
  const lookup = readCancelStoreRecord(storePath, operationId);
  if (lookup.record !== null && lookup.record.phase === "terminal") {
    return alreadyTerminalResult(operationId, lookup.record);
  }
  const controller = inFlightSwitchControllers.get(operationId);
  if (controller !== undefined) {
    controller.abort();
    return cancelRequestedResult(operationId);
  }
  if (lookup.absent || lookup.record === null) {
    return notFoundResult(operationId);
  }
  return notOwnedResult(operationId);
}
