import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

/**
 * #517 — RED tests for the ModelRun serverStart catalog-group fallback:
 * when the stored ModelRun has no residency-group label, the direct start
 * derives the lifecycle group from the catalog row of the target passed to
 * serverStart. A present label still wins, even when it names an undeclared
 * group. Every target resolves to a missing .gguf, so the engine never
 * spawns; at base serverStart uses only the ModelRun label, so each case
 * fails BY ASSERTION on the refusal text or the recorded row.
 */
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const GROUP = "z13-large-gpu";
const OTHER_GROUP = "m4-other";
const GROUP_LABEL = "llamactl.io/residency-group";
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type SeedRow = { model: string; target: ResidencyState; group?: string };
type RunStartResult = {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  advertisedEndpoint: string;
  tunedProfile: string | null;
  retried: boolean;
  error?: string;
};

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let runtimeDir = "";
let modelsDir = "";

const storePath = (): string => defaultResidencyStorePath();

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

function seed(rows: readonly SeedRow[]): void {
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

function writeRun(
  name: string,
  target: string,
  labels: Readonly<Record<string, string>> = {},
): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name, labels },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: target },
      },
    }),
    workloadsDir,
  );
}

async function startRun(workload: string, target: string): Promise<RunStartResult> {
  const stream = await router.createCaller({}).serverStart({ workload, target });
  let result: RunStartResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: RunStartResult } | null;
    if (done?.type === "done" && done.result !== undefined) {
      result = done.result;
    }
  }
  if (result === undefined) {
    throw new Error(`serverStart(${workload}) stream ended without a done event`);
  }
  return result;
}

function refusal(name: string): string {
  return `residency lifecycle refused ${name} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by peer-qwen in state ready`;
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-modelrun-catalog-group-"));
  workloadsDir = join(root, "workloads");
  runtimeDir = join(root, "runtime");
  modelsDir = join(root, "models");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMACTL_CONFIG: join(root, "config-missing"),
    LLAMACTL_NODE_NAME: "local",
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

describe("serverStart catalog residency-group fallback", () => {
  test("CG1: an unlabelled cataloged ModelRun refuses while the group peer is ready, an uncatalogued target does not, and no store is never created", async () => {
    writeRun("glm-run", GLM_REL);
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const result = await startRun("glm-run", GLM_REL);

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(refusal("glm-run"));
    expect(readState("peer-qwen")?.state).toBe("ready");

    writeRun("other-run", "other/missing.gguf");
    const other = await startRun("other-run", "other/missing.gguf");
    expect(other.ok).toBe(false);
    expect(other.error ?? "").toMatch(/^Model file not found:/);

    rmSync(storePath());
    const withoutStore = await startRun("glm-run", GLM_REL);
    expect(withoutStore.ok).toBe(false);
    expect(withoutStore.error ?? "").toMatch(/^Model file not found:/);
    expect(existsSync(storePath())).toBe(false);
  });

  test("CG2: the input target supplies the catalog group even when no ModelRun manifest is stored", async () => {
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const result = await startRun("glm-adhoc", GLM_REL);

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(refusal("glm-adhoc"));
    expect(readState("peer-qwen")?.state).toBe("ready");
  });

  test("CG3: the fallback reaches the lifecycle row, while a present label wins over the catalog", async () => {
    writeRun("glm-run", GLM_REL);
    seed([]);

    const unlabelled = await startRun("glm-run", GLM_REL);
    expect(unlabelled.ok).toBe(false);
    expect(unlabelled.error ?? "").toMatch(/^Model file not found:/);
    expect(readState("glm-run")).toMatchObject({
      state: "failed",
      group: GROUP,
    });

    writeRun("glm-labelled", GLM_REL, { [GROUP_LABEL]: OTHER_GROUP });
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const labelled = await startRun("glm-labelled", GLM_REL);
    expect(labelled.ok).toBe(false);
    expect(labelled.error ?? "").toMatch(/^Model file not found:/);
    expect(readState("glm-labelled")).toMatchObject({
      state: "failed",
      group: null,
    });
  });

  test("CG4: the fallback resolves the input target before consulting the catalog", async () => {
    process.env["LOCAL_AI_SOURCE_MODEL"] = GLM_REL;
    try {
      writeRun("cur-run", GLM_REL);
      seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

      const result = await startRun("cur-run", "current");

      expect(result.ok).toBe(false);
      expect(result.pid).toBeNull();
      expect(result.error).toBe(refusal("cur-run"));
    } finally {
      Reflect.deleteProperty(process.env, "LOCAL_AI_SOURCE_MODEL");
    }
  });
});
