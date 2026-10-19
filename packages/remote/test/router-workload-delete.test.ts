import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../src/workload/modelhost-store.js";
import { parseWorkload, saveWorkload, workloadPath } from "../src/workload/store.js";

const modelHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: mlx-host
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /usr/bin/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

const modelRunYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma-solo
spec:
  node: local
  target:
    kind: rel
    value: gemma.gguf
`;

let tmp = "";
let runtimeDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-workload-delete-"));
  runtimeDir = join(tmp, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    // A missing config file gives a fresh config whose `local` node is the
    // in-proc caller, so stops run against the temp runtime dir.
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

function hostRuntimeDir(): string {
  return join(runtimeDir, "workloads", "mlx-host");
}

describe("workloadDelete", () => {
  test("stops a ModelHost, then removes its manifest and runtime dir", async () => {
    saveModelHost(parseModelHost(modelHostYaml), tmp);
    mkdirSync(hostRuntimeDir(), { recursive: true });
    writeFileSync(join(hostRuntimeDir(), "leftover.log"), "x\n");

    const result = await router.createCaller({}).workloadDelete({ name: "mlx-host" });

    expect(result).toEqual({
      ok: true,
      name: "mlx-host",
      stops: ["stopped modelhost on local"],
    });
    expect(existsSync(workloadPath("mlx-host", tmp))).toBe(false);
    expect(existsSync(hostRuntimeDir())).toBe(false);
  });

  test("keepRunning removes only the ModelHost manifest", async () => {
    saveModelHost(parseModelHost(modelHostYaml), tmp);
    mkdirSync(hostRuntimeDir(), { recursive: true });

    const result = await router
      .createCaller({})
      .workloadDelete({ name: "mlx-host", keepRunning: true });

    expect(result).toEqual({ ok: true, name: "mlx-host", stops: [] });
    expect(existsSync(workloadPath("mlx-host", tmp))).toBe(false);
    expect(existsSync(hostRuntimeDir())).toBe(true);
  });

  test("still deletes a ModelRun manifest", async () => {
    saveWorkload(parseWorkload(modelRunYaml), tmp);

    const result = await router
      .createCaller({})
      .workloadDelete({ name: "gemma-solo", keepRunning: true });

    expect(result).toEqual({ ok: true, name: "gemma-solo", stops: [] });
    expect(existsSync(workloadPath("gemma-solo", tmp))).toBe(false);
  });
});
