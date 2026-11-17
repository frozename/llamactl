/**
 * #520 — end-to-end pin of session protection through the production
 * caller: `applyResidencyProfile` runs the wet switch on the
 * operation-backed executor path with no `sessions` key, so it relies on
 * the installed session seam. A session bound to a victim must refuse the
 * switch at fence time, record the operation `failed`, and run no stop or
 * start. The guard case shows the same wiring runs the switch once the
 * seam holds no session on any victim.
 */
import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { type OkPlan, planProfileSwitch } from "@llamactl/core/residency/planner";
import {
  createSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
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
  type ResidencyApplyProfileResult,
} from "../../src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const NOW = 1_000_000_000;
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";

let tmp = "";
let workloadsDir = "";
let storePath = "";
let stepCalls: string[] = [];
let clock = 0;

function runManifest(name: string, profiles: string): ModelRun {
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
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
      stepCalls.push(`stop:${workload}`);
      return Promise.resolve({ ok: true });
    },
    start: (workload): Promise<ProfileSwitchStepOutcome> => {
      stepCalls.push(`start:${workload}`);
      return Promise.resolve({ ok: true });
    },
  };
}

function planFor(): OkPlan {
  const plan = planProfileSwitch({
    node: "local",
    to: "code",
    budgetGiB: 1000,
    groups: [],
    workloads: [
      { id: "chat-a", profiles: ["chat"], state: "ready", expectedMemoryGiB: 10 },
      { id: "code-b", profiles: ["code"], state: "downloaded", expectedMemoryGiB: 10 },
    ],
    nowMs: NOW,
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`expected ok plan, got refusal ${plan.reason}: ${plan.detail}`);
  }
  expect(plan.victims).toEqual(["chat-a"]);
  expect(plan.replacements).toEqual(["code-b"]);
  return plan;
}

async function apply(plan: OkPlan): Promise<ResidencyApplyProfileResult> {
  return await applyResidencyProfile({
    plan,
    dryRun: false,
    storePath,
    workloadsDir,
    registry: createResidencyLeases(),
    log: () => undefined,
  });
}

function operationRecord(operationId: string | null | undefined): {
  phase: string;
  outcome: string | null;
  detail: string | null;
} | null {
  expect(typeof operationId).toBe("string");
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const rec = store.getOperation(operationId ?? "");
    return rec === null
      ? null
      : { phase: rec.phase, outcome: rec.outcome ?? null, detail: rec.detail ?? null };
  } finally {
    store.close();
  }
}

beforeEach(() => {
  clock = 0;
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-sessions-"));
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
  setSessionRefcountRegistry(null);
  if (tmp !== "") {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("applyResidencyProfile session protection", () => {
  test("a session bound to a victim refuses the wet switch and records the operation failed", async () => {
    // Kills: the operation-backed runFenced call site dropping sessions,
    // or apply-profile passing sessions:null instead of relying on the seam.
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    const acquired = sessions.acquire("s1", "chat-a");
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) {
      throw new Error(`session acquire refused: ${acquired.reason}`);
    }
    sessions.release("s1", acquired.generation);
    setSessionRefcountRegistry(sessions);

    const result = await apply(planFor());

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.steps).toEqual([
      { action: "fence", workload: "chat-a", status: "failed", detail: "SessionsActive: s1" },
      { action: "drain", workload: "chat-a", status: "not-run" },
      { action: "stop", workload: "chat-a", status: "not-run" },
      { action: "start", workload: "code-b", status: "not-run" },
    ]);
    expect(stepCalls).toEqual([]);
    expect(sessions.activeSessions("chat-a")).toEqual(["s1"]);
    const rec = operationRecord(result.operationId);
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("failed");
    expect(rec?.detail ?? "").toContain("SessionsActive: s1");
  });

  test("guard: with no session on a victim the same wiring runs the switch", async () => {
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    const acquired = sessions.acquire("s-other", "code-b");
    expect(acquired.ok).toBe(true);
    setSessionRefcountRegistry(sessions);

    const result = await apply(planFor());

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(stepCalls).toEqual(["stop:chat-a", "start:code-b"]);
    const rec = operationRecord(result.operationId);
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("succeeded");
  });
});
