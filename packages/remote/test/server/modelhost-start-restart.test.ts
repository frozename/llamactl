// #806 phase 2: the modelHostStart RPC must carry an explicit `restart` flag
// through to startModelHost. A healthy, identity-verified host recorded at the
// same spec hash is normally adopted; with `restart: true` on the RPC input the
// router must hand StartModelHostOptions.restart to startModelHost so the
// adopt is skipped and the engine is torn down and respawned. Without the
// router wiring zod strips the unknown key, the host is adopted, and this test
// fails by assertion on the adopted result and the empty teardown list.
//
// The prior "engine" is a /bin/sleep impostor launched with argv0 `omlx` so
// the default pid-identity check verifies it; the readiness probe and the
// teardown are swapped on ENGINES.omlx (the same seam engine-adopt-modelhost
// uses) so no real listener is needed. The respawned child is a shell script
// that execs sleep, killed in the finally.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn as spawnImpostor } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { computeModelHostSpecHash, readModelHostState } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { setResidencyLeaseRegistry } from "../../../core/src/residency/leases.js";
import { setSessionRefcountRegistry } from "../../../core/src/residency/sessions.js";
import { router } from "../../src/router.js";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
  specForHash,
} from "../../src/workload/modelhost-schema.js";

const NAME = "mlx-host-rpc-restart";
const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const BASENAME = "Qwen3-8B-MLX-4bit";
const PORT = 18_197;

type HostResult = { ok: boolean; pid: number | null; error?: string; adopted?: boolean };

const originalEnv = { ...process.env };
let root = "";
const killList = new Set<number>();

function killQuiet(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitForGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for pid ${String(pid)} to exit`);
}

function buildManifest(binary: string): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: NAME },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary,
      endpoint: { host: "127.0.0.1", port: PORT },
      hostedModels: [{ rel: REL }],
      restartPolicy: "Always",
      timeoutSeconds: 30,
    },
  });
}

function seedLiveHost(manifest: ModelHostManifest, pid: number): void {
  const hostDir = join(root, "runtime", "workloads", NAME);
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "modelhost.pid"), `${String(pid)}\n`);
  writeFileSync(
    join(hostDir, "modelhost.state"),
    JSON.stringify({
      kind: "ModelHost",
      engine: "omlx",
      pid,
      host: "127.0.0.1",
      port: PORT,
      modelAliases: [REL, BASENAME],
      startedAt: new Date().toISOString(),
      slotSavePath: null,
      specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
    }),
  );
}

// modelHostStart is a subscription: drain it and keep the done event's result.
async function startOverRpc(
  input: Parameters<ReturnType<typeof router.createCaller>["modelHostStart"]>[0],
): Promise<HostResult> {
  const stream = await router.createCaller({}).modelHostStart(input);
  let result: HostResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: HostResult } | null;
    if (done?.type === "done" && done.result !== undefined) result = done.result;
  }
  if (result === undefined) throw new Error("modelHostStart stream ended without a done event");
  return result;
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-modelhost-rpc-restart-"));
  mkdirSync(join(root, "workloads"), { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: join(root, "workloads"),
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LLAMACTL_CONFIG: join(root, "no-such-kubeconfig.yaml"),
    LLAMACTL_MODELS_DIR: join(root, "models"),
    LLAMA_CPP_MODELS: join(root, "models"),
  });
});

afterEach(() => {
  for (const pid of killList) killQuiet(pid);
  killList.clear();
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

test("modelHostStart restart: true reaches startModelHost and replaces a same-spec host", async () => {
  const engine = ENGINES.omlx;
  const originalProbe = engine.probeReady.bind(engine);
  const originalTeardown = engine.teardown.bind(engine);
  const tornDown: number[] = [];
  const binary = join(root, "omlx");
  writeFileSync(binary, "#!/bin/sh\nexec /bin/sleep 60\n");
  chmodSync(binary, 0o755);
  const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
  try {
    if (impostor.pid === undefined) throw new Error("impostor spawn failed");
    const impostorPid = impostor.pid;
    killList.add(impostorPid);
    const manifest = buildManifest(binary);
    seedLiveHost(manifest, impostorPid);
    engine.probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> =>
      Promise.resolve({ ready: true, modelIds: [BASENAME] });
    engine.teardown = async (pid: number): Promise<void> => {
      tornDown.push(pid);
      killQuiet(pid);
      await waitForGone(pid);
    };

    const result = await startOverRpc({
      workload: NAME,
      manifest,
      timeoutSeconds: 10,
      restart: true,
    });
    if (result.pid !== null) killList.add(result.pid);

    // Kills: dropping `restart` from modelHostStartInput or from the
    // startModelHost call — the same-spec host would be adopted instead.
    expect(result.adopted).not.toBe(true);
    expect(tornDown).toEqual([impostorPid]);
    expect(result.error ?? "").toBe("");
    expect(result.ok).toBe(true);
    expect(result.pid).not.toBe(impostorPid);
    const state = readModelHostState({ name: NAME }, resolveEnv(process.env));
    expect(state?.pid).toBe(result.pid ?? -1);
  } finally {
    engine.probeReady = originalProbe;
    engine.teardown = originalTeardown;
    killQuiet(impostor.pid ?? -1);
  }
}, 60_000);

test("modelHostStart without restart adopts the same-spec host (control)", async () => {
  const engine = ENGINES.omlx;
  const originalProbe = engine.probeReady.bind(engine);
  const originalTeardown = engine.teardown.bind(engine);
  const tornDown: number[] = [];
  const binary = join(root, "omlx");
  writeFileSync(binary, "#!/bin/sh\nexec /bin/sleep 60\n");
  chmodSync(binary, 0o755);
  const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
  try {
    if (impostor.pid === undefined) throw new Error("impostor spawn failed");
    const impostorPid = impostor.pid;
    killList.add(impostorPid);
    const manifest = buildManifest(binary);
    seedLiveHost(manifest, impostorPid);
    engine.probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> =>
      Promise.resolve({ ready: true, modelIds: [BASENAME] });
    engine.teardown = async (pid: number): Promise<void> => {
      tornDown.push(pid);
      killQuiet(pid);
      await waitForGone(pid);
    };

    const result = await startOverRpc({ workload: NAME, manifest, timeoutSeconds: 10 });
    if (result.pid !== null && result.pid !== impostorPid) killList.add(result.pid);

    // Pins the fixture: without the flag the same host is adopted, so the
    // restart case above is distinguished by the flag alone.
    expect(result).toEqual({ ok: true, pid: impostorPid, adopted: true });
    expect(tornDown).toEqual([]);
  } finally {
    engine.probeReady = originalProbe;
    engine.teardown = originalTeardown;
    killQuiet(impostor.pid ?? -1);
  }
}, 60_000);
