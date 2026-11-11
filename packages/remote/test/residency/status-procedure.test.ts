// #284 (DF-11): residencyStatus is a read-only tRPC query landing with
// the fix. The procedures module does not exist at the pinned base and
// the router has no residencyStatus procedure, so both seams are probed
// through guarded dynamic imports and an untyped _def lookup — every
// case fails by assertion, never by a missing module or a type error.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "../../src/safe-fs.js";
import { defaultNodeBudgetGiB } from "../../src/workload/admission.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

const STORE_MODULE = "../../src/residency/store.js";
const PROC_MODULE = "../../src/residency/procedures.js";

type OperationPhase = "pending" | "committed" | "terminal";
type OperationOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
type FailureReason =
  | "stale-fence"
  | "version-conflict"
  | "not-found"
  | "duplicate-conflict"
  | "reservation-conflict"
  | "illegal-phase"
  | "invalid-input";

type Fence = {
  ownerId: string;
  incarnation: string;
  fenceToken: number;
};

type OperationRecord = {
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  phase: OperationPhase;
  outcome: OperationOutcome | null;
  detail: string | null;
  ownerId: string;
  incarnation: string;
  fenceToken: number;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type BeginOperationInput = {
  fenceToken: number;
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  nowMs: number;
};

type MutationInput = {
  fenceToken: number;
  operationId: string;
  expectedVersion: number;
  nowMs: number;
};

type FinishOperationInput = MutationInput & {
  outcome: OperationOutcome;
  detail?: string;
};

type BeginOperationResult =
  | { ok: true; created: boolean; record: OperationRecord }
  | { ok: false; reason: FailureReason };

type MutationResult = { ok: true } | { ok: false; reason: FailureReason };

type WriterStore = {
  claimOwnership: (input: { ownerId: string; incarnation: string }) => Fence;
  currentFence: () => Fence | null;
  beginOperation: (input: BeginOperationInput) => BeginOperationResult;
  commitReservation: (input: MutationInput) => MutationResult;
  finishOperation: (input: FinishOperationInput) => MutationResult;
  getOperation: (operationId: string) => OperationRecord | null;
  close: () => void;
};

type NonterminalOperation = {
  operationId: string;
  model: string;
  phase: string;
  targetState: string;
  reservationGiB: number;
};

type StoreProbe =
  | { path: string; present: false }
  | {
      path: string;
      present: true;
      nonterminalCount: number;
      nonterminal: NonterminalOperation[];
    }
  | { path: string; present: true; error: string };

type ResidencyStatus = {
  node: string;
  nodeRun: { present: boolean };
  policy: { present: false } | { present: true; residency: unknown };
  budget: { memoryGiB: number; source: "noderun" | "computed" };
  store: StoreProbe & { scope: "serving-process" };
};

type BuildInput = {
  node: string;
  nodeRun: unknown;
  budgetGiB: number;
  budgetSource: "noderun" | "computed";
  store: StoreProbe;
};

type StoreModule = {
  openResidencyOperationStore: (input: { path: string }) => WriterStore;
  defaultResidencyStorePath: (env?: Record<string, string | undefined>) => string;
};

type ProcModule = {
  buildResidencyStatus: (input: BuildInput) => ResidencyStatus;
};

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-status-"));
  storePath = join(tmp, "residency-state", "operations.sqlite");
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

async function loadStore(): Promise<StoreModule | null> {
  try {
    return (await import(STORE_MODULE)) as StoreModule;
  } catch {
    return null;
  }
}

async function loadProc(): Promise<ProcModule | null> {
  try {
    return (await import(PROC_MODULE)) as ProcModule;
  } catch {
    return null;
  }
}

async function requireStoreModule(): Promise<StoreModule> {
  const mod = await loadStore();
  expect(typeof mod?.openResidencyOperationStore).toBe("function");
  expect(typeof mod?.defaultResidencyStorePath).toBe("function");
  return mod!;
}

async function requireProcModule(): Promise<ProcModule> {
  const mod = await loadProc();
  expect(typeof mod?.buildResidencyStatus).toBe("function");
  return mod!;
}

async function status(node: string): Promise<ResidencyStatus> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyStatus");
  const caller = router.createCaller({}) as unknown as {
    residencyStatus: (input: { node: string }) => Promise<ResidencyStatus>;
  };
  return await caller.residencyStatus({ node });
}

function opVersion(writer: WriterStore, operationId: string): number {
  const record = writer.getOperation(operationId);
  if (record === null) {
    throw new Error(`expected residency operation ${operationId} to exist`);
  }
  return record.version;
}

function nonterminalStore(store: ResidencyStatus["store"]): {
  nonterminalCount: number;
  nonterminal: NonterminalOperation[];
} {
  if (store.present && "nonterminal" in store) {
    return { nonterminalCount: store.nonterminalCount, nonterminal: store.nonterminal };
  }
  throw new Error("residencyStatus store must expose the nonterminal listing");
}

function storeError(store: ResidencyStatus["store"]): string {
  if (store.present && "error" in store) {
    return store.error;
  }
  throw new Error("residencyStatus store must expose an error for an unmigrated file");
}

describe("residencyStatus", () => {
  test("inert default: no NodeRun, no store file, no writes", async () => {
    const before = readdirSync(tmp).sort();
    const r = await status("local");
    expect(r.node).toBe("local");
    expect(r.nodeRun.present).toBe(false);
    expect(r.policy).toEqual({ present: false });
    expect(r.budget).toEqual({
      memoryGiB: defaultNodeBudgetGiB(undefined),
      source: "computed",
    });
    expect(r.store).toEqual({
      path: storePath,
      present: false,
      scope: "serving-process",
    });
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
    expect(readdirSync(tmp).sort()).toEqual(before);
  });

  test("policy and budget come from the named NodeRun", async () => {
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "local", labels: {} },
        spec: {
          node: "local",
          budget: { memoryGiB: 36 },
          residency: { safetyMarginRatio: 0.5, idleEvictSeconds: 600 },
          infra: [],
        },
      },
      tmp,
    );
    const r = await status("local");
    expect(r.nodeRun.present).toBe(true);
    expect(r.policy).toEqual({
      present: true,
      residency: { safetyMarginRatio: 0.5, idleEvictSeconds: 600 },
    });
    expect(r.budget).toEqual({ memoryGiB: 36, source: "noderun" });

    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "studio", labels: {} },
        spec: { node: "studio", residency: { idleEvictSeconds: 300 }, infra: [] },
      },
      tmp,
    );
    const s = await status("studio");
    expect(s.nodeRun.present).toBe(true);
    expect(s.policy.present).toBe(true);
    expect(s.budget).toEqual({
      memoryGiB: defaultNodeBudgetGiB(undefined),
      source: "computed",
    });
  });

  test("NodeRun lookup is by metadata.name and store provenance is explicit", async () => {
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "studio", labels: {} },
        spec: { node: "other-host", budget: { memoryGiB: 20 }, infra: [] },
      },
      tmp,
    );
    const s = await status("studio");
    expect(s.budget).toEqual({ memoryGiB: 20, source: "noderun" });
    const o = await status("other-host");
    expect(o.nodeRun.present).toBe(false);
    expect(o.budget.source).toBe("computed");
    expect(s.store).toEqual(o.store);
    expect(s.store.scope).toBe("serving-process");
  });

  test("live writer: uncheckpointed WAL rows are visible and the fence is untouched", async () => {
    const storeMod = await loadStore();
    expect(typeof storeMod?.openResidencyOperationStore).toBe("function");
    const writer = storeMod!.openResidencyOperationStore({ path: storePath });
    try {
      const fence = writer.claimOwnership({ ownerId: "o", incarnation: "i" });
      const begunA = writer.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-a",
        model: "m-a",
        targetState: "ready",
        desiredRevision: 1,
        reservationGiB: 8,
        nowMs: 1,
      });
      expect(begunA).toMatchObject({ ok: true, created: true });
      const begunB = writer.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-b",
        model: "m-b",
        targetState: "ready",
        desiredRevision: 1,
        reservationGiB: 4,
        nowMs: 1,
      });
      expect(begunB).toMatchObject({ ok: true, created: true });
      expect(
        writer.commitReservation({
          fenceToken: fence.fenceToken,
          operationId: "op-b",
          expectedVersion: opVersion(writer, "op-b"),
          nowMs: 2,
        }),
      ).toEqual({ ok: true });
      expect(
        writer.finishOperation({
          fenceToken: fence.fenceToken,
          operationId: "op-b",
          expectedVersion: opVersion(writer, "op-b"),
          outcome: "succeeded",
          nowMs: 3,
        }),
      ).toEqual({ ok: true });

      const r = await status("local");
      expect(r.store.present).toBe(true);
      const listing = nonterminalStore(r.store);
      expect(listing.nonterminalCount).toBe(1);
      expect(listing.nonterminal.map((op) => op.operationId)).toEqual(["op-a"]);

      expect(writer.currentFence()).toEqual(fence);
      expect(
        writer.finishOperation({
          fenceToken: fence.fenceToken,
          operationId: "op-a",
          expectedVersion: opVersion(writer, "op-a"),
          outcome: "succeeded",
          nowMs: 4,
        }),
      ).toEqual({ ok: true });
    } finally {
      writer.close();
    }
  });

  test("never migrates: an empty sqlite file reports an error and stays empty", async () => {
    mkdirSync(dirname(storePath), { recursive: true });
    const empty = new Database(storePath);
    empty.close();

    const r = await status("local");
    expect(r.store.present).toBe(true);
    expect(typeof storeError(r.store)).toBe("string");
    expect(r.store.scope).toBe("serving-process");

    const ro = new Database(storePath, { readonly: true });
    try {
      expect(ro.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally {
      ro.close();
    }
  });
});

describe("defaultResidencyStorePath", () => {
  test("is the single source of truth for the store path", async () => {
    const storeMod = await requireStoreModule();
    expect(storeMod.defaultResidencyStorePath({ LLAMACTL_RESIDENCY_STORE: " /x/y.sqlite " })).toBe(
      "/x/y.sqlite",
    );
    expect(storeMod.defaultResidencyStorePath({ DEV_STORAGE: "/d" })).toBe(
      join("/d", "residency", "operations.sqlite"),
    );
    const r = await status("local");
    expect(r.store.path).toBe(storeMod.defaultResidencyStorePath());
  });
});

describe("buildResidencyStatus", () => {
  test("assembles the status shape from plain inputs", async () => {
    const proc = await requireProcModule();
    const built = proc.buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
    });
    expect(built).toEqual({
      node: "n",
      nodeRun: { present: false },
      policy: { present: false },
      budget: { memoryGiB: 10, source: "computed" },
      store: { path: "/p", present: false, scope: "serving-process" },
    });
  });
});
