// packages/remote/test/composite-apply-noderun-admission.test.ts
//
// Part of #519: a composite workload must be admitted against the target
// node's NodeRun budget/residency — applyComposite forwards
// getNodeBudgetGiB/getNodeResidency into applyOne the same way
// workloadApply and the reconciler do. Hermetic: temp config +
// composites/workloads dirs, fake RuntimeBackend, fake WorkloadClient —
// no docker, no live node, no sleeps.
import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Composite } from "../src/composite/schema.js";
import type { RuntimeBackend } from "../src/runtime/backend.js";
import type { WorkloadClient } from "../src/workload/apply.js";
import type { NodeRunResidency } from "../src/workload/noderun-schema.js";

import { applyComposite } from "../src/composite/apply.js";
import { CompositeSchema } from "../src/composite/schema.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
let configPath = "";
let compositesDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-composite-noderun-admission-"));
  configPath = join(tmp, "config");
  compositesDir = join(tmp, "composites");
  saveConfig(freshConfig(), configPath);
  process.env["LLAMACTL_CONFIG"] = configPath;
  process.env["LLAMACTL_COMPOSITES_DIR"] = compositesDir;
  // applyOne's admission accounting lists the workloads dir even when the
  // composite applier does not forward one — point it at a temp path that
  // does not exist so the living set is deterministically empty.
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

// CompositeApplyOptions gains getNodeBudgetGiB/getNodeResidency with the
// #519 fix; intersecting them here keeps this file typechecking on the
// base so every case fails by assertion, never by type error.
type Opts = Parameters<typeof applyComposite>[0] & {
  getNodeBudgetGiB?: (nodeName: string) => number | null | undefined;
  getNodeResidency?: (nodeName: string) => NodeRunResidency | null | undefined;
};

// ---- fakes ---------------------------------------------------------------

// No services/rag/gateways/pipelines in the manifest, so the backend is
// never exercised beyond satisfying the interface.
function makeBackend(): RuntimeBackend {
  return {
    kind: "fake",
    ping: () => Promise.resolve(),
    ensureService: () => Promise.reject(new Error("ensureService unused: no services")),
    removeService: () => Promise.resolve(),
    inspectService: () => Promise.resolve(null),
    listServices: () => Promise.resolve([]),
  };
}

function makeWorkloadClient(): { client: WorkloadClient; started: () => number } {
  let started = 0;
  const neverSubscribe = (): { unsubscribe: () => void } => ({
    unsubscribe: () => undefined,
  });
  const client: WorkloadClient = {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "stopped",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "http://127.0.0.1:8080",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({}) },
    serverStart: {
      subscribe(_input, callbacks) {
        started++;
        queueMicrotask(() => {
          callbacks.onData({
            type: "started",
            pid: 12345,
            endpoint: "http://127.0.0.1:8080",
            model: "m.gguf",
          });
          // applyOne extracts StartDone from `e.result` on the done event.
          callbacks.onData({
            type: "done",
            result: {
              ok: true,
              pid: 12345,
              endpoint: "http://127.0.0.1:8080",
            },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: { subscribe: neverSubscribe },
    modelHostStop: { mutate: () => Promise.resolve({}) },
    modelHostStatus: {
      query: () => Promise.resolve({ state: "Stopped", pid: null }),
    },
    rpcServerStart: { subscribe: neverSubscribe },
    rpcServerStop: { mutate: () => Promise.resolve({}) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: "/fake", llamaCppBin: "/fake" }),
    },
    // 64 GiB of node memory: default budget 48 GiB (0.75), 32 GiB at a
    // 0.5 safetyMarginRatio — both straddle the 40 GiB workload charge.
    nodeFacts: {
      query: () => Promise.resolve({ memBytes: 64 * 1024 ** 3 }),
    },
  };
  return { client, started: () => started };
}

// ---- manifest ------------------------------------------------------------

// Workload-only composite on "gpu1", which is NOT in the kubeconfig, so
// admission takes the verified-nodeFacts path. Parsed through the real
// schema so ModelRunSpec defaults populate (a raw cast would leave
// `enabled` undefined and short-circuit the workload). onFailure is
// leave-partial so an admission refusal produces no rollback noise.
function admissionComposite(): Composite {
  return CompositeSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name: "stack" },
    spec: {
      services: [],
      workloads: [
        {
          node: "gpu1",
          target: { kind: "rel", value: "m.gguf" },
          resources: { expectedMemoryGiB: 40 },
        },
      ],
      ragNodes: [],
      gateways: [],
      pipelines: [],
      dependencies: [],
      onFailure: "leave-partial",
    },
  });
}

function workloadComponentMessage(result: {
  componentResults: { ref: { kind: string }; message?: string }[];
}): string {
  return result.componentResults.find((r) => r.ref.kind === "workload")?.message ?? "";
}

// ---- tests ----------------------------------------------------------------

describe("applyComposite — NodeRun budget/residency forwarding (#519)", () => {
  test("CA1: getNodeResidency sizes the verified-nodeFacts budget", async () => {
    // Kills: applyWorkloadComponent not forwarding getNodeResidency to
    // applyOne — the NodeRun safetyMarginRatio must shrink the computed
    // 64 GiB x ratio budget below the 40 GiB charge.
    const { client, started } = makeWorkloadClient();
    const seen: string[] = [];
    const opts: Opts = {
      manifest: admissionComposite(),
      backend: makeBackend(),
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      getNodeResidency: (n: string): NodeRunResidency | undefined => {
        seen.push(n);
        return n === "gpu1" ? { safetyMarginRatio: 0.5 } : undefined;
      },
    };

    const result = await applyComposite(opts);

    expect(result.ok).toBe(false);
    expect(workloadComponentMessage(result)).toContain("Budget is 32.0 GiB");
    expect(started()).toBe(0);
    expect(seen).toContain("gpu1");
  });

  test("CA2: getNodeBudgetGiB explicit budget wins over nodeFacts", async () => {
    // Kills: applyWorkloadComponent not forwarding getNodeBudgetGiB to
    // applyOne — an explicit NodeRun spec.budget.memoryGiB must beat the
    // computed nodeFacts budget.
    const { client, started } = makeWorkloadClient();
    const opts: Opts = {
      manifest: admissionComposite(),
      backend: makeBackend(),
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      getNodeBudgetGiB: (n: string): number | undefined => (n === "gpu1" ? 16 : undefined),
    };

    const result = await applyComposite(opts);

    expect(result.ok).toBe(false);
    expect(workloadComponentMessage(result)).toContain("Budget is 16.0 GiB");
    expect(started()).toBe(0);
  });

  test("CA3 guard: lookups returning undefined keep the 0.75 default", async () => {
    // Guard (passes on the base and after the fix): 64 GiB x 0.75 = 48 GiB
    // admits the 40 GiB workload and serverStart runs once.
    const { client, started } = makeWorkloadClient();
    const opts: Opts = {
      manifest: admissionComposite(),
      backend: makeBackend(),
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      getNodeBudgetGiB: (): number | undefined => undefined,
      getNodeResidency: (): NodeRunResidency | undefined => undefined,
    };

    const result = await applyComposite(opts);

    expect(result.ok).toBe(true);
    expect(started()).toBe(1);
  });

  test("CA4 guard: explicit budget beats residency margin", async () => {
    // Kills apply.ts resolveAdmissionBudgetGiB `return explicit ?? verified;`
    // degraded to `return residency ? verified : (explicit ?? verified);`.
    // safetyMarginRatio 0.5 sizes the verified-nodeFacts budget to 32 GiB,
    // below the 40 GiB charge, so the residency margin alone would REFUSE it;
    // only the explicit getNodeBudgetGiB=100 can admit. Under the mutant the
    // truthy residency discards the explicit budget and the 32 GiB verified
    // budget refuses, failing these ok/started assertions.
    const { client, started } = makeWorkloadClient();
    const opts: Opts = {
      manifest: admissionComposite(),
      backend: makeBackend(),
      getWorkloadClient: () => client,
      configPath,
      compositesDir,
      getNodeResidency: (n: string): NodeRunResidency | undefined =>
        n === "gpu1" ? { safetyMarginRatio: 0.5 } : undefined,
      getNodeBudgetGiB: (n: string): number | undefined => (n === "gpu1" ? 100 : undefined),
    };

    const result = await applyComposite(opts);

    expect(result.ok).toBe(true);
    expect(started()).toBe(1);
  });
});
