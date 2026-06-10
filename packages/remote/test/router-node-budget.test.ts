import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { parseModelHost, saveModelHost } from "../src/workload/modelhost-store.js";
import { saveNodeRun } from "../src/workload/noderun-store.js";
import { parseWorkload, saveWorkload } from "../src/workload/store.js";

const originalEnv = { ...process.env };
let tmp = "";

const workloadA = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: granite41-8b-long-lived
spec:
  node: local
  target:
    kind: rel
    value: granite41-8b.gguf
  enabled: true
  resources:
    expectedMemoryGiB: 8
  endpoint:
    host: 127.0.0.1
    port: 8181
`;

const workloadB = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma4-26b-a4b-mtp
spec:
  node: local
  target:
    kind: rel
    value: gemma4-26b.gguf
  enabled: true
  resources:
    expectedMemoryGiB: 16
  endpoint:
    host: 127.0.0.1
    port: 8090
`;

const modelHostC = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: mlx-host-local
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /usr/bin/omlx
  resources:
    expectedMemoryGiB: 12
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-router-node-budget-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe("nodeBudget", () => {
  test("rolls up budget and reserved memory for workloads on a node", async () => {
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "local", labels: {} },
        spec: {
          node: "local",
          budget: { memoryGiB: 36 },
          infra: [],
        },
      },
      tmp,
    );
    saveWorkload(parseWorkload(workloadA), tmp);
    saveWorkload(parseWorkload(workloadB), tmp);

    const caller = router.createCaller({});
    const result = await caller.nodeBudget({ node: "local" });

    expect(result.budget).toBe(36);
    expect(result.reserved).toBe(24);
    expect(result.workloads.length).toBe(2);
    expect(result.workloads.map((w) => w.name)).toEqual([
      "gemma4-26b-a4b-mtp",
      "granite41-8b-long-lived",
    ]);
  });

  test("counts enabled ModelHost reservations and tags workload kind", async () => {
    saveNodeRun(
      {
        apiVersion: "llamactl/v1",
        kind: "NodeRun",
        metadata: { name: "local", labels: {} },
        spec: {
          node: "local",
          budget: { memoryGiB: 36 },
          infra: [],
        },
      },
      tmp,
    );
    saveWorkload(parseWorkload(workloadA), tmp); // ModelRun, 8 GiB
    saveModelHost(parseModelHost(modelHostC), tmp); // ModelHost, 12 GiB

    const caller = router.createCaller({});
    const result = await caller.nodeBudget({ node: "local" });

    // Must agree with admission, which counts ModelHosts via
    // listAnyWorkloadsForAdmission. Before this fix nodeBudget saw
    // only the ModelRun (8) and silently dropped the host's 12.
    expect(result.reserved).toBe(20);

    const byName = Object.fromEntries(result.workloads.map((w) => [w.name, w] as const));
    expect(byName["granite41-8b-long-lived"]!.kind).toBe("ModelRun");
    const host = byName["mlx-host-local"];
    expect(host).toBeDefined();
    expect(host!.kind).toBe("ModelHost");
    expect(host!.enabled).toBe(true);
    expect(host!.expectedMemoryGiB).toBe(12);
    expect(host!.endpoint).toBe("127.0.0.1:8094");
  });
});
