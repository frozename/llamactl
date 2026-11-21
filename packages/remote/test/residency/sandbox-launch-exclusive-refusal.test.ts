/**
 * #517 — RED unit tests for `exclusiveGroupLaunchRefusal` in
 * src/residency/direct-lifecycle.ts (not yet landed). The helper is the
 * read-only pre-spawn gate `llamactl eval run` and `llamactl admit measure`
 * call before launching a sandbox engine: it resolves the launch's
 * declared-exclusive residency group, reads the node-local store through a
 * snapshot (never opening or creating it), and returns the refusal string
 * the caller prints, or null when the launch may proceed. The guarded
 * dynamic import keeps every case failing BY ASSERTION at base: the export
 * does not exist yet, so `typeof` is "undefined", never an import or type
 * error. All stores are real SQLite files under a temp dir or injected
 * snapshots — no network, no processes, no sleeps.
 */
import type { ResidencyGroupDeclaration, ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { existsSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";

const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type SeedRow = { model: string; target: ResidencyState; group?: string };

type ExclusiveGroupLaunchRefusalInput = {
  id: string;
  group: string | undefined;
  storePath: string;
  groups?: readonly ResidencyGroupDeclaration[];
  readSnapshot?: (path: string) => ResidencyStoreSnapshot;
};
type ExclusiveGroupLaunchRefusal = (input: ExclusiveGroupLaunchRefusalInput) => string | null;

// The module exists at base but the export does not: the dynamic import
// resolves, and the typeof assertion — not a resolution error — is what
// fails.
async function loadRefusal(): Promise<ExclusiveGroupLaunchRefusal> {
  const mod = (await import("../../src/residency/direct-lifecycle.js")) as unknown as {
    exclusiveGroupLaunchRefusal?: unknown;
  };
  expect(typeof mod.exclusiveGroupLaunchRefusal).toBe("function");
  return mod.exclusiveGroupLaunchRefusal as ExclusiveGroupLaunchRefusal;
}

let root = "";

const storePath = (): string => join(root, "ops.sqlite");

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "warming":
      return ["downloaded", "loading", "warming"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "draining":
      return ["downloaded", "loading", "warming", "ready", "draining"];
    case "unloading":
      return ["downloaded", "loading", "warming", "ready", "draining", "unloading"];
    case "failed":
      return ["downloaded", "loading", "failed"];
    case "unavailable":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

// Walks each row along legal edges under a fence claimed by the
// apply-profile owner, passing the group only on the 'loading' hop and
// expecting every hop to succeed — the store enforces exclusivity on each
// transition, so rows that end occupying must be seeded into separate
// stores or finished before the next peer is walked.
function seedStore(path: string, rows: readonly SeedRow[]): void {
  const store: Store = openResidencyOperationStore({ path });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const row of rows) {
      for (const to of seedPathTo(row.target)) {
        const result = store.transitionResidencyState({
          fenceToken: fence.fenceToken,
          model: row.model,
          ...(to === "loading" && row.group !== undefined ? { group: row.group } : {}),
          to,
          expectedVersion: store.getResidencyState(row.model)?.version ?? 0,
          nowMs: NOW,
        });
        expect(result.ok).toBe(true);
      }
    }
  } finally {
    store.close();
  }
}

// A nonterminal profile-switch operation with no lifecycle rows: the
// in-flight gate a sandbox launch must refuse on.
function seedSwitchOp(path: string): void {
  const store: Store = openResidencyOperationStore({ path });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-switch",
      model: "profile-switch:local",
      targetState: "x",
      desiredRevision: 1,
      reservationGiB: 0,
      nowMs: NOW,
    });
    expect(begun.ok).toBe(true);
  } finally {
    store.close();
  }
}

function lifecycleRow(
  model: string,
  state: ResidencyState,
  group: string | null = GROUP,
): ResidencyStateRecord {
  return {
    model,
    group,
    state,
    ownerId: "seed",
    incarnation: "seed",
    fenceToken: 1,
    version: 1,
    updatedAtMs: NOW,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-launch-refusal-"));
});

afterEach(() => {
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("#517 exclusiveGroupLaunchRefusal", () => {
  // Kills: a guard that opens the store with openResidencyOperationStore
  // (or otherwise creates it) — a read-only pre-spawn check on a node with
  // no store must leave the filesystem untouched and allow the launch.
  test("X1: an absent store file returns null and is not created", async () => {
    const refusal = await loadRefusal();
    const missing = join(root, "no-store", "operations.sqlite");
    expect(existsSync(missing)).toBe(false);
    expect(refusal({ id: "glm", group: GROUP, storePath: missing })).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  // Kills: the guard itself — no exclusive-group occupancy read means the
  // sandbox launch proceeds beside a ready z13-large-gpu peer and doubles
  // GPU memory.
  test("X2: a ready exclusive-group peer refuses with the held-by detail", async () => {
    const refusal = await loadRefusal();
    seedStore(storePath(), [{ model: "qwen-prod", target: "ready", group: GROUP }]);
    expect(refusal({ id: "glm", group: GROUP, storePath: storePath() })).toBe(
      "residency lifecycle refused glm downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready",
    );
  });

  // Kills: an occupancy check that only counts `ready` rows — loading and
  // warming peers hold the group just the same and must refuse too.
  test("X2b: loading and warming peers each refuse naming their own state", async () => {
    const refusal = await loadRefusal();
    const loadingPath = join(root, "loading.sqlite");
    const warmingPath = join(root, "warming.sqlite");
    seedStore(loadingPath, [{ model: "qwen-prod", target: "loading", group: GROUP }]);
    seedStore(warmingPath, [{ model: "qwen-prod", target: "warming", group: GROUP }]);
    expect(refusal({ id: "glm", group: GROUP, storePath: loadingPath })).toBe(
      "residency lifecycle refused glm downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state loading",
    );
    expect(refusal({ id: "glm", group: GROUP, storePath: warmingPath })).toBe(
      "residency lifecycle refused glm downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state warming",
    );
  });

  // Kills: treating every same-group row as occupying — downloaded,
  // draining, unloading and failed rows hold no capacity and must not
  // refuse the launch.
  test("X3: downloaded, draining, unloading and failed peers never refuse", async () => {
    const refusal = await loadRefusal();
    seedStore(storePath(), [
      { model: "peer-downloaded", target: "downloaded", group: GROUP },
      { model: "peer-draining", target: "draining", group: GROUP },
      { model: "peer-unloading", target: "unloading", group: GROUP },
      { model: "peer-failed", target: "failed", group: GROUP },
    ]);
    expect(refusal({ id: "glm", group: GROUP, storePath: storePath() })).toBeNull();
  });

  // Kills: reading the store before resolving the declaration — a launch
  // with no group, an undeclared group, or a non-exclusive group must
  // return null without ever touching the snapshot reader.
  test("X4: no group, undeclared group and non-exclusive group never read the store", async () => {
    const refusal = await loadRefusal();
    const exploding = (): ResidencyStoreSnapshot => {
      throw new Error("store must not be read");
    };
    const path = storePath();
    expect(
      refusal({ id: "glm", group: undefined, storePath: path, readSnapshot: exploding }),
    ).toBeNull();
    expect(
      refusal({ id: "glm", group: "not-declared", storePath: path, readSnapshot: exploding }),
    ).toBeNull();
    expect(
      refusal({
        id: "glm",
        group: "g",
        storePath: path,
        groups: [{ name: "g", exclusive: false }],
        readSnapshot: exploding,
      }),
    ).toBeNull();
  });

  // Kills: dropping the in-flight profile-switch gate — a sandbox launch
  // racing a switch would spawn beside the switch's own occupants.
  test("X5: a nonterminal profile switch refuses with the retry message", async () => {
    const refusal = await loadRefusal();
    seedSwitchOp(storePath());
    expect(refusal({ id: "glm", group: GROUP, storePath: storePath() })).toBe(
      "residency lifecycle refused glm: profile switch in flight on this node; retry after it settles",
    );
  });

  // Kills: swallowing snapshot failures into a null (launch proceeds on an
  // unreadable store) — both the whole-store error and the isolated
  // lifecycleError variants must refuse.
  test("X6: an unreadable store refuses with store unavailable", async () => {
    const refusal = await loadRefusal();
    const path = storePath();
    expect(
      refusal({
        id: "glm",
        group: GROUP,
        storePath: path,
        readSnapshot: (snapshotPath) => ({ path: snapshotPath, present: true, error: "boom" }),
      }),
    ).toBe("residency lifecycle refused glm: store unavailable (boom)");
    expect(
      refusal({
        id: "glm",
        group: GROUP,
        storePath: path,
        readSnapshot: (snapshotPath) => ({
          path: snapshotPath,
          present: true,
          nonterminal: [],
          lifecycleError: "bad",
        }),
      }),
    ).toBe("residency lifecycle refused glm: store unavailable (bad)");
  });

  // Kills: excluding the launch's own id from the occupancy scan — a stale
  // same-name ready row would pass and the sandbox copy would double GPU
  // memory beside the recorded engine.
  test("X7: a same-name ready row still refuses", async () => {
    const refusal = await loadRefusal();
    seedStore(storePath(), [{ model: "glm", target: "ready", group: GROUP }]);
    expect(refusal({ id: "glm", group: GROUP, storePath: storePath() })).toBe(
      "residency lifecycle refused glm downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by glm in state ready",
    );
  });

  // Kills: naming the first occupying row in snapshot order — the refusal
  // must name the lowest member id so the message is deterministic.
  test("X8: the refusal names the lowest-id occupying member", async () => {
    const refusal = await loadRefusal();
    const path = storePath();
    const snapshot: ResidencyStoreSnapshot = {
      path,
      present: true,
      nonterminal: [],
      lifecycle: [lifecycleRow("b-peer", "ready"), lifecycleRow("a-peer", "ready")],
    };
    expect(
      refusal({ id: "glm", group: GROUP, storePath: path, readSnapshot: () => snapshot }),
    ).toBe(
      "residency lifecycle refused glm downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by a-peer in state ready",
    );
  });

  // Kills: dropping `row.group === group` from the occupant filter — an
  // occupying row recorded under a different group holds none of
  // z13-large-gpu's capacity and must not refuse the launch.
  test("X9: ready and loading rows in a different group never refuse", async () => {
    const refusal = await loadRefusal();
    const path = storePath();
    for (const state of ["ready", "loading"] as const) {
      const snapshot: ResidencyStoreSnapshot = {
        path,
        present: true,
        nonterminal: [],
        lifecycle: [lifecycleRow("other-peer", state, "other-group")],
      };
      expect(
        refusal({ id: "glm", group: GROUP, storePath: path, readSnapshot: () => snapshot }),
      ).toBeNull();
    }
  });

  // Kills: dropping `row.group === group` from the occupant filter — an
  // occupying row with no recorded group is outside every exclusive group
  // and must not refuse the launch.
  test("X10: ready and loading rows with no group never refuse", async () => {
    const refusal = await loadRefusal();
    const path = storePath();
    for (const state of ["ready", "loading"] as const) {
      const snapshot: ResidencyStoreSnapshot = {
        path,
        present: true,
        nonterminal: [],
        lifecycle: [lifecycleRow("ungrouped-peer", state, null)],
      };
      expect(
        refusal({ id: "glm", group: GROUP, storePath: path, readSnapshot: () => snapshot }),
      ).toBeNull();
    }
  });
});
