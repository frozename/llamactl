/**
 * #279 DF-06 — RED tests for the per-node operation record and
 * cancellation of `executeProfileSwitch` in
 * `src/residency/profile-transition`: with `opts.operation` the
 * executor must reserve the switch in the fenced residency operation
 * store before any dep runs — a second switch on the same node while
 * one is in flight is refused Busy naming the in-flight operation, an
 * `opts.signal` abort stops the run at the next step boundary (or
 * mid-drain, cancelling every owned drain), completion releases the
 * node through finishOperation, replaying a finished operation id is
 * idempotent, and a store refusal fails closed before any step. At
 * base the executor ignores `opts.operation` and `opts.signal`, so
 * every case fails BY ASSERTION — never by import, type or
 * TypeError. Store reads are assertion-first (`expect(rec).not.toBeNull()`
 * then `rec?.field`); no non-null assertions.
 */
import type {
  BeginDrainResult,
  CommitUnloadResult,
  ResidencyLeases,
  WhenIdleResult,
} from "@llamactl/core/residency/leases";
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
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

let dir = "";
let store: ResidencyOperationStore;
let fenceToken = 0;

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  dir = mkdtempSync(join(tmpdir(), "llamactl-profile-op-"));
  store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
  fenceToken = store.claimOwnership({ ownerId: "test", incarnation: "i1" }).fenceToken;
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  store.close();
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

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

function step(
  action: StepAction,
  workload: string,
  status: StepStatus,
  detail?: string,
): SwitchStep {
  return {
    action,
    workload,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

function operationOpts(operationId: string): SwitchOperation {
  return {
    store,
    fenceToken,
    operationId,
    desiredRevision: 0,
    nowMs: () => 1_000,
  };
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

function recordingRegistry(inner: ResidencyLeases, calls: string[]): ResidencyLeases {
  return {
    acquire: (workload) => inner.acquire(workload),
    active: (workload) => inner.active(workload),
    beginDrain: (workload): BeginDrainResult => {
      calls.push(`beginDrain:${workload}`);
      return inner.beginDrain(workload);
    },
    whenIdle: (token, opts): Promise<WhenIdleResult> => {
      calls.push(`whenIdle:${token.workload}`);
      return inner.whenIdle(token, opts);
    },
    commitUnload: (token, opts): CommitUnloadResult => {
      calls.push(`commitUnload:${token.workload}`);
      return inner.commitUnload(token, opts);
    },
    cancelDrain: (token): boolean => {
      calls.push(`cancelDrain:${token.workload}`);
      return inner.cancelDrain(token);
    },
    reopen: (token) => inner.reopen(token),
    snapshot: (workload) => inner.snapshot(workload),
    waiterCount: (workload) => inner.waiterCount(workload),
    audit: () => inner.audit(),
  };
}

describe("executeProfileSwitch operation record + cancellation", () => {
  test("a second switch on the same node while one is in flight is refused as Busy with the in-flight operation id", async () => {
    const plan = okFleetPlan();
    const entered = deferred();
    const hold = deferred();
    const fxA = makeDeps({
      "stop:v-a": async () => {
        entered.release();
        await hold.promise;
        return { ok: true };
      },
    });

    const pA = runSwitch(plan, fxA.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-a"),
    });
    await entered.promise;

    try {
      const fxB = makeDeps();
      const b = await runSwitch(plan, fxB.deps, {
        dryRun: false,
        registry: null,
        operation: operationOpts("op-b"),
      });
      expect(b.outcome).toBe("busy");
      expect(b.ok).toBe(false);
      expect(b.busy).toEqual({
        reason: "Busy",
        node: NODE,
        operationId: "op-a",
        detail: expect.stringContaining("op-a") as string,
      });
      expect(b.steps).toEqual([]);
      expect(b.ran).toEqual([]);
      expect(fxB.calls).toEqual([]);
    } finally {
      hold.release();
    }

    const a = await pA;
    expect(a.outcome).toBe("stops-and-starts-ran");
    expect(a.ok).toBe(true);
    expect(a.operation).toEqual({ id: "op-a", outcome: "succeeded", recorded: true });
    expect(fxA.calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    const recA = store.getOperation("op-a");
    expect(recA).not.toBeNull();
    expect(recA?.phase).toBe("terminal");
    expect(recA?.outcome).toBe("succeeded");
  });

  test("abort mid-plan stops before the next step boundary and records a cancelled outcome", async () => {
    const plan = okFleetPlan();
    const controller = new AbortController();
    const fxC = makeDeps({
      "stop:v-a": () => {
        controller.abort();
        return { ok: true };
      },
    });

    const c = await runSwitch(plan, fxC.deps, {
      dryRun: false,
      registry: null,
      signal: controller.signal,
      operation: operationOpts("op-c"),
    });

    expect(c.outcome).toBe("cancelled");
    expect(c.ok).toBe(false);
    expect(fxC.calls).toEqual(["stop:v-a"]);
    expect(c.cancelledAt).toEqual({ action: "stop", workload: "v-b" });
    expect(c.steps).toEqual([
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "not-run"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(c.ran).toEqual([step("stop", "v-a", "ok")]);
    expect(c.operation).toEqual({ id: "op-c", outcome: "cancelled", recorded: true });
    const recC = store.getOperation("op-c");
    expect(recC).not.toBeNull();
    expect(recC?.phase).toBe("terminal");
    expect(recC?.outcome).toBe("cancelled");
    expect(recC?.detail).toContain("cancelled before stop v-b");

    const controllerD = new AbortController();
    controllerD.abort();
    const fxD = makeDeps();
    const d = await runSwitch(plan, fxD.deps, {
      dryRun: false,
      registry: null,
      signal: controllerD.signal,
      operation: operationOpts("op-d"),
    });

    expect(d.outcome).toBe("cancelled");
    expect(d.ok).toBe(false);
    expect(fxD.calls).toEqual([]);
    expect(d.cancelledAt).toEqual({ action: "stop", workload: "v-a" });
    expect(d.steps).toEqual([
      step("stop", "v-a", "not-run"),
      step("stop", "v-b", "not-run"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(d.ran).toEqual([]);
    expect(d.operation).toEqual({ id: "op-d", outcome: "cancelled", recorded: true });
  });

  test("completion releases the node so the next switch runs", async () => {
    const plan = okFleetPlan();

    const fxE = makeDeps();
    const e = await runSwitch(plan, fxE.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-e"),
    });
    expect(e.outcome).toBe("stops-and-starts-ran");
    expect(e.ok).toBe(true);

    const recE = store.getOperation("op-e");
    expect(recE).not.toBeNull();
    expect(recE).toMatchObject({ phase: "terminal", outcome: "succeeded" });

    const fxF = makeDeps();
    const f = await runSwitch(plan, fxF.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-f"),
    });
    expect(f.outcome).toBe("stops-and-starts-ran");
    expect(f.ok).toBe(true);
    expect(store.listNonterminal()).toEqual([]);

    const fxG = makeDeps({
      "start:r-x": () => ({ ok: false, detail: "admission refused" }),
    });
    const g = await runSwitch(plan, fxG.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-g"),
    });
    expect(g.outcome).toBe("failed");
    expect(g.ok).toBe(false);
    const recG = store.getOperation("op-g");
    expect(recG).not.toBeNull();
    expect(recG?.phase).toBe("terminal");
    expect(recG?.outcome).toBe("failed");
    expect(recG?.detail).toContain("admission refused");

    const fxH = makeDeps();
    const h = await runSwitch(plan, fxH.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-h"),
    });
    expect(h.outcome).toBe("stops-and-starts-ran");
    expect(h.ok).toBe(true);
    expect(store.listNonterminal()).toEqual([]);
  });

  test("replaying a finished operation id is idempotent and runs no steps", async () => {
    const plan = okFleetPlan();
    const fx = makeDeps();

    const firstRun = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-i"),
    });
    expect(firstRun.outcome).toBe("stops-and-starts-ran");

    const first = store.getOperation("op-i");
    expect(first).not.toBeNull();
    expect(first?.phase).toBe("terminal");
    const v = first?.version;
    const mark = fx.calls.length;

    const replay = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-i"),
    });

    expect(replay.outcome).toBe("replayed");
    expect(replay.ok).toBe(true);
    expect(replay.steps).toEqual([]);
    expect(replay.ran).toEqual([]);
    expect(replay.operation).toEqual({ id: "op-i", outcome: "succeeded", recorded: true });
    expect(fx.calls.length).toBe(mark);

    const after = store.getOperation("op-i");
    expect(after).not.toBeNull();
    expect(after?.version).toBe(v);
  });

  test("a store refusal fails closed before any step", async () => {
    const plan = okFleetPlan();
    store.claimOwnership({ ownerId: "test", incarnation: "i2" });
    const fx = makeDeps();

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      operation: operationOpts("op-j"),
    });

    expect(report.outcome).toBe("refused");
    expect(report.ok).toBe(false);
    expect(report.refusal).toEqual({
      reason: "operation-record-refused",
      detail: "stale-fence",
    });
    expect(fx.calls).toEqual([]);
  });

  test("abort during a fenced drain wait cancels every drain and stops nothing", async () => {
    const plan = okFleetPlan();
    const controller = new AbortController();
    const inner = createResidencyLeases();
    const fx = makeDeps();
    const base = recordingRegistry(inner, fx.calls);
    const registry: ResidencyLeases = {
      ...base,
      whenIdle: (token, opts) => {
        if (token.workload === "v-c") {
          setTimeout(() => {
            controller.abort();
          }, 0);
        }
        return base.whenIdle(token, opts);
      },
    };
    const held = inner.acquire("v-b");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      throw new Error("acquire refused");
    }

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry,
      drainTimeoutMs: 1_000,
      signal: controller.signal,
      operation: operationOpts("op-k"),
    });

    expect(fx.calls).toEqual([
      "beginDrain:v-a",
      "beginDrain:v-b",
      "beginDrain:v-c",
      "whenIdle:v-a",
      "whenIdle:v-b",
      "whenIdle:v-c",
      "cancelDrain:v-a",
      "cancelDrain:v-b",
      "cancelDrain:v-c",
    ]);
    expect(report.outcome).toBe("cancelled");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toBeNull();
    expect(report.cancelledAt).toEqual({ action: "stop", workload: "v-a" });
    expect(report.operation).toEqual({ id: "op-k", outcome: "cancelled", recorded: true });
    expect(report.steps).toEqual([
      step("fence", "v-a", "ok"),
      step("fence", "v-b", "ok"),
      step("fence", "v-c", "ok"),
      step("drain", "v-a", "ok"),
      step("drain", "v-b", "not-run"),
      step("drain", "v-c", "ok"),
      step("stop", "v-a", "not-run"),
      step("stop", "v-b", "not-run"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    const rec = store.getOperation("op-k");
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("cancelled");
    expect(rec?.detail).toContain("cancelled before stop v-a");
  });
});
