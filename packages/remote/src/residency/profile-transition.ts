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
 * Per-node serialization rides the DF-03 operations table, keyed
 * `profile-switch:<node>`, through the partial unique nonterminal index.
 * Cancellation is checked at step boundaries and ends a drain wait. The
 * record is opt-in until a live caller exists, which must pass it. The op's
 * desiredRevision participates in the store's shared watermark. A crash
 * between begin and finish leaves a nonterminal profile-switch row that
 * blocks the node (every later switch is Busy) until the deferred
 * crash-recovery path terminalizes it; serialization is therefore NOT
 * complete without recovery.
 *
 * On an ok, non-noop plan, `deferred` omits `complete` whenever
 * `opts.operation` is passed, because finishing that record terminal is the
 * plan's `complete` step. The omission keys on the option alone, not on a
 * record being finished, so it also holds for a dry run (which writes no
 * record) and for a Busy, store-refused or replayed report. Without
 * `opts.operation`, `complete` stays deferred. A refused or noop plan reports
 * an empty `deferred` either way.
 *
 * Crash recovery/rollback/persist-suppression/verify-release/reserve/
 * verify-ready/publish stay deferred. The planner's `request.timeouts.drainMs`
 * is not carried on `OkPlan`, so the executor uses `opts.drainTimeoutMs` or
 * the default; threading the resolved timeouts through is a later slice.
 */
import { getResidencyLeaseRegistry, type ResidencyLeases } from "@llamactl/core/residency/leases";
import {
  DEFAULT_PROFILE_SWITCH_TIMEOUTS,
  type OkPlan,
  type ProfileSwitchPlan,
  type StepKind,
} from "@llamactl/core/residency/planner";

import type { ResidencyOperationOutcome, ResidencyOperationStore } from "./store.js";

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
export type ProfileSwitchOperationOpts = {
  store: Pick<ResidencyOperationStore, "beginOperation" | "finishOperation" | "listNonterminal">;
  fenceToken: number;
  operationId: string;
  desiredRevision: number;
  nowMs?: () => number;
};
export type ProfileSwitchExecutionReport = {
  dryRun: boolean;
  ok: boolean;
  outcome:
    | "dry-run"
    | "refused"
    | "noop"
    | "stops-and-starts-ran"
    | "failed"
    | "busy"
    | "cancelled"
    | "replayed";
  node: string | null;
  from: string | null;
  to: string | null;
  steps: ProfileSwitchExecutionStep[];
  ran: ProfileSwitchExecutionStep[];
  failedAt: { action: ProfileSwitchStepAction; workload: string; detail: string } | null;
  deferred: StepKind[];
  busy?: { reason: "Busy"; node: string; operationId: string; detail: string };
  cancelledAt?: { action: ProfileSwitchStepAction; workload: string } | null;
  operation?: {
    id: string;
    outcome: ResidencyOperationOutcome;
    recorded: boolean;
    recordFailure?: string;
  };
  refusal?: { reason: string; detail: string };
};

type PlannedStep = { action: ProfileSwitchStepAction; workload: string };
type StepFailure = { action: ProfileSwitchStepAction; workload: string; detail: string };
type CancelledAt = { action: ProfileSwitchStepAction; workload: string };
type RunResult = {
  steps: ProfileSwitchExecutionStep[];
  failedAt: StepFailure | null;
  cancelledAt: CancelledAt | null;
};
type ReportInput = {
  dryRun: boolean;
  node: string | null;
  from: string | null;
  to: string | null;
  deferred: StepKind[];
  steps: ProfileSwitchExecutionStep[];
  failedAt: StepFailure | null;
  cancelledAt: CancelledAt | null;
  outcome: "dry-run" | "stops-and-starts-ran" | "failed" | "cancelled";
  operation?: ProfileSwitchExecutionReport["operation"];
};
type DrainToken = Extract<ReturnType<ResidencyLeases["beginDrain"]>, { ok: true }>["token"];
type WhenIdleOutcome = Awaited<ReturnType<ResidencyLeases["whenIdle"]>>;
type DrainSettle = { kind: "ok"; result: WhenIdleOutcome } | { kind: "err"; error: unknown };
type DrainResult = RunResult & { cancelled: boolean };
type BeginSwitchResult =
  | {
      ok: true;
      created: boolean;
      version: number;
      phase: string;
      outcome: ResidencyOperationOutcome | null;
    }
  | { ok: false; reason: string };
type FinishInfo = { outcome: ResidencyOperationOutcome; detail?: string };
type FinishRecord = { recorded: boolean; recordFailure?: string };

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

function deferredKinds(plan: ProfileSwitchPlan, fenced: boolean, recorded: boolean): StepKind[] {
  if (!plan.ok) {
    return [];
  }
  const executed: StepKind[] = fenced
    ? ["fence-admission", "drain", "unload", "start"]
    : ["unload", "start"];
  if (recorded) {
    executed.push("complete");
  }
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
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const steps: ProfileSwitchExecutionStep[] = [];
  let failedAt: StepFailure | null = null;
  let cancelledAt: CancelledAt | null = null;
  for (const step of planned) {
    if (failedAt !== null || cancelledAt !== null) {
      steps.push(stepRecord(step.action, step.workload, "not-run"));
      continue;
    }
    if (signal?.aborted === true) {
      cancelledAt = { action: step.action, workload: step.workload };
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
  return { steps, failedAt, cancelledAt };
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
  signal: AbortSignal | undefined,
): RunResult & { tokens: DrainToken[] } {
  const steps: ProfileSwitchExecutionStep[] = [];
  const tokens: DrainToken[] = [];
  let failedAt: StepFailure | null = null;
  let cancelledAt: CancelledAt | null = null;
  for (const workload of victims) {
    if (failedAt !== null || cancelledAt !== null) {
      steps.push(stepRecord("fence", workload, "not-run"));
      continue;
    }
    if (signal?.aborted === true) {
      cancelledAt = { action: "fence", workload };
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
  return { steps, tokens, failedAt, cancelledAt };
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

function drainStepFor(settle: DrainSettle, workload: string): ProfileSwitchExecutionStep {
  const detail = classifyDrain(settle);
  if (detail === undefined) {
    return stepRecord("drain", workload, "ok");
  }
  return stepRecord("drain", workload, "failed", detail);
}

function cancelledDrainStepFor(settle: DrainSettle, workload: string): ProfileSwitchExecutionStep {
  const idle = settle.kind === "ok" && settle.result.idle;
  return idle ? stepRecord("drain", workload, "ok") : stepRecord("drain", workload, "not-run");
}

async function drainPhase(
  registry: ResidencyLeases,
  tokens: DrainToken[],
  drainTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<DrainResult> {
  const controller = new AbortController();
  if (signal?.aborted === true) {
    controller.abort();
  }
  const onAbort = (): void => {
    controller.abort();
  };
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort);
  }
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
    if (signal !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const cancelled = signal?.aborted === true;
  const steps: ProfileSwitchExecutionStep[] = [];
  let failedAt: StepFailure | null = null;
  for (const [index, token] of tokens.entries()) {
    const settle = settles[index];
    if (settle === undefined) {
      continue;
    }
    const drainStep = cancelled
      ? cancelledDrainStepFor(settle, token.workload)
      : drainStepFor(settle, token.workload);
    steps.push(drainStep);
    failedAt ??= failureOf(drainStep);
  }
  return { steps, failedAt: cancelled ? null : failedAt, cancelledAt: null, cancelled };
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
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const steps: ProfileSwitchExecutionStep[] = [];
  for (const [index, workload] of victims.entries()) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (signal?.aborted === true) {
      steps.push(stepRecord("stop", workload, "not-run"));
      appendNotRun(steps, "stop", victims.slice(index + 1));
      appendNotRun(steps, "start", replacements);
      cancelBestEffort(registry, tokens.slice(index));
      return { steps, failedAt: null, cancelledAt: { action: "stop", workload } };
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
    return { steps, failedAt: failureOf(failed), cancelledAt: null };
  }
  return { steps, failedAt: null, cancelledAt: null };
}

async function startPhase(
  deps: ProfileSwitchExecutorDeps,
  replacements: string[],
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const steps: ProfileSwitchExecutionStep[] = [];
  let failedAt: StepFailure | null = null;
  let cancelledAt: CancelledAt | null = null;
  for (const workload of replacements) {
    if (failedAt !== null || cancelledAt !== null) {
      steps.push(stepRecord("start", workload, "not-run"));
      continue;
    }
    if (signal?.aborted === true) {
      cancelledAt = { action: "start", workload };
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
  return { steps, failedAt, cancelledAt };
}

function firstVictim(victims: string[], action: ProfileSwitchStepAction): CancelledAt | null {
  const workload = victims[0];
  return workload === undefined ? null : { action, workload };
}

async function runFenced(
  plan: OkPlan,
  deps: ProfileSwitchExecutorDeps,
  registry: ResidencyLeases,
  drainTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  const fence = fencePhase(registry, plan.victims, signal);
  const steps = fence.steps;
  if (fence.failedAt !== null) {
    cancelBestEffort(registry, fence.tokens);
    appendNotRun(steps, "drain", plan.victims);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    return { steps, failedAt: fence.failedAt, cancelledAt: null };
  }
  if (fence.cancelledAt !== null || signal?.aborted === true) {
    cancelBestEffort(registry, fence.tokens);
    appendNotRun(steps, "drain", plan.victims);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    const cancelledAt = fence.cancelledAt ?? firstVictim(plan.victims, "drain");
    return { steps, failedAt: null, cancelledAt };
  }

  const drain = await drainPhase(registry, fence.tokens, drainTimeoutMs, signal);
  steps.push(...drain.steps);
  if (drain.cancelled) {
    cancelBestEffort(registry, fence.tokens);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    return { steps, failedAt: null, cancelledAt: firstVictim(plan.victims, "stop") };
  }
  if (drain.failedAt !== null) {
    cancelBestEffort(registry, fence.tokens);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    return { steps, failedAt: drain.failedAt, cancelledAt: null };
  }

  const stop = await stopPhase(
    registry,
    deps,
    plan.victims,
    plan.replacements,
    fence.tokens,
    signal,
  );
  steps.push(...stop.steps);
  if (stop.failedAt !== null) {
    return { steps, failedAt: stop.failedAt, cancelledAt: null };
  }
  if (stop.cancelledAt !== null) {
    return { steps, failedAt: null, cancelledAt: stop.cancelledAt };
  }

  const start = await startPhase(deps, plan.replacements, signal);
  steps.push(...start.steps);
  return { steps, failedAt: start.failedAt, cancelledAt: start.cancelledAt };
}

function buildReport(input: ReportInput): ProfileSwitchExecutionReport {
  const ran = input.steps.filter((step) => step.status === "ok" || step.status === "failed");
  return {
    dryRun: input.dryRun,
    ok: input.outcome !== "failed" && input.outcome !== "cancelled",
    outcome: input.outcome,
    node: input.node,
    from: input.from,
    to: input.to,
    steps: input.steps,
    ran,
    failedAt: input.failedAt,
    deferred: input.deferred,
    cancelledAt: input.cancelledAt,
    ...(input.operation === undefined ? {} : { operation: input.operation }),
  };
}

export function profileSwitchOperationKey(node: string): string {
  return `profile-switch:${node}`;
}

function beginSwitchOperation(
  plan: OkPlan,
  operation: ProfileSwitchOperationOpts,
): BeginSwitchResult {
  const nowMs = operation.nowMs ?? Date.now;
  try {
    const begun = operation.store.beginOperation({
      fenceToken: operation.fenceToken,
      operationId: operation.operationId,
      model: profileSwitchOperationKey(plan.node),
      targetState: `profile:${plan.to}`,
      desiredRevision: operation.desiredRevision,
      reservationGiB: 0,
      nowMs: nowMs(),
    });
    if (!begun.ok) {
      return { ok: false, reason: begun.reason };
    }
    return {
      ok: true,
      created: begun.created,
      version: begun.record.version,
      phase: begun.record.phase,
      outcome: begun.record.outcome,
    };
  } catch (error: unknown) {
    return { ok: false, reason: messageOf(error) };
  }
}

function finishInfoFor(result: RunResult): FinishInfo {
  if (result.cancelledAt !== null) {
    return {
      outcome: "cancelled",
      detail: `cancelled before ${result.cancelledAt.action} ${result.cancelledAt.workload}`,
    };
  }
  if (result.failedAt !== null) {
    return {
      outcome: "failed",
      detail: `${result.failedAt.action} ${result.failedAt.workload}: ${result.failedAt.detail}`,
    };
  }
  return { outcome: "succeeded" };
}

function finishSwitchOperation(
  operation: ProfileSwitchOperationOpts,
  expectedVersion: number,
  info: FinishInfo,
): FinishRecord {
  const nowMs = operation.nowMs ?? Date.now;
  try {
    const finished = operation.store.finishOperation({
      fenceToken: operation.fenceToken,
      operationId: operation.operationId,
      expectedVersion,
      nowMs: nowMs(),
      outcome: info.outcome,
      ...(info.detail === undefined ? {} : { detail: info.detail }),
    });
    if (finished.ok) {
      return { recorded: true };
    }
    return { recorded: false, recordFailure: finished.reason };
  } catch (error: unknown) {
    return { recorded: false, recordFailure: messageOf(error) };
  }
}

function busyReport(
  plan: OkPlan,
  deferred: StepKind[],
  operationId: string,
): ProfileSwitchExecutionReport {
  return {
    dryRun: false,
    ok: false,
    outcome: "busy",
    node: plan.node,
    from: plan.from,
    to: plan.to,
    steps: [],
    ran: [],
    failedAt: null,
    deferred,
    busy: {
      reason: "Busy",
      node: plan.node,
      operationId,
      detail: `profile switch already in flight on node ${plan.node}: operation ${operationId}`,
    },
  };
}

function inFlightOperationId(operation: ProfileSwitchOperationOpts, plan: OkPlan): string {
  const key = profileSwitchOperationKey(plan.node);
  const inflight = operation.store.listNonterminal().find((record) => record.model === key);
  return inflight?.operationId ?? "unknown";
}

async function executeWithOperation(
  plan: OkPlan,
  deferred: StepKind[],
  operation: ProfileSwitchOperationOpts,
  run: () => Promise<RunResult>,
): Promise<ProfileSwitchExecutionReport> {
  const begun = beginSwitchOperation(plan, operation);
  if (!begun.ok) {
    if (begun.reason === "reservation-conflict") {
      return busyReport(plan, deferred, inFlightOperationId(operation, plan));
    }
    return {
      dryRun: false,
      ok: false,
      outcome: "refused",
      node: plan.node,
      from: plan.from,
      to: plan.to,
      steps: [],
      ran: [],
      failedAt: null,
      deferred,
      refusal: { reason: "operation-record-refused", detail: begun.reason },
    };
  }
  if (!begun.created) {
    if (begun.phase === "terminal") {
      return {
        dryRun: false,
        ok: begun.outcome === "succeeded",
        outcome: "replayed",
        node: plan.node,
        from: plan.from,
        to: plan.to,
        steps: [],
        ran: [],
        failedAt: null,
        deferred,
        operation: {
          id: operation.operationId,
          outcome: begun.outcome ?? "unknown",
          recorded: true,
        },
      };
    }
    return busyReport(plan, deferred, operation.operationId);
  }

  let result: RunResult;
  try {
    result = await run();
  } catch (error: unknown) {
    finishSwitchOperation(operation, begun.version, {
      outcome: "failed",
      detail: messageOf(error),
    });
    throw error;
  }
  const info = finishInfoFor(result);
  const record = finishSwitchOperation(operation, begun.version, info);
  const outcome =
    result.cancelledAt !== null
      ? "cancelled"
      : result.failedAt === null
        ? "stops-and-starts-ran"
        : "failed";
  return buildReport({
    dryRun: false,
    node: plan.node,
    from: plan.from,
    to: plan.to,
    deferred,
    steps: result.steps,
    failedAt: result.failedAt,
    cancelledAt: result.cancelledAt,
    outcome,
    operation: {
      id: operation.operationId,
      outcome: info.outcome,
      recorded: record.recorded,
      ...(record.recordFailure === undefined ? {} : { recordFailure: record.recordFailure }),
    },
  });
}

function drainTimeoutMsFrom(customTimeout: number | undefined): number {
  return customTimeout !== undefined && Number.isFinite(customTimeout) && customTimeout > 0
    ? customTimeout
    : DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs;
}

export async function executeProfileSwitch(
  plan: ProfileSwitchPlan,
  deps: ProfileSwitchExecutorDeps,
  opts?: {
    dryRun?: boolean;
    registry?: ResidencyLeases | null;
    drainTimeoutMs?: number;
    signal?: AbortSignal;
    operation?: ProfileSwitchOperationOpts;
  },
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
  const drainTimeoutMs = drainTimeoutMsFrom(opts?.drainTimeoutMs);
  const fenced = registry !== null;
  const deferred = deferredKinds(plan, fenced, opts?.operation !== undefined);
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
      cancelledAt: null,
      outcome: "dry-run",
    });
  }

  const signal = opts.signal;
  const operation = opts.operation;
  if (operation !== undefined) {
    return await executeWithOperation(plan, deferred, operation, async () =>
      fenced
        ? await runFenced(plan, deps, registry, drainTimeoutMs, signal)
        : await runSteps(planned, deps, signal),
    );
  }

  const result = fenced
    ? await runFenced(plan, deps, registry, drainTimeoutMs, signal)
    : await runSteps(planned, deps, signal);
  const outcome =
    result.cancelledAt !== null
      ? "cancelled"
      : result.failedAt === null
        ? "stops-and-starts-ran"
        : "failed";
  return buildReport({
    dryRun,
    node: plan.node,
    from: plan.from,
    to: plan.to,
    deferred,
    steps: result.steps,
    failedAt: result.failedAt,
    cancelledAt: result.cancelledAt,
    outcome,
  });
}
