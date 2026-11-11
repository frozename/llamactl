/**
 * #279 DF-06: executor for a planned profile switch. Dry-run by default;
 * no live caller in this slice; only the victim stops (plan step
 * `unload`) and replacement starts (plan step `start`) are executed;
 * fence-admission/drain/persist-suppression/verify-release/reserve/verify-ready/publish/complete
 * are reported as `deferred`, as are per-node serialization, crash
 * recovery and rollback.
 */
import type { ProfileSwitchPlan, StepKind } from "@llamactl/core/residency/planner";

export type ProfileSwitchStepOutcome = { ok: true } | { ok: false; detail: string };
export type ProfileSwitchExecutorDeps = {
  // caller wires the verified stop procedures (serverStop/modelHostStop behind the #613 fence)
  stop: (workload: string) => Promise<ProfileSwitchStepOutcome>;
  // caller wires the admission-gated start
  start: (workload: string) => Promise<ProfileSwitchStepOutcome>;
};
export type ProfileSwitchExecutionStatus = "planned" | "ok" | "failed" | "not-run";
export type ProfileSwitchExecutionStep = {
  action: "stop" | "start";
  workload: string;
  status: ProfileSwitchExecutionStatus;
  detail?: string;
};
export type ProfileSwitchExecutionReport = {
  dryRun: boolean;
  ok: boolean;
  outcome: "dry-run" | "refused" | "noop" | "stops-and-starts-ran" | "failed";
  node: string | null;
  from: string | null;
  to: string | null;
  steps: ProfileSwitchExecutionStep[];
  ran: ProfileSwitchExecutionStep[];
  failedAt: { action: "stop" | "start"; workload: string; detail: string } | null;
  deferred: StepKind[];
  refusal?: { reason: string; detail: string };
};

type PlannedStep = { action: "stop" | "start"; workload: string };
type StepFailure = { action: "stop" | "start"; workload: string; detail: string };
type RunResult = { steps: ProfileSwitchExecutionStep[]; failedAt: StepFailure | null };
type ReportInput = {
  dryRun: boolean;
  node: string | null;
  from: string | null;
  to: string | null;
  deferred: StepKind[];
  steps: ProfileSwitchExecutionStep[];
  failedAt: StepFailure | null;
  outcome: "dry-run" | "stops-and-starts-ran" | "failed";
};

function plannedSteps(victims: string[], replacements: string[]): PlannedStep[] {
  const stops = victims.map((workload): PlannedStep => ({ action: "stop", workload }));
  const starts = replacements.map((workload): PlannedStep => ({ action: "start", workload }));
  return [...stops, ...starts];
}

function deferredKinds(plan: ProfileSwitchPlan): StepKind[] {
  if (!plan.ok) {
    return [];
  }
  return plan.steps
    .map((step) => step.kind)
    .filter((kind) => kind !== "unload" && kind !== "start");
}

function buildReport(input: ReportInput): ProfileSwitchExecutionReport {
  const ran = input.steps.filter((step) => step.status === "ok" || step.status === "failed");
  return {
    dryRun: input.dryRun,
    ok: input.outcome !== "failed",
    outcome: input.outcome,
    node: input.node,
    from: input.from,
    to: input.to,
    steps: input.steps,
    ran,
    failedAt: input.failedAt,
    deferred: input.deferred,
  };
}

async function runStep(
  step: PlannedStep,
  deps: ProfileSwitchExecutorDeps,
): Promise<ProfileSwitchStepOutcome> {
  try {
    return await (step.action === "stop" ? deps.stop(step.workload) : deps.start(step.workload));
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function runSteps(
  planned: PlannedStep[],
  deps: ProfileSwitchExecutorDeps,
): Promise<RunResult> {
  const steps: ProfileSwitchExecutionStep[] = [];
  let failedAt: StepFailure | null = null;
  for (const step of planned) {
    if (failedAt !== null) {
      steps.push({ action: step.action, workload: step.workload, status: "not-run" });
      continue;
    }
    const outcome = await runStep(step, deps);
    if (outcome.ok) {
      steps.push({ action: step.action, workload: step.workload, status: "ok" });
      continue;
    }
    steps.push({
      action: step.action,
      workload: step.workload,
      status: "failed",
      detail: outcome.detail,
    });
    failedAt = { action: step.action, workload: step.workload, detail: outcome.detail };
  }
  return { steps, failedAt };
}

export async function executeProfileSwitch(
  plan: ProfileSwitchPlan,
  deps: ProfileSwitchExecutorDeps,
  opts?: { dryRun?: boolean },
): Promise<ProfileSwitchExecutionReport> {
  const dryRun = opts?.dryRun !== false;

  if (!plan.ok) {
    return {
      dryRun,
      ok: false,
      outcome: "refused",
      node: null,
      from: null,
      to: null,
      steps: [],
      ran: [],
      failedAt: null,
      deferred: [],
      refusal: { reason: plan.reason, detail: plan.detail },
    };
  }

  if (plan.noop) {
    return {
      dryRun,
      ok: true,
      outcome: "noop",
      node: plan.node,
      from: plan.from,
      to: plan.to,
      steps: [],
      ran: [],
      failedAt: null,
      deferred: [],
    };
  }

  const deferred = deferredKinds(plan);
  const planned = plannedSteps(plan.victims, plan.replacements);

  if (dryRun) {
    const steps = planned.map(
      (step): ProfileSwitchExecutionStep => ({ ...step, status: "planned" }),
    );
    return buildReport({
      dryRun,
      node: plan.node,
      from: plan.from,
      to: plan.to,
      deferred,
      steps,
      failedAt: null,
      outcome: "dry-run",
    });
  }

  const result = await runSteps(planned, deps);
  const outcome = result.failedAt === null ? "stops-and-starts-ran" : "failed";
  return buildReport({
    dryRun,
    node: plan.node,
    from: plan.from,
    to: plan.to,
    deferred,
    steps: result.steps,
    failedAt: result.failedAt,
    outcome,
  });
}
