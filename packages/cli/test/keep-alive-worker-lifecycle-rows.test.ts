// Part of #517 — RED tests pinning the keep-alive worker's own residency
// lifecycle rows. At the pinned base the worker's start and cleanup stop go
// straight to startServer/stopServer, so no row is recorded and the pre-start
// gate counts the target's own stale row as an occupant. Post-fix the CLI
// passes recorded start/stop seams that wrap runDirectResidencyStart and
// runDirectResidencyStop, keyed by the keep-alive target and grouped by the
// resolved catalog rel, while the launch gate ignores only that target's row.
// Everything is hermetic: temp dirs, a real seeded SQLite store, an empty
// catalog model file, a marker llama-server that must never run, argv
// truncated so runStart cannot spawn, and a rejecting fetch mock.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { keepAlive } from "@llamactl/core";
import { configSchema } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../remote/src/residency/store.js";
import { runKeepAlive } from "../src/commands/keepAlive.js";
import { __resetTestSeams, __setTestSeams, resetGlobals } from "../src/dispatcher.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

// The builtin z13 catalog rel (packages/core/src/catalog.ts), whose
// residencyGroup is z13-large-gpu.
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;
const NONEXCLUSIVE_Z13 = [{ name: GROUP, exclusive: false }] as const;

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
  "LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL",
  "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE",
  "LOCAL_AI_PRESET_OVERRIDES_FILE",
] as const;

let tmp = "";
let storePath = "";
let markerPath = "";
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
// The exclusivity override is used only when a case intentionally needs two
// occupying rows to pin which holder a refusal names; declarations are not
// persisted, so production reads the store back under the exclusive default.
function seedState(
  model: string,
  target: ResidencyState,
  opts: { group?: string; overrideExclusivity?: boolean } = {},
): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of seedPathTo(target)) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" && opts.group !== undefined ? { group: opts.group } : {}),
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

function seedReady(model: string): void {
  seedState(model, "ready", { group: GROUP });
}

function seedReadyOverridingExclusivity(model: string): void {
  seedState(model, "ready", { group: GROUP, overrideExclusivity: true });
}

function readRow(model: string): ResidencyStateRecord | null {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return store.getResidencyState(model);
  } finally {
    store.close();
  }
}

// Truncating argv leaves process.argv[1] undefined, so the runStart path
// stops at "Cannot determine bin path for supervisor" whenever the residency
// gate correctly allows the launch.
async function runStartHermetic(
  args: string[],
): Promise<{ result: number; stdout: string; stderr: string }> {
  const savedArgv = process.argv;
  process.argv = [process.argv[0]!];
  try {
    return await captureProcessStreams(() => runKeepAlive(args));
  } finally {
    process.argv = savedArgv;
  }
}

function stateName(state: ReturnType<typeof keepAlive.readKeepAliveState>): string | undefined {
  return state?.state;
}

async function raceWorkerExit(worker: Promise<number>): Promise<number> {
  return await Promise.race([
    worker,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("keep-alive worker did not exit within 10s"));
      }, 10_000);
    }),
  ]);
}

// Drives one in-process worker until it records one of `states`, then writes
// its stop file and waits for cleanup. Assertions stay outside this helper so
// even a RED failure cannot leave the loop running.
async function driveWorker(states: readonly string[]): Promise<{
  state: ReturnType<typeof keepAlive.readKeepAliveState>;
  exitCode: number | undefined;
  exitError: unknown;
}> {
  // Bun's `typeof fetch` carries a preconnect property, so a bare arrow is
  // not assignable; Object.assign keeps the call signature without a cast.
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign((): Promise<Response> => Promise.reject(new Error("connection refused")), {
      preconnect: (): void => undefined,
    }),
  );
  let state = keepAlive.readKeepAliveState();
  let exitCode: number | undefined;
  let exitError: unknown;
  const worker = runKeepAlive(["worker", GLM_REL, "--interval=1", "--max-backoff=1"]);
  try {
    for (let i = 0; i < 300 && !states.includes(stateName(state) ?? ""); i += 1) {
      await keepAlive.sleepWithAbort(0.01);
      state = keepAlive.readKeepAliveState();
    }
    writeFileSync(keepAlive.keepAliveStopFile(), "");
    try {
      exitCode = await raceWorkerExit(worker);
    } catch (error: unknown) {
      exitError = error;
    }
  } finally {
    writeFileSync(keepAlive.keepAliveStopFile(), "");
    fetchSpy.mockRestore();
  }
  return { state, exitCode, exitError };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-keepalive-rows-"));
  const devStorage = join(tmp, "dev-storage");
  const runtimeDir = join(tmp, "runtime");
  const modelsDir = join(tmp, "models");
  const binDir = join(tmp, "bin");
  storePath = join(tmp, "residency", "operations.sqlite");
  markerPath = join(tmp, "marker");
  mkdirSync(devStorage, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const modelPath = join(modelsDir, GLM_REL);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, "");
  const serverPath = join(binDir, "llama-server");
  writeFileSync(serverPath, `#!/bin/sh\necho ran >> "${markerPath}"\nexit 1\n`);
  chmodSync(serverPath, 0o755);
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
    LLAMA_CPP_HOST: "0.0.0.0",
    LLAMA_CPP_PORT: "65534",
    LLAMA_CPP_MACHINE_PROFILE: "macbook-pro-48g",
    LOCAL_AI_PRESET_OVERRIDES_FILE: join(tmp, "missing-preset-overrides.tsv"),
  });
  for (const key of [
    "LOCAL_AI_SOURCE_MODEL",
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

describe("#517 keep-alive worker lifecycle rows", () => {
  // Kills: no recorded `start` seam (the row stays null); recording without
  // the catalog group (group is undefined); or runWorker/cleanupWorker not
  // using a recorded `stop` (the row stays failed after the worker exits).
  test("W1: a failed worker start records failed and cleanup records downloaded with the catalog group", async () => {
    seedState("other", "downloaded");
    let duringRow: ResidencyStateRecord | null = null;
    const observedStateNames = new Set(["start-failed"]);
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign((): Promise<Response> => Promise.reject(new Error("connection refused")), {
        preconnect: (): void => undefined,
      }),
    );
    let state = keepAlive.readKeepAliveState();
    let exitCode: number | undefined;
    let exitError: unknown;
    const worker = runKeepAlive(["worker", GLM_REL, "--interval=1", "--max-backoff=1"]);
    try {
      for (let i = 0; i < 300 && !observedStateNames.has(stateName(state) ?? ""); i += 1) {
        await keepAlive.sleepWithAbort(0.01);
        state = keepAlive.readKeepAliveState();
      }
      duringRow = readRow(GLM_REL);
      writeFileSync(keepAlive.keepAliveStopFile(), "");
      try {
        exitCode = await raceWorkerExit(worker);
      } catch (error: unknown) {
        exitError = error;
      }
    } finally {
      writeFileSync(keepAlive.keepAliveStopFile(), "");
      fetchSpy.mockRestore();
    }

    const afterRow = readRow(GLM_REL);
    expect(exitError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(stateName(state)).toBe("start-failed");
    expect(duringRow).toMatchObject({ model: GLM_REL, state: "failed", group: GROUP });
    expect(afterRow).toMatchObject({ model: GLM_REL, state: "downloaded", group: GROUP });
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: the worker's beforeStart counting its own row. The row is keyed by
  // the keep-alive target; ignoring it must not ignore any other group peer.
  test("W2: the worker ignores its own ready row and still reaches the unchanged start-failed path", async () => {
    seedReady(GLM_REL);
    const run = await driveWorker(["start-failed", "start-refused"]);

    const log = readFileSync(keepAlive.keepAliveLogFile(), "utf8");
    const finalRow = readRow(GLM_REL);
    expect(run.exitError).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(stateName(run.state)).toBe("start-failed");
    expect(stateName(run.state)).not.toBe("start-refused");
    expect(log).not.toContain("start-refused rel=");
    expect(log).toContain(`start-failed rel=${GLM_REL}`);
    expect(finalRow).toMatchObject({ model: GLM_REL, state: "downloaded", group: GROUP });
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: runStart not ignoring the target's own row after the duplicate
  // supervisor checks — the launch must fall through to the unchanged missing
  // bin/entry error instead of refusing against itself.
  test("L1: keep-alive start ignores the target's own ready row", async () => {
    seedReady(GLM_REL);
    const { result, stderr } = await runStartHermetic(["start", GLM_REL]);
    expect(result).toBe(1);
    expect(stderr).not.toContain("residency lifecycle refused");
    expect(stderr).toContain("Cannot determine bin path for supervisor");
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: ignoreModel ignoring the whole group. With the target's row
  // ignored, the next lowest occupying member is the peer and the refusal
  // must name exactly that peer.
  test("L2: keep-alive start still refuses when another same-group peer is ready", async () => {
    seedReady(GLM_REL);
    seedReadyOverridingExclusivity("qwen-prod");
    const { result, stderr } = await runStartHermetic(["start", GLM_REL]);
    expect(result).toBe(1);
    expect(stderr).toContain(
      `keep-alive start: residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready\n`,
    );
    expect(stderr).not.toContain("Cannot determine bin path for supervisor");
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);
});
