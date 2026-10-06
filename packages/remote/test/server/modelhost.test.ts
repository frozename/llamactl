import { describe, expect, mock, test } from "bun:test";
import { type spawn as nodeSpawn, spawn as spawnImpostor } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { computeModelHostSpecHash } from "../../../core/src/engines/state.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, statusModelHost, stopModelHost } from "../../src/server/modelhost.js";
import { ModelHostManifestSchema, specForHash } from "../../src/workload/modelhost-schema.js";
import { loadModelHostByName } from "../../src/workload/modelhost-store.js";

interface ManifestFixture {
  manifest: {
    readonly apiVersion: "llamactl/v1";
    readonly kind: "ModelHost";
    readonly metadata: { readonly name: "mlx-host-server" };
    readonly spec: {
      readonly engine: "omlx";
      readonly node: "local";
      readonly enabled: true;
      readonly binary: string;
      readonly endpoint: { readonly host: "127.0.0.1"; readonly port: 8094 };
      readonly hostedModels: readonly [{ readonly rel: "mlx-community/Qwen3-8B-MLX-4bit" }];
      readonly extraArgs: readonly ["--max-concurrent-requests", "1"];
      readonly restartPolicy: "Always";
      readonly timeoutSeconds: 60;
    };
  };
  workloadsDir: string;
  runtimeDir: string;
}

function makeManifest(tmp: string): ManifestFixture {
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  const fakeBinary = join(tmp, "omlx");
  mkdirSync(workloadsDir, { recursive: true });
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  const manifest = {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "mlx-host-server" },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: fakeBinary,
      endpoint: { host: "127.0.0.1", port: 8094 },
      hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
      extraArgs: ["--max-concurrent-requests", "1"],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  } as const;
  writeFileSync(
    join(workloadsDir, "mlx-host-server.yaml"),
    `apiVersion: llamactl/v1\nkind: ModelHost\nmetadata:\n  name: mlx-host-server\nspec:\n  engine: omlx\n  node: local\n  enabled: true\n  binary: ${fakeBinary}\n  endpoint:\n    host: 127.0.0.1\n    port: 8094\n  hostedModels:\n    - rel: mlx-community/Qwen3-8B-MLX-4bit\n  extraArgs:\n    - --max-concurrent-requests\n    - '1'\n  restartPolicy: Always\n  timeoutSeconds: 60\n`,
  );
  return { manifest, workloadsDir, runtimeDir };
}

function modelHostEnv(tmp: string): NodeJS.ProcessEnv {
  const modelsDir = join(tmp, "models");
  mkdirSync(modelsDir, { recursive: true });
  return {
    ...process.env,
    LLAMACTL_MODELS_DIR: modelsDir,
    LLAMA_CPP_MODELS: modelsDir,
  };
}

describe("server/modelhost", () => {
  test("persists inline manifest to workloadsDir before start", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-inline-"));
    const workloadsDir = join(tmp, "workloads");
    const runtimeDir = join(tmp, "runtime");
    const fakeBinary = join(tmp, "omlx");
    mkdirSync(workloadsDir, { recursive: true });
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => {
      expect(readFileSync(join(workloadsDir, "mlx-host-inline.yaml"), "utf8")).toContain(
        "name: mlx-host-inline",
      );
      return { pid: 4321 } as const;
    });
    const manifest = {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "mlx-host-inline" },
      spec: {
        engine: "omlx",
        node: "mac-mini",
        enabled: true,
        binary: fakeBinary,
        endpoint: { host: "127.0.0.1", port: 8098 },
        hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
        extraArgs: ["--max-concurrent-requests", "2"],
        restartPolicy: "Always",
        timeoutSeconds: 60,
      },
    } as const;

    try {
      const result = await startModelHost({
        key: { name: "mlx-host-inline" },
        manifest,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(readFileSync(join(workloadsDir, "mlx-host-inline.yaml"), "utf8")).toContain(
        "name: mlx-host-inline",
      );
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("keeps the manifest binary as source of truth", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-binary-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [binary] = spawn.mock.calls[0] as unknown as [string, string[], unknown];
      expect(binary).toBe(join(tmp, "omlx"));
      expect(binary).not.toBe("/tmp/evil.sh");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("keeps the manifest endpoint as source of truth", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-endpoint-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result.pid).toBe(4321);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("calls prepareLaunch before buildBootCommand on the start path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-prepare-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const order: string[] = [];
    const engine = ENGINES.omlx;
    const originalPrepareLaunch = engine.prepareLaunch?.bind(engine);
    if (!originalPrepareLaunch) throw new Error("omlx engine missing prepareLaunch");
    const originalBuildBootCommand = engine.buildBootCommand.bind(engine);
    const prepareLaunch = mock(() => {
      order.push("prepareLaunch");
      return Promise.resolve();
    });
    const buildBootCommand = mock(
      (
        spec: Parameters<typeof engine.buildBootCommand>[0],
        env: Parameters<typeof engine.buildBootCommand>[1],
      ) => {
        order.push(`buildBootCommand:${spec.binary}`);
        return originalBuildBootCommand(spec, env);
      },
    );
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      engine.prepareLaunch = prepareLaunch;
      engine.buildBootCommand = buildBootCommand;
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(order[0]).toBe("prepareLaunch");
      expect(order[1]).toContain("buildBootCommand");
      expect(buildBootCommand).toHaveBeenCalled();
    } finally {
      engine.prepareLaunch = originalPrepareLaunch;
      engine.buildBootCommand = originalBuildBootCommand;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tears down the spawned pid when readiness fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-teardown-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: false, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(tornDown).toEqual([4321]);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sanitizes the spawned env to the allowlist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-env-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      USER: "test",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/tmp",
      LLAMACTL_MODELS_DIR: "/models",
      LLAMA_CPP_MODELS: "/llama-models",
      LLAMA_CPP_BIN: "/bin/llama",
      SECRET_TOKEN: "leak",
    } as NodeJS.ProcessEnv;
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, , options] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv },
      ];
      expect(options.env?.["SECRET_TOKEN"]).toBeUndefined();
      expect(options.env?.["PATH"]).toBe("/usr/bin");
      expect(options.env?.["LLAMA_CPP_BIN"]).toBe("/bin/llama");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("startModelHost writes state sidecar with the spawn pid", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-start-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(
        readFileSync(join(runtimeDir, "workloads", "mlx-host-server", "modelhost.state"), "utf8"),
      ).toContain('"pid": 4321');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("startModelHost records the resolved slotSavePath in state and preserves raw extraArgs in the spec hash input", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-slotpath-"));
    const { workloadsDir, runtimeDir, manifest: baseManifest } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...baseManifest,
          spec: { ...baseManifest.spec, extraArgs: ["--slot-save-path", "auto"] },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      const state = JSON.parse(
        readFileSync(join(runtimeDir, "workloads", "mlx-host-server", "modelhost.state"), "utf8"),
      ) as { slotSavePath?: string | null };
      expect(state.slotSavePath).toBe(join(runtimeDir, "kvstore", "slots", "mlx-host-server"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("stopModelHost reads state, tears down the pid, and removes sidecar state", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-stop-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    // The recorded pid must be a live process with an omlx-shaped command
    // line or the pid-identity check (rightly) refuses teardown — argv0 is
    // stamped so `ps` corroborates it; teardown is mocked so nothing is
    // actually signalled.
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    if (impostor.pid === undefined) throw new Error("impostor spawn failed");
    const spawn = mock(
      (..._args: Parameters<typeof nodeSpawn>) => ({ pid: impostor.pid }) as const,
    );
    const tornDown: number[] = [];
    try {
      await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([impostor.pid]);
      expect(result.pid).toBe(impostor.pid);
      expect(statusModelHost({ key: { name: "mlx-host-server" }, runtimeDir })).toEqual({
        state: "Stopped",
      });
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("spec.env values appear in the spawned child environment", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-specenv-"));
    const workloadsDir = join(tmp, "workloads");
    const runtimeDir = join(tmp, "runtime");
    const fakeBinary = join(tmp, "omlx");
    mkdirSync(workloadsDir, { recursive: true });
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const manifest = {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "mlx-host-specenv" },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: fakeBinary,
        endpoint: { host: "127.0.0.1", port: 8099 },
        hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
        env: { MLX_METAL_MAX_INFLIGHT_PER_STREAM: "1", MY_CUSTOM: "hello" },
      },
    } as const;
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      SECRET_TOKEN: "leak",
      LLAMACTL_MODELS_DIR: "/tmp/models",
    } as NodeJS.ProcessEnv;

    try {
      const result = await startModelHost({
        key: { name: "mlx-host-specenv" },
        manifest,
        workloadsDir,
        runtimeDir,
        env,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, , options] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv },
      ];
      expect(options.env?.["MLX_METAL_MAX_INFLIGHT_PER_STREAM"]).toBe("1");
      expect(options.env?.["MY_CUSTOM"]).toBe("hello");
      expect(options.env?.["SECRET_TOKEN"]).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("statusModelHost reports Stopped when there is no sidecar", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-status-"));
    try {
      expect(
        statusModelHost({
          key: { name: "mlx-host-server" },
          runtimeDir: join(tmp, "runtime"),
        }),
      ).toEqual({ state: "Stopped" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reaps a prior live ModelHost before spawning a replacement", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-reap-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const tornDown: number[] = [];
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      // Seed a prior sidecar whose pid is genuinely alive and presents the
      // omlx argv0, so the reap path verifies identity and tears it down
      // BEFORE the replacement spawns.
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(join(hostDir, "modelhost.pid"), `${String(impostor.pid)}\n`);
      writeFileSync(
        join(hostDir, "modelhost.state"),
        JSON.stringify({
          kind: "ModelHost",
          engine: "omlx",
          pid: impostor.pid,
          host: "127.0.0.1",
          port: 8094,
          modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
          startedAt: new Date().toISOString(),
        }),
      );
      // Mock teardown so the reap does NOT actually signal the impostor.
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([impostor.pid]); // old listener reaped first
      expect(spawn).toHaveBeenCalledTimes(1);
      // The replacement's real pid is recorded, not the stale one.
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain('"pid": 4321');
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

  test("refuses to record a stale pid when the spawned child already exited", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-stalepid-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    // The new child fails to bind the still-held port and has already exited;
    // probeReady is satisfied by the OLD listener that still owns the port.
    const spawn = mock(
      (..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321, exitCode: 1 }) as const,
    );
    try {
      engine.teardown = mock(() => Promise.resolve());
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("exited before readiness");
      // No sidecar is written for the dead pid, so listLocalRoutes won't drop it.
      expect(existsSync(join(runtimeDir, "workloads", "mlx-host-server", "modelhost.state"))).toBe(
        false,
      );
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A pid that is essentially never alive (above any plausible pid_max), so
  // process.kill(pid, 0) reliably throws ESRCH → treated as dead.
  const DEAD_PID = 2 ** 31 - 1;

  function seedDeadSidecar(runtimeDir: string, specHash?: string): string {
    const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
    mkdirSync(hostDir, { recursive: true });
    const state = {
      kind: "ModelHost",
      engine: "omlx",
      pid: DEAD_PID,
      host: "127.0.0.1",
      port: 8094,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
      startedAt: new Date().toISOString(),
      ...(specHash !== undefined ? { specHash } : {}),
    };
    writeFileSync(join(hostDir, "modelhost.state"), JSON.stringify(state));
    writeFileSync(join(hostDir, "modelhost.pid"), `${String(DEAD_PID)}\n`);
    return hostDir;
  }

  test("statusModelHost reports Stopped when the recorded pid is dead", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-deadpid-"));
    const runtimeDir = join(tmp, "runtime");
    try {
      seedDeadSidecar(runtimeDir);
      expect(statusModelHost({ key: { name: "mlx-host-server" }, runtimeDir }).state).toBe(
        "Stopped",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("adopts a live out-of-band host (dead recorded pid) instead of spawning a competitor", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-adopt-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 9999 }) as const);
    try {
      // A same-spec respawn: the recorded launch spec matches the desired
      // manifest, so the live listener is adoptable.
      const desired = loadModelHostByName("mlx-host-server", workloadsDir);
      const hostDir = seedDeadSidecar(
        runtimeDir,
        computeModelHostSpecHash(specForHash(desired.spec)),
      );
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () =>
          Promise.resolve({ ready: true, modelIds: ["mlx-community/Qwen3-8B-MLX-4bit"] }),
        // A genuinely-alive pid serving the endpoint out-of-band.
        findListenerPid: () => Promise.resolve(process.pid),
      });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(process.pid);
      // Adopted the live process — did NOT spawn a competitor for the held port.
      expect(spawn).not.toHaveBeenCalled();
      // The live pid is re-recorded so listLocalRoutes restores the route.
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain(
        `"pid": ${String(process.pid)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("relaunches a live listener whose recorded spec drifted on a resources-only change", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-adoptdrift-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const tornDown: number[] = [];
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const hostDir = seedDeadSidecar(
        runtimeDir,
        // The recorded launch ran with expectedMemoryGiB=24; the applied
        // manifest bumps only resources to 32, so the live listener is a
        // spec-drifted process, not a same-spec respawn.
        computeModelHostSpecHash(
          specForHash(
            ModelHostManifestSchema.parse({
              ...manifest,
              spec: { ...manifest.spec, resources: { expectedMemoryGiB: 24 } },
            }).spec,
          ),
        ),
      );
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: { ...manifest.spec, resources: { expectedMemoryGiB: 32 } },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () =>
          Promise.resolve({ ready: true, modelIds: ["mlx-community/Qwen3-8B-MLX-4bit"] }),
        // The stale spec's process is still bound to the endpoint.
        findListenerPid: () => Promise.resolve(process.pid),
      });

      // A drifted spec must not be silently adopted: the stale listener is
      // torn down and a replacement spawned, so the new resources take effect.
      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([process.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result.pid).toBe(4321);
      const state = JSON.parse(readFileSync(join(hostDir, "modelhost.state"), "utf8")) as {
        specHash?: string;
      };
      expect(state.specHash).toContain('"expectedMemoryGiB":32');
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("defers (does not spawn) when a live process holds the endpoint but is not yet adoptable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-defer-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 9999 }) as const);
    try {
      seedDeadSidecar(runtimeDir);
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        // A live process owns the port but is still loading (not ready).
        probeReady: () => Promise.resolve({ ready: false, modelIds: [] }),
        findListenerPid: () => Promise.resolve(process.pid),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("deferring restart");
      // Must NOT spawn a competitor that cannot bind the held port.
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("spawns a replacement when the recorded pid is dead and no live host serves the endpoint", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-deadrespawn-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const hostDir = seedDeadSidecar(runtimeDir);
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
        // Port is free — nothing to adopt.
        findListenerPid: () => Promise.resolve(null),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain('"pid": 4321');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A tracking record whose mtime predates the process now holding its pid is
  // a recycled-pid record: the recorded process cannot have started after the
  // record was written, so the pid belongs to someone else and must never be
  // torn down (omlx teardown signals the whole process group).
  function seedImpostorSidecar(runtimeDir: string, pid: number, backdate: boolean): string {
    const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
    mkdirSync(hostDir, { recursive: true });
    const pidPath = join(hostDir, "modelhost.pid");
    const statePath = join(hostDir, "modelhost.state");
    writeFileSync(pidPath, `${String(pid)}\n`);
    writeFileSync(
      statePath,
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid,
        host: "127.0.0.1",
        port: 8094,
        modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
        startedAt: new Date().toISOString(),
      }),
    );
    if (backdate) {
      const hourAgo = new Date(Date.now() - 3_600_000);
      utimesSync(pidPath, hourAgo, hourAgo);
      utimesSync(statePath, hourAgo, hourAgo);
    }
    return hostDir;
  }

  test("never tears down a recycled recorded pid and reports Stopped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-reusedpid-"));
    const runtimeDir = join(tmp, "runtime");
    const impostor = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore" });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const pid = impostor.pid;
      const hostDir = seedImpostorSidecar(runtimeDir, pid, true);
      // The recycled pid must read as Stopped while the sidecar still exists.
      expect(statusModelHost({ key: { name: "mlx-host-server" }, runtimeDir })).toEqual({
        state: "Stopped",
      });
      const tornDown: number[] = [];
      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (teardownPid) => {
          tornDown.push(teardownPid);
          return Promise.resolve();
        },
      });

      expect(tornDown).toEqual([]);
      expect(result.ok).toBe(true);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(false);
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tears down a recorded pid whose identity still matches (control)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-samepid-"));
    const runtimeDir = join(tmp, "runtime");
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const pid = impostor.pid;
      seedImpostorSidecar(runtimeDir, pid, false);
      const tornDown: number[] = [];
      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (teardownPid) => {
          tornDown.push(teardownPid);
          return Promise.resolve();
        },
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([pid]);
      expect(result.pid).toBe(pid);
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("identity is anchored on modelhost.pid, not the state sidecar", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-pidanchor-"));
    const runtimeDir = join(tmp, "runtime");
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const hostDir = seedImpostorSidecar(runtimeDir, impostor.pid, false);
      // writeModelHostState writes modelhost.pid first, then the sidecar — so
      // the pid file is the identity anchor. A stale-looking pid file means
      // the process is treated as recycled even when the sidecar is fresh.
      const hourAgo = new Date(Date.now() - 3_600_000);
      utimesSync(join(hostDir, "modelhost.pid"), hourAgo, hourAgo);
      expect(statusModelHost({ key: { name: "mlx-host-server" }, runtimeDir }).state).toBe(
        "Stopped",
      );
      const tornDown: number[] = [];
      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (teardownPid) => {
          tornDown.push(teardownPid);
          return Promise.resolve();
        },
      });
      expect(tornDown).toEqual([]);
      expect(result.ok).toBe(true);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(false);
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("statusModelHost surfaces identityUnknown when the record cannot be verified", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-idunknown-"));
    const runtimeDir = join(tmp, "runtime");
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      seedImpostorSidecar(runtimeDir, impostor.pid, false);
      const st = statusModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        identity: { processStartMs: () => null },
      });
      expect(st.state).toBe("Stopped");
      expect(st.identityUnknown).toBe(true);
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("stopModelHost reports ok:false and preserves state while identity is unknown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-unkstop-"));
    const runtimeDir = join(tmp, "runtime");
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const hostDir = seedImpostorSidecar(runtimeDir, impostor.pid, false);
      const tornDown: number[] = [];
      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (teardownPid) => {
          tornDown.push(teardownPid);
          return Promise.resolve();
        },
        identity: { processStartMs: () => null },
      });
      expect(result.ok).toBe(false);
      expect(tornDown).toEqual([]);
      // Nothing was signalled and the tracking record survives for a retry.
      expect(existsSync(join(hostDir, "modelhost.pid"))).toBe(true);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(true);
      try {
        process.kill(impostor.pid, 0);
      } catch {
        throw new Error("impostor was signalled");
      }
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
