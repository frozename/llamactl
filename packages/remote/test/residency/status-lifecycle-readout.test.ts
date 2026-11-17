// #517: lifecycle read-out — the status surface must carry the persisted
// residency_states rows end to end. readResidencyStoreSnapshot exposes them
// (sorted by model, tolerant of pre-#662 and desired_revision-less tables, and
// isolated from the operations read when a row fails to parse),
// buildResidencyStatus projects them into occupying workloads plus
// exclusive-group violations, and the residencyStatus procedure plumbs the
// section through. Every case fails by assertion at the pinned base: the
// snapshot never reads residency_states and no lifecycle section exists yet.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildResidencyStatus } from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  type ResidencyOperationRecord,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const GROUP = "z13-large-gpu";

// The lifecycle surface lands with the fix; these structural types describe
// the contract the assertions pin so the file typechecks on both sides of it.
type LifecycleWorkload = {
  model: string;
  group: string | null;
  state: ResidencyState;
  occupying: boolean;
  version: number;
  updatedAtMs: number;
};

type LifecycleSection =
  | {
      status: "available";
      scope: "serving-process";
      workloads: LifecycleWorkload[];
      exclusiveViolations: { group: string; members: string[] }[];
    }
  | { status: "unavailable"; scope: "serving-process"; reason: string };

type LifecycleSnapshot = {
  nonterminal: ResidencyOperationRecord[];
  lifecycle?: ResidencyStateRecord[];
  lifecycleError?: string;
};

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-lifecycle-"));
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
  tmp = "";
});

function okSnapshot(snap: ResidencyStoreSnapshot): LifecycleSnapshot {
  if (!snap.present || "error" in snap) {
    throw new Error("expected ok snapshot");
  }
  return snap;
}

function lifecycleOf(value: unknown): LifecycleSection | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)["lifecycle"] as LifecycleSection | undefined;
}

function walkToState(
  store: ReturnType<typeof openResidencyOperationStore>,
  fenceToken: number,
  model: string,
  path: readonly ResidencyState[],
  group?: string,
): ResidencyStateRecord {
  let record: ResidencyStateRecord | null = null;
  for (const [index, to] of path.entries()) {
    const result = store.transitionResidencyState({
      fenceToken,
      model,
      to,
      expectedVersion: record?.version ?? 0,
      nowMs: 1000 + index,
      ...(group !== undefined ? { group } : {}),
    });
    if (!result.ok) {
      throw new Error(`transitionResidencyState ${model} -> ${to} refused: ${result.reason}`);
    }
    record = result.record;
  }
  if (record === null) {
    throw new Error("walkToState requires a non-empty path");
  }
  return record;
}

function rewriteResidencyStates(dbPath: string, statements: readonly string[]): void {
  const raw = new Database(dbPath);
  try {
    for (const statement of statements) {
      raw.run(statement);
    }
  } finally {
    raw.close();
  }
}

function tableColumns(dbPath: string, table: string): string[] {
  const ro = new Database(dbPath, { readonly: true });
  try {
    const rows = ro.query(`PRAGMA table_info('${table}')`).all() as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    ro.close();
  }
}

describe("residency lifecycle read-out (#517)", () => {
  test("R1 snapshot lifecycle carries residency_states rows sorted by model", () => {
    // Kills: a snapshot that never reads residency_states.
    const writer = openResidencyOperationStore({ path: storePath });
    const fence = writer.claimOwnership({ ownerId: "t", incarnation: "i" });
    walkToState(writer, fence.fenceToken, "b-run", ["downloaded"]);
    walkToState(
      writer,
      fence.fenceToken,
      "a-glm",
      ["downloaded", "loading", "warming", "ready"],
      GROUP,
    );
    const aRecord = writer.getResidencyState("a-glm");
    const bRecord = writer.getResidencyState("b-run");
    writer.close();
    if (aRecord === null || bRecord === null) {
      throw new Error("expected both residency rows to exist");
    }

    const snap = okSnapshot(readResidencyStoreSnapshot(storePath));
    expect(snap.lifecycle).toEqual([aRecord, bRecord]);
  });

  test("R2 a store without residency_states reads an empty lifecycle and stays unmigrated", () => {
    // Kills: an unguarded SELECT that reports a pre-#662 file as an error, and
    // a reader that migrates the missing table back into existence.
    const writer = openResidencyOperationStore({ path: storePath });
    writer.close();
    rewriteResidencyStates(storePath, ["DROP TABLE residency_states"]);

    const snap = okSnapshot(readResidencyStoreSnapshot(storePath));
    expect(snap.nonterminal).toEqual([]);
    expect(snap.lifecycle).toEqual([]);
    expect(snap).not.toHaveProperty("lifecycleError");

    const ro = new Database(storePath, { readonly: true });
    try {
      expect(
        ro.query("SELECT name FROM sqlite_master WHERE name = 'residency_states'").all(),
      ).toEqual([]);
    } finally {
      ro.close();
    }
  });

  test("R3 a #662-era residency_states table reads rows without desired_revision", () => {
    // Kills: an unconditional desired_revision column select, and a reader
    // that migrates the table before reading it.
    const writer = openResidencyOperationStore({ path: storePath });
    writer.close();
    rewriteResidencyStates(storePath, [
      "DROP TABLE residency_states",
      `CREATE TABLE residency_states (
        model TEXT PRIMARY KEY,
        residency_group TEXT,
        state TEXT NOT NULL CHECK (state IN ('unavailable','downloaded','loading','warming','ready','draining','unloading','failed')),
        owner_id TEXT NOT NULL,
        incarnation TEXT NOT NULL,
        fence_token INTEGER NOT NULL,
        version INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
      "INSERT INTO residency_states (model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms) VALUES ('m1', 'z13-large-gpu', 'downloaded', 'o', 'i', 1, 1, 5)",
    ]);

    const snap = okSnapshot(readResidencyStoreSnapshot(storePath));
    expect(snap.lifecycle).toStrictEqual([
      {
        model: "m1",
        group: "z13-large-gpu",
        state: "downloaded",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 1,
        updatedAtMs: 5,
      },
    ]);
    expect(snap.lifecycle?.[0]).not.toHaveProperty("desiredRevision");
    expect(tableColumns(storePath, "residency_states")).not.toContain("desired_revision");
  });

  test("R4 a lifecycle read failure is isolated from the operations snapshot", () => {
    // Kills: the lifecycle read inside the same try as nonterminal (which
    // reports StoreUnreadable on an ok operations table), and reporting a
    // lifecycle-read failure as an empty healthy lifecycle.
    const writer = openResidencyOperationStore({ path: storePath });
    writer.close();
    rewriteResidencyStates(storePath, [
      "DROP TABLE residency_states",
      `CREATE TABLE residency_states (
        model TEXT PRIMARY KEY,
        residency_group TEXT,
        state TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        incarnation TEXT NOT NULL,
        fence_token INTEGER NOT NULL,
        version INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        desired_revision INTEGER
      )`,
      "INSERT INTO residency_states (model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms, desired_revision) VALUES ('m-new', NULL, 'hibernating', 'o', 'i', 1, 1, 5, NULL)",
    ]);

    const snap = readResidencyStoreSnapshot(storePath);
    expect(snap.present).toBe(true);
    expect("error" in snap).toBe(false);
    const view = okSnapshot(snap);
    expect(view.nonterminal).toEqual([]);
    expect(snap).not.toHaveProperty("lifecycle");
    expect(view.lifecycleError).toContain("unknown state hibernating");

    const built = buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store: snap,
    });
    expect(built.store).toEqual({
      path: storePath,
      present: true,
      nonterminalCount: 0,
      nonterminal: [],
      scope: "serving-process",
    });
    expect(lifecycleOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "LifecycleUnreadable",
    });
  });

  test("R5 buildResidencyStatus projects lifecycle rows into sorted occupying workloads", () => {
    // Kills: no lifecycle section; occupying computed as state === 'ready'
    // (misses warming); unsorted rows; fence fields leaking into the public row.
    const lifecycleRows: ResidencyStateRecord[] = [
      {
        model: "c-ready",
        group: null,
        state: "ready",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 1,
        updatedAtMs: 10,
      },
      {
        model: "b-warm",
        group: null,
        state: "warming",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 2,
        updatedAtMs: 20,
      },
      {
        model: "a-dl",
        group: null,
        state: "downloaded",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 3,
        updatedAtMs: 30,
      },
    ];
    const store = { path: "/p", present: true as const, nonterminal: [], lifecycle: lifecycleRows };
    const built = buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store,
    });
    expect(lifecycleOf(built)).toEqual({
      status: "available",
      scope: "serving-process",
      workloads: [
        {
          model: "a-dl",
          group: null,
          state: "downloaded",
          occupying: false,
          version: 3,
          updatedAtMs: 30,
        },
        {
          model: "b-warm",
          group: null,
          state: "warming",
          occupying: true,
          version: 2,
          updatedAtMs: 20,
        },
        {
          model: "c-ready",
          group: null,
          state: "ready",
          occupying: true,
          version: 1,
          updatedAtMs: 10,
        },
      ],
      exclusiveViolations: [],
    });
  });

  test("R6 buildResidencyStatus reports exclusive-group violations over occupying rows", () => {
    // Kills: violations hardcoded to []; violations computed over unsorted or
    // non-occupying rows; occupying ignoring loading.
    // The store refuses to write this set (two occupying members of an
    // exclusive group), so the snapshot is injected directly.
    const lifecycleRows: ResidencyStateRecord[] = [
      {
        model: "glm",
        group: GROUP,
        state: "ready",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 1,
        updatedAtMs: 10,
      },
      {
        model: "deepseek",
        group: GROUP,
        state: "loading",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 2,
        updatedAtMs: 20,
      },
      {
        model: "qwen",
        group: GROUP,
        state: "downloaded",
        ownerId: "o",
        incarnation: "i",
        fenceToken: 1,
        version: 3,
        updatedAtMs: 30,
      },
    ];
    const store = { path: "/p", present: true as const, nonterminal: [], lifecycle: lifecycleRows };
    const built = buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store,
    });
    const lifecycle = lifecycleOf(built);
    expect(lifecycle?.status).toBe("available");
    if (lifecycle?.status !== "available") {
      throw new Error("expected an available lifecycle section");
    }
    expect(lifecycle.exclusiveViolations).toEqual([{ group: GROUP, members: ["deepseek", "glm"] }]);
    expect(lifecycle.workloads.map((w) => [w.model, w.occupying])).toEqual([
      ["deepseek", true],
      ["glm", true],
      ["qwen", false],
    ]);
  });

  test("R7 buildResidencyStatus mirrors store readability into the lifecycle section", () => {
    // Kills: an unreadable store reported as an empty healthy lifecycle.
    const absent = buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: false },
    });
    expect(lifecycleOf(absent)).toEqual({
      status: "available",
      scope: "serving-process",
      workloads: [],
      exclusiveViolations: [],
    });

    const errored = buildResidencyStatus({
      node: "n",
      nodeRun: undefined,
      budgetGiB: 10,
      budgetSource: "computed",
      store: { path: "/p", present: true, error: "boom" },
    });
    expect(lifecycleOf(errored)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "StoreUnreadable",
    });
  });

  test("R8 residencyStatus surfaces lifecycle rows through the router", async () => {
    // Kills: the router/status path not plumbing the snapshot's lifecycle.
    const writer = openResidencyOperationStore({ path: storePath });
    const fence = writer.claimOwnership({ ownerId: "t", incarnation: "i" });
    const record = walkToState(
      writer,
      fence.fenceToken,
      "a-glm",
      ["downloaded", "loading", "warming", "ready"],
      GROUP,
    );
    writer.close();

    const result = await router.createCaller({}).residencyStatus({ node: "local" });
    const lifecycle = lifecycleOf(result);
    expect(lifecycle?.status).toBe("available");
    if (lifecycle?.status !== "available") {
      throw new Error("expected an available lifecycle section");
    }
    expect(lifecycle.workloads).toEqual([
      {
        model: "a-glm",
        group: GROUP,
        state: "ready",
        occupying: true,
        version: record.version,
        updatedAtMs: record.updatedAtMs,
      },
    ]);
    expect(lifecycle.exclusiveViolations).toEqual([]);
  });
});
