/**
 * #279 DF-06: executor for a planned profile switch. Dry-run by default;
 * no live caller in this slice.
 *
 * When a residency lease registry is published (or passed via
 * `opts.registry`), fence-admission and drain run as whole-victim-set
 * phases under a single drain window: every victim is fenced
 * (`beginDrain`), every fenced victim is drained (`whenIdle` raced against
 * `drainTimeoutMs`), and only then is each victim stopped and its unload
 * committed before any replacement starts. A refusal or drain timeout
 * cancels every drain the executor owns and stops nothing; a stop or commit
 * failure cancels the outstanding drains. Without a registry the run is the
 * stop/start-only fail-fast loop.
 *
 * persist-suppression/verify-release/reserve/verify-ready/publish/complete
 * stay deferred, as do per-node serialization, crash recovery and rollback.
 * The planner's `request.timeouts.drainMs` is not carried on `OkPlan`, so the
 * executor uses `opts.drainTimeoutMs` or the default; threading the resolved
 * timeouts through is a later slice.
 */
import { getResidencyLeaseRegistry, type ResidencyLeases } from "@llamactl/core/residency/leases";
import {
  DEFAULT_PROFILE_SWITCH_TIMEOUTS,
  type OkPlan,
  type ProfileSwitchPlan,
  type StepKind,
} from "@llamactl/core/residency/planner";

export type ProfileSwitchStepOutcome = { ok: true } | { ok: false; detail: string };
export type ProfileSwitchExecutorDeps = {
  // caller wires the verified stop procedures; with a lease registry in play the
  // executor holds the drain token, so the caller must wire the unfenced verified
  // stop: the #613 fenceWorkloadStop would refuse it with DrainInProgress
  stop: (workload: string) => Promise<ProfileSwitchStepOutcome>;
  // caller wires the admission-gated start
  start: (workload: string) => Promise<ProfileSwitchStepOutcome>;
};
export type ProfileSwitchExecutionStatus = "planned" | "ok" | "failed" | "not-run";
export type ProfileSwitchStepAction = "fence" | "drain" | "stop" | "start";
export type ProfileSwitchExecutionStep = {
  action: ProfileSwitchStepAction;
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
  failedAt: { action: ProfileSwitchStepAction; workload: string; detail: string } | null;
  deferred: StepKind[];
  refusal?: { reason: string; detail: string };
};

type PlannedStep = { action: ProfileSwitchStepAction; workload: string };
type StepFailure = { action: ProfileSwitchStepAction; workload: string; detail: string };
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
type DrainToken = Extract<ReturnType<ResidencyLeases["beginDrain"]>, { ok: true }>["token"];
type WhenIdleOutcome = Awaited<ReturnType<ResidencyLeases["whenIdle"]>>;
type DrainSettle = { kind: "ok"; result: WhenIdleOutcome } | { kind: "err"; error: unknown };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stepRecord(
  action: ProfileSwitchStepAction,
  workload: string,
  status: ProfileSwitchExecutionStatus,
  detail?: string,
): ProfileSwitchExecutionStep {
  return {
    action,
    workload,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

function failureOf(step: ProfileSwitchExecutionStep): StepFailure | null {
  if (step.status === "failed" && step.detail !== undefined) {
    return { action: step.action, workload: step.workload, detail: step.detail };
  }
  return null;
}

function appendNotRun(
  steps: ProfileSwitchExecutionStep[],
  action: ProfileSwitchStepAction,
  workloads: string[],
): void {
  for (const workload of workloads) {
    steps.push(stepRecord(action, workload, "not-run"));
  }
}

function cancelBestEffort(registry: ResidencyLeases, tokens: DrainToken[]): void {
  for (const token of tokens) {
    try {
      registry.cancelDrain(token);
    } catch {
      // best-effort: a failed cancel must not mask the original failure
    }
  }
}

function classifyDrain(settle: DrainSettle): string | undefined {
  if (settle.kind === "err") {
    return messageOf(settle.error);
  }
  if (settle.result.idle) {
    return undefined;
  }
  if (settle.result.reason === "Aborted") {
    return "drain timeout";
  }
  return `drain ${settle.result.reason}`;
}

function deferredKinds(plan: ProfileSwitchPlan, fenced: boolean): StepKind[] {
  if (!plan.ok) {
    return [];
  }
  const executed: StepKind[] = fenced
    ? ["fence-admission", "drain", "unload", "start"]
    : ["unload", "start"];
  return plan.steps.map((step) => step.kind).filter((kind) => !executed.includes(kind));
}

function plannedSteps(victims: string[], replacements: string[], fenced: boolean): PlannedStep[] {
  if (fenced) {
    return [
      ...victims.map((workload): PlannedStep => ({ action: "fence", workload })),
      ...victims.map((workload): PlannedStep => ({ action: "drain", workload })),
      ...victims.map((workload): PlannedStep => ({ action: "stop", workload })),
      ...replacements.map((workload): PlannedStep => ({ action: "start", workload })),
    ];
  }
  return [
    ...victims.map((workload): PlannedStep => ({ action: "stop", workload })),
    ...replacements.map((workload): PlannedStep => ({ action: "start", workload })),
  ];
}

async function runStep(
  step: PlannedStep,
  deps: ProfileSwitchExecutorDeps,
): Promise<ProfileSwitchStepOutcome> {
  try {
    const pending = step.action === "start" ? deps.start(step.workload) : deps.stop(step.workload);
    const outcome: unknown = await pending;
    if (typeof outcome === "object" && outcome !== null && "ok" in outcome) {
      if (outcome.ok === true) {
        return { ok: true };
      }
      if (outcome.ok === false && "detail" in outcome && typeof outcome.detail === "string") {
        const detail: string = outcome.detail;
        return { ok: false, detail };
      }
    }
    return { ok: false, detail: "invalid step outcome" };
  } catch (error: unknown) {
    return { ok: false, detail: messageOf(error) };
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
      steps.push(stepRecord(step.action, step.workload, "not-run"));
      continue;
    }
    const outcome = await runStep(step, deps);
    if (outcome.ok) {
      steps.push(stepRecord(step.action, step.workload, "ok"));
      continue;
    }
    const failed = stepRecord(step.action, step.workload, "failed", outcome.detail);
    steps.push(failed);
    failedAt = failureOf(failed);
  }
  return { steps, failedAt };
}

function fenceOne(
  registry: ResidencyLeases,
  workload: string,
): { step: ProfileSwitchExecutionStep; token?: DrainToken } {
  try {
    const begun = registry.beginDrain(workload);
    if (begun.ok) {
      return { step: stepRecord("fence", workload, "ok"), token: begun.token };
    }
    return { step: stepRecord("fence", workload, "failed", begun.reason) };
  } catch (error: unknown) {
    return { step: stepRecord("fence", workload, "failed", messageOf(error)) };
  }
}

function fencePhase(
  registry: ResidencyLeases,
  victims: string[],
): RunResult & { tokens: DrainToken[] } {
  const steps: ProfileSwitchExecutionStep[] = [];
  const tokens: DrainToken[] = [];
  let failedAt: StepFailure | null = null;
  for (const workload of victims) {
    if (failedAt !== null) {
      steps.push(stepRecord("fence", workload, "not-run"));
      continue;
    }
    const attempt = fenceOne(registry, workload);
    steps.push(attempt.step);
    if (attempt.token === undefined) {
      failedAt = failureOf(attempt.step);
      continue;
    }
    tokens.push(attempt.token);
  }
  return { steps, tokens, failedAt };
}

function waitIdle(
  registry: ResidencyLeases,
  token: DrainToken,
  signal: AbortSignal,
): Promise<DrainSettle> {
  try {
    return registry.whenIdle(token, { signal }).then(
      (result): DrainSettle => ({ kind: "ok", result }),
      (error: unknown): DrainSettle => ({ kind: "err", error }),
    );
  } catch (error: unknown) {
    return Promise.resolve({ kind: "err", error });
  }
}

async function drainPhase(
  registry: ResidencyLeases,
  tokens: DrainToken[],
  drainTimeoutMs: number,
): Promise<RunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, drainTimeoutMs);
  let settles: DrainSettle[];
  try {
    settles = await Promise.all(
      tokens.map((token): Promise<DrainSettle> => waitIdle(registry, token, controller.signal)),
    );
  } finally {
    clearTimeout(timer);
  }

  const steps: ProfileSwitchExecutionStep[] = [];
  let failedAt: StepFailure | null = null;
  for (const [index, token] of tokens.entries()) {
    const settle = settles[index];
    if (settle === undefined) {
      continue;
    }
    const detail = classifyDrain(settle);
    const drainStep =
      detail === undefined
        ? stepRecord("drain", token.workload, "ok")
        : stepRecord("drain", token.workload, "failed", detail);
    steps.push(drainStep);
    failedAt ??= failureOf(drainStep);
  }
  return { steps, failedAt };
}

async function runStopOne(
  registry: ResidencyLeases,
  deps: ProfileSwitchExecutorDeps,
  workload: string,
  token: DrainToken,
): Promise<ProfileSwitchStepOutcome> {
  const stopped = await runStep({ action: "stop", workload }, deps);
  if (!stopped.ok) {
    return stopped;
  }
  try {
    const commit = registry.commitUnload(token);
    if (!commit.ok) {
      return { ok: false, detail: `commit ${commit.reason}` };
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, detail: messageOf(error) };
  }
}

async function stopPhase(
  registry: ResidencyLeases,
  deps: ProfileSwitchExecutorDeps,
  victims: string[],
  replacements: string[],
  tokens: DrainToken[],
): Promise<RunResult> {
  const steps: ProfileSwitchExecutionStep[] = [];
  for (const [index, workload] of victims.entries()) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    const outcome = await runStopOne(registry, deps, workload, token);
    if (outcome.ok) {
      steps.push(stepRecord("stop", workload, "ok"));
      continue;
    }
    const failed = stepRecord("stop", workload, "failed", outcome.detail);
    steps.push(failed);
    appendNotRun(steps, "stop", victims.slice(index + 1));
    appendNotRun(steps, "start", replacements);
    cancelBestEffort(registry, tokens.slice(index));
    return { steps, failedAt: failureOf(failed) };
  }
  return { steps, failedAt: null };
}

async function startPhase(
  deps: ProfileSwitchExecutorDeps,
  replacements: string[],
): Promise<RunResult> {
  const steps: ProfileSwitchExecutionStep[] = [];
  let failedAt: StepFailure | null = null;
  for (const workload of replacements) {
    if (failedAt !== null) {
      steps.push(stepRecord("start", workload, "not-run"));
      continue;
    }
    const outcome = await runStep({ action: "start", workload }, deps);
    if (outcome.ok) {
      steps.push(stepRecord("start", workload, "ok"));
      continue;
    }
    const failed = stepRecord("start", workload, "failed", outcome.detail);
    steps.push(failed);
    failedAt = failureOf(failed);
  }
  return { steps, failedAt };
}

async function runFenced(
  plan: OkPlan,
  deps: ProfileSwitchExecutorDeps,
  registry: ResidencyLeases,
  drainTimeoutMs: number,
): Promise<RunResult> {
  const fence = fencePhase(registry, plan.victims);
  const steps = fence.steps;
  if (fence.failedAt !== null) {
    cancelBestEffort(registry, fence.tokens);
    appendNotRun(steps, "drain", plan.victims);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    return { steps, failedAt: fence.failedAt };
  }

  const drain = await drainPhase(registry, fence.tokens, drainTimeoutMs);
  steps.push(...drain.steps);
  if (drain.failedAt !== null) {
    cancelBestEffort(registry, fence.tokens);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    return { steps, failedAt: drain.failedAt };
  }

  const stop = await stopPhase(registry, deps, plan.victims, plan.replacements, fence.tokens);
  steps.push(...stop.steps);
  if (stop.failedAt !== null) {
    return { steps, failedAt: stop.failedAt };
  }

  const start = await startPhase(deps, plan.replacements);
  steps.push(...start.steps);
  return { steps, failedAt: start.failedAt };
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

export async function executeProfileSwitch(
  plan: ProfileSwitchPlan,
  deps: ProfileSwitchExecutorDeps,
  opts?: { dryRun?: boolean; registry?: ResidencyLeases | null; drainTimeoutMs?: number },
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

  const registry = opts?.registry === undefined ? getResidencyLeaseRegistry() : opts.registry;
  const customTimeout = opts?.drainTimeoutMs;
  const drainTimeoutMs =
    customTimeout !== undefined && Number.isFinite(customTimeout) && customTimeout > 0
      ? customTimeout
      : DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs;
  const fenced = registry !== null;
  const deferred = deferredKinds(plan, fenced);
  const planned = plannedSteps(plan.victims, plan.replacements, fenced);

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

  const result = fenced
    ? await runFenced(plan, deps, registry, drainTimeoutMs)
    : await runSteps(planned, deps);
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
