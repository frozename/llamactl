/**
 * #284 (DF-11): dry-run-by-default residency profile-switch mutation.
 *
 * `applyResidencyProfile` is the pure plan-execution core reached through the
 * router procedure, the CLI verb and the MCP tool. A dry run builds a report
 * from the plan alone and never opens the operation store; a wet run claims
 * the node-local operation fence, records the switch under model
 * `profile-switch:<node>` and runs the fenced executor. A foreign fence, or
 * any fence with a nonterminal `profile-switch:<node>` row, is never claimed
 * over — it reports busy without touching authority (see `runWet` for the
 * cross-process window that remains).
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type { OkPlan } from "@llamactl/core/residency/planner";

import { server as serverMod } from "@llamactl/core";
import { randomUUID } from "node:crypto";

import type { ResidencyPlan } from "./procedures.js";

import { startModelHost, stopModelHost } from "../server/modelhost.js";
import { ModelRunSchema, type ModelRunStatus } from "../workload/schema.js";
import {
  listWorkloadNames,
  loadWorkloadByName,
  loadWorkloadByNameAny,
  saveWorkload,
  withWorkloadsMutex,
} from "../workload/store.js";
import {
  executeProfileSwitch,
  type ProfileSwitchExecutionReport,
  type ProfileSwitchExecutionStep,
  type ProfileSwitchExecutorDeps,
  profileSwitchOperationKey,
  type ProfileSwitchStepOutcome,
} from "./profile-transition.js";
import { reopenWorkloadAfterLoad } from "./stop-fence.js";
import { openResidencyOperationStore, type ResidencyOperationStore } from "./store.js";

// The one owner identity every operation-fence claim on the node-local store
// uses (only the incarnation differs). #279 DF-06 agent-boot recovery claims
// with it too, so a recovery claim never turns later apply-profile calls into
// a foreign-owner Busy.
export const RESIDENCY_APPLY_PROFILE_FENCE_OWNER = "llamactl-residency-apply-profile";
const RESIDENCY_APPLY_PROFILE_DESIRED_REVISION = 0;

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

export type ResidencyApplyProfileRefusal = { reason: string; detail: string };

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

export type ApplyResidencyProfileArgs = {
  plan: ResidencyPlan;
  dryRun: boolean;
  storePath: string;
  workloadsDir: string;
  registry: ResidencyLeases | null;
  fenceIdentity?: FenceIdentity;
  node?: string | null;
  to?: string | null;
  from?: string | null;
  applyModelRun?: (manifest: unknown) => Promise<unknown>;
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
}): ResidencyApplyProfileResult {
  return {
    ok: false,
    dryRun: false,
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
  return { ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER, incarnation: randomUUID() };
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
): Promise<ProfileSwitchStepOutcome> {
  const manifest = loadWorkloadByNameAny(workload, workloadsDir);
  if (manifest.kind === "ModelHost") {
    const stopped = await stopModelHost({ key: { name: workload } });
    return stopped.ok
      ? { ok: true }
      : { ok: false, detail: stopped.error ?? "modelHost stop failed" };
  }
  const result = await serverMod.stopServer({ key: { name: workload } });
  if (!result.stopped) {
    return { ok: false, detail: `stop did not confirm process removal for ${workload}` };
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
  applyModelRun: (manifest: unknown) => Promise<unknown>,
): Promise<ProfileSwitchStepOutcome> {
  if (!listWorkloadNames(workloadsDir).includes(workload)) {
    return { ok: false, detail: `unknown workload ${workload}` };
  }
  const manifest = loadWorkloadByNameAny(workload, workloadsDir);
  if (manifest.kind === "ModelHost") {
    const started = await startModelHost({ key: { name: workload } });
    return started.ok
      ? { ok: true }
      : { ok: false, detail: started.error ?? "modelHost start failed" };
  }
  const applied = await applyModelRun(manifest);
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

export function defaultResidencyApplyProfileSteps(opts: {
  workloadsDir: string;
  applyModelRun: (manifest: unknown) => Promise<unknown>;
}): ProfileSwitchExecutorDeps {
  return {
    stop: (workload) => stopWorkload(opts.workloadsDir, workload),
    start: (workload) => startWorkload(opts.workloadsDir, workload, opts.applyModelRun),
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
    refusal: { reason: plan.reason, detail: plan.detail },
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

async function runWet(
  plan: OkPlan,
  steps: ProfileSwitchExecutorDeps,
  args: ApplyResidencyProfileArgs,
): Promise<ResidencyApplyProfileResult> {
  const store = openResidencyOperationStore({ path: args.storePath });
  try {
    const identity = args.fenceIdentity ?? defaultFenceIdentity();
    // Cross-process race. Every apply-profile caller shares one ownerId (only
    // the incarnation differs), so the foreign-owner check below never stops a
    // second apply-profile process serving the same node. The planner's
    // in-flight refusal comes from `readResidencyStoreSnapshot`, taken before
    // observation collection, so it can be stale by the time we get here: call
    // B snapshots (no row yet), call A claims and begins
    // `profile-switch:<node>`, then B's claimOwnership bumps the token. A's
    // fenced finishOperation then fails stale-fence, A's stops/starts have
    // already run, and A's row is orphaned nonterminal — every later switch on
    // the node is NodeBusy until #702's recovery terminalizes it (a row whose
    // fence is not the current one is recovered, as `unknown`). The agent runs
    // the synchronous variant at boot (#279 DF-06, boot-recovery.ts), so the
    // bound is the next agent start once the row is older than the boot
    // staleness window; nothing recovers it while the agent keeps running.
    // The re-check below closes the snapshot-to-claim gap down to the synchronous
    // listNonterminal → claimOwnership pair; a claim landing between those two
    // calls, or between our claim and beginOperation, is not excluded. In the
    // latter order our beginOperation fails stale-fence and is reported refused
    // before any step runs; in the former, #702 recovery is what bounds the
    // damage. Closing it fully needs a check-and-claim inside one IMMEDIATE
    // store transaction.
    const inFlight = nonterminalSwitchId(store, plan.node);
    if (inFlight !== null) {
      return inFlightBusy(plan, inFlight);
    }
    const current = store.currentFence();
    if (current !== null && current.ownerId !== identity.ownerId) {
      return inFlightBusy(plan, "unknown");
    }
    const fence = store.claimOwnership(identity);
    return mapReport(
      await executeProfileSwitch(plan, steps, {
        dryRun: false,
        registry: args.registry,
        operation: {
          store,
          fenceToken: fence.fenceToken,
          operationId: randomUUID(),
          desiredRevision: RESIDENCY_APPLY_PROFILE_DESIRED_REVISION,
        },
      }),
    );
  } finally {
    store.close();
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
    }),
  );
  if (args.dryRun) {
    return mapReport(
      await executeProfileSwitch(plan, steps, { dryRun: true, registry: args.registry }),
    );
  }
  return await runWet(plan, steps, args);
}
