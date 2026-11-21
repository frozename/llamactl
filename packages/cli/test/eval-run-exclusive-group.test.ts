// Part of #517 — RED tests pinning the pre-spawn exclusive-group refusal in
// `llamactl eval run`. At the pinned base runEvalRun goes straight from flag
// parsing to ensureEvalRoot/spawnServer, so the marker llama-server runs and
// exits 1, waitForHealth throws "server died during startup", and runEval
// rejects — the .catch wrapper turns that throw into an assertion failure on
// `result`. Post-fix the guard fires before ensureEvalRoot: exit 1, the
// refusal line on stderr, no marker, no $DEV_STORAGE/eval. Everything is
// hermetic: temp dirs, a /bin/sh marker binary, a real seeded residency
// store, and a loopback port probe so the base path can never send traffic
// to a live server on 18181.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
import { runEval } from "../src/commands/eval.js";
import { resetGlobals } from "../src/dispatcher.js";
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
const NOW = 1_000_000_000;
const EVAL_PORT = 18181;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_BIN",
  "LLAMACTL_RESIDENCY_STORE",
  "LOCAL_AI_CUSTOM_CATALOG_FILE",
] as const;

let tmp = "";
let devStorage = "";
let modelsDir = "";
let binDir = "";
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

// spawnServer hard-codes port 18181; if a live server already accepts there
// the base path would send eval traffic to it, so refuse to run at all.
async function assertEvalPortFree(): Promise<void> {
  const busy = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: EVAL_PORT });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
  if (busy) {
    throw new Error("port 18181 busy; refusing to run eval RED case");
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-eval-exclusive-"));
  devStorage = join(tmp, "dev-storage");
  modelsDir = join(tmp, "models");
  binDir = join(tmp, "bin");
  storePath = join(tmp, "residency", "operations.sqlite");
  markerPath = join(tmp, "marker");
  mkdirSync(devStorage, { recursive: true });
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
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_BIN: binDir,
    LLAMACTL_RESIDENCY_STORE: storePath,
    LOCAL_AI_CUSTOM_CATALOG_FILE: join(tmp, "missing-custom-catalog.tsv"),
  });
  resetGlobals();
});

afterEach(() => {
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

describe("#517 eval run exclusive-group refusal", () => {
  // Kills: the guard missing or placed after spawnServer/ensureEvalRoot —
  // the marker server runs (marker exists, $DEV_STORAGE/eval created) or
  // the catalog residencyGroup is never read.
  test("E1: an occupied z13-large-gpu group refuses before any spawn", async () => {
    await assertEvalPortFree();
    seedReady("qwen-prod");
    const { result, stderr } = await captureProcessStreams(() =>
      runEval(["run", GLM_REL]).catch((error: unknown) => `threw: ${String(error)}`),
    );
    expect(result).toBe(1);
    expect(stderr).toContain(
      `eval run: residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready\n`,
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(devStorage, "eval"))).toBe(false);
  }, 20_000);

  // Kills: the in-flight profile-switch check dropped — with no lifecycle
  // rows only the nonterminal operation stands between the launch and a
  // store mid-switch.
  test("E2: an in-flight profile switch refuses before any spawn", async () => {
    await assertEvalPortFree();
    seedSwitchOp();
    const { result, stderr } = await captureProcessStreams(() =>
      runEval(["run", GLM_REL]).catch((error: unknown) => `threw: ${String(error)}`),
    );
    expect(result).toBe(1);
    expect(stderr).toContain(
      `eval run: residency lifecycle refused ${GLM_REL}: profile switch in flight on this node; retry after it settles`,
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(devStorage, "eval"))).toBe(false);
  }, 20_000);
});
