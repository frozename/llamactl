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
  openStore?: (path: string) => Store;
};
type DirectRunOutcome = { ran: boolean; detail?: string; result?: DirectDepResult };
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
function seed(rows: readonly SeedRow[], groups?: readonly ResidencyGroupDeclaration[]): Fence {
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
          ...(groups === undefined ? {} : { groups }),
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

// A store handle whose every residency transition throws, standing in for a
// store write that fails mid-walk (disk full, a locked database).
function throwingTransitionsStore(path: string): Store {
  const real = openResidencyOperationStore({ path });
  return {
    ...real,
    transitionResidencyState: (): never => {
      throw new Error("disk full");
    },
  };
}

function countingDep(result: DirectDepResult): { dep: DirectDep; calls: () => number } {
  let calls = 0;
  return {
    dep: (): DirectDepResult => {
      calls += 1;
      return result;
    },
    calls: () => calls,
  };
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

  test("DL10c: a re-start that steals the fence and kills the host still records failed", async () => {
    // kills: releasing the adopted ready row under the pre-dep token — the
    // stolen fence makes every release hop stale-fence and the row would
    // stay ready.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const lines: string[] = [];
    let running = true;
    const dep: DirectDep = () => {
      stealFence();
      running = false;
      return { ok: false, error: "boom" };
    };

    await mod.runDirectResidencyStart(
      "z13-a",
      dep,
      lifecycleOpts(lines, { isRunning: () => running }),
    );

    expect(readState("z13-a")?.state).toBe("failed");
    expect(readFence()?.incarnation).not.toBe("intruder");
    expect(lines.join("")).not.toContain("release not recorded");
  });

  test("DL10d: a release refused under an in-flight switch is logged, not dropped", async () => {
    // kills: discarding the release outcome — the refused pre-walk must
    // surface as a `release not recorded` line.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const lines: string[] = [];
    let running = true;
    const dep: DirectDep = () => {
      beginIntruderSwitchOp();
      running = false;
      return { ok: false, error: "boom" };
    };

    await mod.runDirectResidencyStart(
      "z13-a",
      dep,
      lifecycleOpts(lines, { isRunning: () => running }),
    );

    expect(readState("z13-a")?.state).toBe("ready");
    expect(readFence()?.incarnation).toBe("intruder");
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a start release not recorded: residency lifecycle z13-a ready -> draining failed: stale-fence",
    );
  });

  test("DL10e: an ok re-start keeps the ready row even when the host reads down afterwards", async () => {
    // kills: requiring both an ok dep and a still-running host before
    // keeping the row — an ok dep alone keeps it ready.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("z13-a")?.version ?? 0;
    const lines: string[] = [];
    let running = true;
    const dep: DirectDep = () => {
      running = false;
      return { ok: true };
    };

    const outcome = await mod.runDirectResidencyStart(
      "z13-a",
      dep,
      lifecycleOpts(lines, { isRunning: () => running }),
    );

    expect(outcome).toMatchObject({ ran: true, result: { ok: true } });
    expect(readState("z13-a")).toMatchObject({ state: "ready", version: seededVersion });
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a start kept ready: host already running",
    );
  });

  test("DL10f: a stale ready row for a host that is not running is never adopted", async () => {
    // kills: an adopt gate that skips isRunning — the stale ready row would
    // adopt and run the dep past a loading exclusive-group peer.
    const mod = await loadDirectLifecycle();
    // Seeded under a non-exclusive declaration so both rows can coexist;
    // the wrapper itself checks against the default (exclusive) group.
    seed(
      [
        { model: "z13-a", target: "ready", group: GROUP },
        { model: "z13-b", target: "loading", group: GROUP },
      ],
      [{ name: GROUP, exclusive: false }],
    );
    const lines: string[] = [];
    const counted = countingDep({ ok: true });

    const outcome = await mod.runDirectResidencyStart(
      "z13-a",
      counted.dep,
      lifecycleOpts(lines, { isRunning: () => false }),
    );

    expect(outcome.ran).toBe(false);
    expect(outcome.detail ?? "").toContain("ExclusiveGroupOccupied");
    expect(counted.calls()).toBe(0);
    expect(readState("z13-b")?.state).toBe("loading");
  });

  test("DL11: a stop whose pre-walk write throws still runs, unrecorded", async () => {
    // kills: refusing the stop when bookkeeping fails — a stop must never be
    // blocked by the residency store.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const seeded = readState("z13-a");
    const lines: string[] = [];
    const counted = countingDep({ ok: true });

    const outcome = await mod.runDirectResidencyStop(
      "z13-a",
      counted.dep,
      lifecycleOpts(lines, { openStore: throwingTransitionsStore }),
    );

    expect(outcome).toEqual({ ran: true, result: { ok: true } });
    expect(counted.calls()).toBe(1);
    expect(readState("z13-a")).toEqual(seeded);
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a stop not recorded: residency lifecycle z13-a ready -> draining failed: disk full",
    );
  });

  test("DL12a: a throwing start dep records failed and frees the group", async () => {
    // kills: an uncaught dep throw leaving the row loading with its group —
    // every exclusive peer start would then refuse.
    const mod = await loadDirectLifecycle();
    seed([]);
    const lines: string[] = [];
    const throwing: DirectDep = () => {
      throw new Error("spawn exploded");
    };

    const startError = await mod
      .runDirectResidencyStart("z13-a", throwing, lifecycleOpts(lines))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toBe("spawn exploded");
    expect(readState("z13-a")).toMatchObject({ state: "failed", group: GROUP });

    const peer = countingDep({ ok: true });
    const outcome = await mod.runDirectResidencyStart("z13-b", peer.dep, lifecycleOpts(lines));

    expect(outcome).toEqual({ ran: true, result: { ok: true } });
    expect(peer.calls()).toBe(1);
    expect(readState("z13-b")?.state).toBe("ready");
  });

  test("DL12c: a start dep that steals the fence and throws still records failed", async () => {
    // kills: dropping the re-claim in the dep's catch path — the stolen
    // fence would make the failed post-walk stale-fence, leaving the row
    // loading with its group and refusing every exclusive peer start.
    const mod = await loadDirectLifecycle();
    seed([]);
    const lines: string[] = [];
    const throwing: DirectDep = () => {
      stealFence();
      throw new Error("spawn exploded");
    };

    const startError = await mod
      .runDirectResidencyStart("z13-a", throwing, lifecycleOpts(lines))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toBe("spawn exploded");
    expect(readState("z13-a")).toMatchObject({ state: "failed", group: GROUP });
    expect(readFence()?.incarnation).not.toBe("intruder");

    const peer = countingDep({ ok: true });
    const outcome = await mod.runDirectResidencyStart("z13-b", peer.dep, lifecycleOpts(lines));

    expect(outcome).toEqual({ ran: true, result: { ok: true } });
    expect(peer.calls()).toBe(1);
    expect(readState("z13-b")?.state).toBe("ready");
  });

  test("DL12b: a throwing stop dep records failed and rethrows", async () => {
    // kills: an uncaught stop-dep throw leaving the row unloading.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const lines: string[] = [];
    const throwing: DirectDep = () => {
      throw new Error("teardown exploded");
    };

    const stopError = await mod
      .runDirectResidencyStop("z13-a", throwing, lifecycleOpts(lines))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(stopError).toBeInstanceOf(Error);
    expect((stopError as Error).message).toBe("teardown exploded");
    expect(readState("z13-a")?.state).toBe("failed");
  });

  test("DL13: an unopenable store refuses a grouped start but still runs a stop", async () => {
    // kills: a grouped start that runs past a store-open failure, and a
    // stop that is blocked by it.
    const mod = await loadDirectLifecycle();
    seed([]);
    const lines: string[] = [];
    const opts = lifecycleOpts(lines, {
      openStore: () => {
        throw new Error("disk gone");
      },
    });
    const startDep = countingDep({ ok: true });

    const started = await mod.runDirectResidencyStart("z13-a", startDep.dep, opts);

    expect(started).toEqual({
      ran: false,
      detail: "residency lifecycle refused z13-a: store unavailable (disk gone)",
    });
    expect(startDep.calls()).toBe(0);

    const stopDep = countingDep({ ok: true });
    const stopped = await mod.runDirectResidencyStop("z13-a", stopDep.dep, opts);

    expect(stopped).toEqual({ ran: true, result: { ok: true } });
    expect(stopDep.calls()).toBe(1);
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a stop not recorded: store unavailable (disk gone)",
    );
  });

  test("DL14a: an unconfirmed stop leaves the ready row occupying and refuses a peer start", async () => {
    // kills: a not-ok stop dep walking the row to failed (non-occupying), so
    // an exclusive peer could load beside a process that may still be alive.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const seeded = readState("z13-a");
    const lines: string[] = [];
    const stop = countingDep({ ok: false, error: "process still alive after teardown" });

    const outcome = await mod.runDirectResidencyStop("z13-a", stop.dep, lifecycleOpts(lines));

    expect(outcome).toEqual({
      ran: true,
      result: { ok: false, error: "process still alive after teardown" },
    });
    expect(stop.calls()).toBe(1);
    expect(readState("z13-a")).toEqual(seeded);
    expect(lines.join("")).toContain(
      "[residency] lifecycle z13-a stop not recorded: unconfirmed stop (process may be alive)",
    );

    const peer = countingDep({ ok: true });
    const started = await mod.runDirectResidencyStart("z13-b", peer.dep, lifecycleOpts(lines));

    expect(started).toEqual({
      ran: false,
      detail:
        "residency lifecycle refused z13-b downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by z13-a in state ready",
    });
    expect(peer.calls()).toBe(0);
  });

  test("DL14b: the row keeps occupying the group while the stop dep runs", async () => {
    // kills: pre-walking the row to draining/unloading (both non-occupying)
    // before the stop is confirmed: the group would be free mid-stop.
    const mod = await loadDirectLifecycle();
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const lines: string[] = [];
    const seen: (string | undefined)[] = [];
    const dep: DirectDep = () => {
      seen.push(readState("z13-a")?.state);
      return { ok: true };
    };

    await mod.runDirectResidencyStop("z13-a", dep, lifecycleOpts(lines));

    expect(seen).toEqual(["ready"]);
    expect(readState("z13-a")?.state).toBe("downloaded");
  });
});
