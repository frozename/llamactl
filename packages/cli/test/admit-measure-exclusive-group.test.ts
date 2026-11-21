// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal in
// `llamactl admit measure`. At the pinned base runAdmitMeasure goes straight
// from readLaunchConfig to runMeasureAttempt, so the marker binary runs,
// exits 1, waitForHealth polls until spec.timeoutSeconds (1s) and the
// attempt reports "process exited before health check passed" — status 1
// with the marker file present, never the refusal line. Post-fix the guard
// fires before runMeasureAttempt: status 1, the refusal on stderr, no
// marker, no measured-memory cache. The CLI runs as a real subprocess like
// admit-measure.test.ts, with --port=<free> keeping maxAttempts=1, a 15s
// spawnSync timeout under a 20s test timeout, and r.error asserted so a
// spawn timeout surfaces as an assertion failure.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";
import type { SpawnSyncReturns } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;
// The builtin z13 catalog rel (packages/core/src/catalog.ts), whose
// residencyGroup is z13-large-gpu — A2's catalog fallback target.
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";

let tmp = "";
let storePath = "";
let cachePath = "";
let modelsDir = "";
let markerPath = "";
let binaryPath = "";
let yamlDir = "";

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

// Real-store seed of qwen-prod ready under the apply-profile fence owner —
// the same seeding rule the residency suites use.
function seedReady(model: string): void {
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
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

function buildWorkloadYaml(labelsYaml: string, modelRel: string): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    "  name: test-measure-workload",
    "  labels:",
    labelsYaml,
    "spec:",
    "  node: local",
    "  enabled: true",
    `  binary: "${binaryPath}"`,
    "  timeoutSeconds: 1",
    "  resources:",
    "    expectedMemoryGiB: 2",
    "  target:",
    "    kind: rel",
    `    value: ${modelRel}`,
    "  extraArgs: []",
    "  restartPolicy: Always",
  ].join("\n");
}

function buildModelHostYaml(labelsYaml: string, modelRel: string): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelHost",
    "metadata:",
    "  name: test-measure-host",
    "  labels:",
    labelsYaml,
    "spec:",
    "  engine: omlx",
    "  node: local",
    "  enabled: true",
    `  binary: "${binaryPath}"`,
    "  timeoutSeconds: 1",
    "  resources:",
    "    expectedMemoryGiB: 2",
    "  hostedModels:",
    `    - rel: ${modelRel}`,
    "  extraArgs: []",
  ].join("\n");
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function runMeasure(yamlPath: string, port: number): SpawnSyncReturns<string> {
  return spawnSync("bun", [BIN, "admit", "measure", yamlPath, `--port=${String(port)}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLAMACTL_RESIDENCY_STORE: storePath,
      LLAMACTL_MEASURED_MEMORY_PATH: cachePath,
      LOCAL_AI_CUSTOM_CATALOG_FILE: join(tmp, "missing-custom-catalog.tsv"),
      LLAMA_CPP_MODELS: modelsDir,
    },
    timeout: 15_000,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-admit-measure-exclusive-"));
  storePath = join(tmp, "residency", "operations.sqlite");
  cachePath = join(tmp, "measured-memory.json");
  modelsDir = join(tmp, "models");
  markerPath = join(tmp, "marker");
  yamlDir = join(tmp, "yaml");
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(yamlDir, { recursive: true });
  binaryPath = join(tmp, "marker-server.sh");
  writeFileSync(binaryPath, `#!/bin/sh\necho ran >> "${markerPath}"\nexit 1\n`);
  chmodSync(binaryPath, 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

describe("#517 admit measure exclusive-group refusal", () => {
  // Kills: the guard removed from runAdmitMeasure or the
  // llamactl.io/residency-group label never read — the marker binary runs
  // and the measured-memory path is exercised instead of refusing.
  test("A1: the residency-group label refuses before any spawn", async () => {
    seedReady("qwen-prod");
    const yamlPath = join(yamlDir, "a1.yaml");
    writeFileSync(
      yamlPath,
      buildWorkloadYaml("    llamactl.io/residency-group: z13-large-gpu", "test/fake-model.gguf"),
    );
    const port = await freePort();
    const r = runMeasure(yamlPath, port);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "admit measure: residency lifecycle refused test-measure-workload downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready",
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  }, 20_000);

  // Kills: the catalog fallback dropped — with no label the group must
  // come from the catalog row of spec.target.value, so the GLM rel still
  // refuses through z13-large-gpu.
  test("A2: the catalog row of the model rel refuses with empty labels", async () => {
    seedReady("qwen-prod");
    const yamlPath = join(yamlDir, "a2.yaml");
    writeFileSync(yamlPath, buildWorkloadYaml("    {}", GLM_REL));
    const port = await freePort();
    const r = runMeasure(yamlPath, port);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "admit measure: residency lifecycle refused test-measure-workload downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready",
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  }, 20_000);
  // Kills M18: the ModelHost (omlx) branch of readLaunchConfig dropping
  // `residencyGroup = resolveResidencyGroup(meta, modelRel);` — the group
  // is then undefined, the guard never fires, and the marker binary runs.
  test("A3: a ModelHost residency-group label refuses before any spawn", async () => {
    seedReady("qwen-prod");
    const yamlPath = join(yamlDir, "a3.yaml");
    writeFileSync(
      yamlPath,
      buildModelHostYaml("    llamactl.io/residency-group: z13-large-gpu", "test/fake-mlx-model"),
    );
    const port = await freePort();
    const r = runMeasure(yamlPath, port);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "admit measure: residency lifecycle refused test-measure-host downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready",
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  }, 20_000);

  // Kills M18 via the catalog fallback: with no label, the ModelHost group
  // must come from the catalog row of hostedModels[0].rel (GLM, in
  // z13-large-gpu); deleting the omlx-branch resolveResidencyGroup call
  // lets the marker binary run instead.
  test("A3b: a ModelHost hostedModels[0].rel catalog row refuses with empty labels", async () => {
    seedReady("qwen-prod");
    const yamlPath = join(yamlDir, "a3b.yaml");
    writeFileSync(yamlPath, buildModelHostYaml("    {}", GLM_REL));
    const port = await freePort();
    const r = runMeasure(yamlPath, port);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "admit measure: residency lifecycle refused test-measure-host downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready",
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  }, 20_000);
});
