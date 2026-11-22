// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal in
// `llamactl bench preset` and `llamactl bench vision` on local dispatch. At
// the pinned base runPreset/runVision go straight from flag parsing to
// bench.benchPreset/bench.benchVision, which spawn the fake llama-bench /
// llama-mtmd-cli markers and finish with "No successful benchmark profiles"
// or the mmproj/mtmd error — no residency gate exists. Post-fix both verbs
// resolve the target through resolveTarget and read the local residency
// store read-only through benchLaunchRefusal before the bench call, exiting 1
// with `bench preset: ` / `bench vision: ` + the refusal and never spawning.
// Everything is hermetic: temp dirs, marker binaries that write a file and
// exit 1, a real seeded residency store, in-process local dispatch via
// resetGlobals, and captured process streams.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { configSchema } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
import { runBench } from "../src/commands/bench.js";
import { __resetTestSeams, __setTestSeams, resetGlobals } from "../src/dispatcher.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

// The builtin z13 catalog rel (packages/core/src/catalog.ts), whose
// residencyGroup is z13-large-gpu.
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const UNCATALOGUED_REL = "Uncatalogued-GGUF/uncatalogued-Q4_K_M.gguf";
const NOW = 1_000_000_000;

const OCCUPIED_REFUSAL = `residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by peer-qwen in state ready`;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_LOGS",
  "LLAMACTL_CONFIG",
  "LLAMACTL_RESIDENCY_STORE",
  "LOCAL_AI_CUSTOM_CATALOG_FILE",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_BIN",
  "LLAMA_CPP_HOST",
  "LLAMA_CPP_PORT",
  "LLAMA_CPP_MACHINE_PROFILE",
  "LOCAL_AI_SOURCE_MODEL",
  "LOCAL_AI_BENCH_IMAGE",
  "LOCAL_AI_RECOMMENDATIONS_SOURCE",
  "LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL",
  "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE",
  "LOCAL_AI_PRESET_OVERRIDES_FILE",
] as const;

let tmp = "";
let storePath = "";
let benchMarker = "";
let mtmdMarker = "";
let savedEnv: Record<string, string | undefined> = {};

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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-bench-group-"));
  const devStorage = join(tmp, "dev-storage");
  const runtimeDir = join(tmp, "runtime");
  const modelsDir = join(tmp, "models");
  const binDir = join(tmp, "bin");
  storePath = join(tmp, "residency", "operations.sqlite");
  benchMarker = join(tmp, "llama-bench.marker");
  mtmdMarker = join(tmp, "llama-mtmd-cli.marker");
  mkdirSync(devStorage, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const modelPath = join(modelsDir, GLM_REL);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, "");
  // The mmproj sibling lets `bench vision` reach the spawn at base; the
  // uncatalogued rel is a literal passthrough with no catalog row.
  writeFileSync(join(dirname(modelPath), "mmproj-GLM-5.3-Flash-AJ.gguf"), "");
  const uncataloguedPath = join(modelsDir, UNCATALOGUED_REL);
  mkdirSync(dirname(uncataloguedPath), { recursive: true });
  writeFileSync(uncataloguedPath, "");
  writeMarkerBin(binDir, "llama-bench", benchMarker);
  writeMarkerBin(binDir, "llama-mtmd-cli", mtmdMarker);
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    DEV_STORAGE: devStorage,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_LOGS: join(tmp, "logs"),
    LLAMACTL_CONFIG: join(tmp, "config", "llamactl.yaml"),
    LLAMACTL_RESIDENCY_STORE: storePath,
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(tmp, "missing-custom-catalog.tsv"),
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_BIN: binDir,
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: "65534",
    LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(tmp, "missing-preset-overrides.tsv"),
  });
  for (const key of [
    "LOCAL_AI_SOURCE_MODEL",
    "LOCAL_AI_BENCH_IMAGE",
    "LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL",
    "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE",
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
  __setTestSeams({ config: configSchema.freshConfig() });
  resetGlobals();
});

afterEach(() => {
  __resetTestSeams();
  resetGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

describe("#517 bench exclusive-group refusal", () => {
  // Kills: no gate in the runPreset local branch, or a gate placed after
  // bench.benchPreset — the base prints "No successful benchmark profiles"
  // and the llama-bench marker proves the spawn already ran.
  test("B1: bench preset refuses an occupied z13-large-gpu group before spawning llama-bench", async () => {
    seedReady("peer-qwen");
    const { result, stderr } = await captureProcessStreams(() => runBench(["preset", GLM_REL]));
    expect(result).toBe(1);
    expect(stderr).toContain(`bench preset: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: gate missing from runVision — the base reaches the mmproj check
  // and the llama-mtmd-cli spawn (marker written) instead of refusing.
  test("B2: bench vision refuses an occupied z13-large-gpu group before spawning llama-mtmd-cli", async () => {
    seedReady("peer-qwen");
    const { result, stderr } = await captureProcessStreams(() => runBench(["vision", GLM_REL]));
    expect(result).toBe(1);
    expect(stderr).toContain(`bench vision: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(mtmdMarker)).toBe(false);
  }, 20_000);

  // Kills: gating the raw target instead of the resolveTarget rel — "current"
  // is not a catalog rel, so the gate would miss and the refusal would name
  // `current` (or never fire) instead of GLM_REL.
  test("B3: the default target current resolves to the occupied rel and refuses naming the rel", async () => {
    process.env["LOCAL_AI_SOURCE_MODEL"] = GLM_REL;
    seedReady("peer-qwen");
    const { result, stderr } = await captureProcessStreams(() => runBench(["preset"]));
    expect(result).toBe(1);
    expect(stderr).toContain(`bench preset: ${OCCUPIED_REFUSAL}`);
    expect(stderr).not.toContain("refused current");
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: refusing when there is no store file — with the store deleted the
  // bench must fall through and launch exactly as before (marker written).
  test("B4: an in-flight profile switch refuses; a missing store file launches as before", async () => {
    seedSwitchOp();
    const first = await captureProcessStreams(() => runBench(["preset", GLM_REL]));
    expect(first.result).toBe(1);
    expect(first.stderr).toContain(
      `bench preset: residency lifecycle refused ${GLM_REL}: profile switch in flight on this node; retry after it settles`,
    );
    expect(existsSync(benchMarker)).toBe(false);

    rmSync(storePath, { force: true });
    const second = await captureProcessStreams(() => runBench(["preset", GLM_REL]));
    expect(second.result).toBe(1);
    expect(second.stderr).not.toContain("residency lifecycle refused");
    expect(existsSync(benchMarker)).toBe(true);
  }, 20_000);

  // Kills: throwing or refusing for an uncatalogued or unresolvable target —
  // the occupied group must refuse only the catalogued GLM_REL; every other
  // target keeps its pre-gate behaviour.
  test("B5: the occupied group refuses GLM_REL while uncatalogued and unknown targets fall through", async () => {
    seedReady("peer-qwen");
    const refused = await captureProcessStreams(() => runBench(["preset", GLM_REL]));
    expect(refused.result).toBe(1);
    expect(refused.stderr).toContain(`bench preset: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(benchMarker)).toBe(false);

    rmSync(benchMarker, { force: true });
    const uncatalogued = await captureProcessStreams(() => runBench(["preset", UNCATALOGUED_REL]));
    expect(uncatalogued.stderr).not.toContain("residency lifecycle refused");
    expect(existsSync(benchMarker)).toBe(true);

    rmSync(benchMarker, { force: true });
    const unknown = await captureProcessStreams(() => runBench(["preset", "nope-target"]));
    expect(unknown.result).toBe(1);
    expect(unknown.stderr).toContain("Unknown bench target: nope-target");
    expect(unknown.stderr).not.toContain("residency lifecycle refused");
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);
});
