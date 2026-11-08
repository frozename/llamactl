import { describe, expect, mock, test } from "bun:test";
import { type spawn as nodeSpawn, spawn as spawnImpostor } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineBootEnv } from "../../../core/src/engines/types.js";

import {
  recordModelHostOomKill,
  recordModelHostReconcileError,
} from "../../../core/src/engines/conditions.js";
import { ENGINES } from "../../../core/src/engines/index.js";
import { computeModelHostSpecHash } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
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
import {
  MANAGED_BY_LABEL,
  type ModelHostManifest,
  ModelHostManifestSchema,
  specForHash,
} from "../../src/workload/modelhost-schema.js";
import { loadModelHostByName, saveModelHost } from "../../src/workload/modelhost-store.js";

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

interface ReadinessGate {
  promise: Promise<{ ready: boolean; modelIds: string[] }>;
  open: () => void;
}

function readinessGate(): ReadinessGate {
  let release: (value: { ready: boolean; modelIds: string[] }) => void = () => undefined;
  const promise = new Promise<{ ready: boolean; modelIds: string[] }>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    open: (): void => {
      release({ ready: true, modelIds: [] });
    },
  };
}

// Bounded condition wait: polls every 5 ms for at most 2 s, never a fixed sleep.
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Bounded settle for a start that must answer an abort: a start that swallows
// the signal never resolves, so the sentinel fails the result assertion
// instead of stalling until the bun test timeout.
async function settleWithin<T>(promise: Promise<T>): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => {
          resolve("timed-out");
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  test("preserves the on-disk managed-by label when the inline manifest omits it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-managed-by-"));
    const workloadsDir = join(tmp, "workloads");
    const runtimeDir = join(tmp, "runtime");
    const fakeBinary = join(tmp, "omlx");
    mkdirSync(workloadsDir, { recursive: true });
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    const unlabeled: ModelHostManifest = {
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
    };
    saveModelHost(
      {
        ...unlabeled,
        metadata: { name: "mlx-host-inline", labels: { [MANAGED_BY_LABEL]: "mac-mini" } },
      },
      workloadsDir,
    );
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);

    try {
      const result = await startModelHost({
        key: { name: "mlx-host-inline" },
        manifest: unlabeled,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(
        loadModelHostByName("mlx-host-inline", workloadsDir).metadata.labels?.[MANAGED_BY_LABEL],
      ).toBe("mac-mini");
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

  test("reports the spawned pid as generation evidence when readiness fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-failpid-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const events: unknown[] = [];
    try {
      engine.teardown = mock((_pid: number) => Promise.resolve());
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: false, modelIds: [] }),
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(result.ok).toBe(false);
      expect(result.pid).toBeNull();
      expect(result.spawnedPid).toBe(4321);
      const done = events.find((event) => (event as { type?: string }).type === "done") as
        | { result?: { ok?: boolean; pid?: number | null; spawnedPid?: number } }
        | undefined;
      expect(done?.result?.ok).toBe(false);
      expect(done?.result?.pid).toBeNull();
      expect(done?.result?.spawnedPid).toBe(4321);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("omits spawnedPid when the start fails before any spawn", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-nospawn-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: { ...manifest.spec, endpoint: { host: "0.0.0.0", port: 8094 } },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("allowExternalBind");
      expect(spawn).not.toHaveBeenCalled();
      expect("spawnedPid" in result).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("omits spawnedPid on a successful launch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-oknopid-"));
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
      expect("spawnedPid" in result).toBe(false);
    } finally {
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

  test("startModelHost creates the workload runtime dir so the first launch gets a boot log", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bootlog-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const bootLogPath = join(runtimeDir, "workloads", "mlx-host-server", "modelhost.boot.log");
    // #333: a never-seen host has no <runtime>/workloads/<name>/ yet. The boot
    // log must already be open when the engine is spawned, not degrade to
    // stdio "ignore".
    const bootLogAtSpawn: boolean[] = [];
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>): { pid: number } => {
      bootLogAtSpawn.push(existsSync(bootLogPath));
      return { pid: 4321 };
    });
    try {
      expect(existsSync(join(runtimeDir, "workloads", "mlx-host-server"))).toBe(false);
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        // omlx prepareLaunch writes its isolated model dir under
        // LLAMACTL_RUNTIME_DIR; keep it out of runtimeDir so only the boot-log
        // path can create the workload dir there.
        env: { ...modelHostEnv(tmp), LLAMACTL_RUNTIME_DIR: join(tmp, "omlx-runtime") },
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, , options] = spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { stdio?: "ignore" | ("ignore" | number)[] },
      ];
      expect(options.stdio).not.toBe("ignore");
      const stdio = Array.isArray(options.stdio) ? options.stdio : [];
      expect(stdio).toHaveLength(3);
      expect(stdio[0]).toBe("ignore");
      expect(typeof stdio[1]).toBe("number");
      expect(stdio[2]).toBe(stdio[1]);
      expect(bootLogAtSpawn).toEqual([true]);
      expect(existsSync(bootLogPath)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an operator-set LLAMACTL_RUNTIME_DIR reaches a non-kapitsa engine's boot env unchanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-rtenv-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const operatorRuntimeDir = join(tmp, "operator-runtime");
    const engine = ENGINES.omlx;
    const originalBuildBootCommand = engine.buildBootCommand.bind(engine);
    const bootEnvs: EngineBootEnv[] = [];
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      engine.buildBootCommand = mock(
        (
          spec: Parameters<typeof engine.buildBootCommand>[0],
          env: Parameters<typeof engine.buildBootCommand>[1],
        ) => {
          bootEnvs.push(env);
          return originalBuildBootCommand(spec, env);
        },
      );
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: { ...modelHostEnv(tmp), LLAMACTL_RUNTIME_DIR: operatorRuntimeDir },
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      // #372: the resolved launch root must not overwrite an operator-set
      // LLAMACTL_RUNTIME_DIR for engines that honour it — oMLX places its
      // per-workload .omlx dir underneath it.
      expect(bootEnvs).toHaveLength(1);
      expect(bootEnvs[0]?.LLAMACTL_RUNTIME_DIR).toBe(operatorRuntimeDir);
      const [, args] = spawn.mock.calls[0] as unknown as [string, string[], unknown];
      expect(args).toContain(
        join(operatorRuntimeDir, "workloads", "mlx-host-server", ".omlx", "models"),
      );
    } finally {
      engine.buildBootCommand = originalBuildBootCommand;
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

  test("statusModelHost surfaces persisted conditions after the host stopped", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-conditions-"));
    const runtimeDir = join(tmp, "runtime");
    const key = { name: "mlx-host-server" };
    const resolved = resolveEnv({ LOCAL_AI_RUNTIME_DIR: runtimeDir });
    try {
      recordModelHostReconcileError(
        key,
        { reason: "ApplyFailed", message: "strata run-config --native must be A; got B" },
        resolved,
        new Date("2026-10-21T14:07:00.000Z"),
      );
      recordModelHostOomKill(key, 2, resolved, new Date("2026-10-21T14:02:12.000Z"));
      const st = statusModelHost({ key, runtimeDir });
      expect(st.state).toBe("Stopped");
      expect(st.runtime?.conditions.map((c) => [c.type, c.status, c.reason])).toEqual([
        ["ReconcileError", "True", "ApplyFailed"],
        ["OOMKilled", "True", "CgroupOOMKill"],
      ]);
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

  test("refuses a non-loopback bind before reaping the prior live host", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bind-reap-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const tornDown: number[] = [];
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const events: unknown[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
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
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: { ...manifest.spec, endpoint: { host: "0.0.0.0", port: 8094 } },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        onEvent: (event) => {
          events.push(event);
        },
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("allowExternalBind");
      // The refusal lands before the teardown: the prior host is untouched.
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain(
        `"pid":${String(impostor.pid)}`,
      );
      const done = events.find((event) => (event as { type?: string }).type === "done") as
        | { result?: { ok?: boolean; error?: string } }
        | undefined;
      expect(done?.result?.ok).toBe(false);
      expect(done?.result?.error).toContain("allowExternalBind");
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

  test("a refused external-bind inline start leaves the saved manifest unchanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bindrefuse-save-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const manifestPath = join(workloadsDir, "mlx-host-server.yaml");
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const accepted = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });
      expect(accepted.ok).toBe(true);
      const savedBefore = readFileSync(manifestPath, "utf8");

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: { ...manifest.spec, endpoint: { host: "0.0.0.0", port: 8094 } },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("allowExternalBind");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(manifestPath, "utf8")).toBe(savedBefore);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an engine-validation failure on an inline start leaves the saved manifest unchanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-validate-save-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const manifestPath = join(workloadsDir, "mlx-host-server.yaml");
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const accepted = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });
      expect(accepted.ok).toBe(true);
      const savedBefore = readFileSync(manifestPath, "utf8");

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: { ...manifest.spec, binary: join(tmp, "missing-omlx") },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("binary not found");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(manifestPath, "utf8")).toBe(savedBefore);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an allowed external-bind inline start still persists the manifest", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bindallow-save-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: {
            ...manifest.spec,
            endpoint: { host: "0.0.0.0", port: 8094 },
            allowExternalBind: true,
          },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        warn: () => undefined,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(workloadsDir, "mlx-host-server.yaml"), "utf8")).toContain(
        "host: 0.0.0.0",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("warns once when an allowed external bind proceeds to spawn", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bind-warn-"));
    const { workloadsDir, runtimeDir, manifest } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const warnings: string[] = [];
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        manifest: {
          ...manifest,
          spec: {
            ...manifest.spec,
            endpoint: { host: "0.0.0.0", port: 8094 },
            allowExternalBind: true,
          },
        },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        warn: (message) => {
          warnings.push(message);
        },
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, args] = spawn.mock.calls[0] as unknown as [string, string[], unknown];
      expect(args[args.indexOf("--host") + 1]).toBe("0.0.0.0");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("0.0.0.0:8094");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("does not warn for the default loopback endpoint", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bind-nowarn-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const warnings: string[] = [];
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        warn: (message) => {
          warnings.push(message);
        },
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
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

  test("stopModelHost corroborates a strata pid against the strata-server argv0", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-strata-"));
    const runtimeDir = join(tmp, "runtime");
    const hostDir = join(runtimeDir, "workloads", "strata-host-server");
    mkdirSync(hostDir, { recursive: true });
    const seedStrataSidecar = (pid: number): void => {
      writeFileSync(join(hostDir, "modelhost.pid"), `${String(pid)}\n`);
      writeFileSync(
        join(hostDir, "modelhost.state"),
        JSON.stringify({
          kind: "ModelHost",
          engine: "strata",
          pid,
          host: "127.0.0.1",
          port: 8095,
          modelAliases: ["strata/qwen3-8b", "qwen3-8b"],
          startedAt: new Date().toISOString(),
        }),
      );
    };

    // A live strata-server argv0 corroborates the strata identity map, so
    // teardown runs; an omlx argv0 against the same strata record is a command
    // mismatch (unknown identity) and must NOT be torn down.
    const matched = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "strata-server",
    });
    const mismatched = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0: "omlx" });
    try {
      if (matched.pid === undefined || mismatched.pid === undefined) {
        throw new Error("impostor spawn failed");
      }

      seedStrataSidecar(matched.pid);
      const tornDown: number[] = [];
      const okResult = await stopModelHost({
        key: { name: "strata-host-server" },
        runtimeDir,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(okResult.ok).toBe(true);
      expect(tornDown).toEqual([matched.pid]);

      seedStrataSidecar(mismatched.pid);
      const refusedTornDown: number[] = [];
      const refused = await stopModelHost({
        key: { name: "strata-host-server" },
        runtimeDir,
        teardown: (pid) => {
          refusedTornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(refused.ok).toBe(false);
      expect(refusedTornDown).toEqual([]);
    } finally {
      for (const proc of [matched, mismatched]) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
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

  test("statusModelHost reports identityUnknown for a live pid whose argv0 is not the engine binary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-statuscmd-"));
    const runtimeDir = join(tmp, "runtime");
    const key = { name: "mlx-host-server" };
    // #317: status must agree with stop. The recorded pid is alive, but its
    // argv0 is not omlx, so stop refuses it and status must not say Running.
    const identity = {
      processStartMs: (): number => 0,
      processCommand: (): string => "/bin/sleep 60",
    };
    try {
      const hostDir = seedImpostorSidecar(runtimeDir, process.pid, false);
      expect(statusModelHost({ key, runtimeDir, identity })).toEqual({
        state: "Stopped",
        identityUnknown: true,
      });
      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key,
        runtimeDir,
        identity,
        teardown: (teardownPid) => {
          tornDown.push(teardownPid);
          return Promise.resolve();
        },
      });
      expect(stopped).toEqual({ ok: false, pid: process.pid, error: "pid identity unknown" });
      expect(tornDown).toEqual([]);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("statusModelHost still reports Running when the live pid's argv0 is the engine binary", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-statuscmd-ok-"));
    const runtimeDir = join(tmp, "runtime");
    try {
      seedImpostorSidecar(runtimeDir, process.pid, false);
      expect(
        statusModelHost({
          key: { name: "mlx-host-server" },
          runtimeDir,
          identity: {
            processStartMs: (): number => 0,
            processCommand: (): string => "/opt/omlx/bin/omlx serve --port 8094",
          },
        }),
      ).toEqual({ state: "Running", pid: process.pid });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("#357 an omlx host running as omlx-server is Running and stoppable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-omlx-server-"));
    const runtimeDir = join(tmp, "runtime");
    const key = { name: "mlx-host-server" };
    // A running oMLX server sets its own process title, so ps prints
    // `omlx-server` plus padding instead of the `omlx` launcher name.
    const identity = {
      processStartMs: (): number => 0,
      processCommand: (): string => "omlx-server                ",
    };
    try {
      seedImpostorSidecar(runtimeDir, process.pid, false);
      expect(statusModelHost({ key, runtimeDir, identity })).toEqual({
        state: "Running",
        pid: process.pid,
      });
      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key,
        runtimeDir,
        identity,
        teardown: (teardownPid) => {
          tornDown.push(teardownPid);
          return Promise.resolve();
        },
      });
      expect(stopped).toEqual({ ok: true, pid: process.pid });
      expect(tornDown).toEqual([process.pid]);
    } finally {
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

  test("a concurrent start for the same workload joins the in-flight start instead of spawning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-join-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const gate = readinessGate();
    let probeCalls = 0;
    const probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> => {
      probeCalls += 1;
      return gate.promise;
    };
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const common = {
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
      };
      const firstPromise = startModelHost({
        ...common,
        probeReady,
        onEvent: (event: unknown): void => {
          eventsA.push(event);
        },
      });
      const secondPromise = startModelHost({
        ...common,
        probeReady,
        onEvent: (event: unknown): void => {
          eventsB.push(event);
        },
      });
      await waitFor(() => probeCalls >= 1, "first start to reach readiness");
      expect(eventsB).toEqual([]);
      gate.open();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(probeCalls).toBe(1);
      expect(first).toEqual({ ok: true, pid: 4321 });
      expect(second).toEqual({ ok: true, pid: 4321 });
      expect(eventsA).toEqual([{ type: "done", result: { ok: true, pid: 4321 } }]);
      expect(eventsB).toEqual([{ type: "done", result: { ok: true, pid: 4321 } }]);
      expect(tornDown).toEqual([]);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a concurrent start with a different spec is refused while one is in flight", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-conflict-"));
    const fixture = makeManifest(tmp);
    const { workloadsDir, runtimeDir } = fixture;
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const gate = readinessGate();
    let probeCalls = 0;
    const probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> => {
      probeCalls += 1;
      return gate.promise;
    };
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const common = {
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
      };
      const firstPromise = startModelHost({
        ...common,
        probeReady,
        onEvent: (event: unknown): void => {
          eventsA.push(event);
        },
      });
      const secondPromise = startModelHost({
        ...common,
        manifest: {
          ...fixture.manifest,
          spec: { ...fixture.manifest.spec, endpoint: { host: "127.0.0.1", port: 8095 } },
        },
        probeReady,
        onEvent: (event: unknown): void => {
          eventsB.push(event);
        },
      });
      await waitFor(() => probeCalls >= 1, "first start to reach readiness");
      gate.open();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(second).toEqual({
        ok: false,
        pid: null,
        error: "modelHostStart already in progress for mlx-host-server with a different spec",
      });
      expect(eventsB).toEqual([{ type: "done", result: second }]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ ok: true, pid: 4321 });
      expect(tornDown).toEqual([]);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a settled start releases the in-flight slot for the next start", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-release-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    let spawnCalls = 0;
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>): { pid?: number } => {
      spawnCalls += 1;
      return spawnCalls === 1 ? {} : { pid: 4321 };
    });
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const common = {
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: (): Promise<{ ready: boolean; modelIds: string[] }> =>
          Promise.resolve({ ready: true, modelIds: [] }),
      };
      const failed = await startModelHost(common);
      const retried = await startModelHost(common);
      expect(failed).toEqual({ ok: false, pid: null, error: "failed to spawn modelhost process" });
      expect(retried).toEqual({ ok: true, pid: 4321 });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(tornDown).toEqual([]);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #317: an agent restart while a spawned engine is still starting leaves it
  // live but unrecorded — the state sidecar only exists after readiness. The
  // start-up record (workloads/<name>/modelhost.starting, written at spawn
  // time) is the only track of the child; its mtime is the pid-identity
  // anchor, so it must be seeded AFTER the impostor spawns.
  function seedStartingRecord(runtimeDir: string, pid: number, specHash: string): string {
    const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, "modelhost.starting"),
      JSON.stringify({
        kind: "ModelHostStarting",
        engine: "omlx",
        pid,
        startedAt: new Date().toISOString(),
        specHash,
      }),
    );
    return hostDir;
  }

  test("stopModelHost stops a child that is still starting", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-starting-stop-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const gate = readinessGate();
    const tornDown: number[] = [];
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      // The start's own failure path must not signal the real impostor if the
      // in-flight launch unwinds after the stop.
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const spawn = mock(
        (..._args: Parameters<typeof nodeSpawn>) => ({ pid: impostor.pid }) as const,
      );
      const startPromise = startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => gate.promise,
        findListenerPid: () => Promise.resolve(null),
      });
      await waitFor(() => spawn.mock.calls.length === 1, "spawn");

      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });

      expect(tornDown).toEqual([impostor.pid]);
      expect(result.ok).toBe(true);
      expect(result.pid).toBe(impostor.pid);
      gate.open();
      await startPromise;
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

  test("startModelHost reaps an orphan left by an agent restart during start-up", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-starting-reap-"));
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
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      // A starting record with no state sidecar: the agent died mid-launch.
      const desired = loadModelHostByName("mlx-host-server", workloadsDir);
      const hostDir = seedStartingRecord(
        runtimeDir,
        impostor.pid,
        computeModelHostSpecHash(specForHash(desired.spec)),
      );
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
        findListenerPid: () => Promise.resolve(null),
      });

      expect(tornDown).toEqual([impostor.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, pid: 4321 });
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain('"pid": 4321');
      expect(existsSync(join(hostDir, "modelhost.starting"))).toBe(false);
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

  test("stopModelHost stops an orphaned starting pid when no sidecar exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-starting-orphan-"));
    const runtimeDir = join(tmp, "runtime");
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "omlx",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const hostDir = seedStartingRecord(runtimeDir, impostor.pid, "seeded-hash");
      const tornDown: number[] = [];
      const result = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });

      expect(result.ok).toBe(true);
      expect(result.pid).toBe(impostor.pid);
      expect(tornDown).toEqual([impostor.pid]);
      expect(existsSync(join(hostDir, "modelhost.starting"))).toBe(false);
    } finally {
      try {
        impostor.kill("SIGKILL");
      } catch {
        // already gone
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a starting record whose pid fails identity is not signalled", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-starting-unknown-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    // A live pid that does not present the engine argv0 is unverifiable —
    // fail-closed: never signalled, never spawned over, record kept.
    const impostor = spawnImpostor("/bin/sleep", ["60"], {
      stdio: "ignore",
      argv0: "not-an-engine",
    });
    try {
      if (impostor.pid === undefined) throw new Error("impostor spawn failed");
      const hostDir = seedStartingRecord(runtimeDir, impostor.pid, "seeded-hash");
      const startingPath = join(hostDir, "modelhost.starting");
      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key: { name: "mlx-host-server" },
        runtimeDir,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(stopped.ok).toBe(false);
      expect(stopped.error).toContain("pid identity unknown");
      expect(tornDown).toEqual([]);

      const started = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });
      expect(started.ok).toBe(false);
      expect(started.error).toContain("deferring");
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(startingPath)).toBe(true);
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

  test("a successful start removes the starting record", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-starting-clean-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
    const startingPath = join(hostDir, "modelhost.starting");
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      engine.teardown = mock(() => Promise.resolve());
      // A start that fails readiness must clean up its own starting record
      // too — the record is only meaningful while a child is starting.
      const failed = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: false, modelIds: [] }),
        findListenerPid: () => Promise.resolve(null),
      });
      expect(failed.ok).toBe(false);
      expect(existsSync(startingPath)).toBe(false);

      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
        findListenerPid: () => Promise.resolve(null),
      });

      expect(result.ok).toBe(true);
      expect(existsSync(startingPath)).toBe(false);
      expect(readFileSync(join(hostDir, "modelhost.state"), "utf8")).toContain('"pid": 4321');
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("aborting the caller's signal during the readiness wait tears down the spawned child", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-abortready-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const gate = readinessGate();
    let probeCalls = 0;
    const probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> => {
      probeCalls += 1;
      return gate.promise;
    };
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const events: unknown[] = [];
    const ac = new AbortController();
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const startPromise = startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady,
        signal: ac.signal,
        onEvent: (event: unknown): void => {
          events.push(event);
        },
      });
      await waitFor(() => probeCalls >= 1, "start to reach the readiness wait");
      ac.abort();
      // The gate is never opened: only the abort can settle this start.
      const result = await settleWithin(startPromise);
      expect(result).toEqual({
        ok: false,
        pid: null,
        spawnedPid: 4321,
        error: "modelHostStart aborted",
      });
      expect(tornDown).toEqual([4321]);
      expect(events).toEqual([{ type: "done", result }]);
      expect(existsSync(join(runtimeDir, "workloads", "mlx-host-server", "modelhost.state"))).toBe(
        false,
      );
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an already-aborted signal refuses the start without spawning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-preaborted-"));
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
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
        signal: AbortSignal.abort(),
      });
      expect(result).toEqual({ ok: false, pid: null, error: "modelHostStart aborted" });
      expect(spawn).toHaveBeenCalledTimes(0);
      expect(tornDown).toEqual([]);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an aborted start releases the in-flight slot", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-abortslot-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const gate = readinessGate();
    let probeCalls = 0;
    const gatedProbeReady = (): Promise<{ ready: boolean; modelIds: string[] }> => {
      probeCalls += 1;
      return gate.promise;
    };
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const ac = new AbortController();
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const common = {
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
      };
      const firstPromise = startModelHost({
        ...common,
        probeReady: gatedProbeReady,
        signal: ac.signal,
      });
      await waitFor(() => probeCalls >= 1, "first start to reach the readiness wait");
      ac.abort();
      const first = await settleWithin(firstPromise);
      expect(first).toEqual({
        ok: false,
        pid: null,
        spawnedPid: 4321,
        error: "modelHostStart aborted",
      });
      expect(tornDown).toEqual([4321]);
      const retried = await settleWithin(
        startModelHost({
          ...common,
          probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
        }),
      );
      expect(retried).toEqual({ ok: true, pid: 4321 });
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("aborting a joined caller's signal does not tear down the owner's start", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-joinabort-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const tornDown: number[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    const gate = readinessGate();
    let probeCalls = 0;
    const probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> => {
      probeCalls += 1;
      return gate.promise;
    };
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const acB = new AbortController();
    try {
      engine.teardown = mock((pid: number) => {
        tornDown.push(pid);
        return Promise.resolve();
      });
      const common = {
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady,
      };
      const ownerPromise = startModelHost(common);
      const joinedPromise = startModelHost({ ...common, signal: acB.signal });
      await waitFor(() => probeCalls >= 1, "owner start to reach the readiness wait");
      acB.abort();
      const joined = await settleWithin(joinedPromise);
      expect(joined).toEqual({ ok: false, pid: null, error: "modelHostStart aborted" });
      expect(tornDown).toEqual([]);
      gate.open();
      expect(await ownerPromise).toEqual({ ok: true, pid: 4321 });
    } finally {
      engine.teardown = originalTeardown;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// #516: spec.binaryNames lets a llama-server-compatible fork (the Gufo
// `llama-server-fork-pristine` shim) pass the same pid-identity contract the
// stock `llama-server` argv0 gets. Records carry the names, manifests may
// declare them, and a legacy record without the field falls back to the
// engine default unioned with the desired manifest's names on the start path.
describe("llamacpp fork process identity (#516)", () => {
  const LLAMA_KEY = { name: "gufo-host" };
  const FORK_BINARY_NAME = "llama-server-fork-pristine";
  const FORK_CMDLINE = "/opt/gufo/bin/llama-server-fork-pristine --port 8095";
  const STOCK_CMDLINE = "/usr/local/bin/llama-server --port 8095";

  function seedLlamaRecord(
    runtimeDir: string,
    opts: { pid: number; binaryNames?: string[]; starting?: boolean },
  ): string {
    const hostDir = join(runtimeDir, "workloads", "gufo-host");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(join(hostDir, "modelhost.pid"), `${String(opts.pid)}\n`);
    const names = opts.binaryNames === undefined ? {} : { binaryNames: opts.binaryNames };
    const record = opts.starting
      ? {
          kind: "ModelHostStarting",
          engine: "llamacpp",
          pid: opts.pid,
          startedAt: new Date().toISOString(),
          ...names,
        }
      : {
          kind: "ModelHost",
          engine: "llamacpp",
          pid: opts.pid,
          host: "127.0.0.1",
          port: 8095,
          modelAliases: ["gufo/model.gguf", "model.gguf"],
          startedAt: new Date().toISOString(),
          ...names,
        };
    writeFileSync(
      join(hostDir, opts.starting ? "modelhost.starting" : "modelhost.state"),
      JSON.stringify(record),
    );
    return hostDir;
  }

  function writeLlamaManifest(
    tmp: string,
    binaryNames?: string[],
  ): { workloadsDir: string; runtimeDir: string } {
    const workloadsDir = join(tmp, "workloads");
    const runtimeDir = join(tmp, "runtime");
    const fakeBinary = join(tmp, "gufo-llama-server");
    mkdirSync(workloadsDir, { recursive: true });
    writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(workloadsDir, "gufo-host.yaml"),
      [
        "apiVersion: llamactl/v1",
        "kind: ModelHost",
        "metadata:",
        "  name: gufo-host",
        "spec:",
        "  engine: llamacpp",
        "  node: local",
        "  enabled: true",
        `  binary: ${fakeBinary}`,
        "  endpoint:",
        "    host: 127.0.0.1",
        "    port: 8095",
        "  hostedModels:",
        "    - rel: gufo/model.gguf",
        "  extraArgs: []",
        "  restartPolicy: Always",
        "  timeoutSeconds: 60",
        ...(binaryNames === undefined
          ? []
          : ["  binaryNames:", ...binaryNames.map((name) => `    - ${name}`)]),
        "",
      ].join("\n"),
    );
    mkdirSync(join(tmp, "models", "gufo"), { recursive: true });
    writeFileSync(join(tmp, "models", "gufo", "model.gguf"), "fake gguf\n");
    return { workloadsDir, runtimeDir };
  }

  function forkIdentity(cmdline: string): {
    processStartMs: () => number;
    processCommand: () => string;
  } {
    return {
      processStartMs: () => 0,
      processCommand: () => cmdline,
    };
  }

  function patchLlamacppTeardown(): { tornDown: number[]; restore: () => void } {
    const engine = ENGINES.llamacpp;
    const originalTeardown = engine.teardown.bind(engine);
    const tornDown: number[] = [];
    engine.teardown = mock((pid: number) => {
      tornDown.push(pid);
      return Promise.resolve();
    });
    return {
      tornDown,
      restore: (): void => {
        engine.teardown = originalTeardown;
      },
    };
  }

  test("status and stop verify a fork pid against the record's binaryNames", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-stop-"));
    const runtimeDir = join(tmp, "runtime");
    const identity = forkIdentity(FORK_CMDLINE);
    try {
      const hostDir = seedLlamaRecord(runtimeDir, {
        pid: process.pid,
        binaryNames: [FORK_BINARY_NAME],
      });
      expect(statusModelHost({ key: LLAMA_KEY, runtimeDir, identity })).toEqual({
        state: "Running",
        pid: process.pid,
      });
      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key: LLAMA_KEY,
        runtimeDir,
        identity,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(stopped).toEqual({ ok: true, pid: process.pid });
      expect(tornDown).toEqual([process.pid]);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("stop tears down a still-starting fork child named by binaryNames", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-starting-"));
    const runtimeDir = join(tmp, "runtime");
    try {
      const hostDir = seedLlamaRecord(runtimeDir, {
        pid: process.pid,
        binaryNames: [FORK_BINARY_NAME],
        starting: true,
      });
      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key: LLAMA_KEY,
        runtimeDir,
        identity: forkIdentity(FORK_CMDLINE),
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(stopped).toEqual({ ok: true, pid: process.pid });
      expect(tornDown).toEqual([process.pid]);
      expect(existsSync(join(hostDir, "modelhost.starting"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("record binaryNames replace the engine default on identity checks", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-replaces-"));
    const runtimeDir = join(tmp, "runtime");
    const identity = forkIdentity(STOCK_CMDLINE);
    try {
      const hostDir = seedLlamaRecord(runtimeDir, {
        pid: process.pid,
        binaryNames: [FORK_BINARY_NAME],
      });
      expect(statusModelHost({ key: LLAMA_KEY, runtimeDir, identity })).toEqual({
        state: "Stopped",
        identityUnknown: true,
      });
      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key: LLAMA_KEY,
        runtimeDir,
        identity,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(stopped).toEqual({ ok: false, pid: process.pid, error: "pid identity unknown" });
      expect(tornDown).toEqual([]);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("start persists manifest binaryNames into the state and starting records", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-start-"));
    const { workloadsDir, runtimeDir } = writeLlamaManifest(tmp, [FORK_BINARY_NAME]);
    const patch = patchLlamacppTeardown();
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    const gate = readinessGate();
    let startingBinaryNames: unknown;
    const probeReady = (): Promise<{ ready: boolean; modelIds: string[] }> => {
      const raw = JSON.parse(
        readFileSync(join(runtimeDir, "workloads", "gufo-host", "modelhost.starting"), "utf8"),
      ) as { binaryNames?: unknown };
      startingBinaryNames = raw.binaryNames;
      gate.open();
      return gate.promise;
    };
    try {
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkIdentity(FORK_CMDLINE),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady,
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r.ok).toBe(true);
      expect(startingBinaryNames).toEqual([FORK_BINARY_NAME]);
      const state = JSON.parse(
        readFileSync(join(runtimeDir, "workloads", "gufo-host", "modelhost.state"), "utf8"),
      ) as { pid?: number; binaryNames?: string[] };
      expect(state.pid).toBe(4321);
      expect(state.binaryNames).toEqual([FORK_BINARY_NAME]);
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reap accepts a fork cmdline for a legacy record the manifest names", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-reap-"));
    const { workloadsDir, runtimeDir } = writeLlamaManifest(tmp, [FORK_BINARY_NAME]);
    seedLlamaRecord(runtimeDir, { pid: process.pid });
    const patch = patchLlamacppTeardown();
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkIdentity(FORK_CMDLINE),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r.ok).toBe(true);
      expect(patch.tornDown).toEqual([process.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
      const state = JSON.parse(
        readFileSync(join(runtimeDir, "workloads", "gufo-host", "modelhost.state"), "utf8"),
      ) as { pid?: number; binaryNames?: string[] };
      expect(state.pid).toBe(4321);
      expect(state.binaryNames).toEqual([FORK_BINARY_NAME]);
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reap still accepts the stock binary for a legacy record", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-reapstock-"));
    const { workloadsDir, runtimeDir } = writeLlamaManifest(tmp, [FORK_BINARY_NAME]);
    seedLlamaRecord(runtimeDir, { pid: process.pid });
    const patch = patchLlamacppTeardown();
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkIdentity(STOCK_CMDLINE),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r.ok).toBe(true);
      expect(patch.tornDown).toEqual([process.pid]);
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the record's binaryNames are authoritative over the manifest's on reap", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-authority-"));
    const { workloadsDir, runtimeDir } = writeLlamaManifest(tmp, [FORK_BINARY_NAME]);
    seedLlamaRecord(runtimeDir, { pid: process.pid, binaryNames: [FORK_BINARY_NAME] });
    const patch = patchLlamacppTeardown();
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkIdentity(STOCK_CMDLINE),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r).toEqual({
        ok: false,
        pid: null,
        error: "pid identity unknown; deferring restart",
      });
      expect(patch.tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reapStartingOrphan accepts a fork cmdline for a legacy starting record", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-startreap-"));
    const { workloadsDir, runtimeDir } = writeLlamaManifest(tmp, [FORK_BINARY_NAME]);
    seedLlamaRecord(runtimeDir, { pid: process.pid, starting: true });
    const patch = patchLlamacppTeardown();
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkIdentity(FORK_CMDLINE),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r.ok).toBe(true);
      expect(patch.tornDown).toEqual([process.pid]);
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("legacy records without binaryNames keep the engine-default identity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-legacy-"));
    const runtimeDir = join(tmp, "runtime");
    const patch = patchLlamacppTeardown();
    const forkDeps = forkIdentity(FORK_CMDLINE);
    try {
      const hostDir = seedLlamaRecord(runtimeDir, { pid: process.pid });
      const { workloadsDir } = writeLlamaManifest(tmp);
      const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkDeps,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r.ok).toBe(false);
      expect(r.error).toContain("pid identity unknown; deferring restart");
      expect(patch.tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();

      const tornDown: number[] = [];
      const stopped = await stopModelHost({
        key: LLAMA_KEY,
        runtimeDir,
        identity: forkDeps,
        teardown: (pid) => {
          tornDown.push(pid);
          return Promise.resolve();
        },
      });
      expect(stopped.ok).toBe(false);
      expect(stopped.error).toContain("pid identity unknown");
      expect(tornDown).toEqual([]);
      expect(existsSync(join(hostDir, "modelhost.state"))).toBe(true);

      // The stock argv0 still verifies against the engine default.
      seedLlamaRecord(runtimeDir, { pid: process.pid });
      const stockDeps = forkIdentity(STOCK_CMDLINE);
      expect(statusModelHost({ key: LLAMA_KEY, runtimeDir, identity: stockDeps })).toEqual({
        state: "Running",
        pid: process.pid,
      });
      const tornDownStock: number[] = [];
      const stoppedStock = await stopModelHost({
        key: LLAMA_KEY,
        runtimeDir,
        identity: stockDeps,
        teardown: (pid) => {
          tornDownStock.push(pid);
          return Promise.resolve();
        },
      });
      expect(stoppedStock).toEqual({ ok: true, pid: process.pid });
      expect(tornDownStock).toEqual([process.pid]);
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("start without binaryNames writes a state record with no binaryNames key", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fork-nonames-"));
    const { workloadsDir, runtimeDir } = writeLlamaManifest(tmp);
    const patch = patchLlamacppTeardown();
    const spawn = mock((..._args: Parameters<typeof nodeSpawn>) => ({ pid: 4321 }) as const);
    try {
      const r = await startModelHost({
        key: LLAMA_KEY,
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity: forkIdentity(FORK_CMDLINE),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
      expect(r.ok).toBe(true);
      const state = JSON.parse(
        readFileSync(join(runtimeDir, "workloads", "gufo-host", "modelhost.state"), "utf8"),
      ) as Record<string, unknown>;
      expect("binaryNames" in state).toBe(false);
    } finally {
      patch.restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
