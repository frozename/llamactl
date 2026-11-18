// #519: minResidencySeconds protects a resident from operator idle eviction.
// The idleEviction snapshot row gains an optional minResidencyUntilMs — the
// ready-since (clamped to nowMs, as #735 does for the planner) plus
// minResidencySeconds — and dueAtMs becomes the later of the idle-due and
// min-residency timestamps, so a resident still inside its minimum residency
// reports due:false with the hold field set. runIdleEviction maps that held
// row to a skipped MinResidency result (dry run and targeted wet run) instead
// of NotDue, and the residencyEvictIdle router path carries the same hold.
// At the pinned base neither the field nor the reason exists, so every case
// fails BY ASSERTION — never by import or type error.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import {
  createResidencyLeases,
  type ResidencyAuditEntry,
  type ResidencyLeases,
  type ResidencySnapshot,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import * as procedures from "../../src/residency/procedures.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

// The min-residency idle-eviction contract the assertions pin, described
// structurally so the file typechecks on both sides of the fix: the snapshot
// row gains an optional minResidencyUntilMs and the eviction rows gain the
// "MinResidency" skip reason.
type IdleEvictionSnapshotRow = {
  workload: string;
  readySinceMs: number;
  lastActivityAtMs: number | null;
  idleSinceMs: number | null;
  activeLeaseCount: number;
  dueAtMs: number | null;
  due: boolean;
  minResidencyUntilMs?: number;
};

type IdleEvictionSnapshot =
  | { status: "disabled"; scope: string }
  | { status: "unavailable"; scope: string; reason: string }
  | {
      status: "available";
      scope: string;
      advisory: boolean;
      idleEvictSeconds: number;
      workloads: IdleEvictionSnapshotRow[];
    };

type ResidencyKnobs = {
  idleEvictSeconds?: number;
  minResidencySeconds?: number;
};

type FakeLeaseRegistry = {
  snapshot: (workload: string) => ResidencySnapshot;
  audit: () => ResidencyAuditEntry[];
  lastActivityAtMs?: (workload: string) => number;
};

type BuildIdleEvictionSnapshot = (input: {
  residency: ResidencyKnobs | null | undefined;
  servingNode: string | null;
  node: string;
  store: ResidencyStoreSnapshot;
  leaseRegistry: FakeLeaseRegistry | null;
  nowMs: number;
}) => IdleEvictionSnapshot;

type IdleEvictKind = "modelrun" | "modelhost";

type IdleEvictTarget = { workload: string; kind: IdleEvictKind };

type IdleEvictStopResult = { stopped: boolean; detail?: string };

type IdleEvictionResultRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: IdleEvictKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};

type IdleEvictionRunResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: IdleEvictionResultRow[] };

type LeaseRegistryProbe = {
  snapshot: (workload: string) => ResidencySnapshot;
  lastActivityAtMs?: (workload: string) => number;
};

type RunIdleEviction = (input: {
  idleEviction: IdleEvictionSnapshot;
  leaseRegistry: LeaseRegistryProbe | null;
  nowMs: number;
  targets: readonly IdleEvictTarget[] | null;
  stop: (workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult>;
}) => Promise<IdleEvictionRunResult>;

const NODE = "n";
const LOCAL_NODE = "local";
const IDLE_SECONDS = 60;
const MIN_RESIDENCY_SECONDS = 600;
const DEFAULT_RESIDENCY: ResidencyKnobs = {
  idleEvictSeconds: IDLE_SECONDS,
  minResidencySeconds: MIN_RESIDENCY_SECONDS,
};
const NOW_MS = 61_000;
const MIN_UNTIL_MS = MIN_RESIDENCY_SECONDS * 1000;

function requireSnapshotBuilder(): BuildIdleEvictionSnapshot {
  const build = (procedures as unknown as Record<string, unknown>)["buildIdleEvictionSnapshot"] as
    | BuildIdleEvictionSnapshot
    | undefined;
  expect(typeof build).toBe("function");
  return build!;
}

function requireRun(): RunIdleEviction {
  const run = (procedures as unknown as Record<string, unknown>)["runIdleEviction"] as
    | RunIdleEviction
    | undefined;
  expect(typeof run).toBe("function");
  return run!;
}

function lifecycleRow(
  model: string,
  state: ResidencyState,
  updatedAtMs: number,
): ResidencyStateRecord {
  return {
    model,
    group: null,
    state,
    ownerId: "o",
    incarnation: "i",
    fenceToken: 1,
    version: 1,
    updatedAtMs,
  };
}

function storeWithLifecycle(lifecycle: ResidencyStateRecord[]): ResidencyStoreSnapshot {
  return { path: "/p", present: true, nonterminal: [], lifecycle };
}

function fakeLeaseRegistry(opts?: { active?: readonly string[] }): FakeLeaseRegistry {
  const active = opts?.active ?? [];
  return {
    snapshot: (workload) => ({
      workload,
      phase: "open",
      epoch: 0,
      active: [...active],
      waiters: 0,
    }),
    audit: () => [],
    lastActivityAtMs: () => 0,
  };
}

function snapshotRows(opts: {
  residency?: ResidencyKnobs | null;
  lifecycle?: ResidencyStateRecord[];
  registry?: FakeLeaseRegistry | null;
  nowMs: number;
}): IdleEvictionSnapshotRow[] {
  const built = requireSnapshotBuilder()({
    residency: opts.residency === undefined ? DEFAULT_RESIDENCY : opts.residency,
    servingNode: NODE,
    node: NODE,
    store: storeWithLifecycle(opts.lifecycle ?? [lifecycleRow("w", "ready", 0)]),
    leaseRegistry: opts.registry === undefined ? fakeLeaseRegistry() : opts.registry,
    nowMs: opts.nowMs,
  });
  if (built.status !== "available") {
    throw new Error(`expected an available idleEviction snapshot, got ${built.status}`);
  }
  return built.workloads;
}

function onlyRow(rows: readonly IdleEvictionSnapshotRow[]): IdleEvictionSnapshotRow {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one idleEviction snapshot row");
  }
  return row;
}

function snapshotRow(
  workload: string,
  opts: {
    readySinceMs?: number;
    lastActivityAtMs?: number | null;
    idleSinceMs?: number | null;
    dueAtMs?: number | null;
    due?: boolean;
    minResidencyUntilMs?: number;
  } = {},
): IdleEvictionSnapshotRow {
  return {
    workload,
    readySinceMs: opts.readySinceMs ?? 0,
    lastActivityAtMs: opts.lastActivityAtMs === undefined ? 0 : opts.lastActivityAtMs,
    idleSinceMs: opts.idleSinceMs === undefined ? 0 : opts.idleSinceMs,
    activeLeaseCount: 0,
    dueAtMs: opts.dueAtMs === undefined ? IDLE_SECONDS * 1000 : opts.dueAtMs,
    due: opts.due ?? true,
    ...(opts.minResidencyUntilMs !== undefined
      ? { minResidencyUntilMs: opts.minResidencyUntilMs }
      : {}),
  };
}

// The row buildIdleEvictionSnapshot produces for the default residency at
// NOW_MS once the fix lands: idle-due under the 60s window but held by the
// 600s min-residency window.
function heldRow(): IdleEvictionSnapshotRow {
  return snapshotRow("w", {
    dueAtMs: MIN_UNTIL_MS,
    due: false,
    minResidencyUntilMs: MIN_UNTIL_MS,
  });
}

function availableSnapshot(workloads: readonly IdleEvictionSnapshotRow[]): IdleEvictionSnapshot {
  return {
    status: "available",
    scope: "serving-process",
    advisory: true,
    idleEvictSeconds: IDLE_SECONDS,
    workloads: [...workloads],
  };
}

function recordingStop(
  calls: [string, IdleEvictKind][],
): (workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult> {
  return (workload, kind) => {
    calls.push([workload, kind]);
    return Promise.resolve({ stopped: true });
  };
}

function rowsOf(result: IdleEvictionRunResult): IdleEvictionResultRow[] {
  return result.ok ? result.rows : [];
}

function rowFor(
  result: IdleEvictionRunResult,
  workload: string,
): IdleEvictionResultRow | undefined {
  return rowsOf(result).find((row) => row.workload === workload);
}

describe("buildIdleEvictionSnapshot minResidencySeconds (#519)", () => {
  test("M1: an idle-due resident inside minResidencySeconds is held", () => {
    // kills: the dueAtMs/due computation ignoring minResidencySeconds — on
    // base due is true and dueAtMs is the bare idle-due 60_000.
    const row = onlyRow(snapshotRows({ nowMs: NOW_MS }));
    expect(row).toEqual({
      workload: "w",
      readySinceMs: 0,
      lastActivityAtMs: 0,
      idleSinceMs: 0,
      activeLeaseCount: 0,
      dueAtMs: MIN_UNTIL_MS,
      due: false,
      minResidencyUntilMs: MIN_UNTIL_MS,
    });
  });

  test("M2: the hold releases at exactly ready-since + minResidencySeconds", () => {
    // kills: `<=` vs `<` at the ready-since + min boundary, and the hold
    // field emitted after the window has passed.
    const before = onlyRow(snapshotRows({ nowMs: MIN_UNTIL_MS - 1 }));
    expect(before).toEqual({
      workload: "w",
      readySinceMs: 0,
      lastActivityAtMs: 0,
      idleSinceMs: 0,
      activeLeaseCount: 0,
      dueAtMs: MIN_UNTIL_MS,
      due: false,
      minResidencyUntilMs: MIN_UNTIL_MS,
    });
    const at = onlyRow(snapshotRows({ nowMs: MIN_UNTIL_MS }));
    expect(at).toEqual({
      workload: "w",
      readySinceMs: 0,
      lastActivityAtMs: 0,
      idleSinceMs: 0,
      activeLeaseCount: 0,
      dueAtMs: MIN_UNTIL_MS,
      due: true,
    });
    expect("minResidencyUntilMs" in at).toBe(false);
  });

  test("M3: no minResidencySeconds (absent or 0) leaves the row unchanged", () => {
    // kills: emitting the hold field or shifting dueAtMs under the default
    // policy — guard, passes on base.
    const expected = {
      workload: "w",
      readySinceMs: 0,
      lastActivityAtMs: 0,
      idleSinceMs: 0,
      activeLeaseCount: 0,
      dueAtMs: IDLE_SECONDS * 1000,
      due: true,
    };
    for (const residency of [
      { idleEvictSeconds: IDLE_SECONDS },
      { idleEvictSeconds: IDLE_SECONDS, minResidencySeconds: 0 },
    ]) {
      const row = onlyRow(snapshotRows({ residency, nowMs: NOW_MS }));
      expect(row).toEqual(expected);
      expect("minResidencyUntilMs" in row).toBe(false);
    }
  });

  test("M4: dueAtMs is the max of idle-due and min-residency, not the sum", () => {
    // kills: summing the two windows (660_000) instead of taking the max —
    // guard, passes on base.
    const withMin = onlyRow(
      snapshotRows({
        residency: { idleEvictSeconds: 600, minResidencySeconds: 60 },
        nowMs: 600_000,
      }),
    );
    const withoutMin = onlyRow(
      snapshotRows({ residency: { idleEvictSeconds: 600 }, nowMs: 600_000 }),
    );
    expect(withMin).toEqual(withoutMin);
    expect(withMin).toEqual({
      workload: "w",
      readySinceMs: 0,
      lastActivityAtMs: 0,
      idleSinceMs: 0,
      activeLeaseCount: 0,
      dueAtMs: 600_000,
      due: true,
    });
    expect("minResidencyUntilMs" in withMin).toBe(false);
  });

  test("M5: a future-dated ready row clamps ready-since to nowMs for the hold", () => {
    // kills: an unclamped ready-since feeding the min-residency hold — on
    // base dueAtMs is 121_000.
    const row = onlyRow(
      snapshotRows({
        lifecycle: [lifecycleRow("w", "ready", NOW_MS + 10_000_000)],
        nowMs: NOW_MS,
      }),
    );
    expect(row).toMatchObject({
      workload: "w",
      lastActivityAtMs: 0,
      idleSinceMs: NOW_MS,
      activeLeaseCount: 0,
      dueAtMs: NOW_MS + MIN_RESIDENCY_SECONDS * 1000,
      due: false,
    });
  });

  test("M6: an active lease means the row is not idle and carries no hold", () => {
    // kills: setting minResidencyUntilMs without checking lease idleness —
    // the absence check passes on base.
    const row = onlyRow(
      snapshotRows({ registry: fakeLeaseRegistry({ active: ["l1"] }), nowMs: NOW_MS }),
    );
    expect(row).toMatchObject({
      workload: "w",
      readySinceMs: 0,
      lastActivityAtMs: 0,
      idleSinceMs: 0,
      activeLeaseCount: 1,
      due: false,
    });
    expect("minResidencyUntilMs" in row).toBe(false);
  });
});

describe("runIdleEviction MinResidency (#519)", () => {
  test("E1: a dry run reports a min-residency-held row skipped MinResidency", async () => {
    // kills: runIdleEviction ignoring minResidencyUntilMs — on base the row
    // is NotDue.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([heldRow()]),
      leaseRegistry: fakeLeaseRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(stops),
    });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: IDLE_SECONDS });
    expect(rowFor(result, "w")).toEqual({
      workload: "w",
      action: "skipped",
      reason: "MinResidency",
    });
    expect(stops).toEqual([]);
  });

  test("E2: a targeted wet run skips MinResidency without calling stop", async () => {
    // kills: a wet path that stops a resident still inside
    // minResidencySeconds — on base the row is NotDue.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([heldRow()]),
      leaseRegistry: fakeLeaseRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(result).toMatchObject({ ok: true, dryRun: false, windowSeconds: IDLE_SECONDS });
    expect(rowFor(result, "w")).toEqual({
      workload: "w",
      action: "skipped",
      reason: "MinResidency",
    });
    expect(stops).toEqual([]);
  });

  test("E3: a not-due row without the hold field is still NotDue", async () => {
    // kills: reporting MinResidency for a row that carries no hold field —
    // guard, passes on base.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w", { due: false, dueAtMs: 120_000 })]),
      leaseRegistry: fakeLeaseRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(stops),
    });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: IDLE_SECONDS });
    expect(rowFor(result, "w")).toEqual({
      workload: "w",
      action: "skipped",
      reason: "NotDue",
    });
    expect(stops).toEqual([]);
  });
});

describe("residencyEvictIdle min-residency hold (#519)", () => {
  const GROUP = "z13-large-gpu";
  const GROUP_LABEL = "llamactl.io/residency-group";
  const SEED_AGE_MS = 120_000;
  const originalEnv = { ...process.env };
  let root = "";
  let workloadsDir = "";
  let runtimeDir = "";
  let modelsDir = "";
  let leases: ResidencyLeases;

  const storePath = (): string => defaultResidencyStorePath();

  function seedReadyRow(model: string, group: string, nowMs: number): void {
    const store = openResidencyOperationStore({ path: storePath() });
    try {
      const fence = store.claimOwnership({
        ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
        incarnation: "seed",
      });
      let version = 0;
      for (const to of ["downloaded", "loading", "warming", "ready"] as const) {
        const result = store.transitionResidencyState({
          fenceToken: fence.fenceToken,
          model,
          ...(to === "loading" ? { group } : {}),
          to,
          expectedVersion: version,
          nowMs,
        });
        if (!result.ok) {
          throw new Error(`seed ${model} -> ${to} refused: ${result.reason}`);
        }
        version = result.record.version;
      }
    } finally {
      store.close();
    }
  }

  function readState(model: string): ResidencyStateRecord | null {
    const store = openResidencyOperationStore({ path: storePath() });
    try {
      return store.getResidencyState(model);
    } finally {
      store.close();
    }
  }

  function evictIdleCaller(): (input: {
    node: string;
    targets?: { workload: string; kind: IdleEvictKind }[];
  }) => Promise<IdleEvictionRunResult> {
    const caller = router.createCaller({}) as unknown as {
      residencyEvictIdle: (input: {
        node: string;
        targets?: { workload: string; kind: IdleEvictKind }[];
      }) => Promise<IdleEvictionRunResult>;
    };
    return (input) => caller.residencyEvictIdle(input);
  }

  beforeEach(() => {
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(null);
    root = mkdtempSync(join(tmpdir(), "llamactl-evict-idle-min-residency-"));
    workloadsDir = join(root, "workloads");
    runtimeDir = join(root, "runtime");
    modelsDir = join(root, "models");
    mkdirSync(workloadsDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    Object.assign(process.env, {
      DEV_STORAGE: join(root, "dev"),
      LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMA_CPP_MODELS: modelsDir,
      LLAMACTL_CONFIG: join(root, "config-missing"),
      LLAMACTL_NODE_NAME: LOCAL_NODE,
    });
    // The lease clock is pinned at the same instant the lifecycle row is
    // seeded with, so lastActivityAtMs reports that past instant; the real
    // Date.now() at call time is ~2 minutes later — past the 60s idle window
    // but far inside the 3600s min-residency hold.
    leases = createResidencyLeases({ now: () => Date.now() - SEED_AGE_MS });
    setResidencyLeaseRegistry(leases);
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: LOCAL_NODE, labels: {} },
        spec: {
          node: LOCAL_NODE,
          residency: { idleEvictSeconds: IDLE_SECONDS, minResidencySeconds: 3600 },
          infra: [],
        },
      },
      workloadsDir,
    );
    saveWorkload(
      ModelRunSchema.parse({
        apiVersion: "llamactl/v1",
        kind: "ModelRun",
        metadata: {
          name: "w1",
          labels: { [GROUP_LABEL]: GROUP },
        },
        spec: {
          node: LOCAL_NODE,
          enabled: true,
          restartPolicy: "Always",
          target: { kind: "rel", value: "w1/missing.gguf" },
        },
      }),
      workloadsDir,
    );
    seedReadyRow("w1", GROUP, Date.now() - SEED_AGE_MS);
  });

  afterEach(() => {
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(null);
    for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
    Object.assign(process.env, originalEnv);
    if (root !== "") {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("R1: a bare { node } dry run reports the held resident skipped MinResidency", async () => {
    // kills: the router path losing the min-residency hold — on base the row
    // comes back would-evict.
    const evict = evictIdleCaller();
    const result = await evict({ node: LOCAL_NODE });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: IDLE_SECONDS });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "MinResidency",
    });
  });

  test("R2: a targeted wet call skips MinResidency and stops nothing", async () => {
    // kills: the router wet path evicting a resident still inside
    // minResidencySeconds — on base the fenced stop walks the row to
    // downloaded and commits the lease unload, so no pid or sidecar stop may
    // happen here.
    const evict = evictIdleCaller();
    const result = await evict({
      node: LOCAL_NODE,
      targets: [{ workload: "w1", kind: "modelrun" }],
    });
    expect(result).toMatchObject({ ok: true, dryRun: false, windowSeconds: IDLE_SECONDS });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "MinResidency",
    });
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
  });
});
