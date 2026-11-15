/**
 * #279 DF-06 — RED tests for crash recovery of in-flight profile-switch
 * operation records via `recoverProfileSwitchOperations` in
 * `src/residency/recovery`. A restart is simulated by opening a second
 * store handle on the same SQLite file and claiming the next fence, then
 * running recovery as the new owner: every nonterminal
 * `profile-switch:<node>` row left by the previous incarnation is
 * terminalized — `unknown`/`interrupted-unverified` (or
 * `readiness-check-failed` when the optional readiness probe throws or
 * overruns `verifyTimeoutMs`), or `succeeded`/`target-verified-ready`
 * when the probe confirms the target — while rows owned by the current
 * fence and non-switch operations stay untouched, and recovery is
 * idempotent. At base the module does not exist: the guarded dynamic
 * import resolves to null and every case fails BY ASSERTION — never by
 * an import, type or module-resolution error. Store reads are
 * assertion-first (`expect(rec).not.toBeNull()` then `rec?.field`); no
 * non-null assertions.
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";
import type {
  OkPlan,
  PlannerWorkload,
  ProfileSwitchPlan,
  ProfileSwitchRequest,
  StepKind,
} from "@llamactl/core/residency/planner";

import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeProfileSwitch } from "../../src/residency/profile-transition.js";
import {
  openResidencyOperationStore,
  type ResidencyOperationPhase,
  type ResidencyOperationRecord,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const RECOVERY_MODULE = "../../src/residency/recovery.js" as string;

// ── recoverProfileSwitchOperations contract (declared loose, RED) ──────

type RecoverStore = Pick<ResidencyOperationStore, "finishOperation" | "listNonterminal">;

type RecoverVerifyArg = { node: string; profile: string; operationId: string };
type RecoverVerifier = (arg: RecoverVerifyArg) => unknown;

type RecoveredOperation = {
  operationId: string;
  node: string;
  profile: string;
  priorPhase: string;
  outcome: "succeeded" | "unknown";
  reason: "target-verified-ready" | "interrupted-unverified" | "readiness-check-failed";
  recorded: boolean;
  recordFailure?: string;
};

type SkippedOperation = {
  operationId: string;
  node: string;
  reason: "owned-by-current-fence";
};

type RecoverResult = { recovered: RecoveredOperation[]; skipped: SkippedOperation[] };

type RecoverOpts = {
  store: RecoverStore;
  fenceToken: number;
  nowMs?: () => number;
  verifyTargetReady?: RecoverVerifier;
  verifyTimeoutMs?: number;
};

type RecoverFn = (opts: RecoverOpts) => Promise<RecoverResult>;

// A variable specifier keeps tsc from resolving the not-yet-existing
// module — a literal specifier would be a resolution error, not an
// assertion failure.
async function loadRecover(): Promise<RecoverFn> {
  const mod = (await import(RECOVERY_MODULE).catch(() => null)) as Record<string, unknown> | null;
  expect(mod).not.toBeNull();
  const fn = mod?.["recoverProfileSwitchOperations"];
  expect(typeof fn).toBe("function");
  return fn as RecoverFn;
}

type ResidencyStore = ReturnType<typeof openResidencyOperationStore>;

let dir = "";
let path = "";
let storeA: ResidencyOperationStore;
let storeB: ResidencyStore | null = null;
let fenceA = 0;
let fenceB = 0;

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  dir = mkdtempSync(join(tmpdir(), "llamactl-recovery-"));
  path = join(dir, "operations.sqlite");
  storeA = openResidencyOperationStore({ path });
  fenceA = storeA.claimOwnership({ ownerId: "agent", incarnation: "i1" }).fenceToken;
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  storeA.close();
  storeB?.close();
  storeB = null;
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

// The restart: a second handle on the same file claims the next fence, so
// every row the crashed owner left carries a stale fenceToken.
function restartStore(): ResidencyStore {
  const reopened = openResidencyOperationStore({ path });
  storeB = reopened;
  fenceB = reopened.claimOwnership({ ownerId: "agent", incarnation: "i2" }).fenceToken;
  expect(fenceB).toBeGreaterThan(fenceA);
  return reopened;
}

const NODE = "n1";
const NOW_MS = 1_000_000_000;
const VICTIM_IDS = ["v-a", "v-b", "v-c"];
const REPLACEMENT_IDS = ["r-x", "r-y"];

type StepAction = "fence" | "drain" | "stop" | "start";
type StepStatus = "planned" | "ok" | "failed" | "not-run";

interface SwitchStep {
  action: StepAction;
  workload: string;
  status: StepStatus;
  detail?: string;
}

interface StepFailure {
  action: StepAction;
  workload: string;
  detail: string;
}

type SwitchOperation = {
  store: ResidencyOperationStore;
  fenceToken: number;
  operationId: string;
  desiredRevision: number;
  nowMs?: () => number;
};

type ExecuteOpts = {
  dryRun?: boolean;
  registry?: ResidencyLeases | null;
  drainTimeoutMs?: number;
  signal?: AbortSignal;
  operation?: SwitchOperation;
};

interface Report {
  dryRun: boolean;
  outcome: string;
  ok: boolean;
  steps: SwitchStep[];
  ran: SwitchStep[];
  failedAt: StepFailure | null;
  deferred: StepKind[];
  busy?: { reason: string; node: string; operationId: string; detail: string };
  cancelledAt?: { action: string; workload: string } | null;
  operation?: { id: string; outcome: string; recorded: boolean; recordFailure?: string };
  refusal?: { reason: string; detail: string };
}

type LooseDeps = {
  stop: (w: string) => Promise<unknown>;
  start: (w: string) => Promise<unknown>;
};

type LooseExecute = (
  plan: ProfileSwitchPlan,
  deps: LooseDeps,
  opts?: ExecuteOpts,
) => Promise<unknown>;

const run = executeProfileSwitch as unknown as LooseExecute;

function workload(id: string, spec: Omit<PlannerWorkload, "id">): PlannerWorkload {
  return {
    id,
    profiles: spec.profiles,
    state: spec.state,
    expectedMemoryGiB: spec.expectedMemoryGiB,
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(spec.protected === undefined ? {} : { protected: spec.protected }),
    ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
    ...(spec.loadedAtMs === undefined ? {} : { loadedAtMs: spec.loadedAtMs }),
  };
}

function fleetWorkloads(): PlannerWorkload[] {
  return [
    workload("v-a", { profiles: ["maintenance"], state: "ready", expectedMemoryGiB: 16 }),
    workload("v-b", { profiles: ["maintenance"], state: "ready", expectedMemoryGiB: 16 }),
    workload("v-c", { profiles: ["maintenance"], state: "ready", expectedMemoryGiB: 16 }),
    workload("r-x", { profiles: ["interactive"], state: "downloaded", expectedMemoryGiB: 20 }),
    workload("r-y", { profiles: ["interactive"], state: "downloaded", expectedMemoryGiB: 20 }),
    workload("emb", {
      profiles: [],
      state: "ready",
      expectedMemoryGiB: 6,
      protected: true,
    }),
  ];
}

function fleetRequest(spec: { to?: string; budgetGiB?: number } = {}): ProfileSwitchRequest {
  return {
    node: NODE,
    to: spec.to ?? "interactive",
    budgetGiB: spec.budgetGiB ?? 64,
    groups: [],
    workloads: fleetWorkloads(),
    nowMs: NOW_MS,
  };
}

function okPlan(plan: ProfileSwitchPlan): OkPlan {
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`expected ok plan, got refusal ${plan.reason}`);
  }
  return plan;
}

function okFleetPlan(spec: { to?: string; budgetGiB?: number } = {}): OkPlan {
  const plan = okPlan(planProfileSwitch(fleetRequest(spec)));
  expect(plan.victims).toEqual(VICTIM_IDS);
  expect(plan.replacements).toEqual(REPLACEMENT_IDS);
  return plan;
}

type DepImpl = (id: string) => unknown;

function makeDeps(overrides: Record<string, DepImpl> = {}): { calls: string[]; deps: LooseDeps } {
  const calls: string[] = [];
  const invoke = (label: "stop" | "start", id: string): Promise<unknown> => {
    calls.push(`${label}:${id}`);
    const impl = overrides[`${label}:${id}`];
    return Promise.resolve(impl === undefined ? { ok: true } : impl(id));
  };
  return {
    calls,
    deps: {
      stop: (id) => invoke("stop", id),
      start: (id) => invoke("start", id),
    },
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = (): void => {
      resolve(undefined);
    };
  });
  return { promise, release };
}

async function runSwitch(
  plan: ProfileSwitchPlan,
  deps: LooseDeps,
  opts?: ExecuteOpts,
): Promise<Report> {
  const result = (await run(plan, deps, opts).catch((error: unknown) => ({
    rejected: String(error),
  }))) as Report & { rejected?: string };
  expect(result.rejected).toBeUndefined();
  return result;
}

// ── crash-row fixtures ────────────────────────────────────────────────

// Leaves the same pending `profile-switch:n1` row a crashed switch would
// have begun, without running any step.
function beginPendingSwitchRow(
  store: ResidencyOperationStore,
  fenceToken: number,
  operationId: string,
): void {
  const begun = store.beginOperation({
    fenceToken,
    operationId,
    model: "profile-switch:n1",
    targetState: "profile:interactive",
    desiredRevision: 0,
    reservationGiB: 0,
    nowMs: 1,
  });
  if (!begun.ok) {
    throw new Error(`beginOperation(${operationId}) refused: ${begun.reason}`);
  }
}

// Parks a live switch inside the given dep: the entered promise resolves
// once the step is in flight and the run then waits on the hold.
function startHangingSwitch(
  hangKey: string,
  operationId: string,
): { entered: Promise<void>; release: () => void; abandoned: Promise<Report> } {
  const entered = deferred();
  const hold = deferred();
  const fx = makeDeps({
    [hangKey]: async () => {
      entered.release();
      await hold.promise;
      return { ok: true };
    },
  });
  const abandoned = runSwitch(okFleetPlan(), fx.deps, {
    dryRun: false,
    registry: null,
    operation: { store: storeA, fenceToken: fenceA, operationId, desiredRevision: 0 },
  });
  return { entered: entered.promise, release: hold.release, abandoned };
}

// Parks a fenced switch in the drain wait: v-a holds a lease, so the
// whenIdle wait cannot settle until the lease is released.
function startDrainCrash(operationId: string): {
  releaseLease: () => void;
  abandoned: Promise<Report>;
} {
  const registry = createResidencyLeases();
  const held = registry.acquire("v-a");
  if (!held.ok) {
    throw new Error(`acquire(v-a) refused: ${held.reason}`);
  }
  const lease = held.lease;
  const abandoned = runSwitch(okFleetPlan(), makeDeps().deps, {
    dryRun: false,
    registry,
    drainTimeoutMs: 60_000,
    operation: { store: storeA, fenceToken: fenceA, operationId, desiredRevision: 0 },
  });
  return {
    releaseLease: (): void => {
      lease.release();
    },
    abandoned,
  };
}

async function waitForOperationPhase(
  store: ResidencyOperationStore,
  operationId: string,
  phase: ResidencyOperationPhase,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getOperation(operationId)?.phase === phase) {
      return;
    }
    await Promise.resolve();
  }
  expect(store.getOperation(operationId)?.phase).toBe(phase);
}

function isRecord(value: unknown): value is ResidencyOperationRecord {
  return typeof value === "object" && value !== null;
}

// Leaves one pending `profile-switch:<node>` row per node, created in the
// given order so `listNonterminal` returns them in that order.
function beginPendingSwitchRows(
  store: ResidencyOperationStore,
  fenceToken: number,
  rows: readonly { operationId: string; node: string }[],
): void {
  for (const [index, row] of rows.entries()) {
    const begun = store.beginOperation({
      fenceToken,
      operationId: row.operationId,
      model: `profile-switch:${row.node}`,
      targetState: "profile:interactive",
      desiredRevision: 0,
      reservationGiB: 0,
      nowMs: index + 1,
    });
    if (!begun.ok) {
      throw new Error(`beginOperation(${row.operationId}) refused: ${begun.reason}`);
    }
  }
}

const THREE_ROWS = [
  { operationId: "op-1", node: "n1" },
  { operationId: "op-2", node: "n2" },
  { operationId: "op-3", node: "n3" },
] as const;

function recoveredRow(
  operationId: string,
  node: string,
  outcome: "succeeded" | "unknown",
  reason: RecoveredOperation["reason"],
): RecoveredOperation {
  return {
    operationId,
    node,
    profile: "interactive",
    priorPhase: "pending",
    outcome,
    reason,
    recorded: true,
  };
}

// Counts the timers created through the global setTimeout that have
// neither fired nor been cleared.
function trackPendingTimers(): { pending: () => number; restore: () => void } {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const live = new Set<unknown>();
  const trackedSet = (handler: () => void, ms?: number): unknown => {
    const handle: unknown = realSetTimeout(() => {
      live.delete(handle);
      handler();
    }, ms);
    live.add(handle);
    return handle;
  };
  const trackedClear = (handle?: unknown): void => {
    live.delete(handle);
    realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  };
  globalThis.setTimeout = trackedSet as unknown as typeof setTimeout;
  globalThis.clearTimeout = trackedClear;
  return {
    pending: () => live.size,
    restore: (): void => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

const UNKNOWN_RECOVERED = {
  operationId: "op-crash",
  node: "n1",
  profile: "interactive",
  priorPhase: "pending",
  outcome: "unknown",
  reason: "interrupted-unverified",
  recorded: true,
} as const;

describe("recoverProfileSwitchOperations crash recovery (#279 DF-06)", () => {
  test.each(["fence", "drain", "stop", "start"] as const)(
    "a crash during the %s phase is terminalized as unknown",
    async (crashAt) => {
      const recover = await loadRecover();
      let releaseCrash: (() => void) | null = null;
      let abandoned: Promise<Report> | null = null;
      try {
        if (crashAt === "fence") {
          beginPendingSwitchRow(storeA, fenceA, "op-crash");
        } else if (crashAt === "drain") {
          const crash = startDrainCrash("op-crash");
          releaseCrash = crash.releaseLease;
          abandoned = crash.abandoned;
          await waitForOperationPhase(storeA, "op-crash", "pending");
        } else {
          const crash = startHangingSwitch(
            crashAt === "stop" ? "stop:v-a" : "start:r-x",
            "op-crash",
          );
          releaseCrash = crash.release;
          abandoned = crash.abandoned;
          await crash.entered;
        }

        const store = restartStore();
        const result = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });

        expect(result.recovered).toEqual([UNKNOWN_RECOVERED]);
        expect(result.skipped).toEqual([]);
        const rec = store.getOperation("op-crash");
        expect(rec).not.toBeNull();
        expect(rec?.phase).toBe("terminal");
        expect(rec?.outcome).toBe("unknown");
        expect(rec?.detail).toBe("recovered: interrupted-unverified (was pending)");
        expect(store.listNonterminal()).toEqual([]);
      } finally {
        releaseCrash?.();
        if (abandoned !== null) {
          await abandoned;
        }
      }
    },
  );

  test("the next switch proceeds once recovery terminalizes the crashed row", async () => {
    const recover = await loadRecover();
    const crash = startHangingSwitch("stop:v-a", "op-crash");
    await crash.entered;

    try {
      const store = restartStore();
      const result = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });
      expect(result.recovered).toHaveLength(1);

      const next = await runSwitch(okFleetPlan(), makeDeps().deps, {
        dryRun: false,
        registry: null,
        operation: { store, fenceToken: fenceB, operationId: "op-next", desiredRevision: 0 },
      });
      expect(next.outcome).toBe("stops-and-starts-ran");
      expect(next.operation?.recorded).toBe(true);
    } finally {
      crash.release();
      await crash.abandoned;
    }
  });

  test("a target that verifies ready is recovered as succeeded", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRow(storeA, fenceA, "op-crash");
    const store = restartStore();
    const seen: RecoverVerifyArg[] = [];

    const result = await recover({
      store,
      fenceToken: fenceB,
      nowMs: () => 5,
      verifyTargetReady: (arg) => {
        seen.push(arg);
        return true;
      },
    });

    expect(seen).toEqual([{ node: "n1", profile: "interactive", operationId: "op-crash" }]);
    expect(result.recovered).toEqual([
      {
        operationId: "op-crash",
        node: "n1",
        profile: "interactive",
        priorPhase: "pending",
        outcome: "succeeded",
        reason: "target-verified-ready",
        recorded: true,
      },
    ]);
    const rec = store.getOperation("op-crash");
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("succeeded");
  });

  test("a target that does not verify recovers as unknown/interrupted-unverified", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRow(storeA, fenceA, "op-crash");
    const store = restartStore();

    const result = await recover({
      store,
      fenceToken: fenceB,
      nowMs: () => 5,
      verifyTargetReady: () => false,
    });

    expect(result.recovered).toEqual([UNKNOWN_RECOVERED]);
    const rec = store.getOperation("op-crash");
    expect(rec).not.toBeNull();
    expect(rec?.outcome).toBe("unknown");
  });

  test("a throwing readiness verifier recovers as unknown/readiness-check-failed and recover still resolves", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRow(storeA, fenceA, "op-crash");
    const store = restartStore();

    const result = await recover({
      store,
      fenceToken: fenceB,
      nowMs: () => 5,
      verifyTargetReady: () => {
        throw new Error("probe exploded");
      },
    });

    expect(result.recovered).toEqual([
      {
        operationId: "op-crash",
        node: "n1",
        profile: "interactive",
        priorPhase: "pending",
        outcome: "unknown",
        reason: "readiness-check-failed",
        recorded: true,
      },
    ]);
    const rec = store.getOperation("op-crash");
    expect(rec).not.toBeNull();
    expect(rec?.outcome).toBe("unknown");
  });

  test("a non-boolean verifier result is not treated as ready", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRow(storeA, fenceA, "op-crash");
    const store = restartStore();

    const result = await recover({
      store,
      fenceToken: fenceB,
      nowMs: () => 5,
      verifyTargetReady: () => "yes",
    });

    expect(result.recovered).toEqual([UNKNOWN_RECOVERED]);
    const rec = store.getOperation("op-crash");
    expect(rec).not.toBeNull();
    expect(rec?.outcome).toBe("unknown");
  });

  test("the readiness verifier is bounded by verifyTimeoutMs", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRow(storeA, fenceA, "op-crash");
    const store = restartStore();
    let sentinel: ReturnType<typeof setTimeout> | undefined;

    const raced: unknown = await Promise.race([
      recover({
        store,
        fenceToken: fenceB,
        nowMs: () => 5,
        verifyTargetReady: () => new Promise<boolean>(() => undefined),
        verifyTimeoutMs: 20,
      }),
      new Promise((resolve) => {
        sentinel = setTimeout(() => {
          resolve("hung");
        }, 2000);
      }),
    ]);
    if (sentinel !== undefined) {
      clearTimeout(sentinel);
    }

    expect(raced).not.toBe("hung");
    const result = raced as RecoverResult;
    expect(result.recovered).toEqual([
      {
        operationId: "op-crash",
        node: "n1",
        profile: "interactive",
        priorPhase: "pending",
        outcome: "unknown",
        reason: "readiness-check-failed",
        recorded: true,
      },
    ]);
    const rec = store.getOperation("op-crash");
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("unknown");
  });

  test("an already-terminal row and a non-switch row are left untouched", async () => {
    const recover = await loadRecover();
    const begunDone = storeA.beginOperation({
      fenceToken: fenceA,
      operationId: "op-done",
      model: "profile-switch:n2",
      targetState: "profile:interactive",
      desiredRevision: 0,
      reservationGiB: 0,
      nowMs: 1,
    });
    if (!begunDone.ok) {
      throw new Error(`op-done begin refused: ${begunDone.reason}`);
    }
    const finished = storeA.finishOperation({
      fenceToken: fenceA,
      operationId: "op-done",
      expectedVersion: begunDone.record.version,
      nowMs: 2,
      outcome: "succeeded",
    });
    if (!finished.ok) {
      throw new Error(`op-done finish refused: ${finished.reason}`);
    }
    const begunModel = storeA.beginOperation({
      fenceToken: fenceA,
      operationId: "op-model",
      model: "llama-x",
      targetState: "ready",
      desiredRevision: 0,
      reservationGiB: 0,
      nowMs: 3,
    });
    if (!begunModel.ok) {
      throw new Error(`op-model begin refused: ${begunModel.reason}`);
    }

    const store = restartStore();
    const doneBefore = store.getOperation("op-done");
    const modelBefore = store.getOperation("op-model");
    expect(doneBefore).not.toBeNull();
    expect(modelBefore).not.toBeNull();

    const result = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });
    expect(result.recovered).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(store.getOperation("op-done")).toEqual(doneBefore);
    expect(store.getOperation("op-model")).toEqual(modelBefore);
    expect(store.listNonterminal().map((record) => record.operationId)).toEqual(["op-model"]);
  });

  test("recovery is idempotent and ignores rows that already reached terminal", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRow(storeA, fenceA, "op-crash");
    const store = restartStore();

    const first = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });
    expect(first.recovered).toEqual([UNKNOWN_RECOVERED]);
    const snapshot = store.getOperation("op-crash");
    expect(snapshot).not.toBeNull();

    const leaking: RecoverStore = {
      listNonterminal: () =>
        [...store.listNonterminal(), store.getOperation("op-crash")].filter(isRecord),
      finishOperation: (input) => store.finishOperation(input),
    };
    const second = await recover({ store: leaking, fenceToken: fenceB, nowMs: () => 5 });
    expect(second).toEqual({ recovered: [], skipped: [] });
    expect(store.getOperation("op-crash")).toEqual(snapshot);

    const third = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });
    expect(third).toEqual({ recovered: [], skipped: [] });
  });

  test("the stale owner's late finish is refused by the fence after recovery", async () => {
    const recover = await loadRecover();
    const crash = startHangingSwitch("stop:v-a", "op-crash");
    await crash.entered;

    try {
      const store = restartStore();
      const result = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });
      expect(result.recovered).toHaveLength(1);

      const before = store.getOperation("op-crash");
      expect(before).not.toBeNull();
      const version = before?.version;

      crash.release();
      const report = await crash.abandoned;

      expect(report.operation?.recorded).toBe(false);
      expect(report.operation?.recordFailure).toBe("stale-fence");

      const after = store.getOperation("op-crash");
      expect(after).not.toBeNull();
      expect(after?.phase).toBe("terminal");
      expect(after?.outcome).toBe("unknown");
      expect(after?.detail).toBe("recovered: interrupted-unverified (was pending)");
      expect(after?.version).toBe(version);
    } finally {
      crash.release();
    }
  });

  test("a row owned by the current fence is skipped, not terminalized", async () => {
    const recover = await loadRecover();
    const store = restartStore();
    beginPendingSwitchRow(store, fenceB, "op-live");

    const result = await recover({ store, fenceToken: fenceB, nowMs: () => 5 });
    expect(result.recovered).toEqual([]);
    expect(result.skipped).toEqual([
      { operationId: "op-live", node: "n1", reason: "owned-by-current-fence" },
    ]);
    const rec = store.getOperation("op-live");
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("pending");
  });
  test("a synchronously throwing verifier under verifyTimeoutMs is recorded readiness-check-failed and the scan continues", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRows(storeA, fenceA, THREE_ROWS);
    const store = restartStore();
    const seen: string[] = [];

    const settled = await recover({
      store,
      fenceToken: fenceB,
      nowMs: () => 5,
      verifyTargetReady: (arg) => {
        seen.push(arg.operationId);
        if (arg.operationId === "op-1") {
          throw new Error("probe exploded synchronously");
        }
        return true;
      },
      verifyTimeoutMs: 60_000,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ rejected: String(error) }),
    );

    expect(settled).not.toHaveProperty("rejected");
    const result = (settled as { result: RecoverResult }).result;
    expect(seen).toEqual(["op-1", "op-2", "op-3"]);
    expect(result.recovered).toEqual([
      recoveredRow("op-1", "n1", "unknown", "readiness-check-failed"),
      recoveredRow("op-2", "n2", "succeeded", "target-verified-ready"),
      recoveredRow("op-3", "n3", "succeeded", "target-verified-ready"),
    ]);
    expect(result.skipped).toEqual([]);
    const first = store.getOperation("op-1");
    expect(first).not.toBeNull();
    expect(first?.phase).toBe("terminal");
    expect(first?.outcome).toBe("unknown");
    expect(first?.detail).toBe("recovered: readiness-check-failed (was pending)");
    expect(store.listNonterminal()).toEqual([]);
  });

  test("a row whose finish is refused does not stop the scan", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRows(storeA, fenceA, THREE_ROWS);
    const store = restartStore();

    const refusing: RecoverStore = {
      listNonterminal: () => store.listNonterminal(),
      finishOperation: (input) =>
        input.operationId === "op-1"
          ? { ok: false, reason: "version-conflict" }
          : store.finishOperation(input),
    };
    const result = await recover({ store: refusing, fenceToken: fenceB, nowMs: () => 5 });

    expect(result.recovered).toEqual([
      {
        ...recoveredRow("op-1", "n1", "unknown", "interrupted-unverified"),
        recorded: false,
        recordFailure: "version-conflict",
      },
      recoveredRow("op-2", "n2", "unknown", "interrupted-unverified"),
      recoveredRow("op-3", "n3", "unknown", "interrupted-unverified"),
    ]);
    expect(store.listNonterminal().map((record) => record.operationId)).toEqual(["op-1"]);
  });

  test("the verifyTimeoutMs timer is cleared once the verifier settles", async () => {
    const recover = await loadRecover();
    beginPendingSwitchRows(storeA, fenceA, THREE_ROWS);
    const store = restartStore();

    const timers = trackPendingTimers();
    let result: RecoverResult;
    try {
      result = await recover({
        store,
        fenceToken: fenceB,
        nowMs: () => 5,
        verifyTargetReady: (arg) => {
          if (arg.operationId === "op-1") {
            throw new Error("probe exploded synchronously");
          }
          if (arg.operationId === "op-2") {
            return Promise.reject(new Error("probe rejected"));
          }
          return Promise.resolve(true);
        },
        verifyTimeoutMs: 60_000,
      });
      expect(timers.pending()).toBe(0);
    } finally {
      timers.restore();
    }

    expect(result.recovered.map((row) => row.reason)).toEqual([
      "readiness-check-failed",
      "readiness-check-failed",
      "target-verified-ready",
    ]);
  });
});
