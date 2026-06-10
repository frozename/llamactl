import type { spawn as nodeSpawn } from "node:child_process";

import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { startModelHost, statusModelHost, stopModelHost } from "../../src/server/modelhost.js";

function makeManifest(tmp: string) {
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
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
    const originalPrepareLaunch = engine.prepareLaunch;
    const originalBuildBootCommand = engine.buildBootCommand;
    const prepareLaunch = mock(async () => {
      order.push("prepareLaunch");
    });
    const buildBootCommand = mock((spec: Parameters<typeof engine.buildBootCommand>[0], env) => {
      order.push(`buildBootCommand:${spec.binary}`);
      return originalBuildBootCommand(spec, env);
    });
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
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
    const originalTeardown = engine.teardown;
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      engine.teardown = mock(async (pid: number) => {
        tornDown.push(pid);
      });
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: async () => ({ ready: false, modelIds: [] }),
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, , options] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv },
      ];
      expect(options.env?.SECRET_TOKEN).toBeUndefined();
      expect(options.env?.PATH).toBe("/usr/bin");
      expect(options.env?.LLAMA_CPP_BIN).toBe("/bin/llama");
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
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
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const tornDown: number[] = [];
    try {
      await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: async (pid) => {
          tornDown.push(pid);
        },
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([4321]);
      expect(result.pid).toBe(4321);
      expect(statusModelHost({ key: { name: "mlx-host-server" }, runtimeDir })).toEqual({
        state: "Stopped",
      });
    } finally {
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, , options] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env?: NodeJS.ProcessEnv },
      ];
      expect(options.env?.MLX_METAL_MAX_INFLIGHT_PER_STREAM).toBe("1");
      expect(options.env?.MY_CUSTOM).toBe("hello");
      expect(options.env?.SECRET_TOKEN).toBeUndefined();
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
    const originalTeardown = engine.teardown;
    const tornDown: number[] = [];
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      // Seed a prior sidecar whose pid is genuinely alive (this test process),
      // so the reap path fires and tears it down BEFORE the replacement spawns.
      const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(
        join(hostDir, "modelhost.state"),
        JSON.stringify({
          kind: "ModelHost",
          engine: "omlx",
          pid: process.pid,
          host: "127.0.0.1",
          port: 8094,
          modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
          startedAt: new Date().toISOString(),
        }),
      );
      // Mock teardown so the reap does NOT actually signal this test process.
      engine.teardown = mock(async (pid: number) => {
        tornDown.push(pid);
      });

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([process.pid]); // old listener reaped first
      expect(spawn).toHaveBeenCalledTimes(1);
      // The replacement's real pid is recorded, not the stale one.
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain('"pid": 4321');
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses to record a stale pid when the spawned child already exited", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-stalepid-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown;
    // The new child fails to bind the still-held port and has already exited;
    // probeReady is satisfied by the OLD listener that still owns the port.
    const spawn = mock(
      (..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321, exitCode: 1 }) as const,
    );
    try {
      engine.teardown = mock(async () => {});
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: async () => ({ ready: true, modelIds: [] }),
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

  function seedDeadSidecar(runtimeDir: string): string {
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
    };
    writeFileSync(join(hostDir, "modelhost.state"), JSON.stringify(state));
    writeFileSync(join(hostDir, "modelhost.pid"), `${DEAD_PID}\n`);
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
      const hostDir = seedDeadSidecar(runtimeDir);
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: async () => ({ ready: true, modelIds: ["mlx-community/Qwen3-8B-MLX-4bit"] }),
        // A genuinely-alive pid serving the endpoint out-of-band.
        findListenerPid: async () => process.pid,
      });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(process.pid);
      // Adopted the live process — did NOT spawn a competitor for the held port.
      expect(spawn).not.toHaveBeenCalled();
      // The live pid is re-recorded so listLocalRoutes restores the route.
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain(
        `"pid": ${process.pid}`,
      );
    } finally {
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
        probeReady: async () => ({ ready: false, modelIds: [] }),
        findListenerPid: async () => process.pid,
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
        probeReady: async () => ({ ready: true, modelIds: [] }),
        // Port is free — nothing to adopt.
        findListenerPid: async () => null,
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain('"pid": 4321');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
