/**
 * #517 — RED tests for the bench-launch exclusive-group refusal on the
 * agent-side `autotuneAfterPull` and `candidateTestRun` subscription
 * procedures. At the pinned base both call core's maybeTuneAfterPull /
 * candidateTest without a launchRefusal, so the post-pull auto-tune and the
 * candidate-test preset/vision benches spawn llama-bench beside an occupied
 * z13-large-gpu group (and beside an in-flight profile switch). Post-fix each
 * procedure passes `launchRefusal: benchLaunchRefusal`, the same read-only,
 * unfenced gate the bench procedures use, and the step records
 * `exclusive-group-occupied` instead of spawning. Everything is hermetic:
 * temp dirs, marker llama-bench/llama-mtmd-cli scripts that write a file and
 * exit 1, a stub hf binary, a real seeded residency store, and drained
 * subscription streams. At base every case fails BY ASSERTION on the done
 * event's step shape or the marker — never by import, type or exit code.
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

// autotuneAfterPull/candidateTestRun are subscriptions: drain the stream and
// keep the terminal event — the refusal-shaped step post-fix, the bench error
// at base — as the assertion target. Progress events carry no assertion weight.
async function drain<T>(stream: AsyncIterable<T>): Promise<{
  error: Error | null;
  events: T[];
}> {
  const events: T[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
    }
    return { error: null, events };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)), events };
  }
}

function findDone<E extends { type: string }, T extends string>(
  events: readonly E[],
  type: T,
): Extract<E, { type: T }> | undefined {
  return events.find((e): e is Extract<E, { type: T }> => e.type === type);
}

function autotunePull(
  rel: string,
  wasMissing: boolean,
): ReturnType<ReturnType<typeof router.createCaller>["autotuneAfterPull"]> {
  return router.createCaller({}).autotuneAfterPull({ rel, wasMissing });
}

function candidateRun(
  repo: string,
  file: string,
): ReturnType<ReturnType<typeof router.createCaller>["candidateTestRun"]> {
  return router.createCaller({}).candidateTestRun({ repo, file });
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
  // The mmproj sibling lets the candidate-test vision step reach the gate.
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
    "LLAMA_CPP_AUTO_TUNE_ON_PULL",
    "LLAMA_CPP_AUTO_BENCH_VISION",
    "LOCAL_AI_HF_BIN",
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

describe("#517 autotune + candidate-test exclusive-group refusal", () => {
  // Kills: router autotuneAfterPull not passing launchRefusal — at base the
  // marker spawns (exit 1 across the three profiles) and the done-tune
  // preset step reports kind "error" instead of the residency refusal.
  test("R1: autotuneAfterPull refuses an occupied z13-large-gpu group before spawning llama-bench", async () => {
    seedReady("peer-qwen");
    const { events } = await drain(await autotunePull(GLM_REL, true));
    const done = findDone(events, "done-tune");
    expect(done?.result.preset).toEqual({
      ran: false,
      reason: { kind: "exclusive-group-occupied", message: OCCUPIED_REFUSAL },
    });
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: a gate that checks lifecycle rows but not profile-switch ops — at
  // base the marker spawns and the preset step reports kind "error".
  test("R2: autotuneAfterPull reports an in-flight profile switch as exclusive-group-occupied", async () => {
    seedSwitchOp();
    const { events } = await drain(await autotunePull(GLM_REL, true));
    const done = findDone(events, "done-tune");
    expect(done?.result.preset).toEqual({
      ran: false,
      reason: { kind: "exclusive-group-occupied", message: SWITCH_REFUSAL },
    });
    expect(existsSync(benchMarker)).toBe(false);
  }, 20_000);

  // Kills: router candidateTestRun not passing launchRefusal — at base the
  // pull succeeds through the stub hf binary, the preset bench spawns the
  // marker (exit 1) and the stream rejects with the bench error instead of
  // emitting a done-candidate-test whose preset step carries the refusal.
  test("R3: candidateTestRun refuses an occupied z13-large-gpu group before spawning llama-bench", async () => {
    seedReady("peer-qwen");
    const hfBin = join(root, "hf-stub.sh");
    writeFileSync(hfBin, "#!/bin/sh\nexit 0\n");
    chmodSync(hfBin, 0o755);
    process.env["LOCAL_AI_HF_BIN"] = hfBin;
    const { events } = await drain(
      await candidateRun("fixture-org/GLM-5.3-Flash-AJ-GGUF", GLM_REL),
    );
    const done = findDone(events, "done-candidate-test");
    expect(done?.result.preset).toEqual({ ran: false, reason: OCCUPIED_REFUSAL });
    expect(existsSync(benchMarker)).toBe(false);
    expect(existsSync(mtmdMarker)).toBe(false);
  }, 20_000);
});
