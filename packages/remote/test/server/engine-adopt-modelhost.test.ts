import { describe, expect, mock, test } from "bun:test";
import {
  type ChildProcess,
  type spawn as nodeSpawn,
  spawn as spawnImpostor,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { computeModelHostSpecHash } from "../../../core/src/engines/state.js";
import { canonicalSlotDir } from "../../../core/src/kvstore/slotPath.js";
import {
  createResidencyLeases,
  setResidencyLeaseRegistry,
} from "../../../core/src/residency/leases.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, statusModelHost, stopModelHost } from "../../src/server/modelhost.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
  specForHash,
} from "../../src/workload/modelhost-schema.js";

// #806 phase 2: ModelHost adopt gates. The unchanged-spec adopt must survive
// legacy sidecars (no binaryNames), --alias launches, and a pid that dies
// mid-probe; it must refuse a not-ready probe, a foreign model, and an
// explicit restart; and a same-hash starting record must be promoted (loaded)
// or deferred (still loading) instead of bounced. These tests pin the mutants
// M02/M04/M10-M13/M20-M23.

interface Fixture {
  manifest: ModelHostManifest;
  workloadsDir: string;
  runtimeDir: string;
  hostDir: string;
  env: NodeJS.ProcessEnv;
}

const NAME = "mlx-host-server";
const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const BASENAME = "Qwen3-8B-MLX-4bit";

function fixture(tmp: string, specOverrides: Record<string, unknown> = {}): Fixture {
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  const modelsDir = join(tmp, "models");
  const fakeBinary = join(tmp, "omlx");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  const manifest = ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: NAME },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: fakeBinary,
      endpoint: { host: "127.0.0.1", port: 8094 },
      hostedModels: [{ rel: REL }],
      extraArgs: ["--max-concurrent-requests", "1"],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      ...specOverrides,
    },
  });
  return {
    manifest,
    workloadsDir,
    runtimeDir,
    hostDir: join(runtimeDir, "workloads", NAME),
    env: { ...process.env, LLAMACTL_MODELS_DIR: modelsDir, LLAMA_CPP_MODELS: modelsDir },
  };
}

function hashOf(manifest: ModelHostManifest): string {
  return computeModelHostSpecHash(specForHash(manifest.spec));
}

// Sidecar in the exact key order validateModelHostState rebuilds, so a
// same-spec adopt (nothing out-of-hash changed) can stay byte-identical.
function sidecarFor(pid: number, hash: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "ModelHost",
    engine: "omlx",
    pid,
    host: "127.0.0.1",
    port: 8094,
    modelAliases: [REL, BASENAME],
    startedAt: new Date().toISOString(),
    slotSavePath: null,
    specHash: hash,
    ...extra,
  });
}

function llamacppFixture(tmp: string, declaredBinaryNames: string[]): Fixture {
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  const modelsDir = join(tmp, "models");
  const fakeBinary = join(tmp, "llama-server");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  const manifest = ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: NAME },
    spec: {
      engine: "llamacpp",
      node: "local",
      enabled: true,
      binary: fakeBinary,
      endpoint: { host: "127.0.0.1", port: 8080 },
      hostedModels: [{ rel: "fork/model.gguf" }],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      binaryNames: declaredBinaryNames,
    },
  });
  return {
    manifest,
    workloadsDir,
    runtimeDir,
    hostDir: join(runtimeDir, "workloads", NAME),
    env: { ...process.env, LLAMACTL_MODELS_DIR: modelsDir, LLAMA_CPP_MODELS: modelsDir },
  };
}

function seedLiveHost(hostDir: string, pid: number, state: string): void {
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "modelhost.pid"), `${String(pid)}\n`);
  writeFileSync(join(hostDir, "modelhost.state"), state);
}

function seedStartingRecord(hostDir: string, record: Record<string, unknown>): void {
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "modelhost.starting"), JSON.stringify(record));
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

function killTeardown(proc: ReturnType<typeof spawnImpostor>): (pid: number) => Promise<void> {
  return (pid) => {
    proc.kill("SIGKILL");
    return waitForGone(pid);
  };
}

// launchModelHost reads only pid, exitCode and unref off the spawned child;
// exitCode stays undefined, which ensureSpawnedChildStillRunning reads as
// still-running. The EventEmitter downcast supplies the ChildProcess shape
// without a real process.
function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter() as ChildProcess, { pid });
}

describe("ModelHost unchanged-spec adopt (#806 phase 2)", () => {
  test("adopts a legacy sidecar without binaryNames and records the declared names", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-legacy-bins-"));
    const engine = ENGINES.llamacpp;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "gufo-impostor",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = llamacppFixture(tmp, ["gufo-impostor"]);
      seedLiveHost(
        fx.hostDir,
        impostor.pid,
        JSON.stringify({
          kind: "ModelHost",
          engine: "llamacpp",
          pid: impostor.pid,
          host: "127.0.0.1",
          port: 8080,
          modelAliases: ["fork/model.gguf", "model.gguf"],
          startedAt: new Date().toISOString(),
          slotSavePath: null,
          specHash: hashOf(fx.manifest),
        }),
      );
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: ["model.gguf"] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      // The adopted sidecar must carry the manifest's declared names, or a
      // later status/stop re-derives engine defaults and the real argv0 fails
      // identity.
      const state = readFileSync(join(fx.hostDir, "modelhost.state"), "utf8");
      expect(state).toContain("gufo-impostor");
      expect(statusModelHost({ key: { name: NAME }, runtimeDir: fx.runtimeDir }).state).toBe(
        "Running",
      );
      const stop = await stopModelHost({
        key: { name: NAME },
        runtimeDir: fx.runtimeDir,
        teardown: (pid) => {
          impostor.kill("SIGKILL");
          return waitForGone(pid);
        },
      });
      expect(stop.ok).toBe(true);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("adopts a live host that advertises the model under its declared --alias", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-alias-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp, { extraArgs: ["--alias", "golden-alias"] });
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      // A teardown stub that resolves without releasing: if the adopt wrongly
      // refuses an aliased engine, the confirmed-gone check defers the restart.
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: ["golden-alias"] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("adopts and refreshes the sidecar readiness when the declared probe changed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-readiness-"));
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp, { readiness: { path: "/ready" } });
      seedLiveHost(
        fx.hostDir,
        impostor.pid,
        sidecarFor(impostor.pid, hashOf(fx.manifest), {
          readiness: { path: "/old-health", expectStatus: 200 },
        }),
      );

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(spawn).not.toHaveBeenCalled();
      const state = readFileSync(join(fx.hostDir, "modelhost.state"), "utf8");
      expect(state).toContain("/ready");
      expect(state).not.toContain("/old-health");
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("never adopts a host advertising a different model; tears it down first", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-foreign-model-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      const kill = killTeardown(impostor);
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return kill(pid);
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: ["someone-elses.gguf"] }),
      });

      expect(result).toEqual({ ok: true, pid: 4321 });
      expect("adopted" in result).toBe(false);
      expect(tornDown).toEqual([impostor.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("never adopts when the readiness probe refuses, even at the same hash", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-notready-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      const kill = killTeardown(impostor);
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return kill(pid);
      });
      let firstProbe = true;
      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => {
          if (firstProbe) {
            firstProbe = false;
            return Promise.resolve({ ready: false, modelIds: [BASENAME] });
          }
          return Promise.resolve({ ready: true, modelIds: [BASENAME] });
        },
      });

      expect(result).toEqual({ ok: true, pid: 4321 });
      expect("adopted" in result).toBe(false);
      expect(tornDown).toEqual([impostor.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses the adopt when the recorded pid dies between probe and refresh", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-diedmidprobe-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      engine.teardown = mock(() => Promise.resolve());
      // The engine answers readiness, then exits before the adopt records it:
      // adopting a dead pid would record a corpse and drop the route.
      let firstProbe = true;
      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: async () => {
          if (firstProbe) {
            firstProbe = false;
            impostor.kill("SIGKILL");
            if (impostor.pid !== undefined) {
              await waitForGone(impostor.pid);
            }
          }
          return { ready: true, modelIds: [BASENAME] };
        },
      });

      expect(result).toEqual({ ok: true, pid: 4321 });
      expect("adopted" in result).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a same-spec adopt leaves the state and pid files byte-for-byte untouched", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-untouched-"));
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      const state = sidecarFor(impostor.pid, hashOf(fx.manifest));
      seedLiveHost(fx.hostDir, impostor.pid, state);
      const stateBefore = readFileSync(join(fx.hostDir, "modelhost.state"), "utf8");
      const stateMtimeBefore = statSync(join(fx.hostDir, "modelhost.state"), {
        bigint: true,
      }).mtimeNs;
      const pidMtimeBefore = statSync(join(fx.hostDir, "modelhost.pid"), { bigint: true }).mtimeNs;

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(join(fx.hostDir, "modelhost.state"), "utf8")).toBe(state);
      expect(stateBefore).toContain(`"pid":${String(impostor.pid)}`);
      expect(statSync(join(fx.hostDir, "modelhost.state"), { bigint: true }).mtimeNs).toBe(
        stateMtimeBefore,
      );
      // The pid file mtime is the identity anchor; an adopt must never rewrite it.
      expect(statSync(join(fx.hostDir, "modelhost.pid"), { bigint: true }).mtimeNs).toBe(
        pidMtimeBefore,
      );
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("restart: true skips the adopt and forces teardown plus respawn", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-restart-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      const kill = killTeardown(impostor);
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return kill(pid);
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
        restart: true,
      });

      expect(result).toEqual({ ok: true, pid: 4321 });
      expect("adopted" in result).toBe(false);
      expect(tornDown).toEqual([impostor.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("promotes a same-hash starting record that finished loading", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-promote-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      const hash = hashOf(fx.manifest);
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date().toISOString(),
        specHash: hash,
      });
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(false);
      const promoted = JSON.parse(readFileSync(join(fx.hostDir, "modelhost.state"), "utf8")) as {
        pid: number;
        specHash: string;
      };
      expect(promoted.pid).toBe(impostor.pid);
      expect(promoted.specHash).toBe(hash);
      expect(readFileSync(join(fx.hostDir, "modelhost.pid"), "utf8")).toContain(
        String(impostor.pid),
      );
      expect(statusModelHost({ key: { name: NAME }, runtimeDir: fx.runtimeDir }).state).toBe(
        "Running",
      );
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("defers instead of killing a same-hash starting record that is still loading", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-defer-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date().toISOString(),
        specHash: hashOf(fx.manifest),
      });
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: false, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("still loading");
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(true);
      process.kill(impostor.pid, 0);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reaps a starting record older than the readiness budget even at the same hash", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-starting-stale-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        specHash: hashOf(fx.manifest),
      });
      const kill = killTeardown(impostor);
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return kill(pid);
      });
      let firstProbe = true;
      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => {
          if (firstProbe) {
            firstProbe = false;
            return Promise.resolve({ ready: false, modelIds: [] });
          }
          return Promise.resolve({ ready: true, modelIds: [BASENAME] });
        },
      });

      expect(result).toEqual({ ok: true, pid: 4321 });
      expect(tornDown).toEqual([impostor.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(false);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reaps a live starting record whose hash differs, even when it serves our model", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-starting-drift-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date().toISOString(),
        specHash: "stale-hash-from-a-different-spec",
      });
      const kill = killTeardown(impostor);
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return kill(pid);
      });

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect(result).toEqual({ ok: true, pid: 4321 });
      expect(tornDown).toEqual([impostor.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(false);
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #806 phase 2 re-review: a promoted starting record must carry the same
  // resolved KV slot directory a fresh launch would write, so the proxy keeps
  // the slot cache. Base wrote `slotSavePath: null` for every promote.
  test("promotes a starting record with the auto slot-save-path a fresh launch would resolve", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-promote-slot-auto-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp, { extraArgs: ["--slot-save-path", "auto"] });
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date().toISOString(),
        specHash: hashOf(fx.manifest),
      });
      engine.teardown = mock(() => Promise.resolve());

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(spawn).not.toHaveBeenCalled();
      const promoted = JSON.parse(readFileSync(join(fx.hostDir, "modelhost.state"), "utf8")) as {
        slotSavePath: string | null;
      };
      expect(promoted.slotSavePath).toBe(canonicalSlotDir(fx.runtimeDir, NAME));
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("promotes a starting record with an absolute slot-save-path onto the state sidecar", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-promote-slot-abs-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp, { extraArgs: ["--slot-save-path", "/srv/golden-slots"] });
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date().toISOString(),
        specHash: hashOf(fx.manifest),
      });
      engine.teardown = mock(() => Promise.resolve());

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect(result).toEqual({ ok: true, pid: impostor.pid, adopted: true });
      expect(spawn).not.toHaveBeenCalled();
      const promoted = JSON.parse(readFileSync(join(fx.hostDir, "modelhost.state"), "utf8")) as {
        slotSavePath: string | null;
      };
      expect(promoted.slotSavePath).toBe("/srv/golden-slots");
    } finally {
      engine.teardown = originalTeardown;
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #806 phase 2 re-review: an unchanged apply must not adopt a live host while
  // a published residency registry reports the workload as drained/unloaded —
  // admission is closed, so the start must fall through to the fenced
  // teardown/respawn. Base adopted unconditionally.
  test("does not adopt an unchanged sidecar host while the residency phase is unloaded", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-unloaded-sidecar-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      const drain = reg.beginDrain(NAME);
      if (!drain.ok) throw new Error(`beginDrain refused: ${drain.reason}`);
      expect(reg.commitUnload(drain.token).ok).toBe(true);
      expect(reg.snapshot(NAME).phase).toBe("unloaded");
      engine.teardown = killTeardown(impostor);

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect("adopted" in result).toBe(false);
      expect(result).toEqual({ ok: true, pid: 4321 });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      engine.teardown = originalTeardown;
      setResidencyLeaseRegistry(null);
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("does not adopt an unchanged sidecar host while the residency phase is draining", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-draining-sidecar-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedLiveHost(fx.hostDir, impostor.pid, sidecarFor(impostor.pid, hashOf(fx.manifest)));
      const drain = reg.beginDrain(NAME);
      if (!drain.ok) throw new Error(`beginDrain refused: ${drain.reason}`);
      expect(reg.snapshot(NAME).phase).toBe("draining");
      engine.teardown = mock(() => Promise.resolve());

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect("adopted" in result).toBe(false);
      expect(result.refused?.reason).toBe("DrainInProgress");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      engine.teardown = originalTeardown;
      setResidencyLeaseRegistry(null);
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("does not promote a same-hash starting record while the residency phase is unloaded", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-adopt-unloaded-starting-"));
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((_command: string): ChildProcess => fakeChild(4321));
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const fx = fixture(tmp);
      seedStartingRecord(fx.hostDir, {
        kind: "ModelHostStarting",
        engine: "omlx",
        pid: impostor.pid,
        startedAt: new Date().toISOString(),
        specHash: hashOf(fx.manifest),
      });
      const drain = reg.beginDrain(NAME);
      if (!drain.ok) throw new Error(`beginDrain refused: ${drain.reason}`);
      expect(reg.commitUnload(drain.token).ok).toBe(true);
      expect(reg.snapshot(NAME).phase).toBe("unloaded");
      engine.teardown = killTeardown(impostor);

      const result = await startModelHost({
        key: { name: NAME },
        manifest: fx.manifest,
        workloadsDir: fx.workloadsDir,
        runtimeDir: fx.runtimeDir,
        env: fx.env,
        spawn: spawn as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [BASENAME] }),
      });

      expect("adopted" in result).toBe(false);
      expect(result).toEqual({ ok: true, pid: 4321 });
      expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      engine.teardown = originalTeardown;
      setResidencyLeaseRegistry(null);
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
