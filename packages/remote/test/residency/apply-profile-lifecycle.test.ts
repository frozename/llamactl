import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
/**
 * #517 — RED tests for the production wiring of residency lifecycle rows
 * through `applyResidencyProfile`: the wet run must pass
 * `operation.lifecycle` (the operation store plus a `groupOf` that reads
 * the `llamactl.io/residency-group` manifest label) into the executor, so
 * the same stop/start row walks pinned at executor level also happen on
 * the live path — including reconciliation of stale uncorroborated peers
 * and refusal on corroborated exclusive-group occupants. At base
 * apply-profile never passes `lifecycle`, so every case fails BY
 * ASSERTION on the residency_states rows — never by import, type or exit
 * code.
 */
import { RESIDENCY_GROUPS, type ResidencyState } from "@llamactl/core/residency/lifecycle";
import {
  type OkPlan,
  type PlannerWorkload,
  planProfileSwitch,
} from "@llamactl/core/residency/planner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ProfileSwitchExecutorDeps,
  ProfileSwitchStepOutcome,
} from "../../src/residency/profile-transition.js";

import {
  __setResidencyApplyProfileStepsForTests,
  applyResidencyProfile,
  RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
  type ResidencyApplyProfileResult,
} from "../../src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const NOW = 1_000_000_000;
const GROUP_LABEL = "llamactl.io/residency-group";
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const GROUP = "z13-large-gpu";

type Store = ResidencyOperationStore & ResidencyLifecycleStore;

let tmp = "";
let workloadsDir = "";
let storePath = "";
let stepCalls: [string, string][] = [];

function runManifest(name: string, profiles: string, groupLabel: string = GROUP): ModelRun {
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
      labels: { [GROUP_LABEL]: groupLabel },
      annotations: { [PROFILES_ANNOTATION]: profiles },
    },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
      resources: { expectedMemoryGiB: 10 },
    },
  });
}

function recordingSteps(): ProfileSwitchExecutorDeps {
  return {
    stop: (workload): Promise<ProfileSwitchStepOutcome> => {
      stepCalls.push(["stop", workload]);
      return Promise.resolve({ ok: true });
    },
    start: (workload): Promise<ProfileSwitchStepOutcome> => {
      stepCalls.push(["start", workload]);
      return Promise.resolve({ ok: true });
    },
  };
}

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

// Walks `model` from its current row to `target` through legal edges under
// a fence claimed by the apply-profile owner, so the wet run's own claim
// does not report the seeded fence as a foreign owner. The first write
// from an absent row targets 'downloaded' at expectedVersion 0;
// 'unavailable' is never written.
function seed(model: string, target: ResidencyState, group?: string): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fenceToken = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    }).fenceToken;
    for (const to of seedPathTo(target)) {
      const result = store.transitionResidencyState({
        fenceToken,
        model,
        ...(group === undefined ? {} : { group }),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// The planner workloads deliberately carry no `group`: membership must
// come from the manifest labels through the live path's groupOf, not
// from plan input.
function planFor(extra: PlannerWorkload[] = []): OkPlan {
  const plan = planProfileSwitch({
    node: "local",
    to: "code",
    budgetGiB: 1000,
    groups: RESIDENCY_GROUPS,
    workloads: [
      { id: "chat-a", profiles: ["chat"], state: "ready", expectedMemoryGiB: 10 },
      { id: "code-b", profiles: ["code"], state: "downloaded", expectedMemoryGiB: 10 },
      ...extra,
    ],
    nowMs: NOW,
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`expected ok plan, got refusal ${plan.reason}: ${plan.detail}`);
  }
  return plan;
}

async function apply(plan: OkPlan, logs: string[]): Promise<ResidencyApplyProfileResult> {
  return await applyResidencyProfile({
    plan,
    dryRun: false,
    storePath,
    workloadsDir,
    registry: null,
    log: (line) => logs.push(line),
  });
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-lifecycle-"));
  workloadsDir = join(tmp, "workloads");
  storePath = join(tmp, "residency", "operations.sqlite");
  stepCalls = [];
  saveWorkload(runManifest("chat-a", "chat"), workloadsDir);
  saveWorkload(runManifest("code-b", "code"), workloadsDir);
  __setResidencyApplyProfileStepsForTests(recordingSteps());
});

afterEach(() => {
  __setResidencyApplyProfileStepsForTests(null);
  setResidencyLeaseRegistry(null);
  if (tmp !== "") {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("applyResidencyProfile residency lifecycle", () => {
  test("AP1: a wet apply drives the replacement row to ready in its manifest group", async () => {
    // kills: apply-profile not passing `lifecycle`; groupOf not reading the
    // llamactl.io/residency-group label (group would be null).
    const logs: string[] = [];
    const result = await apply(planFor(), logs);

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    const row = withStore((store) => store.getResidencyState("code-b"));
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      state: "ready",
      group: GROUP,
    });
  });

  test("AP1b: a whitespace-padded group label lands the row in the trimmed group", async () => {
    // kills: groupOf and the planner's buildWorkload normalizing the
    // residency-group label differently.
    saveWorkload(runManifest("code-b", "code", `  ${GROUP} `), workloadsDir);
    const logs: string[] = [];
    const result = await apply(planFor(), logs);

    expect(result.ok).toBe(true);
    const row = withStore((store) => store.getResidencyState("code-b"));
    expect(row).toMatchObject({ state: "ready", group: GROUP });
  });

  test("AP2: a stale uncorroborated peer is reconciled through the live path", async () => {
    // kills: the live path wiring the lifecycle without stale-peer
    // reconciliation (this is the wedge).
    seed("deepseek-x", "ready", GROUP);
    const logs: string[] = [];
    const result = await apply(planFor(), logs);

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(withStore((store) => store.getResidencyState("deepseek-x")?.state)).toBe("downloaded");
    expect(withStore((store) => store.getResidencyState("code-b")?.state)).toBe("ready");
    expect(stepCalls).toContainEqual(["start", "code-b"]);
  });

  test("AP3: a corroborated exclusive-group occupant refuses the start through the live path", async () => {
    // kills: apply-profile wiring the executor without lifecycle, which
    // lets the start run.
    seed("deepseek-x", "ready", GROUP);
    const plan = planFor([
      { id: "deepseek-x", profiles: ["code"], state: "ready", expectedMemoryGiB: 1 },
    ]);
    const logs: string[] = [];
    const result = await apply(plan, logs);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(stepCalls.filter((call) => call[0] === "start" && call[1] === "code-b")).toEqual([]);
    const step = result.steps.find((s) => s.action === "start" && s.workload === "code-b");
    expect(step?.status).toBe("failed");
    expect(step?.detail ?? "").toContain("ExclusiveGroupOccupied");
    expect(step?.detail ?? "").toContain("deepseek-x");
    expect(withStore((store) => store.getResidencyState("deepseek-x")?.state)).toBe("ready");
  });
});
