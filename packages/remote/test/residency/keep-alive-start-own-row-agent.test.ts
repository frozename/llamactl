// Part of #517 — RED tests for the agent-side keepAliveStart own-row rule.
// The worker records its residency row under the keep-alive target, so the
// pre-spawn gate must pass `ignoreModel: target`: a stale row for that same
// target never blocks a restart, while any other occupying group member does.
// At the pinned base the gate counts the target's own row and returns the
// self-refusal before spawning. The fake CLI entry only appends a marker and
// never registers a supervisor pid, so every allowed launch returns the
// procedure's existing 2s supervisor-timeout error.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;
const NONEXCLUSIVE_Z13 = [{ name: GROUP, exclusive: false }] as const;

const originalEnv = { ...process.env };
let root = "";
let storePath = "";
let marker = "";

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

// Same real-store seeding rule as the residency suites: claim under the
// apply-profile owner and walk legal edges, group on the loading hop only.
// The override is only for the deliberate two-occupant refusal-ordering row;
// declarations are not persisted, so production still reads z13 as exclusive.
function seedReady(model: string, opts: { overrideExclusivity?: boolean } = {}): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of seedPathTo("ready")) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" ? { group: GROUP } : {}),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
        ...(opts.overrideExclusivity === true ? { groups: NONEXCLUSIVE_Z13 } : {}),
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

function keepAliveStart(
  target: string,
): ReturnType<ReturnType<typeof router.createCaller>["keepAliveStart"]> {
  return router.createCaller({}).keepAliveStart({ target });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-keep-alive-own-row-"));
  const modelsDir = join(root, "models");
  const runtimeDir = join(root, "runtime");
  const binDir = join(root, "bin");
  const homeDir = join(root, "home");
  storePath = join(root, "residency", "operations.sqlite");
  marker = join(root, "keep-alive-worker.marker");
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const modelPath = join(modelsDir, GLM_REL);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, "");
  // keepAliveStart spawns `bun $LLAMACTL_HOME/packages/cli/src/bin.ts
  // keep-alive worker <target>` detached. The fake entry appends "ran" and
  // exits, so readKeepAlivePid stays null and the procedure reports its 2s
  // supervisor timeout whenever the gate correctly allows the launch.
  const entry = join(homeDir, "packages", "cli", "src", "bin.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`,
  );
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
    LLAMACTL_WORKLOADS_DIR: join(root, "workloads"),
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_BIN: binDir,
    LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    LLAMACTL_CONFIG: join(root, "config-missing"),
    LLAMACTL_NODE_NAME: "local",
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(root, "missing-custom-catalog.tsv"),
    LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
    LLAMACTL_HOME: homeDir,
  });
  Reflect.deleteProperty(process.env, "LOCAL_AI_SOURCE_MODEL");
});

afterEach(() => {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("#517 keepAliveStart own-row refusal", () => {
  // Kills: keepAliveStartRefusal not passing `ignoreModel: target` — the
  // target's stale row refuses its own restart before the fake worker entry
  // can be spawned.
  test("A1: keepAliveStart ignores the target's own ready row and falls through to the spawn path", async () => {
    seedReady(GLM_REL);
    const res = await keepAliveStart(GLM_REL);
    expect(res.ok).toBe(false);
    expect(res.pid).toBeNull();
    expect(res.error).toBe("supervisor did not register a PID within 2s");
    expect(existsSync(marker)).toBe(true);
  }, 20_000);

  // Kills: ignoreModel ignoring the whole group — after the target row is
  // filtered, the remaining peer must still produce the deterministic refusal.
  test("A2: keepAliveStart still refuses a different ready same-group peer", async () => {
    seedReady(GLM_REL);
    seedReady("peer-qwen", { overrideExclusivity: true });
    const res = await keepAliveStart(GLM_REL);
    expect(res.ok).toBe(false);
    expect(res.pid).toBeNull();
    expect(res.error).toBe(
      `keep-alive start: residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by peer-qwen in state ready`,
    );
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});
