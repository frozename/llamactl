// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal in
// `llamactl keep-alive start` and the `beforeStart` wiring in `keep-alive
// worker`. At the pinned base runStart goes straight from flag parsing to
// the detached spawn (or "Cannot determine bin path for supervisor" when
// argv has no entry), and runWorker calls runKeepAliveWorker without a gate,
// so the 0.0.0.0 bind refusal records start-failed. Post-fix runStart reads
// the local residency store read-only through keepAliveLaunchRefusal before
// the bin/entry check and exits 1 without spawning, and runWorker passes a
// beforeStart that re-runs the same check before every start or restart,
// recording start-refused in the worker log. Everything is hermetic: temp
// dirs, a marker llama-server that must never run, a real seeded residency
// store, process.argv truncated so the base can never spawn a detached
// worker, and a rejecting fetch mock.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { keepAlive, qualificationOverrides } from "@llamactl/core";
import { configSchema } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
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
let runtimeDirPath = "";
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

// Truncating argv leaves process.argv[1] undefined, so the base runStart
// path stops at "Cannot determine bin path for supervisor" and can never
// spawn a detached worker.
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-keepalive-group-"));
  const devStorage = join(tmp, "dev-storage");
  const runtimeDir = join(tmp, "runtime");
  runtimeDirPath = runtimeDir;
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

describe("#517 keep-alive exclusive-group refusal", () => {
  // Kills: no pre-spawn gate in runStart, or a gate placed after the
  // bin/entry check — the base prints "Cannot determine bin path for
  // supervisor" instead of the residency refusal.
  test("S1: an occupied z13-large-gpu group refuses keep-alive start before any spawn", async () => {
    seedReady("qwen-prod");
    const { result, stderr } = await runStartHermetic(["start", GLM_REL]);
    expect(result).toBe(1);
    expect(stderr).toContain(
      `keep-alive start: residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready\n`,
    );
    expect(stderr).not.toContain("Cannot determine bin path");
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: the gate not using exclusiveGroupLaunchRefusal — with no
  // lifecycle rows only the nonterminal operation stands between the
  // launch and a store mid-switch.
  test("S2: an in-flight profile switch refuses keep-alive start", async () => {
    seedSwitchOp();
    const { result, stderr } = await runStartHermetic(["start", GLM_REL]);
    expect(result).toBe(1);
    expect(stderr).toContain(
      `keep-alive start: residency lifecycle refused ${GLM_REL}: profile switch in flight on this node; retry after it settles`,
    );
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: a refusal when the store is absent — with no store file the
  // start must fall through to the unchanged bin/entry check.
  test("S3: no store file launches as before", async () => {
    const { result, stderr } = await runStartHermetic(["start", GLM_REL]);
    expect(result).toBe(1);
    expect(stderr).not.toContain("residency lifecycle refused");
    expect(stderr).toContain("Cannot determine bin path for supervisor");
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: runWorker not passing beforeStart — at the base the bind
  // refusal yields start-failed and the worker log never records
  // start-refused.
  test("S4: the worker re-checks the gate and records start-refused", async () => {
    seedReady("qwen-prod");
    // Bun's `typeof fetch` carries a preconnect property, so a bare arrow is
    // not assignable; Object.assign keeps the call signature without a cast.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign((): Promise<Response> => Promise.reject(new Error("connection refused")), {
        preconnect: (): void => undefined,
      }),
    );
    let state = keepAlive.readKeepAliveState();
    try {
      const worker = runKeepAlive(["worker", GLM_REL, "--interval=1", "--max-backoff=1"]);
      for (let i = 0; i < 300 && stateName(state) !== "start-refused"; i += 1) {
        await keepAlive.sleepWithAbort(0.01);
        state = keepAlive.readKeepAliveState();
      }
      writeFileSync(keepAlive.keepAliveStopFile(), "");
      const code = await Promise.race([
        worker,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("keep-alive worker did not exit within 10s"));
          }, 10_000);
        }),
      ]);
      expect(code).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
    const log = readFileSync(keepAlive.keepAliveLogFile(), "utf8");
    expect(stateName(state)).toBe("start-refused");
    expect(log).toContain(
      `start-refused rel=${GLM_REL} reason=residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready`,
    );
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: runStart passing the raw target to keepAliveLaunchRefusal — the
  // default target "current" is not a catalog rel, so findByRel misses,
  // the gate returns null and the start falls through to the bin/entry
  // check ("Cannot determine bin path for supervisor") instead of refusing.
  test("S5: the default target current resolves to the occupied rel and refuses before any spawn", async () => {
    process.env["LOCAL_AI_SOURCE_MODEL"] = GLM_REL;
    seedReady("qwen-prod");
    const { result, stderr } = await runStartHermetic(["start"]);
    expect(result).toBe(1);
    expect(stderr).toContain(
      `keep-alive start: residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready\n`,
    );
    expect(stderr).not.toContain("Cannot determine bin path");
    expect(existsSync(keepAlive.keepAlivePidFile())).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: runStart passing the raw alias to keepAliveLaunchRefusal, or
  // using the alias rather than the resolved rel as the refusal id — the
  // alias "best" misses findByRel and falls through to the bin/entry check,
  // and an alias id would print "refused best" instead of the rel.
  test("S6: an alias resolving to the occupied rel refuses with the rel as the id", async () => {
    process.env["LOCAL_AI_PRESET_MACBOOK_PRO_48G_BEST_MODEL"] = GLM_REL;
    // The builtin row is experimental, which the env preset override skips;
    // pin it to candidate so `best` resolves to it.
    qualificationOverrides.writeQualificationOverride(
      join(runtimeDirPath, "qualification-overrides.tsv"),
      { rel: GLM_REL, action: "pin", stage: "candidate", author: "test", reason: "517 alias" },
    );
    seedReady("qwen-prod");
    const { result, stderr } = await runStartHermetic(["start", "best"]);
    expect(result).toBe(1);
    expect(stderr).toContain(
      `keep-alive start: residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready\n`,
    );
    expect(stderr).not.toContain("refused best");
    expect(stderr).not.toContain("Cannot determine bin path");
    expect(existsSync(keepAlive.keepAlivePidFile())).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: inventing a new error path for an unresolvable target — the
  // start must fall through to the unchanged bin/entry check exactly as
  // before, even with an occupied group.
  test("S7: an unresolvable target falls through to the unchanged start path", async () => {
    seedReady("qwen-prod");
    const { result, stderr } = await runStartHermetic(["start", "no-such-alias"]);
    expect(result).toBe(1);
    expect(stderr).not.toContain("residency lifecycle refused");
    expect(stderr).toContain("Cannot determine bin path for supervisor");
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);

  // Kills: throwing or refusing when the resolved rel has no catalog row.
  // resolveTarget passes any literal rel (a path or a .gguf name) straight
  // through, so an uncatalogued model reaches the gate; it has no residency
  // group, so the start must fall through to the unchanged path.
  test("S8: an uncatalogued literal rel falls through even with an occupied group", async () => {
    seedReady("qwen-prod");
    const { result, stderr } = await runStartHermetic([
      "start",
      "Uncatalogued-GGUF/uncatalogued-Q4_K_M.gguf",
    ]);
    expect(result).toBe(1);
    expect(stderr).not.toContain("residency lifecycle refused");
    expect(stderr).toContain("Cannot determine bin path for supervisor");
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);
});
