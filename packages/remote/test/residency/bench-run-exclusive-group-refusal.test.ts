/**
 * #517 — RED tests for the bench-launch exclusive-group refusal on the
 * agent-side subscription procedures. `benchPresetRun` and `benchVisionRun`
 * in src/router.ts are the bench scheduler path and the remote-dispatch
 * target of `llamactl bench preset`/`bench vision`: at the pinned base they
 * call bench.benchPreset/bench.benchVision directly, so a bench launches
 * beside an occupied z13-large-gpu group (and beside an in-flight profile
 * switch). Post-fix each procedure runs benchLaunchRefusal — the same
 * read-only, unfenced gate the CLI local branch uses — before the bench
 * call, and the stream rejects with the refusal instead of spawning.
 * Everything is hermetic: temp dirs, marker llama-bench/llama-mtmd-cli
 * scripts that write a file and exit 1, a real seeded residency store, and
 * drained subscription streams. At base every case fails BY ASSERTION on
 * the rejection message or the marker — never by import, type or exit code.
 */
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";

// The builtin z13 catalog rel (packages/core/src/catalog.ts), whose
// residencyGroup is z13-large-gpu.
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;

const OCCUPIED_REFUSAL = `residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by peer-qwen in state ready`;

const originalEnv = { ...process.env };
let root = "";
let storePath = "";
let benchMarker = "";
let mtmdMarker = "";

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

// A nonterminal profile-switch operation and no lifecycle rows.
function seedSwitchOp(): void {
  const store = openResidencyOperationStore({ path: storePath });
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

function writeMarkerBin(binDir: string, name: string, marker: string): void {
  const binPath = join(binDir, name);
  writeFileSync(binPath, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`);
  chmodSync(binPath, 0o755);
}

// benchPresetRun/benchVisionRun are subscriptions: drain the stream and keep
// the terminal rejection — the refusal post-fix, the bench error at base —
// as the assertion target. Progress events carry no assertion weight.
async function drain(stream: AsyncIterable<unknown>): Promise<{
  error: Error | null;
  events: unknown[];
}> {
  const events: unknown[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
    }
    return { error: null, events };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)), events };
  }
}

function presetRun(
  target: string,
): ReturnType<ReturnType<typeof router.createCaller>["benchPresetRun"]> {
  return router.createCaller({}).benchPresetRun({ target });
}

function visionRun(
  target: string,
): ReturnType<ReturnType<typeof router.createCaller>["benchVisionRun"]> {
  return router.createCaller({}).benchVisionRun({ target });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-bench-run-group-"));
  const modelsDir = join(root, "models");
  const runtimeDir = join(root, "runtime");
  const binDir = join(root, "bin");
  storePath = join(root, "residency", "operations.sqlite");
  benchMarker = join(root, "llama-bench.marker");
  mtmdMarker = join(root, "llama-mtmd-cli.marker");
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const modelPath = join(modelsDir, GLM_REL);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, "");
  // The mmproj sibling lets benchVision reach the spawn at base.
  writeFileSync(join(dirname(modelPath), "mmproj-GLM-5.3-Flash-AJ.gguf"), "");
  writeMarkerBin(binDir, "llama-bench", benchMarker);
  writeMarkerBin(binDir, "llama-mtmd-cli", mtmdMarker);
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
  });
  for (const key of ["LOCAL_AI_SOURCE_MODEL", "LOCAL_AI_BENCH_IMAGE"]) {
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("#517 bench run exclusive-group refusal", () => {
  // Kills: no gate in benchPresetRun — the bench scheduler path — the base
  // spawns llama-bench (marker written) and the stream rejects with "No
  // successful benchmark profiles" instead of the residency refusal.
  test("R1: benchPresetRun refuses an occupied z13-large-gpu group before spawning llama-bench", async () => {
    seedReady("peer-qwen");
    const stream = await presetRun(GLM_REL);
    const { error } = await drain(stream);
    expect(error?.message ?? "").toContain(OCCUPIED_REFUSAL);
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: gate missing from benchVisionRun — the base spawns
  // llama-mtmd-cli (marker written) and the stream rejects with the mtmd
  // failure instead of the residency refusal.
  test("R2: benchVisionRun refuses an occupied z13-large-gpu group before spawning llama-mtmd-cli", async () => {
    seedReady("peer-qwen");
    const stream = await visionRun(GLM_REL);
    const { error } = await drain(stream);
    expect(error?.message ?? "").toContain(OCCUPIED_REFUSAL);
    expect(existsSync(mtmdMarker)).toBe(false);
  }, 20_000);

  // Kills: refusing when there is no store file — with the store deleted the
  // subscription must fall through and run the bench exactly as before
  // (marker written, stream rejects with the bench error).
  test("R3: an in-flight profile switch refuses; a missing store file launches as before", async () => {
    seedSwitchOp();
    const refused = await drain(await presetRun(GLM_REL));
    expect(refused.error?.message ?? "").toContain(
      `residency lifecycle refused ${GLM_REL}: profile switch in flight on this node; retry after it settles`,
    );
    expect(existsSync(benchMarker)).toBe(false);

    rmSync(storePath, { force: true });
    const fellThrough = await drain(await presetRun(GLM_REL));
    expect(fellThrough.error?.message ?? "").toContain("No successful benchmark profiles");
    expect(existsSync(benchMarker)).toBe(true);
  }, 20_000);

  // Kills: gating the raw target instead of the resolveTarget rel — "current"
  // is not a catalog rel, so the gate would miss (findByRel("current") is
  // undefined) and the bench would launch beside the occupied group; and
  // naming the raw target in the refusal would print `refused current`.
  test("R4: target current resolves to the occupied rel and refuses naming the rel", async () => {
    process.env["LOCAL_AI_SOURCE_MODEL"] = GLM_REL;
    seedReady("peer-qwen");
    const { error } = await drain(await presetRun("current"));
    expect(error?.message ?? "").toContain(OCCUPIED_REFUSAL);
    expect(error?.message ?? "").not.toContain("refused current");
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills the same two mutations on a catalog preset alias: `best` resolves
  // through resolvePreset to the occupied rel (a qualification pin un-experimental
  // -pins it so the env preset override is not skipped), so the gate must fire
  // and the refusal must name the resolved rel, never the alias `best`.
  test("R5: a catalog alias resolving to the occupied rel refuses naming the rel", async () => {
    const overrideFile = join(root, "qualification-overrides.tsv");
    writeFileSync(
      overrideFile,
      `${GLM_REL}\tpin\tvalidated\ttest\talias-resolution\t2026-01-01T00:00:00Z\n`,
    );
    Object.assign(process.env, {
      LOCAL_AI_QUALIFICATION_OVERRIDES_FILE: overrideFile,
      LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL: GLM_REL,
      LOCAL_AI_PRESET_OVERRIDES_FILE: join(root, "missing-preset-overrides.tsv"),
    });
    seedReady("peer-qwen");
    const { error } = await drain(await presetRun("best"));
    expect(error?.message ?? "").toContain(OCCUPIED_REFUSAL);
    expect(error?.message ?? "").not.toContain("refused best");
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);
});
