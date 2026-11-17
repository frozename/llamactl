/**
 * #517 — RED unit tests for the direct ModelHost residency lifecycle
 * module (src/residency/direct-lifecycle.ts, not yet landed). The module
 * wraps an injected start/stop dep with the same fenced residency walks
 * the profile-switch decorator uses: claim the apply-profile fence,
 * pre-walk, run the dep, then RE-CLAIM under the profile-switch predicate
 * before the post-walk — a dep that stalls (or a peer that steals the
 * fence mid-flight) must not leave the row stuck or recorded under a
 * stolen fence. The guarded dynamic import keeps every case failing BY
 * ASSERTION at base: the specifier stays a `string` (not a literal) so
 * `tsc` cannot resolve the not-yet-existing module — a literal specifier
 * would be a resolution error, not an assertion failure.
 */
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const DIRECT_LIFECYCLE_MODULE = "../../src/residency/direct-lifecycle.js" as string;
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type Fence = { ownerId: string; incarnation: string; fenceToken: number };
type SeedRow = { model: string; target: ResidencyState; group?: string };

type DirectDepResult = { ok: boolean; error?: string };
type DirectDep = (model: string) => Promise<DirectDepResult> | DirectDepResult;
type DirectLifecycleOpts = {
  storePath: string;
  group?: string;
  isProvenDown: (model: string) => boolean;
  isRunning: (model: string) => boolean;
  log: (line: string) => void;
};
type DirectRunOutcome = { ran: boolean; error?: string };
type DirectLifecycleModule = {
  runDirectResidencyStart: (
    model: string,
    dep: DirectDep,
    opts: DirectLifecycleOpts,
  ) => Promise<DirectRunOutcome>;
  runDirectResidencyStop: (
    model: string,
    dep: DirectDep,
    opts: DirectLifecycleOpts,
  ) => Promise<DirectRunOutcome>;
};

async function loadDirectLifecycle(): Promise<DirectLifecycleModule> {
  const mod = (await import(DIRECT_LIFECYCLE_MODULE).catch(() => null)) as Record<
    string,
    unknown
  > | null;
  expect(mod).not.toBeNull();
  expect(typeof mod?.["runDirectResidencyStart"]).toBe("function");
  expect(typeof mod?.["runDirectResidencyStop"]).toBe("function");
  return mod as unknown as DirectLifecycleModule;
}

let root = "";

const storePath = (): string => join(root, "ops.sqlite");

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "unavailable":
    case "warming":
    case "draining":
    case "unloading":
    case "failed":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

// Same seeding rule as the router-level file: claim under the
// apply-profile owner with incarnation 'seed' and walk each row along
// legal edges, passing the group only on the 'loading' hop.
function seed(rows: readonly SeedRow[]): Fence {
  const store = openResidencyOperationStore({ path: storePath() });
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
    return fence;
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function readFence(): Fence | null {
  return withStore((store) => store.currentFence());
}

function lifecycleOpts(
  lines: string[],
  overrides?: Partial<DirectLifecycleOpts>,
): DirectLifecycleOpts {
  return {
    storePath: storePath(),
    group: GROUP,
    isProvenDown: () => false,
    isRunning: () => false,
    log: (line) => lines.push(line),
    ...(overrides ?? {}),
  };
}

// The dep-side fence steal shared by DL9a-c: a second store handle claims
// ownership under the same apply-profile owner with incarnation 'intruder',
// bumps the fence token, and closes — exactly what a concurrent profile
// switch (or any other fenced writer) does to a stalled direct start/stop.
function stealFence(): void {
  const intruder = openResidencyOperationStore({ path: storePath() });
  try {
    intruder.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "intruder",
    });
  } finally {
    intruder.close();
  }
}

function beginIntruderSwitchOp(): void {
  const intruder = openResidencyOperationStore({ path: storePath() });
  try {
    const fence = intruder.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "intruder",
    });
    const begun = intruder.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-intruder",
      model: "profile-switch:local",
      targetState: "x",
      desiredRevision: 1,
      reservationGiB: 0,
      nowMs: NOW,
    });
    expect(begun.ok).toBe(true);
  } finally {
    intruder.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-direct-lifecycle-"));
});

afterEach(() => {
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("direct residency lifecycle (injected deps)", () => {
  test("DL9a: a fence stolen mid-start is re-acquired before the failed post-walk", async () => {
    // kills: no fence re-acquire before the post-start walk — without it
    // the loading row is stuck forever.
    const mod = await loadDirectLifecycle();
    seed([]);
    const lines: string[] = [];
    const dep: DirectDep = () => {
      stealFence();
      return { ok: false, error: "boom" };
    };

    const outcome = await mod.runDirectResidencyStart("z13-a", dep, lifecycleOpts(lines));

    expect(outcome).toMatchObject({ ran: true });
    expect(readState("z13-a")).toMatchObject({ state: "failed", group: GROUP });
    const fence = readFence();
    expect(fence).not.toBeNull();
    expect(fence?.incarnation).not.toBe("intruder");
  });

  test("DL9b: the post-start re-claim refuses while an intruder's switch is in flight", async () => {
    // kills: a re-acquire that ignores the profile-switch predicate and
    // steals from an in-flight switch — the fence and row must stay put.
    const mod = await loadDirectLifecycle();
    seed([]);
    const lines: string[] = [];
    const dep: DirectDep = () => {
      beginIntruderSwitchOp();
      return { ok: false, error: "boom" };
    };

    await mod.runDirectResidencyStart("z13-a", dep, lifecycleOpts(lines));

    expect(readFence()?.incarnation).toBe("intruder");
    expect(readState("z13-a")?.state).toBe("loading");
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a start not recorded: profile switch in flight",
    );
  });

  test("DL9c: a fence stolen mid-stop is re-acquired before the post-stop walk", async () => {
    // kills: no re-acquire before the post-stop walk — the unloading row
    // would be stuck.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const lines: string[] = [];
    const dep: DirectDep = () => {
      stealFence();
      return { ok: true };
    };

    await mod.runDirectResidencyStop("z13-a", dep, lifecycleOpts(lines));

    expect(readState("z13-a")?.state).toBe("downloaded");
  });

  test("DL10a: an idempotent re-start of a running host keeps the ready row untouched", async () => {
    // kills: churning the row of an already-running host — without the
    // isRunning skip the version would climb (+4 teardown hops, +2
    // reload hops) on every re-start.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("z13-a")?.version ?? 0;
    const lines: string[] = [];
    const dep: DirectDep = () => ({ ok: true });

    await mod.runDirectResidencyStart(
      "z13-a",
      dep,
      lifecycleOpts(lines, { isRunning: () => true }),
    );

    expect(readState("z13-a")).toMatchObject({ state: "ready", version: seededVersion });
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a start kept ready: host already running",
    );
  });

  test("DL10b: a re-start that kills a previously running host records failed", async () => {
    // kills: leaving 'ready' for a host the re-start left dead — the
    // isRunning flip across the dep is what separates this from DL10a.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const lines: string[] = [];
    let running = true;
    const dep: DirectDep = () => {
      running = false;
      return { ok: false, error: "boom" };
    };

    await mod.runDirectResidencyStart(
      "z13-a",
      dep,
      lifecycleOpts(lines, { isRunning: () => running }),
    );

    expect(readState("z13-a")?.state).toBe("failed");
  });
});
