/**
 * #522 — RED tests for the post-pull auto-tune exclusive-group refusal on the
 * agent-side `autotuneAfterPull` subscription procedure. At the pinned base
 * the procedure calls autotune.maybeTuneAfterPull with no launchRefusal, so a
 * pull auto-tune launches llama-bench beside an occupied z13-large-gpu group
 * (and beside an in-flight profile switch). Post-fix the procedure passes
 * `launchRefusal: benchLaunchRefusal`, maybeTuneAfterPull records the refusal
 * as the preset step's `{ ran: false, reason: { kind: "launch-refused" } }`,
 * and the done-tune result carries it instead of spawning. Everything is
 * hermetic: temp dirs, marker llama-bench/llama-mtmd-cli scripts that write a
 * file and exit 1, a real seeded residency store, a pre-created model file,
 * and drained subscription streams. At base every killing case fails BY
 * ASSERTION on the report or the marker — never by import, type or exit code.
 */
import type { autotune } from "@llamactl/core";
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
const SWITCH_REFUSAL = `residency lifecycle refused ${GLM_REL}: profile switch in flight on this node; retry after it settles`;

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

// autotuneAfterPull is a subscription: drain the stream and keep the
// done-tune payload — the refusal report post-fix, the bench error at base —
// as the assertion target. Bench progress events carry no assertion weight.
async function drainTune(
  stream: AsyncIterable<unknown>,
): Promise<autotune.MaybeTuneAfterPullResult> {
  let result: autotune.MaybeTuneAfterPullResult | null = null;
  for await (const event of stream) {
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: unknown }).type === "done-tune"
    ) {
      result = (event as { result: autotune.MaybeTuneAfterPullResult }).result;
    }
  }
  if (result === null) {
    throw new Error("autotuneAfterPull stream completed without a done-tune event");
  }
  return result;
}

function tuneRun(
  rel: string,
  wasMissing: boolean,
): ReturnType<ReturnType<typeof router.createCaller>["autotuneAfterPull"]> {
  return router.createCaller({}).autotuneAfterPull({ rel, wasMissing });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-autotune-group-"));
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
  // The mmproj sibling lets the vision step reach its checks if the preset
  // ever ran; the catalog class still gates it out for this rel.
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
  for (const key of [
    "LOCAL_AI_SOURCE_MODEL",
    "LOCAL_AI_BENCH_IMAGE",
    "LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL",
    "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE",
    "LOCAL_AI_PRESET_OVERRIDES_FILE",
    "LLAMA_CPP_AUTO_TUNE_ON_PULL",
    "LLAMA_CPP_AUTO_BENCH_VISION",
  ]) {
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

describe("#522 autotune-after-pull exclusive-group refusal", () => {
  // Kills: the router autotuneAfterPull procedure not passing
  // launchRefusal — at base maybeTuneAfterPull spawns the llama-bench marker
  // (exit 1) and the done-tune preset reason is the bench error, not the
  // residency refusal.
  test("R1: autotuneAfterPull refuses an occupied z13-large-gpu group before spawning llama-bench", async () => {
    seedReady("peer-qwen");
    const result = await drainTune(await tuneRun(GLM_REL, true));
    // `as unknown`: the launch-refused kind does not exist in the base
    // MaybeTuneSkipReason union — the pin must fail by assertion, not type.
    expect(result.preset as unknown).toEqual({
      ran: false,
      reason: { kind: "launch-refused", message: OCCUPIED_REFUSAL },
    });
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: the same unwired gate against a nonterminal profile switch — the
  // refusal must carry the switch-in-flight message, not the bench error.
  test("R2: autotuneAfterPull refuses while a profile switch is in flight", async () => {
    seedSwitchOp();
    const result = await drainTune(await tuneRun(GLM_REL, true));
    expect(result.preset as unknown).toEqual({
      ran: false,
      reason: { kind: "launch-refused", message: SWITCH_REFUSAL },
    });
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Guard: refusing when there is no store file would break every pull —
  // with the store deleted the tune must fall through and run the bench
  // exactly as before (marker written, preset reports the bench error).
  test("R3: a missing store file lets the auto-tune bench run as before", async () => {
    rmSync(storePath, { force: true });
    const result = await drainTune(await tuneRun(GLM_REL, true));
    expect(result.preset.ran).toBe(false);
    if (!result.preset.ran) expect(result.preset.reason.kind).toBe("error");
    expect(existsSync(benchMarker)).toBe(true);
  }, 20_000);
});
