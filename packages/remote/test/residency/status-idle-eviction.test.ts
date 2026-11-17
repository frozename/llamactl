// #519: idleEviction status read-out. `buildResidencyStatus` gains `nowMs`
// and `servingNode` inputs and an `idleEviction` section that reports, per
// ready residency_states row on the serving node, when the workload went
// idle (the later of ready-since and the lease registry's last activity),
// whether it is due for eviction under NodeRun `idleEvictSeconds`, and why
// the section is unavailable when it cannot answer. The section is advisory
// only — status, never enforcement. At the pinned base the inputs and the
// section do not exist, so every case fails BY ASSERTION on the structural
// probe — never by import or type error.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import {
  createResidencyLeases,
  type ResidencyAuditEntry,
  type ResidencySnapshot,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun, NodeRunResidency } from "../../src/workload/noderun-schema.js";

import { buildResidencyStatus, type ResidencyStatus } from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

// The idleEviction contract the assertions pin, described structurally so the
// file typechecks on both sides of the fix.
type IdleEvictionWorkload = {
  workload: string;
  readySinceMs: number;
  lastActivityAtMs: number | null;
  idleSinceMs: number | null;
  activeLeaseCount: number;
  dueAtMs: number | null;
  due: boolean;
};

type IdleEvictionSection =
  | { status: "disabled"; scope: "serving-process" }
  | { status: "unavailable"; scope: "serving-process"; reason: string }
  | {
      status: "available";
      scope: "serving-process";
      advisory: boolean;
      idleEvictSeconds: number;
      workloads: IdleEvictionWorkload[];
    };

type StatusInput = Parameters<typeof buildResidencyStatus>[0] & {
  nowMs?: number;
  servingNode?: string | null;
};

type FakeLeaseRegistry = {
  snapshot: (workload: string) => ResidencySnapshot;
  audit: () => ResidencyAuditEntry[];
  lastActivityAtMs?: (workload: string) => number;
};

const NODE = "n";
const IDLE_SECONDS = 300;

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-idle-eviction-"));
  storePath = join(tmp, "residency-state", "operations.sqlite");
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  tmp = "";
});

function nodeRunManifest(residency?: NodeRunResidency): NodeRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: NODE, labels: {} },
    spec: {
      node: NODE,
      infra: [],
      ...(residency !== undefined ? { residency } : {}),
    },
  };
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

function fakeLeaseRegistry(opts?: {
  phase?: ResidencySnapshot["phase"];
  active?: readonly string[];
  activityAtMs?: number | ((workload: string) => number);
  withActivity?: boolean;
  onActivity?: () => void;
}): FakeLeaseRegistry {
  const phase = opts?.phase ?? "open";
  const active = opts?.active ?? [];
  const activity = opts?.activityAtMs ?? 0;
  const onActivity = opts?.onActivity;
  const registry: FakeLeaseRegistry = {
    snapshot: (workload) => ({
      workload,
      phase,
      epoch: 0,
      active: [...active],
      waiters: 0,
    }),
    audit: () => [],
  };
  if (opts?.withActivity !== false) {
    registry.lastActivityAtMs = (workload: string): number => {
      onActivity?.();
      return typeof activity === "function" ? activity(workload) : activity;
    };
  }
  return registry;
}

function buildStatus(input: {
  nodeRun?: NodeRun | undefined;
  store?: ResidencyStoreSnapshot;
  leaseRegistry?: FakeLeaseRegistry | null;
  nowMs: number;
  servingNode?: string | null;
}): ResidencyStatus {
  const statusInput: StatusInput = {
    node: NODE,
    nodeRun: input.nodeRun,
    budgetGiB: 10,
    budgetSource: "computed",
    store: input.store ?? { path: "/p", present: false },
    leaseRegistry: input.leaseRegistry ?? null,
    nowMs: input.nowMs,
    servingNode: input.servingNode === undefined ? NODE : input.servingNode,
  };
  return buildResidencyStatus(statusInput);
}

function idleEvictionOf(status: ResidencyStatus): IdleEvictionSection | undefined {
  return (status as unknown as { idleEviction?: IdleEvictionSection }).idleEviction;
}

function idleWorkloads(status: ResidencyStatus): IdleEvictionWorkload[] {
  const idle = idleEvictionOf(status);
  return idle?.status === "available" ? idle.workloads : [];
}

function seedReadyRow(model: string): void {
  const writer = openResidencyOperationStore({ path: storePath });
  try {
    const fence = writer.claimOwnership({ ownerId: "t", incarnation: "i" });
    let version = 0;
    for (const [index, to] of (["downloaded", "loading", "warming", "ready"] as const).entries()) {
      const result = writer.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        to,
        expectedVersion: version,
        nowMs: 1000 + index,
      });
      if (!result.ok) {
        throw new Error(`transitionResidencyState ${model} -> ${to} refused: ${result.reason}`);
      }
      version = result.record.version;
    }
  } finally {
    writer.close();
  }
}

describe("buildResidencyStatus idleEviction (#519)", () => {
  test("I1: a nodeRun without spec.residency reports idleEviction disabled", () => {
    // Kills: the idleEviction section being omitted entirely.
    const built = buildStatus({ nodeRun: nodeRunManifest(), nowMs: 0 });
    expect(idleEvictionOf(built)).toEqual({ status: "disabled", scope: "serving-process" });
  });

  test("I2: idleEvictSeconds 0 is disabled even off-node without a registry", () => {
    // Kills: treating 0 as enabled, or checking serving scope before
    // disabled.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: 0 }),
      nowMs: 0,
      servingNode: null,
      leaseRegistry: null,
    });
    expect(idleEvictionOf(built)).toEqual({ status: "disabled", scope: "serving-process" });
  });

  test("I3: a ready idle row reports dueAtMs and flips due at the threshold", () => {
    // Kills: `>` instead of `>=` on the due check, or a missing
    // seconds-to-ms factor.
    const store = storeWithLifecycle([lifecycleRow("w", "ready", 0)]);
    const registry = fakeLeaseRegistry({ activityAtMs: 0 });
    const before = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store,
      leaseRegistry: registry,
      nowMs: 299_999,
    });
    expect(idleEvictionOf(before)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      idleEvictSeconds: IDLE_SECONDS,
      workloads: [
        {
          workload: "w",
          readySinceMs: 0,
          lastActivityAtMs: 0,
          idleSinceMs: 0,
          activeLeaseCount: 0,
          dueAtMs: 300_000,
          due: false,
        },
      ],
    });
    const at = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store,
      leaseRegistry: registry,
      nowMs: 300_000,
    });
    expect(idleWorkloads(at)).toEqual([
      {
        workload: "w",
        readySinceMs: 0,
        lastActivityAtMs: 0,
        idleSinceMs: 0,
        activeLeaseCount: 0,
        dueAtMs: 300_000,
        due: true,
      },
    ]);
  });

  test("I4: lease activity later than ready-since moves idleSinceMs", () => {
    // Kills: idleSinceMs derived from readySinceMs only (ignoring lease
    // activity).
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle([lifecycleRow("w", "ready", 0)]),
      leaseRegistry: fakeLeaseRegistry({ activityAtMs: 200_000 }),
      nowMs: 300_000,
    });
    expect(idleWorkloads(built)).toEqual([
      {
        workload: "w",
        readySinceMs: 0,
        lastActivityAtMs: 200_000,
        idleSinceMs: 200_000,
        activeLeaseCount: 0,
        dueAtMs: 500_000,
        due: false,
      },
    ]);
  });

  test("I5: an active lease past the idle threshold is not due", () => {
    // Kills: dropping the activeLeaseCount gate on due.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle([lifecycleRow("w", "ready", 0)]),
      leaseRegistry: fakeLeaseRegistry({ activityAtMs: 0, active: ["w#1"] }),
      nowMs: 400_000,
    });
    expect(idleWorkloads(built)).toEqual([
      {
        workload: "w",
        readySinceMs: 0,
        lastActivityAtMs: 0,
        idleSinceMs: 0,
        activeLeaseCount: 1,
        dueAtMs: 300_000,
        due: false,
      },
    ]);
  });

  test("I6: a draining or unloaded lease phase is not due", () => {
    // Kills: dropping the lease phase check on due.
    for (const phase of ["draining", "unloaded"] as const) {
      const built = buildStatus({
        nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
        store: storeWithLifecycle([lifecycleRow("w", "ready", 0)]),
        leaseRegistry: fakeLeaseRegistry({ activityAtMs: 0, phase }),
        nowMs: 400_000,
      });
      expect(idleWorkloads(built)).toEqual([
        {
          workload: "w",
          readySinceMs: 0,
          lastActivityAtMs: 0,
          idleSinceMs: 0,
          activeLeaseCount: 0,
          dueAtMs: 300_000,
          due: false,
        },
      ]);
    }
  });

  test("I7: only ready lifecycle rows are listed, sorted by workload", () => {
    // Kills: listing non-ready rows (loading/draining/cold/failed and the
    // rest), or emitting them unsorted. "cold" has no residency_states
    // state; the downloaded/unavailable rows cover the not-resident case.
    const lifecycle = [
      lifecycleRow("b-ready", "ready", 0),
      lifecycleRow("loading-row", "loading", 0),
      lifecycleRow("draining-row", "draining", 0),
      lifecycleRow("cold-row", "downloaded", 0),
      lifecycleRow("failed-row", "failed", 0),
      lifecycleRow("a-ready", "ready", 0),
      lifecycleRow("warming-row", "warming", 0),
      lifecycleRow("unloading-row", "unloading", 0),
      lifecycleRow("unavailable-row", "unavailable", 0),
    ];
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle(lifecycle),
      leaseRegistry: fakeLeaseRegistry({ activityAtMs: 0 }),
      nowMs: 0,
    });
    expect(idleWorkloads(built).map((w) => w.workload)).toEqual(["a-ready", "b-ready"]);
  });

  test("I8a: off the serving node the section is unavailable NotServingNode", () => {
    // Kills: the missing servingNode === node gate (applying node B's policy
    // and rows to node A), and calling lastActivityAtMs before the gate.
    let activityCalls = 0;
    const registry = fakeLeaseRegistry({
      activityAtMs: 0,
      onActivity: () => {
        activityCalls += 1;
      },
    });
    const store = storeWithLifecycle([lifecycleRow("w", "ready", 0)]);
    for (const servingNode of [null, "other"] as const) {
      const built = buildStatus({
        nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
        store,
        leaseRegistry: registry,
        nowMs: 0,
        servingNode,
      });
      expect(idleEvictionOf(built)).toEqual({
        status: "unavailable",
        scope: "serving-process",
        reason: "NotServingNode",
      });
    }
    expect(activityCalls).toBe(0);
  });

  test("I8b: on the serving node without a lease registry the section is LeasesUnavailable", () => {
    // Kills: treating a missing registry as empty activity, or checking the
    // store before the registry.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle([lifecycleRow("w", "ready", 0)]),
      leaseRegistry: null,
      nowMs: 0,
    });
    expect(idleEvictionOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "LeasesUnavailable",
    });
  });

  test("I8c: store and lifecycle read failures map to their reasons", () => {
    // Kills: collapsing store/lifecycle read failures into available-empty
    // or the wrong reason.
    const registry = fakeLeaseRegistry({ activityAtMs: 0 });
    const errored = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: { path: "/p", present: true, error: "boom" },
      leaseRegistry: registry,
      nowMs: 0,
    });
    expect(idleEvictionOf(errored)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "StoreUnreadable",
    });
    const lifecycleErrored = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: { path: "/p", present: true, nonterminal: [], lifecycleError: "lifecycle boom" },
      leaseRegistry: registry,
      nowMs: 0,
    });
    expect(idleEvictionOf(lifecycleErrored)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "LifecycleUnreadable",
    });
  });

  test("I8d: precedence is serving-node, then registry, then store, then lifecycle", () => {
    // Kills: a wrong precedence order between the unavailable reasons. The
    // snapshot union cannot carry error and lifecycleError together, so the
    // both-bad probe is cast structurally.
    const storeError: ResidencyStoreSnapshot = { path: "/p", present: true, error: "boom" };
    const bothBad = {
      path: "/p",
      present: true,
      nonterminal: [],
      error: "store boom",
      lifecycleError: "lifecycle boom",
    } as unknown as ResidencyStoreSnapshot;
    const residency = nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS });

    expect(
      idleEvictionOf(
        buildStatus({
          nodeRun: residency,
          store: storeError,
          leaseRegistry: null,
          nowMs: 0,
          servingNode: null,
        }),
      ),
    ).toEqual({ status: "unavailable", scope: "serving-process", reason: "NotServingNode" });
    expect(
      idleEvictionOf(
        buildStatus({
          nodeRun: residency,
          store: storeError,
          leaseRegistry: null,
          nowMs: 0,
        }),
      ),
    ).toEqual({ status: "unavailable", scope: "serving-process", reason: "LeasesUnavailable" });
    expect(
      idleEvictionOf(
        buildStatus({
          nodeRun: residency,
          store: bothBad,
          leaseRegistry: fakeLeaseRegistry({ activityAtMs: 0 }),
          nowMs: 0,
        }),
      ),
    ).toEqual({ status: "unavailable", scope: "serving-process", reason: "StoreUnreadable" });
  });

  test("I8e: an absent store is available with no workloads", () => {
    // Kills: treating an absent store as unreadable or unknown-idle.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: { path: "/p", present: false },
      leaseRegistry: fakeLeaseRegistry({ activityAtMs: 0 }),
      nowMs: 0,
    });
    expect(idleEvictionOf(built)).toEqual({
      status: "available",
      scope: "serving-process",
      advisory: true,
      idleEvictSeconds: IDLE_SECONDS,
      workloads: [],
    });
  });

  test("I9: a registry without lastActivityAtMs yields null activity fields", () => {
    // Kills: falling back to readySinceMs when lease activity is unknown.
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle([lifecycleRow("w", "ready", 0)]),
      leaseRegistry: fakeLeaseRegistry({ withActivity: false }),
      nowMs: 400_000,
    });
    expect(idleWorkloads(built)).toEqual([
      {
        workload: "w",
        readySinceMs: 0,
        lastActivityAtMs: null,
        idleSinceMs: null,
        activeLeaseCount: 0,
        dueAtMs: null,
        due: false,
      },
    ]);
  });

  test("I10: future-dated ready and activity stamps clamp idleSinceMs to nowMs", () => {
    // Kills: a missing clamp letting a future stamp push idleSinceMs and
    // dueAtMs out.
    const nowMs = 300_000;
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle([lifecycleRow("w", "ready", nowMs + 5_000)]),
      leaseRegistry: fakeLeaseRegistry({ activityAtMs: nowMs + 9_000 }),
      nowMs,
    });
    const row = idleWorkloads(built)[0];
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      workload: "w",
      idleSinceMs: nowMs,
      dueAtMs: nowMs + 300_000,
      due: false,
    });
    expect(Number.isFinite(row?.readySinceMs)).toBe(true);
    expect(Number.isFinite(row?.lastActivityAtMs)).toBe(true);
  });

  test("I11: a ready row with NaN updatedAtMs is not listed", () => {
    // Kills: a missing Number.isFinite filter emitting NaN dueAtMs (matches
    // recordedReadySinceMs in procedures.ts).
    const built = buildStatus({
      nodeRun: nodeRunManifest({ idleEvictSeconds: IDLE_SECONDS }),
      store: storeWithLifecycle([
        lifecycleRow("nan-ready", "ready", Number.NaN),
        lifecycleRow("fine-ready", "ready", 0),
      ]),
      leaseRegistry: fakeLeaseRegistry({ activityAtMs: 0 }),
      nowMs: 0,
    });
    expect(idleWorkloads(built).map((w) => w.workload)).toEqual(["fine-ready"]);
  });
});

describe("residencyStatus idleEviction router wiring (#519)", () => {
  test("I12: residencyStatus forwards registry activity into idleEviction", async () => {
    // Kills: the router auditSource wrapper dropping lastActivityAtMs, and
    // the procedure not passing servingNode/nowMs through.
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "idle-node", labels: {} },
        spec: { node: "idle-node", residency: { idleEvictSeconds: IDLE_SECONDS }, infra: [] },
      },
      tmp,
    );
    seedReadyRow("idle-model");
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    process.env["LLAMACTL_NODE_NAME"] = "idle-node";
    try {
      const res = await router.createCaller({}).residencyStatus({ node: "idle-node" });
      const idle = idleEvictionOf(res);
      expect(idle?.status).toBe("available");
      const workloads = idle?.status === "available" ? idle.workloads : [];
      const row = workloads.find((w) => w.workload === "idle-model");
      expect(row).toBeDefined();
      const probe = registry as unknown as {
        lastActivityAtMs?: (workload: string) => number;
      };
      expect(typeof probe.lastActivityAtMs).toBe("function");
      expect(row?.lastActivityAtMs).toBe(probe.lastActivityAtMs!("idle-model"));
      expect(typeof row?.lastActivityAtMs).toBe("number");
      if (idle?.status === "available") {
        expect(idle.idleEvictSeconds).toBe(IDLE_SECONDS);
      }
    } finally {
      Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
    }
  });

  test("I13: residencyStatus reports NotServingNode without LLAMACTL_NODE_NAME", async () => {
    // Kills: the router not passing servingNode through to the status
    // builder.
    Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "idle-node", labels: {} },
        spec: { node: "idle-node", residency: { idleEvictSeconds: IDLE_SECONDS }, infra: [] },
      },
      tmp,
    );
    seedReadyRow("idle-model");
    setResidencyLeaseRegistry(createResidencyLeases());
    const res = await router.createCaller({}).residencyStatus({ node: "idle-node" });
    expect(idleEvictionOf(res)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "NotServingNode",
    });
  });
});
