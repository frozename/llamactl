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
 * When `opts.sessions` is provided (or defaults to the installed seam), the
 * session registry composes with the switch's own drain: every victim is
 * checked at fence time (in `fenceOne`, same synchronous tick as
 * `beginDrain.ok`) and re-checked after the drain window settles (per-victim
 * in `drainPhase` before any stop runs), refusing `SessionsActive` /
 * `SessionsUnknown` before any stop. The override is `residency force-unload`.
 * A dry run (no drain, no stop) reports the same session refusals as advisory
 * `detail` on each session-bound victim's planned `fence` step, leaving the
 * outcome `dry-run` and ok true.
 *
 * Per-node serialization rides the DF-03 operations table, keyed
 * `profile-switch:<node>`, through the partial unique nonterminal index.
 * The switch reserves its replacements' memory at begin (the plan's `reserve`
 * step, or 0 when there is none) and is budget-admitted against the caller's
 * `nodeBudgetGiB` when one is passed; a store refusal surfaces as
 * `operation-record-refused`. Cancellation is checked at step boundaries and
 * ends a drain wait. The record is opt-in; the live caller (apply-profile)
 * passes it. The op's desiredRevision participates in the store's shared
 * watermark. An interrupted dispatched switch can leave its nonterminal row
 * blocking later switches until its dispatch outcome is verified.
 *
 * On an ok, non-noop plan, `deferred` omits `complete` whenever
 * `opts.operation` is passed, because finishing that record terminal is the
 * plan's `complete` step. The omission keys on the option alone, not on a
 * record being finished, so it also holds for a dry run (which writes no
 * record) and for a Busy, store-refused or replayed report. Without
 * `opts.operation`, `complete` stays deferred. A refused or noop plan reports
 * an empty `deferred` either way.
 *
 * Heartbeat. With `opts.operation`, the executor refreshes the record's
 * `updatedAtMs` at every step boundary: after each fence, after each drain
 * settles, after each stop and after each start. The write is the store's
 * fenced `touchOperation`, which never bumps the record's version. A refused
 * or throwing heartbeat (a stale fence, a locked store) is logged through
 * `opts.operation.log` (default stderr) and the switch carries on: a missed
 * heartbeat must never abort a switch half way. The agent-boot recovery reads
 * `updatedAtMs` as "last step progress", so a live switch whose steps each
 * finish inside its staleness window is never terminalized under it.
 *
 * Crash recovery (via `recovery.ts`) preserves committed profile-switch rows
 * and their reservations. Per-action step budgets ride `opts.stepTimeouts`: `unloadMs`
 * bounds each `stop` and `loadMs` each `start`, armed through the injectable
 * `opts.stepTimer`; absent, zero or non-finite budgets leave that action
 * unbounded (the same rule as `opts.drainTimeoutMs`, with no default). A
 * timed-out step fails with reason `StepTimedOut`, aborts the per-step signal
 * handed to the dep, and stops the switch and records it failed. That abort
 * signal is ADVISORY: no live dep honours it yet, so a timed-out dep may still
 * be running after the record goes terminal and the per-node lock is released,
 * letting a later switch on the node overlap it. A timed-out fenced stop
 * therefore leaves that victim's drain fenced (a later `beginDrain` gets
 * `AlreadyDraining`) and does not reopen admission; only the untouched later
 * victims are cancelled. The planner's resolved `request.timeouts` are still
 * not carried on `OkPlan`, so `apply-profile` runs unbounded until a later
 * slice threads them through. A `StepTimedOut` start or stop whose dep later
 * resolves is recorded `failed` via that aborted signal, and its row can still
 * be written after the operation is terminal.
 *
 * Residency lifecycle states. When `opts.operation.lifecycle` is passed, the
 * executor decorates its stop/start deps so each victim walks
 * ready -> draining -> unloading -> downloaded (or `failed`) and each
 * replacement walks down to loaded then -> loading -> warming -> ready (or
 * `failed`), refusing before the dep runs on a corroborated exclusive-group
 * occupant or any failed write. Corroboration: `victims ∪ retained` is what
 * the planner observed occupying, and `buildResidencyPlan` refuses
 * `UnknownState` unless every on-node workload was observed, so a same-group
 * occupying row outside that set is stale and is reconciled to downloaded.
 */
import { getResidencyLeaseRegistry, type ResidencyLeases } from "@llamactl/core/residency/leases";
import {
  DEFAULT_PROFILE_SWITCH_TIMEOUTS,
  type OkPlan,
  type ProfileSwitchPlan,
  type StepKind,
} from "@llamactl/core/residency/planner";
import { profileSwitchOperationKey } from "@llamactl/core/residency/profile-selection";
import {
  currentSessionRefcounts,
  type SessionRefcounts,
  type SessionUnloadCheck,
} from "@llamactl/core/residency/sessions";

import type {
  BeginOperationResult,
  ResidencyOperationOutcome,
  ResidencyOperationStore,
} from "./store.js";

import { type ProfileSwitchLifecycleOpts, withResidencyLifecycle } from "./lifecycle-steps.js";

export type ProfileSwitchStepOutcome = { ok: true } | { ok: false; detail: string };
// Per-action budgets for the stop/start steps. `unloadMs` bounds each `stop`
// dep call and `loadMs` each `start` dep call. `readyMs` is not here: it belongs
// to the still-deferred verify-ready step, and `drainMs` stays the drain-phase
// `drainTimeoutMs`, not a per-step budget.
export type ProfileSwitchStepTimeouts = { unloadMs?: number; loadMs?: number };
// Arms a one-shot timeout for `ms` and returns a cancel function. Injected so
// tests drive timeouts deterministically.
export type ProfileSwitchStepTimer = (ms: number, onTimeout: () => void) => () => void;
export type ProfileSwitchExecutorDeps = {
  beforeTeardown?: () => string | undefined;
  // caller wires the verified stop procedures; with a lease registry in play the
  // executor holds the drain token, so the caller must wire the unfenced verified
  // stop: the #613 fenceWorkloadStop would refuse it with DrainInProgress. The
  // optional ctx carries an ADVISORY abort signal handed to a budgeted step.
  // The session registry composes with the switch's own drain: checked at fence
  // and re-checked after the drain, refusing SessionsActive/SessionsUnknown,
  // never releasing sessions; the override is `residency force-unload`. A dry
  // run reports the same session refusals as advisory detail on the bound
  // victim's planned fence step.
  stop: (workload: string, ctx?: { signal?: AbortSignal }) => Promise<ProfileSwitchStepOutcome>;
  // caller wires the admission-gated start
  start: (workload: string, ctx?: { signal?: AbortSignal }) => Promise<ProfileSwitchStepOutcome>;
};
export type ProfileSwitchExecutionStatus = "planned" | "ok" | "failed" | "not-run";
export type ProfileSwitchStepAction = "fence" | "drain" | "verify" | "stop" | "start";
export type ProfileSwitchExecutionStep = {
  action: ProfileSwitchStepAction;
  workload: string;
  status: ProfileSwitchExecutionStatus;
  detail?: string;
  reason?: "StepTimedOut";
  timeoutMs?: number;
};
export type ProfileSwitchOperationOpts = {
  store: Pick<
    ResidencyOperationStore,
    "beginOperation" | "finishOperation" | "listNonterminal" | "touchOperation"
  >;
  fenceToken: number;
  operationId: string;
  desiredRevision: number;
  managed?: boolean;
  nowMs?: () => number;
  // the resolved node budget the reservation is admitted against; absent =
  // recorded but not admitted (store opt-in, #685)
  nodeBudgetGiB?: number;
  // The wet apply caller writes the reservation together with its new fence.
  begun?: Extract<BeginOperationResult, { ok: true }>;
  // where a failed step-boundary heartbeat is reported; default stderr
  log?: (line: string) => void;
  /** Revalidates desired inputs just before an actuator and its lifecycle writes. */
  checkDesired?: () => string | null;
  // per-model residency lifecycle wiring; when set the executor drives the
  // residency_states rows around each fenced stop/start
  lifecycle?: ProfileSwitchLifecycleOpts;
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
  failedAt: {
    action: ProfileSwitchStepAction;
    workload: string;
    detail: string;
    reason?: "StepTimedOut";
    timeoutMs?: number;
  } | null;
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
type StepFailure = {
  action: ProfileSwitchStepAction;
  workload: string;
  detail: string;
  reason?: "StepTimedOut";
  timeoutMs?: number;
};
// A step outcome carrying the budget that timed out (ms), set only on a
// StepTimedOut failure, so the step record and failedAt can stamp reason/timeoutMs.
type StepOutcome = ProfileSwitchStepOutcome & { timedOut?: number };
type StepBudget = {
  stopMs: number | null;
  startMs: number | null;
  timer: ProfileSwitchStepTimer;
  signal: AbortSignal | undefined;
};
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
// Called at every step boundary. It never throws.
type Beat = () => void;
const NO_BEAT: Beat = () => undefined;
type FinishRecord = { recorded: boolean; recordFailure?: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionRefusal(sessions: SessionRefcounts | null, workload: string): string | null {
  if (sessions === null) {
    return null;
  }
  let check: SessionUnloadCheck;
  try {
    check = sessions.checkUnload(workload);
  } catch {
    return "SessionsUnknown";
  }
  if (!check.ok) {
    return `SessionsActive: ${check.sessions.join(",")}`;
  }
  return null;
}

function dryRunSteps(
  planned: PlannedStep[],
  fenced: boolean,
  sessions: SessionRefcounts | null,
): ProfileSwitchExecutionStep[] {
  return planned.map((step): ProfileSwitchExecutionStep => {
    const refusal =
      fenced && sessions !== null && step.action === "fence"
        ? sessionRefusal(sessions, step.workload)
        : null;
    return {
      ...step,
      status: "planned",
      ...(refusal !== null ? { detail: refusal } : {}),
    };
  });
}

function stepRecord(
  action: ProfileSwitchStepAction,
  workload: string,
  status: ProfileSwitchExecutionStatus,
  detail?: string,
  timedOutMs?: number,
): ProfileSwitchExecutionStep {
  return {
    action,
    workload,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(timedOutMs === undefined ? {} : { reason: "StepTimedOut", timeoutMs: timedOutMs }),
  };
}

function failureOf(step: ProfileSwitchExecutionStep): StepFailure | null {
  if (step.status === "failed" && step.detail !== undefined) {
    return {
      action: step.action,
      workload: step.workload,
      detail: step.detail,
      ...(step.reason === undefined ? {} : { reason: step.reason }),
      ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    };
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

function normalizeOutcome(raw: unknown): StepOutcome {
  if (typeof raw === "object" && raw !== null && "ok" in raw) {
    if (raw.ok === true) {
      return { ok: true };
    }
    if (raw.ok === false && "detail" in raw && typeof raw.detail === "string") {
      const detail: string = raw.detail;
      return { ok: false, detail };
    }
  }
  return { ok: false, detail: "invalid step outcome" };
}

async function runStep(
  step: PlannedStep,
  deps: ProfileSwitchExecutorDeps,
  budget: StepBudget,
): Promise<StepOutcome> {
  const budgetMs = step.action === "start" ? budget.startMs : budget.stopMs;
  const execute = (signal: AbortSignal | undefined): Promise<ProfileSwitchStepOutcome> => {
    const run = step.action === "start" ? deps.start : deps.stop;
    return signal === undefined ? run(step.workload) : run(step.workload, { signal });
  };
  if (budgetMs === null) {
    try {
      return normalizeOutcome(await execute(budget.signal));
    } catch (error: unknown) {
      return { ok: false, detail: messageOf(error) };
    }
  }
  const controller = new AbortController();
  const signal =
    budget.signal === undefined
      ? controller.signal
      : AbortSignal.any([budget.signal, controller.signal]);
  // The dep promise is normalized before the race so a late resolve or reject
  // is already handled and never unhandled once the timer wins. The dep is
  // invoked inside a then callback so a synchronous throw or a non-promise
  // return is normalized exactly like the unbudgeted path, never escaping
  // runStep (which would skip cancelBestEffort on the fenced path).
  const depSettled: Promise<StepOutcome> = Promise.resolve()
    .then(() => execute(signal))
    .then(
      normalizeOutcome,
      (error: unknown): StepOutcome => ({ ok: false, detail: messageOf(error) }),
    );
  let cancel: () => void = () => undefined;
  const timedOut = new Promise<StepOutcome>((resolve) => {
    cancel = budget.timer(budgetMs, () => {
      controller.abort();
      resolve({
        ok: false,
        detail: `StepTimedOut: ${step.action} exceeded ${String(budgetMs)}ms`,
        timedOut: budgetMs,
      });
    });
  });
  try {
    return await Promise.race([depSettled, timedOut]);
  } finally {
    cancel();
  }
}

async function runSteps(
  planned: PlannedStep[],
  deps: ProfileSwitchExecutorDeps,
  signal: AbortSignal | undefined,
  beat: Beat,
  budget: StepBudget,
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
    const outcome = await runStep(step, deps, budget);
    beat();
    if (outcome.ok) {
      steps.push(stepRecord(step.action, step.workload, "ok"));
      continue;
    }
    const failed = stepRecord(
      step.action,
      step.workload,
      "failed",
      outcome.detail,
      outcome.timedOut,
    );
    steps.push(failed);
    failedAt = failureOf(failed);
  }
  return { steps, failedAt, cancelledAt };
}

function fenceOne(
  registry: ResidencyLeases,
  workload: string,
  sessions: SessionRefcounts | null,
): { step: ProfileSwitchExecutionStep; token?: DrainToken } {
  try {
    const begun = registry.beginDrain(workload);
    if (begun.ok) {
      const refusal = sessionRefusal(sessions, workload);
      if (refusal !== null) {
        try {
          registry.cancelDrain(begun.token);
        } catch {
          // best-effort: a failed cancel must not mask the refusal
        }
        return { step: stepRecord("fence", workload, "failed", refusal) };
      }
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
  sessions: SessionRefcounts | null,
  signal: AbortSignal | undefined,
  beat: Beat,
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
    const attempt = fenceOne(registry, workload, sessions);
    beat();
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
  beat: Beat,
): Promise<DrainSettle> {
  try {
    return registry.whenIdle(token, { signal }).then(
      (result): DrainSettle => {
        beat();
        return { kind: "ok", result };
      },
      (error: unknown): DrainSettle => {
        beat();
        return { kind: "err", error };
      },
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
  beat: Beat,
  sessions: SessionRefcounts | null,
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
      tokens.map(
        (token): Promise<DrainSettle> => waitIdle(registry, token, controller.signal, beat),
      ),
    );
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const cancelled = signal?.aborted === true;
  const steps = buildDrainSteps(cancelled, settles, tokens);
  const postDrain = cancelled ? null : applySessionChecks(settles, tokens, sessions);
  const finalSteps = postDrain ?? steps;
  return {
    steps: finalSteps,
    failedAt: cancelled ? null : firstFailure(finalSteps),
    cancelledAt: null,
    cancelled,
  };
}

function buildDrainSteps(
  cancelled: boolean,
  settles: DrainSettle[],
  tokens: DrainToken[],
): ProfileSwitchExecutionStep[] {
  const steps: ProfileSwitchExecutionStep[] = [];
  for (const [index, token] of tokens.entries()) {
    const settle = settles[index];
    if (settle === undefined) {
      continue;
    }
    const drainStep = cancelled
      ? cancelledDrainStepFor(settle, token.workload)
      : drainStepFor(settle, token.workload);
    steps.push(drainStep);
  }
  return steps;
}

function firstFailure(steps: ProfileSwitchExecutionStep[]): StepFailure | null {
  for (const step of steps) {
    const f = failureOf(step);
    if (f !== null) {
      return f;
    }
  }
  return null;
}

function applySessionChecks(
  settles: DrainSettle[],
  tokens: DrainToken[],
  sessions: SessionRefcounts | null,
): ProfileSwitchExecutionStep[] | null {
  const steps = buildDrainSteps(false, settles, tokens);
  for (const [index, token] of tokens.entries()) {
    const settle = settles[index];
    if (settle === undefined) {
      continue;
    }
    const idle = settle.kind === "ok" && settle.result.idle;
    if (!idle) {
      continue;
    }
    const refusal = sessionRefusal(sessions, token.workload);
    if (refusal !== null) {
      steps[index] = stepRecord("drain", token.workload, "failed", refusal);
    }
  }
  return steps;
}

async function runStopOne(
  registry: ResidencyLeases,
  deps: ProfileSwitchExecutorDeps,
  workload: string,
  token: DrainToken,
  budget: StepBudget,
): Promise<StepOutcome> {
  const stopped = await runStep({ action: "stop", workload }, deps, budget);
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
  beat: Beat,
  budget: StepBudget,
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
    const outcome = await runStopOne(registry, deps, workload, token, budget);
    beat();
    if (outcome.ok) {
      steps.push(stepRecord("stop", workload, "ok"));
      continue;
    }
    const failed = stepRecord("stop", workload, "failed", outcome.detail, outcome.timedOut);
    steps.push(failed);
    appendNotRun(steps, "stop", victims.slice(index + 1));
    appendNotRun(steps, "start", replacements);
    // A timed-out victim's stop may still be in flight, so leave its drain
    // fenced (admission stays closed) and release only the untouched later
    // victims. A non-timeout failure has no in-flight dep, so release from
    // this victim too.
    const releaseFrom = outcome.timedOut === undefined ? index : index + 1;
    cancelBestEffort(registry, tokens.slice(releaseFrom));
    return { steps, failedAt: failureOf(failed), cancelledAt: null };
  }
  return { steps, failedAt: null, cancelledAt: null };
}

async function startPhase(
  deps: ProfileSwitchExecutorDeps,
  replacements: string[],
  signal: AbortSignal | undefined,
  beat: Beat,
  budget: StepBudget,
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
    const outcome = await runStep({ action: "start", workload }, deps, budget);
    beat();
    if (outcome.ok) {
      steps.push(stepRecord("start", workload, "ok"));
      continue;
    }
    const failed = stepRecord("start", workload, "failed", outcome.detail, outcome.timedOut);
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
  beat: Beat,
  budget: StepBudget,
  sessions: SessionRefcounts | null,
): Promise<RunResult> {
  const fence = fencePhase(registry, plan.victims, sessions, signal, beat);
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

  const drain = await drainPhase(registry, fence.tokens, drainTimeoutMs, signal, beat, sessions);
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

  const refusal = beforeTeardownRefusal(deps);
  if (refusal !== undefined) {
    cancelBestEffort(registry, fence.tokens);
    const failure = stepRecord("verify", plan.node, "failed", refusal);
    steps.push(failure);
    appendNotRun(steps, "stop", plan.victims);
    appendNotRun(steps, "start", plan.replacements);
    return { steps, failedAt: failureOf(failure), cancelledAt: null };
  }

  const stop = await stopPhase(
    registry,
    deps,
    plan.victims,
    plan.replacements,
    fence.tokens,
    signal,
    beat,
    budget,
  );
  steps.push(...stop.steps);
  if (stop.failedAt !== null) {
    return { steps, failedAt: stop.failedAt, cancelledAt: null };
  }
  if (stop.cancelledAt !== null) {
    return { steps, failedAt: null, cancelledAt: stop.cancelledAt };
  }

  const start = await startPhase(deps, plan.replacements, signal, beat, budget);
  steps.push(...start.steps);
  return { steps, failedAt: start.failedAt, cancelledAt: start.cancelledAt };
}

function beforeTeardownRefusal(deps: ProfileSwitchExecutorDeps): string | undefined {
  try {
    return deps.beforeTeardown?.();
  } catch (error: unknown) {
    return messageOf(error);
  }
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

export { profileSwitchOperationKey };

// The reservation the switch records at begin: the plan's `reserve` step, or 0
// when there is none or it is not a finite non-negative number.
export function profileSwitchReservationGiB(plan: OkPlan): number {
  const reserve = plan.steps.find((step) => step.kind === "reserve");
  const giB = reserve?.reservationGiB;
  if (giB === undefined || !Number.isFinite(giB) || giB < 0) {
    return 0;
  }
  return giB;
}

function beginSwitchOperation(
  plan: OkPlan,
  operation: ProfileSwitchOperationOpts,
): BeginSwitchResult {
  const nowMs = operation.nowMs ?? Date.now;
  try {
    const begun =
      operation.begun ??
      operation.store.beginOperation({
        fenceToken: operation.fenceToken,
        operationId: operation.operationId,
        model: profileSwitchOperationKey(plan.node),
        targetState: `profile:${plan.to}`,
        desiredRevision: operation.desiredRevision,
        reservationGiB: profileSwitchReservationGiB(plan),
        nowMs: nowMs(),
        ...(operation.nodeBudgetGiB === undefined
          ? {}
          : { nodeBudgetGiB: operation.nodeBudgetGiB }),
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

function defaultLog(line: string): void {
  process.stderr.write(line);
}

// The step-boundary heartbeat. A refusal or a throw is logged and swallowed:
// a heartbeat failure must never abort the switch.
function heartbeatFor(operation: ProfileSwitchOperationOpts): Beat {
  const nowMs = operation.nowMs ?? Date.now;
  const log = operation.log ?? defaultLog;
  return () => {
    let failure: string | null;
    try {
      const touched = operation.store.touchOperation({
        fenceToken: operation.fenceToken,
        operationId: operation.operationId,
        nowMs: nowMs(),
      });
      failure = touched.ok ? null : touched.reason;
    } catch (error: unknown) {
      failure = `threw: ${messageOf(error).split("\n")[0] ?? ""}`;
    }
    if (failure === null) {
      return;
    }
    try {
      log(`[residency] profile-switch heartbeat failed: ${failure}\n`);
    } catch {
      // logging must never abort the switch either
    }
  };
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

function refusedOperationReport(
  plan: OkPlan,
  deferred: StepKind[],
  reason: string,
): ProfileSwitchExecutionReport {
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
    refusal: { reason: "operation-record-refused", detail: reason },
  };
}

export function profileSwitchOperationRefusal(
  plan: OkPlan,
  registry: ResidencyLeases | null,
  reason: string,
): ProfileSwitchExecutionReport {
  return refusedOperationReport(plan, deferredKinds(plan, registry !== null, true), reason);
}

async function executeWithOperation(
  plan: OkPlan,
  deferred: StepKind[],
  operation: ProfileSwitchOperationOpts,
  run: (beat: Beat) => Promise<RunResult>,
): Promise<ProfileSwitchExecutionReport> {
  const begun = beginSwitchOperation(plan, operation);
  if (!begun.ok) {
    if (begun.reason === "reservation-conflict") {
      return busyReport(plan, deferred, inFlightOperationId(operation, plan));
    }
    return refusedOperationReport(plan, deferred, begun.reason);
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
    result = await run(heartbeatFor(operation));
  } catch (error: unknown) {
    finishCrashedExecution(operation, begun.version, error);
    throw error;
  }
  const { info, record } = finishExecution(operation, begun.version, result);
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

function finishCrashedExecution(
  operation: ProfileSwitchOperationOpts,
  version: number,
  error: unknown,
): void {
  if (operation.managed === true) return;
  finishSwitchOperation(operation, version, { outcome: "failed", detail: messageOf(error) });
}

function finishExecution(
  operation: ProfileSwitchOperationOpts,
  version: number,
  result: RunResult,
): { info: FinishInfo; record: FinishRecord } {
  const info = finishInfoFor(result);
  const acted = result.steps.some(
    (step) =>
      (step.action === "stop" || step.action === "start") &&
      (step.status === "ok" || step.status === "failed"),
  );
  if (operation.managed === true && info.outcome !== "succeeded" && acted) {
    return {
      info: { ...info, outcome: "unknown" },
      record: { recorded: false, recordFailure: "managed dispatch requires generation recovery" },
    };
  }
  return { info, record: finishSwitchOperation(operation, version, info) };
}

function drainTimeoutMsFrom(customTimeout: number | undefined): number {
  return customTimeout !== undefined && Number.isFinite(customTimeout) && customTimeout > 0
    ? customTimeout
    : DEFAULT_PROFILE_SWITCH_TIMEOUTS.drainMs;
}

const defaultStepTimer: ProfileSwitchStepTimer = (ms, onTimeout) => {
  const timer = setTimeout(onTimeout, ms);
  return () => {
    clearTimeout(timer);
  };
};

// A budget is honoured only when finite and > 0; otherwise that action is
// unbounded (the same rule as drainTimeoutMsFrom, with no default).
function finiteBudgetMs(ms: number | undefined): number | null {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : null;
}

function stepBudgetFrom(
  stepTimeouts: ProfileSwitchStepTimeouts | undefined,
  stepTimer: ProfileSwitchStepTimer | undefined,
  signal: AbortSignal | undefined,
): StepBudget {
  return {
    stopMs: finiteBudgetMs(stepTimeouts?.unloadMs),
    startMs: finiteBudgetMs(stepTimeouts?.loadMs),
    timer: stepTimer ?? defaultStepTimer,
    signal,
  };
}

// The executor deps, wrapped in the residency-lifecycle decorator only when
// the operation opts carry `lifecycle`. Without it the deps pass through
// untouched, so the switch behaves byte-identically to a no-lifecycle run.
function lifecycleDepsFor(
  plan: OkPlan,
  deps: ProfileSwitchExecutorDeps,
  operation: ProfileSwitchOperationOpts | undefined,
): ProfileSwitchExecutorDeps {
  if (operation?.lifecycle === undefined) {
    return deps;
  }
  return {
    ...deps,
    ...withResidencyLifecycle(deps, {
      lifecycle: operation.lifecycle,
      fenceToken: operation.fenceToken,
      occupiedAtPlan: new Set([...plan.victims, ...plan.retained]),
      nowMs: operation.nowMs ?? Date.now,
      log: operation.log ?? defaultLog,
    }),
  };
}

function checkBeforeProfileStep(
  checkDesired: () => string | null,
  run: () => Promise<ProfileSwitchStepOutcome>,
): Promise<ProfileSwitchStepOutcome> {
  const stale = checkDesired();
  return stale === null ? run() : Promise.resolve({ ok: false, detail: stale });
}

function executorDepsFor(
  plan: OkPlan,
  deps: ProfileSwitchExecutorDeps,
  operation: ProfileSwitchOperationOpts | undefined,
): ProfileSwitchExecutorDeps {
  const lifecycleDeps = lifecycleDepsFor(plan, deps, operation);
  const checkDesired = operation?.checkDesired;
  if (checkDesired === undefined) return lifecycleDeps;
  return {
    stop: (workload, ctx) =>
      checkBeforeProfileStep(checkDesired, () => lifecycleDeps.stop(workload, ctx)),
    start: (workload, ctx) =>
      checkBeforeProfileStep(checkDesired, () => lifecycleDeps.start(workload, ctx)),
  };
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
    stepTimeouts?: ProfileSwitchStepTimeouts;
    stepTimer?: ProfileSwitchStepTimer;
    sessions?: SessionRefcounts | null;
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
  const sessions = opts?.sessions === undefined ? currentSessionRefcounts() : opts.sessions;
  const drainTimeoutMs = drainTimeoutMsFrom(opts?.drainTimeoutMs);
  const fenced = registry !== null;
  const deferred =
    opts?.operation?.managed === true
      ? []
      : deferredKinds(plan, fenced, opts?.operation !== undefined);
  const planned = plannedSteps(plan.victims, plan.replacements, fenced);

  if (dryRun) {
    const steps = dryRunSteps(planned, fenced, sessions);
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
  const budget = stepBudgetFrom(opts.stepTimeouts, opts.stepTimer, signal);
  const executorDeps = executorDepsFor(plan, deps, operation);
  if (operation !== undefined) {
    return await executeWithOperation(plan, deferred, operation, async (beat) =>
      fenced
        ? await runFenced(
            plan,
            executorDeps,
            registry,
            drainTimeoutMs,
            signal,
            beat,
            budget,
            sessions,
          )
        : await runSteps(planned, executorDeps, signal, beat, budget),
    );
  }

  const result = fenced
    ? await runFenced(
        plan,
        executorDeps,
        registry,
        drainTimeoutMs,
        signal,
        NO_BEAT,
        budget,
        sessions,
      )
    : await runSteps(planned, executorDeps, signal, NO_BEAT, budget);
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
