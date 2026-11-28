import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
/**
 * #517 — RED tests for threading `isProvenDown` through the live
 * apply-profile path and for wiring the router to `directWorkloadProvenDown`.
 * The executor-level contract is pinned in profile-switch-unproven-peer:
 * uncorroborated ready peers are reconciled only when proven down, while
 * loading peers fail closed unprobed. At base apply-profile never forwards a
 * predicate and the router wires none, so stale peers are reconciled
 * unconditionally and every RED case fails BY ASSERTION — never by import,
 * type or exit code.
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
  type ApplyResidencyProfileArgs,
  RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
  type ResidencyApplyProfileResult,
} from "../../src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const NOW = 1_000_000_000;
const GROUP_LABEL = "llamactl.io/residency-group";
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const GROUP = "z13-large-gpu";
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
] as const;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type ApplyArgsWithProvenDown = ApplyResidencyProfileArgs & {
  isProvenDown?: (model: string) => boolean;
};

let tmp = "";
let workloadsDir = "";
let storePath = "";
let runtimeDir = "";
let savedEnv: Record<string, string | undefined> = {};
let stepCalls: [string, string][] = [];

function runManifest(
  name: string,
  profiles: string,
  options: {
    phase?: "Pending" | "Running" | "Failed" | "Stopped";
    expectedMemoryGiB?: number;
    group?: string | null;
  } = {},
): ModelRun {
  const group = options.group === undefined ? GROUP : options.group;
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
      ...(group === null ? {} : { labels: { [GROUP_LABEL]: group } }),
      annotations: { [PROFILES_ANNOTATION]: profiles },
    },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
      resources: { expectedMemoryGiB: options.expectedMemoryGiB ?? 10 },
    },
    ...(options.phase === undefined
      ? {}
      : {
          status: {
            phase: options.phase,
            lastTransitionTime: "2026-01-01T00:00:00.000Z",
          },
        }),
  });
}

function seedLiveFixture(): void {
  saveWorkload(runManifest("chat-a", "chat"), workloadsDir);
  saveWorkload(runManifest("code-b", "code"), workloadsDir);
}

function seedRouterFixture(): void {
  saveWorkload(
    runManifest("chat-a", "chat", {
      phase: "Running",
      expectedMemoryGiB: 10,
      group: null,
    }),
    workloadsDir,
  );
  saveWorkload(
    runManifest("code-b", "code", {
      phase: "Stopped",
      expectedMemoryGiB: 12,
    }),
    workloadsDir,
  );
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
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
// does not report the seeded fence as a foreign owner.
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

// The planner workloads deliberately carry no `group`: membership must come
// from the manifest labels through the live path's groupOf, not from plan
// input.
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

async function apply(
  plan: OkPlan,
  logs: string[],
  isProvenDown?: (model: string) => boolean,
): Promise<ResidencyApplyProfileResult> {
  const args: ApplyArgsWithProvenDown = {
    plan,
    dryRun: false,
    storePath,
    workloadsDir,
    registry: null,
    log: (line) => logs.push(line),
    ...(isProvenDown === undefined ? {} : { isProvenDown }),
  };
  return await applyResidencyProfile(args);
}

function writeKeepAliveState(target: string): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "llama-keep-alive.state"),
    `target=${target}\nmodel=${GLM_REL}\nstate=ready\n`,
  );
}

function codeStartStep(
  result: ResidencyApplyProfileResult,
): ResidencyApplyProfileResult["steps"][number] | undefined {
  return result.steps.find((step) => step.action === "start" && step.workload === "code-b");
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-unproven-peer-"));
  workloadsDir = join(tmp, "workloads");
  storePath = join(tmp, "residency", "operations.sqlite");
  runtimeDir = join(tmp, "runtime");
  savedEnv = {};
  for (const key of ROUTER_ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_RESIDENCY_STORE: storePath,
    LLAMACTL_NODE_NAME: "local",
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
  });
  stepCalls = [];
  seedLiveFixture();
  __setResidencyApplyProfileStepsForTests(recordingSteps());
});

afterEach(() => {
  __setResidencyApplyProfileStepsForTests(null);
  setResidencyLeaseRegistry(null);
  for (const key of ROUTER_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  if (tmp !== "") {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("applyResidencyProfile unproven exclusive-group peers", () => {
  test("AU1: an unproven ready peer refuses the live replacement start", async () => {
    // kills: apply-profile accepting but not forwarding isProvenDown into
    // operation.lifecycle.
    seed("deepseek-x", "ready", GROUP);
    const logs: string[] = [];

    const result = await apply(planFor(), logs, () => false);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    const step = codeStartStep(result);
    expect(step?.status).toBe("failed");
    expect(step?.detail ?? "").toContain("ExclusiveGroupOccupied");
    expect(step?.detail ?? "").toContain("deepseek-x");
    expect(stepCalls).not.toContainEqual(["start", "code-b"]);
    expect(withStore((store) => store.getResidencyState("deepseek-x")?.state)).toBe("ready");
  });

  test("AU1b: a loading peer fails closed even when its probe would return true", async () => {
    // kills: probing loading rows through the live path; a direct start may
    // be occupying the row before its pid file exists.
    seed("deepseek-x", "loading", GROUP);
    const logs: string[] = [];

    const result = await apply(planFor(), logs, () => true);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    const step = codeStartStep(result);
    expect(step?.status).toBe("failed");
    expect(step?.detail ?? "").toContain("ExclusiveGroupOccupied");
    expect(step?.detail ?? "").toContain("deepseek-x");
    expect(stepCalls).not.toContainEqual(["start", "code-b"]);
    expect(withStore((store) => store.getResidencyState("deepseek-x")?.state)).toBe("loading");
  });

  test("AU2: a ready peer proven down is reconciled through the live path", async () => {
    // kills: forwarding a predicate that is never consulted. At base the
    // unconditional reconcile makes every row/result assertion pass; the
    // recorded probe call is the RED.
    seed("deepseek-x", "ready", GROUP);
    const logs: string[] = [];
    const calls: string[] = [];

    const result = await apply(planFor(), logs, (model) => {
      calls.push(model);
      return true;
    });

    expect(result.ok).toBe(true);
    expect(withStore((store) => store.getResidencyState("deepseek-x")?.state)).toBe("downloaded");
    expect(withStore((store) => store.getResidencyState("code-b")?.state)).toBe("ready");
    expect(calls).toContain("deepseek-x");
  });
});

describe("residencyApplyProfile router proven-down wiring", () => {
  test.each(["different ModelRun generation", "malformed ModelRun sidecar", "corrupt supervisor"])(
    "a %s keeps the exclusive peer in place",
    async (record) => {
      seedRouterFixture();
      const peer = record === "corrupt supervisor" ? "glm-keepalive" : "exclusive-peer";
      if (record === "corrupt supervisor") {
        writeKeepAliveState(peer);
        writeFileSync(join(runtimeDir, "llama-keep-alive.pid"), "incomplete-pid");
      } else {
        const dir = join(runtimeDir, "workloads", peer);
        mkdirSync(dir, { recursive: true });
        saveWorkload(runManifest(peer, "other", { phase: "Stopped" }), workloadsDir);
        writeFileSync(join(dir, "llama-server.pid"), "2147483647\n");
        const sidecar = {
          pid: process.pid,
          rel: "org/repo/run.gguf",
          extraArgs: [],
          startedAt: new Date().toISOString(),
          host: "127.0.0.1",
          port: 18080,
        };
        writeFileSync(
          join(dir, "llama-server.state"),
          record === "different ModelRun generation" ? JSON.stringify(sidecar) : "{",
        );
      }
      seed(peer, "ready", GROUP);
      const result = await router.createCaller({}).residencyApplyProfile({
        node: "local",
        to: "code",
        from: "chat",
        dryRun: false,
        confirm: true,
      });
      expect(result.ok).toBe(false);
      expect(codeStartStep(result)?.detail).toContain("ExclusiveGroupOccupied");
      expect(stepCalls).not.toContainEqual(["start", "code-b"]);
      expect(withStore((store) => store.getResidencyState(peer)?.state)).toBe("ready");
    },
  );

  test.each(["ModelRun PID", "ModelHost state", "ModelHost starting record"])(
    "%s keeps an exclusive peer in place when its exit is unverified",
    async (record) => {
      const peer = "exclusive-peer";
      seedRouterFixture();
      const dir = join(runtimeDir, "workloads", peer);
      mkdirSync(dir, { recursive: true });
      if (record === "ModelRun PID") {
        saveWorkload(runManifest(peer, "other", { phase: "Stopped" }), workloadsDir);
        writeFileSync(join(dir, "llama-server.pid"), "incomplete-pid");
      } else {
        saveModelHost(
          parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${peer}
  labels: { llamactl.io/residency-group: ${GROUP} }
  annotations: { llamactl.io/residency-profiles: other }
spec:
  node: local
  engine: llamacpp
  binary: /fixture/llama-server
  endpoint: { host: 127.0.0.1, port: 18080 }
  hostedModels: [{ rel: fake.gguf }]
  resources: { expectedMemoryGiB: 10 }
`),
          workloadsDir,
        );
        if (record === "ModelHost state") {
          writeFileSync(join(dir, "modelhost.state"), "{");
        } else {
          writeFileSync(
            join(dir, "modelhost.starting"),
            JSON.stringify({
              kind: "ModelHostStarting",
              engine: "llamacpp",
              pid: process.pid,
              startedAt: new Date().toISOString(),
            }),
          );
        }
      }
      seed(peer, "ready", GROUP);
      const result = await router.createCaller({}).residencyApplyProfile({
        node: "local",
        to: "code",
        from: "chat",
        dryRun: false,
        confirm: true,
      });
      expect(result.ok).toBe(false);
      expect(codeStartStep(result)?.detail).toContain("ExclusiveGroupOccupied");
      expect(stepCalls).not.toContainEqual(["start", "code-b"]);
      expect(withStore((store) => store.getResidencyState(peer)?.state)).toBe("ready");
    },
  );

  test("AU3: the router refuses an unproven keep-alive-named ready row", async () => {
    // kills: the router omitting directWorkloadProvenDown from the wet
    // apply-profile call. glm-keepalive has no manifest, no keep-alive state
    // file and no server sidecar here, so the production predicate cannot
    // prove it down.
    seedRouterFixture();
    seed("glm-keepalive", "ready", GROUP);

    const result = await router.createCaller({}).residencyApplyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(false);
    const step = codeStartStep(result);
    expect(step?.status).toBe("failed");
    expect(step?.detail ?? "").toContain("ExclusiveGroupOccupied");
    expect(step?.detail ?? "").toContain("glm-keepalive");
    expect(stepCalls).not.toContainEqual(["start", "code-b"]);
    expect(withStore((store) => store.getResidencyState("glm-keepalive")?.state)).toBe("ready");
  });

  test("AU4: the router reconciles a provably dead keep-alive row", async () => {
    // Guard: this may pass at base because reconciliation is unconditional;
    // it pins that wiring the predicate does not wedge a crash-left
    // keep-alive row whose state file, absent supervisor and absent server
    // pid all prove it down.
    seedRouterFixture();
    seed("glm-keepalive", "ready", GROUP);
    writeKeepAliveState("glm-keepalive");

    const result = await router.createCaller({}).residencyApplyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(withStore((store) => store.getResidencyState("glm-keepalive")?.state)).toBe(
      "downloaded",
    );
    expect(withStore((store) => store.getResidencyState("code-b")?.state)).toBe("ready");
    expect(stepCalls).toContainEqual(["start", "code-b"]);
  });
});
