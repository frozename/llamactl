// #520: session protection must surface in the idleEviction status read-out.
// An idle-due ready row consults the session registry without releasing
// sessions: active bindings hold the row as SessionsActive with their ids, a
// throwing registry holds it as SessionsUnknown, and neither variant carries
// the mutable eviction detail key. Rows that are not idle-due never consult
// the registry. At the pinned base buildIdleEvictionSnapshot has no sessions
// input, so R1-R4 fail BY ASSERTION — never by an import or type error.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import {
  createResidencyLeases,
  type ResidencyAuditEntry,
  type ResidencySnapshot,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun } from "../../src/workload/noderun-schema.js";

import * as procedures from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

// The session-hold contract the assertions pin, described structurally so the
// file typechecks on both sides of the fix. The status row carries the hold,
// never a mutable detail field.
type SessionHold = {
  reason: "SessionsActive" | "SessionsUnknown";
  sessions: string[];
};

type IdleEvictionSnapshotRow = {
  workload: string;
  readySinceMs: number;
  lastActivityAtMs: number | null;
  idleSinceMs: number | null;
  activeLeaseCount: number;
  dueAtMs: number | null;
  due: boolean;
  minResidencyUntilMs?: number;
  sessionHold?: SessionHold;
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

type SessionCheck =
  | { ok: true; released: string[] }
  | { ok: false; reason: "SessionActive"; sessions: string[] };

type SessionProbe = {
  checkUnload: (workload: string, opts?: { force?: boolean }) => SessionCheck;
};

type BuildIdleEvictionInput = {
  residency: ResidencyKnobs | null | undefined;
  servingNode: string | null;
  node: string;
  store: ResidencyStoreSnapshot;
  leaseRegistry: FakeLeaseRegistry | null;
  nowMs: number;
  sessions?: SessionProbe | null | undefined;
};

type BuildIdleEvictionSnapshot = (input: BuildIdleEvictionInput) => IdleEvictionSnapshot;

type IdleEvictKind = "modelrun" | "modelhost";

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

const NODE = "n1";
const WORKLOAD = "wl-a";
const T0_MS = 1_000_000;
const IDLE_SECONDS = 60;
const IDLE_DUE_AT_MS = T0_MS + IDLE_SECONDS * 1000;
const NOW_MS = T0_MS + 120_000;
const ROUTER_AGE_MS = 120_000;

function buildSnapshot(input: BuildIdleEvictionInput): IdleEvictionSnapshot {
  const build = procedures.buildIdleEvictionSnapshot as unknown as BuildIdleEvictionSnapshot;
  return build(input);
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

function readyRow(model: string = WORKLOAD, updatedAtMs: number = T0_MS): ResidencyStateRecord {
  return lifecycleRow(model, "ready", updatedAtMs);
}

function storeWithLifecycle(lifecycle: ResidencyStateRecord[]): ResidencyStoreSnapshot {
  return { path: "/p", present: true, nonterminal: [], lifecycle };
}

function fakeLeaseRegistry(opts?: { activityAtMs?: number }): FakeLeaseRegistry {
  const activityAtMs = opts?.activityAtMs ?? T0_MS;
  return {
    snapshot: (workload) => ({
      workload,
      phase: "open",
      epoch: 0,
      active: [],
      waiters: 0,
    }),
    audit: () => [],
    lastActivityAtMs: () => activityAtMs,
  };
}

function snapshotInput(
  opts: {
    residency?: ResidencyKnobs;
    lifecycle?: ResidencyStateRecord[];
    nowMs?: number;
    sessions?: SessionProbe | null;
  } = {},
): BuildIdleEvictionInput {
  return {
    residency: opts.residency ?? { idleEvictSeconds: IDLE_SECONDS },
    servingNode: NODE,
    node: NODE,
    store: storeWithLifecycle(opts.lifecycle ?? [readyRow()]),
    leaseRegistry: fakeLeaseRegistry(),
    nowMs: opts.nowMs ?? NOW_MS,
    ...(opts.sessions !== undefined ? { sessions: opts.sessions } : {}),
  };
}

function rowsOf(snapshot: IdleEvictionSnapshot): IdleEvictionSnapshotRow[] {
  if (snapshot.status !== "available") {
    throw new Error(`expected an available idleEviction snapshot, got ${snapshot.status}`);
  }
  return snapshot.workloads;
}

function onlyRow(snapshot: IdleEvictionSnapshot): IdleEvictionSnapshotRow {
  const rows = rowsOf(snapshot);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one idleEviction snapshot row");
  }
  return row;
}

function rowForInput(input: BuildIdleEvictionInput): IdleEvictionSnapshotRow {
  return onlyRow(buildSnapshot(input));
}

function okSessions(): SessionProbe {
  return {
    checkUnload: () => ({ ok: true, released: [] }),
  };
}

function idleRowFromStatus(status: unknown, workload: string): IdleEvictionSnapshotRow {
  const idle = (status as { idleEviction?: IdleEvictionSnapshot }).idleEviction;
  expect(idle?.status).toBe("available");
  const rows = idle?.status === "available" ? idle.workloads : [];
  const row = rows.find((candidate) => candidate.workload === workload);
  if (row === undefined) {
    throw new Error(`expected an idleEviction row for ${workload}`);
  }
  return row;
}

function evictRow(
  result: IdleEvictionRunResult,
  workload: string,
): IdleEvictionResultRow | undefined {
  return result.ok ? result.rows.find((row) => row.workload === workload) : undefined;
}

function nodeRunManifest(): NodeRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: NODE, labels: {} },
    spec: {
      node: NODE,
      residency: { idleEvictSeconds: IDLE_SECONDS },
      infra: [],
    },
  };
}

describe("#520 residency status idle-evict session hold", () => {
  test("R1: an idle-due row is held SessionsActive without changing dueAtMs", () => {
    // kills: the snapshot never consulting the session registry.
    const sessions: SessionProbe = {
      checkUnload: (workload) =>
        workload === WORKLOAD
          ? { ok: false, reason: "SessionActive", sessions: ["s1", "s2"] }
          : { ok: true, released: [] },
    };
    const row = rowForInput(snapshotInput({ sessions }));
    expect(row.due).toBe(false);
    expect(row.sessionHold).toEqual({ reason: "SessionsActive", sessions: ["s1", "s2"] });
    expect(row.dueAtMs).toBe(IDLE_DUE_AT_MS);
    expect("detail" in row).toBe(false);
  });

  test("R2: a throwing session registry holds the row SessionsUnknown", () => {
    // kills: a throwing registry treated as clear, or the throw propagated.
    const sessions: SessionProbe = {
      checkUnload: () => {
        throw new Error("registry down");
      },
    };
    const row = rowForInput(snapshotInput({ sessions }));
    expect(row.due).toBe(false);
    expect(row.sessionHold).toEqual({ reason: "SessionsUnknown", sessions: [] });
  });

  test("R3: buildResidencyStatus forwards the session registry without releasing s1", () => {
    // kills: buildResidencyStatus not forwarding sessionRegistry, and
    // checkUnload being called with force:true (which would release s1).
    const sessionRegistry = createSessionRefcounts({
      idleTimeoutMs: 600_000,
      now: () => NOW_MS,
    });
    const acquired = sessionRegistry.acquire("s1", WORKLOAD);
    if (!acquired.ok) {
      throw new Error("acquire(s1) refused");
    }
    sessionRegistry.release("s1", acquired.generation);

    const built = procedures.buildResidencyStatus({
      node: NODE,
      nodeRun: nodeRunManifest(),
      budgetGiB: 10,
      budgetSource: "computed",
      store: storeWithLifecycle([readyRow()]),
      leaseRegistry: fakeLeaseRegistry(),
      sessionRegistry,
      nowMs: NOW_MS,
      servingNode: NODE,
    });
    const row = idleRowFromStatus(built, WORKLOAD);
    expect(row.due).toBe(false);
    expect(row.sessionHold).toEqual({ reason: "SessionsActive", sessions: ["s1"] });
    const snapshot = sessionRegistry.snapshot?.();
    expect(snapshot?.sessions.map((session) => session.sessionId)).toEqual(["s1"]);
  });

  test("G1: a clear session registry leaves the due row byte-identical", () => {
    // Guard, passes on base: sessions that check clean do not change the row.
    const withSessions = rowForInput(snapshotInput({ sessions: okSessions() }));
    const withoutSessions = rowForInput(snapshotInput());
    expect(withSessions).toEqual(withoutSessions);
    expect(withSessions.due).toBe(true);
    expect("sessionHold" in withSessions).toBe(false);
  });

  test("G2: a row inside its idle window never consults sessions", () => {
    // Guard, passes on base: the probe is only for idle-due rows.
    let calls = 0;
    const sessions: SessionProbe = {
      checkUnload: () => {
        calls += 1;
        return { ok: false, reason: "SessionActive", sessions: ["s1"] };
      },
    };
    const row = rowForInput(snapshotInput({ nowMs: T0_MS + 30_000, sessions }));
    expect(row.due).toBe(false);
    expect("sessionHold" in row).toBe(false);
    expect(calls).toBe(0);
  });

  test("G3: a MinResidency-held row keeps its hold and never consults sessions", () => {
    // Guard, passes on base: min-residency remains the reason the row is held.
    let calls = 0;
    const sessions: SessionProbe = {
      checkUnload: () => {
        calls += 1;
        return { ok: false, reason: "SessionActive", sessions: ["s1"] };
      },
    };
    const row = rowForInput(
      snapshotInput({
        residency: { idleEvictSeconds: IDLE_SECONDS, minResidencySeconds: 600 },
        sessions,
      }),
    );
    expect(row.minResidencyUntilMs).toBe(T0_MS + 600_000);
    expect(row.due).toBe(false);
    expect("sessionHold" in row).toBe(false);
    expect(calls).toBe(0);
  });

  test("G4: sessions null or undefined gives a byte-identical row", () => {
    // Guard, passes on base: absence, null and undefined are one no-probe case.
    const baseline = rowForInput(snapshotInput());
    const withNull = rowForInput(snapshotInput({ sessions: null }));
    const withUndefined = rowForInput({
      ...snapshotInput(),
      sessions: undefined,
    });
    expect(withNull).toEqual(baseline);
    expect(withUndefined).toEqual(baseline);
  });
});

describe("#520 residency status idle-evict session hold router wiring", () => {
  const originalEnv = { ...process.env };
  let root = "";
  let workloadsDir = "";
  let storePath = "";

  beforeEach(() => {
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(null);
    root = mkdtempSync(join(tmpdir(), "llamactl-idle-status-session-hold-"));
    workloadsDir = join(root, "workloads");
    storePath = join(root, "residency", "operations.sqlite");
    mkdirSync(workloadsDir, { recursive: true });
    Object.assign(process.env, {
      DEV_STORAGE: join(root, "dev"),
      LLAMACTL_CONFIG: join(root, "config-missing"),
      LLAMACTL_NODE_NAME: NODE,
      LLAMACTL_RESIDENCY_STORE: storePath,
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
    });
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

  function seedReadyRouterRow(model: string, nowMs: number): void {
    const store = openResidencyOperationStore({ path: storePath });
    try {
      const fence = store.claimOwnership({ ownerId: "router-test", incarnation: "seed" });
      let version = 0;
      for (const to of ["downloaded", "loading", "warming", "ready"] as const) {
        const result = store.transitionResidencyState({
          fenceToken: fence.fenceToken,
          model,
          ...(to === "loading" ? { group: "z13-large-gpu" } : {}),
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

  function installRouterFixture(sessions: SessionRefcounts): void {
    saveNodeRun(nodeRunManifest(), workloadsDir);
    const oldMs = Date.now() - ROUTER_AGE_MS;
    seedReadyRouterRow(WORKLOAD, oldMs);
    setResidencyLeaseRegistry(createResidencyLeases({ now: () => oldMs }));
    setSessionRefcountRegistry(sessions);
  }

  function idleBoundSessions(): SessionRefcounts {
    const registry = createSessionRefcounts({ idleTimeoutMs: 600_000 });
    const acquired = registry.acquire("s1", WORKLOAD);
    if (!acquired.ok) {
      throw new Error("acquire(s1) refused");
    }
    registry.release("s1", acquired.generation);
    return registry;
  }

  function throwingSessions(): SessionRefcounts {
    const real = createSessionRefcounts({ idleTimeoutMs: 600_000 });
    return {
      ...real,
      checkUnload: (): never => {
        throw new Error("registry down");
      },
    };
  }

  function caller(): {
    residencyStatus: (input: { node: string }) => Promise<unknown>;
    residencyEvictIdle: (input: { node: string }) => Promise<IdleEvictionRunResult>;
  } {
    return router.createCaller({});
  }

  test("R4: residencyStatus carries SessionsActive for the idle-bound workload", async () => {
    // kills: the router path not carrying the hold.
    installRouterFixture(idleBoundSessions());
    const status = await caller().residencyStatus({ node: NODE });
    const row = idleRowFromStatus(status, WORKLOAD);
    expect(row.due).toBe(false);
    expect(row.sessionHold).toEqual({ reason: "SessionsActive", sessions: ["s1"] });
  });

  test("G5: residencyEvictIdle still reports SessionsActive rather than NotDue", async () => {
    // Guard, passes on base: kills passing sessions into the residencyEvictIdle
    // snapshot call, which would hide the due row behind NotDue.
    installRouterFixture(idleBoundSessions());
    const result = await caller().residencyEvictIdle({ node: NODE });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: IDLE_SECONDS });
    expect(evictRow(result, WORKLOAD)).toMatchObject({
      workload: WORKLOAD,
      action: "skipped",
      reason: "SessionsActive",
    });
  });

  test("G7: residencyEvictIdle preserves the SessionsUnknown error detail", async () => {
    // Guard, passes on base: kills a shared helper that drops the error text.
    installRouterFixture(throwingSessions());
    const result = await caller().residencyEvictIdle({ node: NODE });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: IDLE_SECONDS });
    expect(evictRow(result, WORKLOAD)).toMatchObject({
      workload: WORKLOAD,
      action: "skipped",
      reason: "SessionsUnknown",
    });
    expect(evictRow(result, WORKLOAD)?.detail ?? "").toContain("registry down");
  });
});
