import { resolveEnv } from "@llamactl/core/env";
import {
  isOccupyingResidencyState,
  RESIDENCY_GROUPS,
  type ResidencyGroupDeclaration,
} from "@llamactl/core/residency/lifecycle";
/**
 * #517: fenced residency lifecycle for the direct ModelHost and ModelRun
 * start/stop writers. `runDirectResidencyStart`/`runDirectResidencyStop` wrap
 * an injected start/stop dep in the same `withResidencyLifecycle` walks the
 * profile-switch decorator uses, claimed under the shared apply-profile fence
 * owner, so a direct start/stop (`modelHostStart`/`modelHostStop` and
 * `serverStart`/`serverStop`) drives its `residency_states` row and honours
 * exclusive-group refusals through the fenced store without a new registry.
 *
 * The wrapper never creates the store: a node with no store file runs the dep
 * unrecorded (rule a), so a bare `startModelHost`/`stopModelHost` never
 * conjures one. A label that names no declared group is recorded without a
 * group, so an undeclared group is never refused as `UnknownGroup`.
 *
 * The switch scope is the escape hatch for the profile switch's own writers.
 * `runInResidencySwitchScope` runs a callback in an `AsyncLocalStorage` scope;
 * while a caller is inside it, `inResidencySwitchScope` is true and the direct
 * wrapper neither records nor refuses: it runs the dep directly and returns,
 * because the switch's lifecycle walk already owns that row. This keeps the
 * switch's `applyManifest` start/stop off the fence it already holds and off
 * the in-flight gate it itself trips.
 *
 * A direct stop runs its dep before the row moves, so an occupying row keeps
 * its exclusive group held for the whole stop. Only a confirmed stop walks the
 * row down to downloaded; an unconfirmed one (the process may still be alive)
 * is never recorded and leaves the row occupying, so the group is not freed.
 *
 * Known limits this slice accepts:
 * - A `ready` row fails closed and refuses direct starts in that group when a
 *   recorded pid is still alive or its identity cannot be verified
 *   (`unknown`): `isProvenDown` clears a ModelHost proven Stopped with a
 *   resolved identity, and a ModelRun only when it has no recorded pid or its
 *   recorded pid verifies `dead` or `reused` against the pid file.
 * - A switch that claims the fence between our claim and its beginOperation is
 *   refused by its own stale-fence check, not by us; we only refuse to claim
 *   while a `profile-switch:` operation is already nonterminal.
 * - A row left `loading` because the post-dep refence was refused (a switch
 *   began mid-dep) is reconciled by that switch or by boot recovery, not here;
 *   the post-walk rides the stolen-fence rejection and logs `not recorded`.
 *
 * `exclusiveGroupLaunchRefusal` is the read-only, unfenced sandbox-launch
 * refusal (#517) that `llamactl eval run` and `llamactl admit measure` consult
 * before spawning. Unlike `isCorroboratedOccupant`/`runDirectResidencyStart`,
 * which exclude the starting workload's own row, it counts self-occupancy (a
 * row for the same id) unless the caller names its own workload with
 * `ignoreModel`: a sandbox copy runs beside any existing engine and so doubles
 * GPU memory. The keep-alive worker and the keep-alive start gates do name it,
 * because the fenced start that follows adopts or walks that row instead of
 * running a second engine beside it. Note that eval's id is a catalog rel while
 * admit measure's is a workload name, so the self-row case triggers only when a
 * store row's model happens to match that name.
 */
import { hasManagedRuntimeMarker } from "@llamactl/core/residency/managed-runtime";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { existsSync } from "../safe-fs.js";
import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "./apply-profile.js";
import { withResidencyLifecycle } from "./lifecycle-steps.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "./store.js";

// The profile-switch operation key is `profile-switch:<node>` (see
// profile-transition.ts); the colon-terminated prefix is the discriminator a
// direct claim must refuse to step over. Inlined to keep this module off the
// profile-transition import edge (the live-caller guard pins that edge).
const PROFILE_SWITCH_PREFIX = "profile-switch:";

// The profile switch's own scope: while a callback runs inside it, a direct
// writer must neither record nor refuse, because the switch's lifecycle walk
// already owns that row. In-process only (the switch forces its applyManifest
// client local so the scope survives to serverStart/serverStop).
const switchScope = new AsyncLocalStorage<true>();

export function runInResidencySwitchScope<T>(fn: () => Promise<T>): Promise<T> {
  return switchScope.run(true, fn);
}

export function inResidencySwitchScope(): boolean {
  return switchScope.getStore() === true;
}

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type DirectAction = "start" | "stop";
type DepResult = { ok: boolean; error?: string };
// Structural twin of StepOutcome, kept local so this module does
// not import profile-transition.ts (the live-caller guard pins that edge).
type StepOutcome = { ok: true } | { ok: false; detail: string };

export type DirectLifecycleOpts = {
  storePath: string;
  // the residency-group label value from residencyGroupLabelOf; a declared
  // group only (an undeclared label records no group)
  group: string | undefined;
  isProvenDown: (model: string) => boolean;
  isRunning: (model: string) => boolean;
  log: (line: string) => void;
  openStore?: (path: string) => Store;
  incarnation?: string;
  nowMs?: () => number;
  groups?: readonly ResidencyGroupDeclaration[];
};

export type DirectLifecycleOutcome<T> = { ran: true; result: T } | { ran: false; detail: string };

type DepEnv<T> = {
  managed: boolean;
  lifecycleGroup: string | undefined;
  groups: readonly ResidencyGroupDeclaration[];
  nowMs: () => number;
  log: (line: string) => void;
  incarnation: string;
  dep: (workload: string) => T | Promise<T>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSafe(log: (line: string) => void, line: string): void {
  try {
    log(line);
  } catch {
    // logging must never change a dep outcome
  }
}

// A group is recorded only when the caller's declarations name it; an
// undeclared label records no group so the store never refuses it as
// UnknownGroup.
function declaredGroup(
  groups: readonly ResidencyGroupDeclaration[],
  group: string | undefined,
): string | undefined {
  if (group === undefined) {
    return undefined;
  }
  return groups.some((declared) => declared.name === group) ? group : undefined;
}

function isRunningSafe(opts: DirectLifecycleOpts, model: string): boolean {
  try {
    return opts.isRunning(model);
  } catch {
    return false;
  }
}

function isProvenDownSafe(opts: DirectLifecycleOpts, model: string): boolean {
  try {
    return opts.isProvenDown(model);
  } catch {
    return false;
  }
}

function getState(store: Store, model: string): ResidencyStateRecord | null {
  try {
    return store.getResidencyState(model);
  } catch {
    return null;
  }
}

// Claiming means the current fence is absent or already owned by the shared
// apply-profile owner, and no nonterminal `profile-switch:` operation is in
// flight. A refusal never bumps the fence.
function claimFence(store: Store, incarnation: string): number | null {
  const current = store.currentFence();
  if (current !== null && current.ownerId !== RESIDENCY_APPLY_PROFILE_FENCE_OWNER) {
    return null;
  }
  const result = store.claimOwnershipWhen(
    { ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER, incarnation },
    (nonterminal) => !nonterminal.some((row) => row.model.startsWith(PROFILE_SWITCH_PREFIX)),
  );
  return result.claimed ? result.fence.fenceToken : null;
}

// A same-group peer is corroborated (occupies the group) unless it is a `ready`
// row the live corroboration proves down; a loading/warming peer is always
// corroborated.
function isCorroboratedOccupant(
  row: ResidencyStateRecord,
  workload: string,
  lifecycleGroup: string,
  opts: DirectLifecycleOpts,
): boolean {
  if (row.model === workload || row.group !== lifecycleGroup) {
    return false;
  }
  if (!isOccupyingResidencyState(row.state)) {
    return false;
  }
  return !(row.state === "ready" && isProvenDownSafe(opts, row.model));
}

function occupyingPeers(
  store: Store,
  workload: string,
  lifecycleGroup: string | undefined,
  opts: DirectLifecycleOpts,
): Set<string> {
  const peers = new Set<string>();
  if (lifecycleGroup === undefined) {
    return peers;
  }
  let rows: ResidencyStateRecord[];
  try {
    rows = store.listResidencyStates();
  } catch {
    return peers;
  }
  for (const row of rows) {
    if (isCorroboratedOccupant(row, workload, lifecycleGroup, opts)) {
      peers.add(row.model);
    }
  }
  return peers;
}

// Releases an adopted `ready` row whose re-start left the host dead: a no-op
// start and a not-ok stop walk it ready -> draining -> unloading -> failed.
// The fence is re-claimed first (the dep may have outlived the held token),
// and a release whose pre-walk refused is logged rather than dropped.
async function releaseReadyRow<T extends DepResult>(
  store: Store,
  heldToken: number,
  workload: string,
  env: DepEnv<T>,
  detail: string,
): Promise<void> {
  const token = refence(store, "start", workload, env.incarnation, env.log, heldToken);
  const release = { reached: false };
  const noop = (): Promise<StepOutcome> => Promise.resolve({ ok: true });
  const dead = (): Promise<StepOutcome> => {
    release.reached = true;
    return Promise.resolve({ ok: false, detail });
  };
  const wrapped = withResidencyLifecycle(
    { start: noop, stop: dead },
    {
      lifecycle: {
        store,
        groupOf: (candidate) => (candidate === workload ? env.lifecycleGroup : undefined),
        groups: env.groups,
      },
      fenceToken: token,
      occupiedAtPlan: new Set<string>(),
      nowMs: env.nowMs,
      log: env.log,
    },
  );
  const step = await wrapped.stop(workload, undefined);
  if (!release.reached) {
    logSafe(
      env.log,
      `[residency] lifecycle ${workload} start release not recorded: ${stepRefusalDetail(step)}\n`,
    );
  }
}

// Adopts a `ready` row for an already-running host (start only): run the dep
// with no walk, keep the row if the host is still up, else release it to
// failed. Returns null when there is nothing to adopt.
async function adoptReadyStart<T extends DepResult>(
  workload: string,
  opts: DirectLifecycleOpts,
  store: Store,
  token: number,
  env: DepEnv<T>,
): Promise<DirectLifecycleOutcome<T> | null> {
  const own = getState(store, workload);
  if (own?.state !== "ready" || !isRunningSafe(opts, workload)) {
    return null;
  }
  const result = await env.dep(workload);
  if (result.ok || isRunningSafe(opts, workload)) {
    logSafe(env.log, `[residency] lifecycle ${workload} start kept ready: host already running\n`);
  } else {
    await releaseReadyRow(store, token, workload, env, result.error ?? "");
  }
  return { ran: true, result };
}

// Re-claims the fence only when a concurrent writer moved it (rule g). A
// refused re-claim leaves the held token stale so the post-walk fails
// stale-fence and reports `not recorded`.
function refence(
  store: Store,
  action: DirectAction,
  workload: string,
  incarnation: string,
  log: (line: string) => void,
  heldToken: number,
): number {
  const current = store.currentFence();
  if (current !== null && current.fenceToken === heldToken) {
    return heldToken;
  }
  const next = claimFence(store, incarnation);
  if (next !== null) {
    return next;
  }
  logSafe(
    log,
    `[residency] lifecycle ${workload} ${action} not recorded: profile switch in flight\n`,
  );
  return heldToken;
}

function stepRefusalDetail(step: StepOutcome): string {
  return step.ok ? "residency lifecycle refused" : step.detail;
}

// (g) runs a start under the lifecycle walk: the row walks to loading, the
// caller's dep runs, the fence is re-claimed, then the row walks to its
// terminal. A pre-walk refusal means the start never ran. A dep that throws is
// recorded failed (so its row never keeps the group occupied) and the error is
// rethrown once the post-walk has run.
async function walkStartWithDep<T extends DepResult>(
  workload: string,
  store: Store,
  initialToken: number,
  env: DepEnv<T>,
  occupiedAtPlan: ReadonlySet<string>,
): Promise<DirectLifecycleOutcome<T>> {
  let token = initialToken;
  const capture: T[] = [];
  let thrown: { error: unknown } | undefined;
  const runDep = async (): Promise<StepOutcome> => {
    let result: T;
    try {
      result = await env.dep(workload);
    } catch (error: unknown) {
      thrown = { error };
      token = refence(store, "start", workload, env.incarnation, env.log, token);
      return { ok: false, detail: messageOf(error) };
    }
    capture.push(result);
    token = refence(store, "start", workload, env.incarnation, env.log, token);
    return { ok: result.ok, detail: result.error ?? "" };
  };
  const wrapped = withResidencyLifecycle(
    { start: runDep, stop: runDep },
    {
      lifecycle: {
        store,
        groupOf: (candidate) => (candidate === workload ? env.lifecycleGroup : undefined),
        groups: env.groups,
      },
      fenceToken: token,
      fenceTokenOf: () => token,
      occupiedAtPlan,
      nowMs: env.nowMs,
      log: env.log,
    },
  );
  const step = await wrapped.start(workload, undefined);
  if (thrown !== undefined) {
    throw thrown.error;
  }
  const result = capture[0];
  if (result !== undefined) {
    return { ran: true, result };
  }
  return { ran: false, detail: stepRefusalDetail(step) };
}

// (h) a stop runs its dep FIRST, with the row untouched, so an occupying row
// keeps the exclusive group held until the stop is confirmed (fail closed,
// as #741's proven-down rule). Only a confirmed stop (ok) walks the row
// ready -> draining -> unloading -> downloaded; a dep that throws walks it to
// failed and rethrows. An unconfirmed stop (not ok: the process may still be
// alive) is never recorded, so the row stays occupying and a same-group peer
// start is still refused. A refused walk is logged; bookkeeping never blocks
// or reruns a stop.
async function walkStopAfterDep<T extends DepResult>(
  workload: string,
  store: Store,
  initialToken: number,
  env: DepEnv<T>,
): Promise<DirectLifecycleOutcome<T>> {
  let settled: { result: T } | { thrown: unknown };
  try {
    settled = { result: await env.dep(workload) };
  } catch (error: unknown) {
    settled = { thrown: error };
  }
  if ("result" in settled && !settled.result.ok) {
    logSafe(
      env.log,
      `[residency] lifecycle ${workload} stop not recorded: unconfirmed stop (process may be alive)\n`,
    );
    return { ran: true, result: settled.result };
  }
  const token = refence(store, "stop", workload, env.incarnation, env.log, initialToken);
  await recordSettledStop(
    workload,
    store,
    token,
    env,
    "thrown" in settled ? messageOf(settled.thrown) : undefined,
  );
  if ("thrown" in settled) {
    throw settled.thrown;
  }
  return { ran: true, result: settled.result };
}

// Walks a settled stop's row: ready -> draining -> unloading, then downloaded
// for a confirmed stop or failed for a thrown one (`failure`). A refused
// pre-walk never reaches the settled dep and is logged `not recorded`.
async function recordSettledStop<T extends DepResult>(
  workload: string,
  store: Store,
  token: number,
  env: DepEnv<T>,
  failure: string | undefined,
): Promise<void> {
  const reached = { value: false };
  const settledDep = (): Promise<StepOutcome> => {
    reached.value = true;
    return Promise.resolve(failure === undefined ? { ok: true } : { ok: false, detail: failure });
  };
  const wrapped = withResidencyLifecycle(
    { start: settledDep, stop: settledDep },
    {
      lifecycle: {
        store,
        groupOf: (candidate) => (candidate === workload ? env.lifecycleGroup : undefined),
        groups: env.groups,
      },
      fenceToken: token,
      occupiedAtPlan: new Set<string>(),
      nowMs: env.nowMs,
      log: env.log,
    },
  );
  const step = await wrapped.stop(workload, undefined);
  if (!reached.value) {
    logSafe(
      env.log,
      `[residency] lifecycle ${workload} stop not recorded: ${stepRefusalDetail(step)}\n`,
    );
  }
}

// A managed or grouped start requires a usable transition journal.
async function unrecordedOrFail<T extends DepResult>(
  action: DirectAction,
  workload: string,
  lifecycleGroup: string | undefined,
  env: DepEnv<T>,
  message: string,
): Promise<DirectLifecycleOutcome<T>> {
  if (action === "start" && (env.managed || lifecycleGroup !== undefined)) {
    return {
      ran: false,
      detail: `residency lifecycle refused ${workload}: store unavailable (${message})`,
    };
  }
  logSafe(
    env.log,
    `[residency] lifecycle ${workload} ${action} not recorded: store unavailable (${message})\n`,
  );
  return { ran: true, result: await env.dep(workload) };
}

// (c) the initial claim: a refusal refuses a start but only logs a stop,
// which still runs.
async function initialClaim<T extends DepResult>(
  action: DirectAction,
  workload: string,
  store: Store,
  env: DepEnv<T>,
): Promise<number | DirectLifecycleOutcome<T>> {
  try {
    const claimed = claimFence(store, env.incarnation);
    if (claimed !== null) {
      return claimed;
    }
  } catch (error: unknown) {
    return await unrecordedOrFail(action, workload, env.lifecycleGroup, env, messageOf(error));
  }
  if (action === "start") {
    return {
      ran: false,
      detail: `residency lifecycle refused ${workload}: profile switch in flight on this node; retry after it settles`,
    };
  }
  logSafe(
    env.log,
    `[residency] lifecycle ${workload} stop not recorded: profile switch in flight\n`,
  );
  return { ran: true, result: await env.dep(workload) };
}

async function runRecorded<T extends DepResult>(
  action: DirectAction,
  workload: string,
  opts: DirectLifecycleOpts,
  store: Store,
  env: DepEnv<T>,
  lifecycleGroup: string | undefined,
): Promise<DirectLifecycleOutcome<T>> {
  const claimed = await initialClaim(action, workload, store, env);
  if (typeof claimed !== "number") {
    return claimed;
  }
  if (action === "start") {
    const adopted = await adoptReadyStart<T>(workload, opts, store, claimed, env);
    if (adopted !== null) {
      return adopted;
    }
  }
  if (action === "stop") {
    return await walkStopAfterDep(workload, store, claimed, env);
  }
  const occupiedAtPlan = occupyingPeers(store, workload, lifecycleGroup, opts);
  return await walkStartWithDep(workload, store, claimed, env, occupiedAtPlan);
}

async function runDirect<T extends DepResult>(
  action: DirectAction,
  workload: string,
  opts: DirectLifecycleOpts,
  dep: (workload: string) => T | Promise<T>,
): Promise<DirectLifecycleOutcome<T>> {
  // The switch's lifecycle walk owns this row: a direct writer inside the
  // switch scope records nothing and refuses nothing.
  if (inResidencySwitchScope()) {
    return { ran: true, result: await dep(workload) };
  }
  const managed = hasManagedRuntimeMarker(resolveEnv().LOCAL_AI_RUNTIME_DIR);
  if (!existsSync(opts.storePath) && !managed) {
    return { ran: true, result: await dep(workload) };
  }
  const groups = opts.groups ?? RESIDENCY_GROUPS;
  const lifecycleGroup = declaredGroup(groups, opts.group);
  const env: DepEnv<T> = {
    managed,
    lifecycleGroup,
    groups,
    nowMs: opts.nowMs ?? Date.now,
    log: opts.log,
    incarnation: opts.incarnation ?? randomUUID(),
    dep,
  };
  if (!existsSync(opts.storePath)) {
    return await unrecordedOrFail(action, workload, lifecycleGroup, env, "missing journal");
  }
  let store: Store;
  try {
    store =
      opts.openStore?.(opts.storePath) ??
      openResidencyOperationStore({ path: opts.storePath, requireExisting: managed });
  } catch (error: unknown) {
    return await unrecordedOrFail(action, workload, lifecycleGroup, env, messageOf(error));
  }
  try {
    return await runRecorded(action, workload, opts, store, env, lifecycleGroup);
  } finally {
    store.close();
  }
}

export async function runDirectResidencyStart<T extends DepResult>(
  workload: string,
  dep: (workload: string) => T | Promise<T>,
  opts: DirectLifecycleOpts,
): Promise<DirectLifecycleOutcome<T>> {
  return await runDirect("start", workload, opts, dep);
}

export async function runDirectResidencyStop<T extends DepResult>(
  workload: string,
  dep: (workload: string) => T | Promise<T>,
  opts: DirectLifecycleOpts,
): Promise<DirectLifecycleOutcome<T>> {
  return await runDirect("stop", workload, opts, dep);
}

export type ExclusiveGroupLaunchRefusalOpts = {
  id: string;
  group: string | undefined;
  storePath: string;
  // the caller's own workload, whose row must not refuse the launch (#517: the
  // keep-alive worker records its row under its target and the fenced start
  // then adopts or walks it rather than running a second engine beside it)
  ignoreModel?: string;
  groups?: readonly ResidencyGroupDeclaration[];
  readSnapshot?: (path: string) => ResidencyStoreSnapshot;
};

// The read-only, unfenced pre-spawn gate for a sandbox launch (#517). It never
// claims the fence and never opens the store for write: it resolves the
// declared-exclusive group, reads a snapshot, and returns the refusal string
// the caller prints or null when the launch may proceed. Unlike a fenced start
// it counts self-occupancy, because a sandbox copy runs beside any engine the
// row records and doubles GPU memory — unless the caller names its own workload
// with `ignoreModel`, as the keep-alive gates do, because the fenced start that
// follows adopts or walks that row.
export function exclusiveGroupLaunchRefusal(opts: ExclusiveGroupLaunchRefusalOpts): string | null {
  const group = opts.group;
  if (group === undefined) {
    return null;
  }
  const groups = opts.groups ?? RESIDENCY_GROUPS;
  const declared = groups.find((candidate) => candidate.name === group);
  if (!declared?.exclusive) {
    return null;
  }
  const read = opts.readSnapshot ?? readResidencyStoreSnapshot;
  const snapshot = read(opts.storePath);
  if (!snapshot.present) {
    return null;
  }
  if ("error" in snapshot) {
    return `residency lifecycle refused ${opts.id}: store unavailable (${snapshot.error})`;
  }
  if (snapshot.lifecycleError !== undefined) {
    return `residency lifecycle refused ${opts.id}: store unavailable (${snapshot.lifecycleError})`;
  }
  if (snapshot.nonterminal.some((row) => row.model.startsWith(PROFILE_SWITCH_PREFIX))) {
    return `residency lifecycle refused ${opts.id}: profile switch in flight on this node; retry after it settles`;
  }
  const occupants = (snapshot.lifecycle ?? [])
    .filter(
      (row) =>
        row.group === group &&
        row.model !== opts.ignoreModel &&
        isOccupyingResidencyState(row.state),
    )
    .sort((a, b) => {
      if (a.model < b.model) {
        return -1;
      }
      return a.model > b.model ? 1 : 0;
    });
  const holder = occupants[0];
  if (holder === undefined) {
    return null;
  }
  return `residency lifecycle refused ${opts.id} downloaded -> loading: ExclusiveGroupOccupied: exclusive group ${group} is held by ${holder.model} in state ${holder.state}`;
}
