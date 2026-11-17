/**
 * #517: a pure decorator over ProfileSwitchExecutorDeps that drives the
 * residency lifecycle rows around a fenced profile switch. Every hop is a
 * RESIDENCY_TRANSITIONS edge; the path tables are data, so a stop walks its
 * victim ready -> draining -> unloading -> (dep) -> downloaded|failed and a
 * start reconciles the replacement's stale same-group peers, walks its own
 * row down to loaded, then -> warming -> ready|failed. A corroborated
 * exclusive-group occupant (one the plan observed) is left alone and makes
 * the loading hop refuse before the dep runs; an uncorroborated occupying
 * peer is walked down to downloaded first. The decorator never throws: every
 * store call is guarded, and a failed post write is logged, leaving the dep's
 * own outcome unchanged.
 */
import {
  isOccupyingResidencyState,
  type ResidencyGroupDeclaration,
  type ResidencyState,
  type ResidencyTransitionDecision,
} from "@llamactl/core/residency/lifecycle";

import type { ProfileSwitchExecutorDeps, ProfileSwitchStepOutcome } from "./profile-transition.js";
import type {
  ResidencyLifecycleStore,
  ResidencyStateRecord,
  TransitionResidencyStateResult,
} from "./store.js";

type LifecycleTransitionStore = Pick<
  ResidencyLifecycleStore,
  "getResidencyState" | "listResidencyStates" | "transitionResidencyState"
>;

export type ProfileSwitchLifecycleOpts = {
  store: LifecycleTransitionStore;
  groupOf: (workload: string) => string | undefined;
  groups?: readonly ResidencyGroupDeclaration[];
};

type LifecycleCtx = {
  deps: ProfileSwitchExecutorDeps;
  lifecycle: ProfileSwitchLifecycleOpts;
  fenceToken: number;
  occupiedAtPlan: ReadonlySet<string>;
  nowMs: () => number;
  log: (line: string) => void;
};

type LifecycleStepCtx = { signal?: AbortSignal };

// Every target list is a chain of legal RESIDENCY_TRANSITIONS edges from the
// keyed state. An absent row is treated as 'unavailable' by the store, so it
// shares that entry. States with no entry walk zero hops.
const TO_LOADING: Readonly<Record<ResidencyState, readonly ResidencyState[]>> = {
  unavailable: ["downloaded", "loading"],
  downloaded: ["loading"],
  failed: ["downloaded", "loading"],
  ready: ["draining", "unloading", "downloaded", "loading"],
  loading: ["unloading", "downloaded", "loading"],
  warming: ["unloading", "downloaded", "loading"],
  draining: ["unloading", "downloaded", "loading"],
  unloading: ["downloaded", "loading"],
};

const RELEASE: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>> = {
  ready: ["draining", "unloading", "downloaded"],
  loading: ["unloading", "downloaded"],
  warming: ["unloading", "downloaded"],
};

const PRE_STOP: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>> = {
  ready: ["draining", "unloading"],
  loading: ["unloading"],
  warming: ["unloading"],
  draining: ["unloading"],
};

const POST_STOP_OK: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>> = {
  unloading: ["downloaded"],
  failed: ["downloaded"],
  draining: ["unloading", "downloaded"],
};

const POST_STOP_FAIL: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>> = {
  unloading: ["failed"],
};

const POST_START_OK: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>> = {
  loading: ["warming", "ready"],
};

const POST_START_FAIL: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>> = {
  loading: ["failed"],
  warming: ["failed"],
};

type HopResult =
  | { ok: true; record: ResidencyStateRecord }
  | { ok: false; reason: string; decision?: Extract<ResidencyTransitionDecision, { ok: false }> };

type WalkFailure = {
  ok: false;
  from: ResidencyState;
  to: ResidencyState;
  hop: HopResult;
};

type WalkOutcome = { ok: true } | WalkFailure;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentOf(ctx: LifecycleCtx, model: string): ResidencyStateRecord | null {
  try {
    return ctx.lifecycle.store.getResidencyState(model);
  } catch {
    return null;
  }
}

function transitionOne(
  ctx: LifecycleCtx,
  model: string,
  to: ResidencyState,
  expectedVersion: number,
  group: string | undefined,
): HopResult {
  try {
    const result: TransitionResidencyStateResult = ctx.lifecycle.store.transitionResidencyState({
      fenceToken: ctx.fenceToken,
      model,
      to,
      expectedVersion,
      nowMs: ctx.nowMs(),
      ...(group === undefined ? {} : { group }),
      ...(ctx.lifecycle.groups === undefined ? {} : { groups: ctx.lifecycle.groups }),
    });
    if (result.ok) {
      return { ok: true, record: result.record };
    }
    if (result.reason === "lifecycle-refused") {
      return { ok: false, reason: result.reason, decision: result.decision };
    }
    return { ok: false, reason: result.reason };
  } catch (error: unknown) {
    return { ok: false, reason: messageOf(error) };
  }
}

function pathFor(
  table: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>>,
  state: ResidencyState,
): readonly ResidencyState[] {
  return table[state] ?? [];
}

// Walks each hop in `path`, chaining expectedVersion from the resulting record
// version. `group` rides only the 'loading' hop; passing it on an occupying
// row would trip the store's group-conflict check.
function walk(
  ctx: LifecycleCtx,
  model: string,
  path: readonly ResidencyState[],
  groupOnLoading: string | undefined,
): WalkOutcome {
  let current = currentOf(ctx, model);
  for (const to of path) {
    const from: ResidencyState = current?.state ?? "unavailable";
    const group = to === "loading" ? groupOnLoading : undefined;
    const hop = transitionOne(ctx, model, to, current?.version ?? 0, group);
    if (hop.ok) {
      current = hop.record;
      continue;
    }
    return { ok: false, from, to, hop };
  }
  return { ok: true };
}

function failureReason(hop: HopResult): string {
  return hop.ok ? "ok" : (hop.decision?.reason ?? hop.reason);
}

function describeRefusal(workload: string, failure: WalkFailure): string {
  const { from, to, hop } = failure;
  if (hop.ok || hop.decision === undefined) {
    return `residency lifecycle ${workload} ${from} -> ${to} failed: ${failureReason(hop)}`;
  }
  const decision = hop.decision;
  return `residency lifecycle refused ${workload} ${from} -> ${to}: ${decision.reason}: ${decision.detail}`;
}

function logUnrecordedPost(ctx: LifecycleCtx, workload: string, failure: WalkFailure): void {
  const line = `[residency] lifecycle ${workload} ${failure.from} -> ${failure.to} not recorded: ${failureReason(failure.hop)}\n`;
  try {
    ctx.log(line);
  } catch {
    // logging must never change a dep outcome
  }
}

// Reconciles occupying rows in `group` that the plan did not observe, walking
// each down to downloaded. A corroborated occupant (in occupiedAtPlan) is
// left for the loading hop to refuse through the store's exclusive check.
function releaseStalePeers(ctx: LifecycleCtx, workload: string, group: string): void {
  let rows: ResidencyStateRecord[];
  try {
    rows = ctx.lifecycle.store.listResidencyStates();
  } catch {
    return;
  }
  for (const row of rows) {
    if (reconcilableStalePeer(ctx, workload, row)) {
      reconcilePeer(ctx, row, group);
    }
  }
}

function reconcilableStalePeer(
  ctx: LifecycleCtx,
  workload: string,
  row: ResidencyStateRecord,
): boolean {
  return (
    row.model !== workload &&
    row.group === ctx.lifecycle.groupOf(workload) &&
    isOccupyingResidencyState(row.state) &&
    !ctx.occupiedAtPlan.has(row.model)
  );
}

function reconcilePeer(ctx: LifecycleCtx, row: ResidencyStateRecord, group: string): void {
  const outcome = walk(ctx, row.model, pathFor(RELEASE, row.state), undefined);
  const prefix = `[residency] lifecycle reconciled stale ${row.model} ${row.state} -> downloaded in group ${group}: `;
  const line = outcome.ok
    ? `${prefix}not observed occupying by the plan\n`
    : `${prefix}not reconciled: ${failureReason(outcome.hop)}\n`;
  try {
    ctx.log(line);
  } catch {
    // a reconcile log failure never aborts the switch
  }
}

function postTable(
  ok: boolean,
  aborted: boolean,
  okTable: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>>,
  failTable: Readonly<Partial<Record<ResidencyState, readonly ResidencyState[]>>>,
  state: ResidencyState,
): readonly ResidencyState[] {
  // A dep that resolves after StepTimedOut (signal aborted) is recorded failed,
  // not ready/unloading, so the row never lands occupying for a timed-out step.
  return pathFor(aborted || !ok ? failTable : okTable, state);
}

async function startWrapped(
  ctx: LifecycleCtx,
  workload: string,
  stepCtx: LifecycleStepCtx | undefined,
): Promise<ProfileSwitchStepOutcome> {
  const group = ctx.lifecycle.groupOf(workload);
  if (group !== undefined) {
    releaseStalePeers(ctx, workload, group);
  }
  const own = currentOf(ctx, workload);
  const walkToLoading = walk(
    ctx,
    workload,
    pathFor(TO_LOADING, own?.state ?? "unavailable"),
    group,
  );
  if (!walkToLoading.ok) {
    return { ok: false, detail: describeRefusal(workload, walkToLoading) };
  }
  const outcome = await ctx.deps.start(workload, stepCtx);
  const after = currentOf(ctx, workload);
  const post = walk(
    ctx,
    workload,
    postTable(
      outcome.ok,
      stepCtx?.signal?.aborted === true,
      POST_START_OK,
      POST_START_FAIL,
      after?.state ?? "unavailable",
    ),
    undefined,
  );
  if (!post.ok) {
    logUnrecordedPost(ctx, workload, post);
  }
  return outcome;
}

async function stopWrapped(
  ctx: LifecycleCtx,
  workload: string,
  stepCtx: LifecycleStepCtx | undefined,
): Promise<ProfileSwitchStepOutcome> {
  const before = currentOf(ctx, workload);
  const pre = walk(ctx, workload, pathFor(PRE_STOP, before?.state ?? "unavailable"), undefined);
  if (!pre.ok) {
    return { ok: false, detail: describeRefusal(workload, pre) };
  }
  const outcome = await ctx.deps.stop(workload, stepCtx);
  const after = currentOf(ctx, workload);
  const post = walk(
    ctx,
    workload,
    postTable(
      outcome.ok,
      stepCtx?.signal?.aborted === true,
      POST_STOP_OK,
      POST_STOP_FAIL,
      after?.state ?? "unavailable",
    ),
    undefined,
  );
  if (!post.ok) {
    logUnrecordedPost(ctx, workload, post);
  }
  return outcome;
}

export function withResidencyLifecycle(
  deps: ProfileSwitchExecutorDeps,
  ctx: {
    lifecycle: ProfileSwitchLifecycleOpts;
    fenceToken: number;
    occupiedAtPlan: ReadonlySet<string>;
    nowMs: () => number;
    log: (line: string) => void;
  },
): ProfileSwitchExecutorDeps {
  const bound: LifecycleCtx = { deps, ...ctx };
  return {
    stop: (workload, stepCtx) => stopWrapped(bound, workload, stepCtx),
    start: (workload, stepCtx) => startWrapped(bound, workload, stepCtx),
  };
}
