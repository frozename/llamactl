// Part of #522 — RED tests pinning the pre-spawn exclusive-group refusal on
// the `llamactl pull file` / `llamactl pull candidate` auto-tune local
// dispatch path. At the pinned base runAutotuneAfterPull goes straight to
// core's maybeTuneAfterPull with no launchRefusal, so the post-pull preset
// bench spawns the fake llama-bench marker and finishes with "No successful
// benchmark profiles" — no residency gate exists. Post-fix the local branch
// passes `launchRefusal: benchLaunchRefusal` into core, the tune records the
// refusal as its skip reason, prints `Auto-tune skipped: <refusal>` and no
// bench process spawns. Everything is hermetic: temp dirs, a marker
// llama-bench that writes a file and exits 1, a stub hf binary that
// materialises the pulled rel, a real seeded residency store, in-process
// local dispatch via resetGlobals, and captured process streams. At base the
// killing cases fail BY ASSERTION — never by import, type or exit code alone.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { configSchema } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
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
const REPO = "owner/GLM-5.3-Flash-AJ-GGUF";
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

function writeMarkerBin(binDir: string, name: string, marker: string): void {
  const binPath = join(binDir, name);
  writeFileSync(binPath, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`);
  chmodSync(binPath, 0o755);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-pull-autotune-group-"));
  const devStorage = join(tmp, "dev-storage");
  const runtimeDir = join(tmp, "runtime");
  modelsDir = join(tmp, "models");
  const binDir = join(tmp, "bin");
  storePath = join(tmp, "residency", "operations.sqlite");
  benchMarker = join(tmp, "llama-bench.marker");
  mkdirSync(devStorage, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeMarkerBin(binDir, "llama-bench", benchMarker);
  // Stub hf: materialise the pulled rel at its on-disk path ($3 is the file
  // argument of `hf download <repo> <file> ...`), then exit 0. The model file
  // must be absent before the pull so wasMissing stays true.
  const hfBin = join(tmp, "hf-stub.sh");
  writeFileSync(
    hfBin,
    `#!/bin/sh\nmkdir -p "$(dirname "$LLAMA_CPP_MODELS/$3")"\n: > "$LLAMA_CPP_MODELS/$3"\nexit 0\n`,
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

describe("#522 pull auto-tune exclusive-group refusal", () => {
  // Kills: the CLI pull local branch not passing launchRefusal — at base the
  // auto-tune preset spawns the llama-bench marker (exit 1) and the skip text
  // names the bench error instead of the residency refusal.
  test("P1: pull file skips the auto-tune bench when the exclusive group is occupied", async () => {
    seedReady("peer-qwen");
    const { result, stdout } = await captureProcessStreams(() => runPull(["file", REPO, GLM_REL]));
    expect(result).toBe(0);
    expect(stdout).toContain(`Auto-tune skipped: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: the same unwired gate on the candidate path — `pull candidate`
  // resolves the explicit file verbatim and reaches the same
  // runAutotuneAfterPull local branch, so it must refuse identically.
  test("P2: pull candidate skips the auto-tune bench when the exclusive group is occupied", async () => {
    seedReady("peer-qwen");
    const { result, stdout } = await captureProcessStreams(() =>
      runPull(["candidate", REPO, GLM_REL]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain(`Auto-tune skipped: ${OCCUPIED_REFUSAL}`);
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Guard: refusing when there is no store file would break every pull —
  // with the store removed the tune must run exactly as before (marker
  // written, bench error surfaced as the skip reason).
  test("P3: a missing store file lets the auto-tune bench run as before", async () => {
    rmSync(storePath, { force: true });
    const { result, stdout } = await captureProcessStreams(() => runPull(["file", REPO, GLM_REL]));
    expect(result).toBe(0);
    expect(stdout).toContain("Auto-tune skipped:");
    expect(stdout).not.toContain("residency lifecycle refused");
    expect(existsSync(benchMarker)).toBe(true);
  }, 20_000);
});
