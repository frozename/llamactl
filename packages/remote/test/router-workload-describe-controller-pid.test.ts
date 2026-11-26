import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../src/workload/modelhost-store.js";

const originalEnv = { ...process.env };
let tmp = "";

const ghostHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ghost-host
spec:
  engine: omlx
  node: ghost-node
  enabled: true
  binary: /usr/bin/omlx
  endpoint:
    host: 127.0.0.1
    port: 18094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-router-describe-ctl-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    LLAMACTL_RESIDENCY_STORE: join(tmp, "residency.sqlite"),
  });
  saveModelHost(parseModelHost(ghostHostYaml), tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

function controllerPidOf(result: unknown): unknown {
  return (result as { controllerPid?: unknown }).controllerPid;
}

describe("workloadDescribe controllerPid", () => {
  test("reports the pid from a live controller lock", async () => {
    writeFileSync(join(tmp, ".controller.lock"), String(process.pid));

    const result = await router.createCaller({}).workloadDescribe({ name: "ghost-host" });

    expect(controllerPidOf(result)).toBe(process.pid);
  });

  test("reports null when no controller lock exists", async () => {
    const result = await router.createCaller({}).workloadDescribe({ name: "ghost-host" });

    expect(controllerPidOf(result)).toBeNull();
  });

  test("reports null when the controller lock holds a dead pid", async () => {
    writeFileSync(join(tmp, ".controller.lock"), "2147483646");

    const result = await router.createCaller({}).workloadDescribe({ name: "ghost-host" });

    expect(controllerPidOf(result)).toBeNull();
  });
});
