// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal on
// the `llamactl pull file` auto-tune and `llamactl candidate test` local
// dispatch paths. At the pinned base runAutotuneAfterPull/runTest go straight
// to core's maybeTuneAfterPull/candidateTest with no launchRefusal, so the
// post-pull preset bench and the candidate-test preset step spawn the fake
// llama-bench marker and finish with "No successful benchmark profiles" — no
// residency gate exists. Post-fix both pass `launchRefusal: benchLaunchRefusal`
// into core, the step records the refusal as its skip reason, and no bench
// process spawns. Everything is hermetic: temp dirs, marker binaries that
// write a file and exit 1, a stub hf binary that materialises the pulled file,
// a real seeded residency store, in-process local dispatch via resetGlobals,
// and captured process streams. At base every case fails BY ASSERTION — never
// by import, type or exit code alone.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { configSchema } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
import { runCandidate } from "../src/commands/candidate.js";
import { runPull } from "../src/commands/pull.js";
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
const REPO = "fixture-org/GLM-5.3-Flash-AJ-GGUF";
const GROUP = "z13-large-gpu";
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
  "LOCAL_AI_HF_BIN",
  "LLAMA_CPP_AUTO_TUNE_ON_PULL",
  "LLAMA_CPP_AUTO_BENCH_VISION",
  "LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL",
  "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE",
  "LOCAL_AI_PRESET_OVERRIDES_FILE",
] as const;

let tmp = "";
let modelsDir = "";
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
  tmp = mkdtempSync(join(tmpdir(), "llamactl-pull-group-"));
  const devStorage = join(tmp, "dev-storage");
  const runtimeDir = join(tmp, "runtime");
  modelsDir = join(tmp, "models");
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
  // The mmproj sibling lets the candidate-test vision step reach the gate.
  writeFileSync(join(dirname(modelPath), "mmproj-GLM-5.3-Flash-AJ.gguf"), "");
  writeMarkerBin(binDir, "llama-bench", benchMarker);
  writeMarkerBin(binDir, "llama-mtmd-cli", mtmdMarker);
  // Stub hf: materialise the pulled file at its on-disk rel path, then exit 0.
  const hfBin = join(tmp, "hf-stub.sh");
  writeFileSync(
    hfBin,
    `#!/bin/sh\nmkdir -p "${dirname(join(modelsDir, GLM_REL))}"\n: > "${join(modelsDir, GLM_REL)}"\nexit 0\n`,
  );
  chmodSync(hfBin, 0o755);
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
    LOCAL_AI_HF_BIN: hfBin,
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(tmp, "missing-preset-overrides.tsv"),
  });
  for (const key of [
    "LOCAL_AI_SOURCE_MODEL",
    "LOCAL_AI_BENCH_IMAGE",
    "LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL",
    "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE",
    "LLAMA_CPP_AUTO_TUNE_ON_PULL",
    "LLAMA_CPP_AUTO_BENCH_VISION",
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

describe("#517 pull + candidate-test exclusive-group refusal", () => {
  // Kills: the CLI pull local branch not passing launchRefusal — at base the
  // auto-tune preset spawns the llama-bench marker (exit 1) and the skip text
  // names the bench error instead of the residency refusal.
  test("P1: pull file skips the auto-tune bench when the exclusive group is occupied", async () => {
    // pullRepoFile computes wasMissing before hf runs; the file must be absent
    // beforehand for the auto-tune to engage at all.
    rmSync(join(modelsDir, GLM_REL), { force: true });
    seedReady("peer-qwen");
    const { result, stdout } = await captureProcessStreams(() => runPull(["file", REPO, GLM_REL]));
    expect(result).toBe(0);
    expect(stdout).toContain("wasMissing=true");
    expect(stdout).toContain(`Auto-tune skipped: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: the CLI candidate test local branch not passing launchRefusal — at
  // base the preset step spawns the llama-bench marker (exit 1) and the
  // command exits 1 with the bench error.
  test("P2: candidate test skips the preset step when the exclusive group is occupied", async () => {
    seedReady("peer-qwen");
    const { result, stdout } = await captureProcessStreams(() =>
      runCandidate(["test", REPO, GLM_REL]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain(`preset skipped: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);
});
