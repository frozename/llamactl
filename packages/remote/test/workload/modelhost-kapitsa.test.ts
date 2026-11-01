import type { spawn as nodeSpawn } from "node:child_process";

import { expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost } from "../../src/server/modelhost.js";
import { ModelHostManifestSchema, specForEngine } from "../../src/workload/modelhost-schema.js";

test("ModelHost accepts the registry-wired Kapitsa engine", () => {
  const parsed = ModelHostManifestSchema.safeParse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "experimental-kapitsa" },
    spec: {
      engine: "kapitsa",
      node: "local",
      binary: "/opt/kapitsa",
      endpoint: { host: "127.0.0.1", port: 18200 },
      hostedModels: [{ rel: "mlx/qwen35b" }],
      extraArgs: ["--mem-budget", "26", "--slots", "1"],
    },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(specForEngine(parsed.data.spec).engine).toBe("kapitsa");
});

test("runtimeDir keeps Kapitsa state and cache under the same launch root", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kapitsa-runtime-"));
  const runtimeDir = join(tmp, "requested-runtime");
  const prior = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "process-default");
  const binary = join(tmp, "kapitsa");
  mkdirSync(join(tmp, "models", "model"), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const environments: NodeJS.ProcessEnv[] = [];
  const spawn = mock(
    (_binary: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      environments.push(options.env);
      return { pid: 4321 } as const;
    },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, LLAMACTL_MODELS_DIR: join(tmp, "models") };
  delete env["LLAMACTL_RUNTIME_DIR"];
  try {
    const result = await startModelHost({
      key: { name: "experimental-kapitsa" },
      runtimeDir,
      workloadsDir: join(tmp, "manifests"),
      env,
      manifest: {
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: "experimental-kapitsa" },
        spec: {
          engine: "kapitsa",
          node: "local",
          binary,
          endpoint: { host: "127.0.0.1", port: 18200 },
          hostedModels: [{ rel: "model" }],
        },
      },
      spawn: spawn as unknown as typeof nodeSpawn,
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["model"] }),
    });
    expect(result.ok).toBe(true);
    expect(environments[0]?.["KAPITSA_HOME"]).toBe(
      join(runtimeDir, "workloads", "experimental-kapitsa", ".kapitsa"),
    );
  } finally {
    if (prior === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
    else process.env["LOCAL_AI_RUNTIME_DIR"] = prior;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("KAPITSA_HOME exists as a private directory before the Kapitsa process spawns", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kapitsa-home-"));
  const runtimeDir = join(tmp, "runtime");
  const binary = join(tmp, "kapitsa");
  mkdirSync(join(tmp, "models", "model"), { recursive: true });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const homes: (string | undefined)[] = [];
  const existsAtSpawn: boolean[] = [];
  const spawn = mock(
    (_binary: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      const home = options.env["KAPITSA_HOME"];
      homes.push(home);
      existsAtSpawn.push(home !== undefined && existsSync(home));
      return { pid: 4321 } as const;
    },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, LLAMACTL_MODELS_DIR: join(tmp, "models") };
  delete env["LLAMACTL_RUNTIME_DIR"];
  try {
    const result = await startModelHost({
      key: { name: "experimental-kapitsa" },
      runtimeDir,
      workloadsDir: join(tmp, "manifests"),
      env,
      manifest: {
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: "experimental-kapitsa" },
        spec: {
          engine: "kapitsa",
          node: "local",
          binary,
          endpoint: { host: "127.0.0.1", port: 18200 },
          hostedModels: [{ rel: "model" }],
        },
      },
      spawn: spawn as unknown as typeof nodeSpawn,
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["model"] }),
    });
    expect(result.ok).toBe(true);
    const home = join(runtimeDir, "workloads", "experimental-kapitsa", ".kapitsa");
    expect(homes).toEqual([home]);
    // The adapter must create KAPITSA_HOME itself: the launcher only exports
    // the path, and Kapitsa writes state into it during boot.
    expect(existsAtSpawn).toEqual([true]);
    expect(statSync(home).isDirectory()).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Kapitsa refuses manifest overrides of adapter-owned environment", () => {
  for (const name of ["KAPITSA_HOME", "KAPITSA_NO_AUTO_UPDATE"]) {
    const parsed = ModelHostManifestSchema.safeParse({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "experimental-kapitsa" },
      spec: {
        engine: "kapitsa",
        node: "local",
        binary: "/opt/kapitsa",
        endpoint: { host: "127.0.0.1", port: 18200 },
        hostedModels: [{ rel: "model" }],
        env: { [name]: "override" },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["spec", "env", name]);
    }
  }
});

test("other engines retain their existing environment configuration", () => {
  const parsed = ModelHostManifestSchema.safeParse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "existing-omlx" },
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/opt/omlx",
      endpoint: { host: "127.0.0.1", port: 18200 },
      hostedModels: [{ rel: "model" }],
      env: { KAPITSA_HOME: "existing-value" },
    },
  });
  expect(parsed.success).toBe(true);
});
