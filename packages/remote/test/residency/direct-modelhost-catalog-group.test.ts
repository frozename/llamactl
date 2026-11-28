import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

/**
 * #517 — RED tests for the ModelHost catalog-group fallback: when neither the
 * inline nor stored ModelHost carries a residency-group label, modelHostStart
 * derives the lifecycle group from the catalog row of the hosted rel. A label
 * still wins, even when it names an undeclared group, and an inline hosted rel
 * wins over the stored host's rel. Every host binds 0.0.0.0 without
 * allowExternalBind, so startModelHost refuses before any spawn; at base the
 * fallback is missing, so each case fails BY ASSERTION on the refusal text or
 * the recorded row.
 */
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";

const GROUP = "z13-large-gpu";
const OTHER_GROUP = "m4-other";
const GROUP_LABEL = "llamactl.io/residency-group";
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type SeedRow = { model: string; target: ResidencyState; group?: string };
type HostResult = { ok: boolean; pid: number | null; error?: string };
type HostManifest = ReturnType<typeof parseModelHost>;

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let fakeBinary = "";
let nextPort = 0;

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

function hostYaml(name: string, rel: string, group?: string): string {
  const port = nextPort;
  nextPort += 1;
  const labels = group === undefined ? "" : `  labels:\n    ${GROUP_LABEL}: ${group}\n`;
  return `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${name}
${labels}spec:
  engine: omlx
  node: local
  enabled: true
  binary: ${fakeBinary}
  endpoint:
    host: 0.0.0.0
    port: ${String(port)}
  hostedModels:
    - rel: ${rel}
`;
}

function writeHost(name: string, rel: string, group?: string): void {
  saveModelHost(parseModelHost(hostYaml(name, rel, group)), workloadsDir);
}

function inlineHost(name: string, rel: string, group?: string): HostManifest {
  return parseModelHost(hostYaml(name, rel, group));
}

function bindRefusal(name: string): string {
  return `refusing to bind ModelHost ${name} to 0.0.0.0 without \`allowExternalBind: true\` in the workload spec`;
}

function refusal(name: string): string {
  return `residency lifecycle refused ${name} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by peer-qwen in state ready`;
}

async function startWorkload(
  workload: string,
  manifest?: HostManifest,
  managedLaunchAdmission?: ManagedLaunchAdmission,
): Promise<HostResult> {
  const caller = router.createCaller(
    managedLaunchAdmission === undefined ? {} : { managedLaunchAdmission },
  );
  const stream = await caller.modelHostStart({
    workload,
    ...(manifest !== undefined ? { manifest } : {}),
  });
  let result: HostResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: HostResult } | null;
    if (done?.type === "done" && done.result !== undefined) {
      result = done.result;
    }
  }
  if (result === undefined) {
    throw new Error(`modelHostStart(${workload}) stream ended without a done event`);
  }
  return result;
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-modelhost-catalog-group-"));
  workloadsDir = join(root, "workloads");
  fakeBinary = join(root, "fake-omlx");
  nextPort = 18120;
  writeFileSync(fakeBinary, "");
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LLAMA_CPP_MODELS: join(root, "models"),
    LLAMACTL_CONFIG: join(root, "no-such-kubeconfig.yaml"),
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

describe("modelHostStart catalog residency-group fallback", () => {
  test("MH1: a stored unlabelled ModelHost uses its hosted catalog rel, while an uncatalogued rel and a missing store do not", async () => {
    writeHost("glm-host", GLM_REL);
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const result = await startWorkload("glm-host");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(refusal("glm-host"));
    expect(readState("peer-qwen")?.state).toBe("ready");

    writeHost("other-host", "other/missing.gguf");
    const other = await startWorkload("other-host");
    expect(other.ok).toBe(false);
    expect(other.error).toBe(bindRefusal("other-host"));

    rmSync(storePath());
    const withoutStore = await startWorkload("glm-host");
    expect(withoutStore.ok).toBe(false);
    expect(withoutStore.error).toBe(bindRefusal("glm-host"));
    expect(existsSync(storePath())).toBe(false);
  });

  test("MH2: an unstored inline ModelHost uses the catalog group of its hosted rel", async () => {
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const result = await startWorkload("glm-inline", inlineHost("glm-inline", GLM_REL));

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(refusal("glm-inline"));
    expect(readState("peer-qwen")?.state).toBe("ready");
  });

  test("MH3: the catalog fallback reaches the lifecycle row, while a present label wins over the catalog", async () => {
    writeHost("glm-host", GLM_REL);
    seed([]);

    const unlabelled = await startWorkload("glm-host");
    expect(unlabelled.ok).toBe(false);
    expect(unlabelled.error).toBe(bindRefusal("glm-host"));
    expect(readState("glm-host")).toMatchObject({
      state: "failed",
      group: GROUP,
    });

    writeHost("glm-labelled", GLM_REL, OTHER_GROUP);
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const labelled = await startWorkload("glm-labelled");
    expect(labelled.ok).toBe(false);
    expect(labelled.error).toBe(bindRefusal("glm-labelled"));
    expect(readState("glm-labelled")).toMatchObject({
      state: "failed",
      group: null,
    });
  });

  test("MH4: the inline hosted rel wins over the stored rel, but the stored label still wins over both", async () => {
    writeHost("glm-host", "other/missing.gguf");
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);

    const inlineRel = await startWorkload("glm-host", inlineHost("glm-host", GLM_REL));

    expect(inlineRel.ok).toBe(false);
    expect(inlineRel.pid).toBeNull();
    expect(inlineRel.error).toBe(refusal("glm-host"));

    writeHost("glm-host", "other/missing.gguf", OTHER_GROUP);
    const storedLabel = await startWorkload("glm-host", inlineHost("glm-host", GLM_REL));
    expect(storedLabel.ok).toBe(false);
    expect(storedLabel.error).toBe(bindRefusal("glm-host"));
  });

  test("a pinned managed ModelHost keeps the catalog group guard before engine startup", async () => {
    seed([{ model: "peer-qwen", target: "ready", group: GROUP }]);
    const commits: number[] = [];
    const admissions: string[] = [];
    const owner: ManagedLaunchAdmission = {
      run: (request, _signal, start) => {
        expect(request.effectiveLaunch).toMatchObject({ hostedModels: [{ rel: GLM_REL }] });
        admissions.push(request.runtimeKey);
        return start((pid) => {
          commits.push(pid);
          return undefined;
        });
      },
    };

    const result = await startWorkload("glm-managed", inlineHost("glm-managed", GLM_REL), owner);

    expect(result).toEqual({ ok: false, pid: null, error: refusal("glm-managed") });
    expect(admissions).toEqual(["glm-managed"]);
    expect(commits).toEqual([]);
    expect(readState("peer-qwen")?.state).toBe("ready");
  });
});
