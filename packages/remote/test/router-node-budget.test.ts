import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../src/workload/modelhost-store.js";
import { saveNodeRun } from "../src/workload/noderun-store.js";
import { listWorkloads, parseWorkload, saveWorkload } from "../src/workload/store.js";

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
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
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

// #239: router workloadApply (the MCP, app and ops-chat path) admits a ModelRun against an
// explicit NodeRun budget, as `llamactl apply` and the reconciler do. Every ModelRun asks for
// endpoint host 0.0.0.0 without allowExternalBind: apply refuses that bind right after
// admission and before any server stop or start, so a ModelRun that passes admission fails
// with the bind refusal instead of launching llama-server.
const BIND_REFUSAL = "refusing to bind llama-server to 0.0.0.0";

function budgetProbeYaml(name: string): string {
  return `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ${name}
spec:
  node: local
  target:
    kind: rel
    value: budget-probe.gguf
  enabled: true
  resources:
    expectedMemoryGiB: 1
  endpoint:
    host: 0.0.0.0
    port: 18431
`;
}

// Far above any real node's 75%-of-RAM default, so admission refuses this ModelHost with or
// without the NodeRun budget and it never reaches its engine start.
const budgetProbeHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: budget-probe-host
spec:
  engine: llamacpp
  node: local
  enabled: true
  binary: /nonexistent/llama-server
  resources:
    expectedMemoryGiB: 100000
  endpoint:
    host: 127.0.0.1
    port: 18432
  hostedModels:
    - rel: budget-probe-host.gguf
`;

function saveProbeNodeRun(name: string, budget?: { memoryGiB: number }): void {
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name, labels: {} },
      spec: budget === undefined ? { node: name, infra: [] } : { node: name, budget, infra: [] },
    },
    tmp,
  );
}

async function workloadApplyError(yaml: string): Promise<string> {
  try {
    await router.createCaller({}).workloadApply({ yaml });
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }
  throw new Error("expected workloadApply to reject");
}

describe("workloadApply NodeRun budget", () => {
  beforeEach(() => {
    // serverStatus probes LLAMA_CPP_HOST:LLAMA_CPP_PORT; use core env.ts's offline sentinel
    // port so no live llama-server is ever asked. The top-level afterEach restores the env.
    Object.assign(process.env, { LLAMA_CPP_HOST: "127.0.0.1", LLAMA_CPP_PORT: "65534" });
  });

  test("an explicit NodeRun budget refuses an over-budget ModelRun", async () => {
    saveProbeNodeRun("local", { memoryGiB: 0.5 });
    const message = await workloadApplyError(budgetProbeYaml("budget-probe-over"));
    expect(message).toContain("Budget is 0.5 GiB");
    expect(message).not.toContain(BIND_REFUSAL);
    expect(listWorkloads(tmp).map((m) => m.metadata.name)).toEqual([]);
  });

  test("a ModelRun within the NodeRun budget passes admission", async () => {
    saveProbeNodeRun("local", { memoryGiB: 4 });
    const message = await workloadApplyError(budgetProbeYaml("budget-probe-under"));
    expect(message).not.toContain("Budget is");
    expect(message).toContain(BIND_REFUSAL);
    expect(listWorkloads(tmp).map((m) => m.metadata.name)).toEqual([]);
  });

  test("a NodeRun without spec.budget leaves the ModelRun unbounded", async () => {
    saveProbeNodeRun("local");
    const message = await workloadApplyError(budgetProbeYaml("budget-probe-none"));
    expect(message).not.toContain("Budget is");
    expect(message).toContain(BIND_REFUSAL);
  });

  test("a NodeRun budget for another node does not apply", async () => {
    saveProbeNodeRun("other-node", { memoryGiB: 0.5 });
    const message = await workloadApplyError(budgetProbeYaml("budget-probe-other"));
    expect(message).not.toContain("Budget is");
    expect(message).toContain(BIND_REFUSAL);
  });

  test("an explicit NodeRun budget sizes a ModelHost applied through the router", async () => {
    saveProbeNodeRun("local", { memoryGiB: 0.5 });
    const message = await workloadApplyError(budgetProbeHostYaml);
    expect(message).toContain("Budget is 0.5 GiB");
  });
});
