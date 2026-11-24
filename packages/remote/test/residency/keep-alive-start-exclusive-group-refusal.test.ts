/**
 * #517 — RED tests for the agent-side keepAliveStart exclusive-group
 * refusal. `keepAliveStart` in src/router.ts is the remote-dispatch target
 * of `llamactl keep-alive start`: at the pinned base it runs only the
 * duplicate-supervisor checks and then spawns the detached
 * `keep-alive worker` child, so a keep-alive launches beside an occupied
 * z13-large-gpu group (and beside an in-flight profile switch). Post-fix
 * the procedure runs keepAliveStartRefusal — the same read-only, unfenced
 * gate the CLI local branch uses — on the rel resolveTarget returns,
 * after the duplicate checks and before the spawn, and returns
 * `{ ok: false, pid: null, error: "keep-alive start: residency lifecycle
 * refused ..." }` instead of spawning. Everything is hermetic: temp dirs,
 * a fake LLAMACTL_HOME/packages/cli/src/bin.ts that appends a marker and
 * exits without registering a pid (so every fall-through returns the 2s
 * supervisor-timeout error), a real seeded residency store, and env
 * save/restore. At base every case fails BY ASSERTION on the `error`
 * text or the marker — never by import, type or exit code.
 */
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

// The builtin z13 catalog rel (packages/core/src/catalog.ts), whose
// residencyGroup is z13-large-gpu.
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;

const OCCUPIED_REFUSAL = `residency lifecycle refused ${GLM_REL} downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by peer-qwen in state ready`;

const originalEnv = { ...process.env };
let root = "";
let storePath = "";
let marker = "";

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

function keepAliveStart(
  target: string,
): ReturnType<ReturnType<typeof router.createCaller>["keepAliveStart"]> {
  return router.createCaller({}).keepAliveStart({ target });
}

// The detached child never registers a pid, so the procedure's 2s poll
// always returns the supervisor-timeout error; the marker proves the
// spawn actually happened on the fall-through paths.
async function waitForMarker(timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(marker);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llamactl-keep-alive-start-group-"));
  const modelsDir = join(root, "models");
  const runtimeDir = join(root, "runtime");
  const binDir = join(root, "bin");
  const homeDir = join(root, "home");
  storePath = join(root, "residency", "operations.sqlite");
  marker = join(root, "keep-alive-worker.marker");
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const modelPath = join(modelsDir, GLM_REL);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, "");
  // keepAliveStart spawns `bun $LLAMACTL_HOME/packages/cli/src/bin.ts
  // keep-alive worker <target>` detached. The fake entry appends "ran" to
  // the marker (path baked in as a JSON string literal, no env var) and
  // exits, so readKeepAlivePid stays null and the procedure reports the
  // 2s supervisor timeout instead of a live pid.
  const entry = join(homeDir, "packages", "cli", "src", "bin.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`,
  );
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
    LLAMACTL_HOME: homeDir,
  });
  Reflect.deleteProperty(process.env, "LOCAL_AI_SOURCE_MODEL");
});

afterEach(() => {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("#517 keepAliveStart exclusive-group refusal", () => {
  // Kills: no exclusive-group gate in keepAliveStart — the base spawns the
  // detached worker (marker written) and returns the 2s supervisor-timeout
  // error instead of the residency refusal; and refusing or throwing on an
  // uncatalogued rel — a target with no catalog row must fall through and
  // spawn exactly as before (marker written, same 2s error).
  test("K1: keepAliveStart refuses an occupied z13-large-gpu group before spawning; an uncatalogued rel falls through", async () => {
    seedReady("peer-qwen");
    const refused = await keepAliveStart(GLM_REL);
    expect(refused.ok).toBe(false);
    expect(refused.pid).toBeNull();
    expect(refused.error).toBe(`keep-alive start: ${OCCUPIED_REFUSAL}`);
    expect(refused.error?.startsWith("keep-alive start: residency lifecycle refused ")).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const fellThrough = await keepAliveStart("Uncatalogued-GGUF/x.gguf");
    expect(fellThrough.error).toBe("supervisor did not register a PID within 2s");
    expect(await waitForMarker()).toBe(true);
  }, 20_000);

  // Kills: gating the raw target instead of the rel resolveTarget returns —
  // "current" is not a catalog rel, so the gate would miss
  // (findByRel("current") is undefined) and the worker would spawn beside
  // the occupied group; and naming the raw target in the refusal would
  // print `refused current` instead of the resolved rel.
  test("K2: target current resolves to the occupied rel and refuses naming the rel", async () => {
    process.env["LOCAL_AI_SOURCE_MODEL"] = GLM_REL;
    seedReady("peer-qwen");
    const res = await keepAliveStart("current");
    expect(res.ok).toBe(false);
    expect(res.pid).toBeNull();
    expect(res.error).toBe(`keep-alive start: ${OCCUPIED_REFUSAL}`);
    expect(res.error ?? "").not.toContain("refused current");
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  // Kills: missing profile-switch handling — an in-flight switch must
  // refuse before the spawn; and refusing when there is no store file —
  // with the store deleted the procedure must fall through and spawn
  // exactly as before (marker written, 2s supervisor-timeout error).
  test("K3: an in-flight profile switch refuses; a missing store file spawns as before", async () => {
    seedSwitchOp();
    const refused = await keepAliveStart(GLM_REL);
    expect(refused.error ?? "").toContain(
      `residency lifecycle refused ${GLM_REL}: profile switch in flight on this node; retry after it settles`,
    );
    expect(existsSync(marker)).toBe(false);

    rmSync(storePath, { force: true });
    const fellThrough = await keepAliveStart(GLM_REL);
    expect(fellThrough.error).toBe("supervisor did not register a PID within 2s");
    expect(await waitForMarker()).toBe(true);
  }, 20_000);
});
