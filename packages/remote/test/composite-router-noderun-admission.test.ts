// packages/remote/test/composite-router-noderun-admission.test.ts
//
// Part of #519 review: the router's compositeApply wet run must feed
// applyComposite the NodeRun budget/residency lookups against the default
// workloads dir, so a composite workload is admitted exactly like a direct
// workloadApply.
//
// The wet run is driven through the real router with a fake composite runtime
// and a fake node client installed via __setCompositeApplyTargetsForTests (the
// wet block has no other injection seam: getCompositeRuntime would otherwise
// build a real Docker backend and clientForNode would reach a live agent). The
// node client's nodeFacts report 64 GiB so the residency budget is a known
// quantity, and a NodeRun in LLAMACTL_WORKLOADS_DIR supplies the explicit
// budget / residency margin keyed by the node name. The exact-line static pins
// are kept alongside the behavioural cases: a `workloadsDir = "/nonexistent"`
// reassignment and the `nodeRunBudgetGiB(...) && undefined` /
// `nodeRunResidency(...) && undefined` short-circuits each break both the
// whole-line pins and the behavioural refusal assertion.
import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { Composite } from "../src/composite/schema.js";
import type { RuntimeBackend } from "../src/runtime/backend.js";
import type { WorkloadClient } from "../src/workload/apply.js";

import { CompositeSchema } from "../src/composite/schema.js";
import { __setCompositeApplyTargetsForTests, router } from "../src/router.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { NodeRunSchema } from "../src/workload/noderun-schema.js";
import { saveNodeRun } from "../src/workload/noderun-store.js";

let tmp = "";
let configPath = "";
let compositesDir = "";
let workloadsDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-composite-router-noderun-admission-"));
  configPath = join(tmp, "config");
  compositesDir = join(tmp, "composites");
  workloadsDir = join(tmp, "workloads");
  saveConfig(freshConfig(), configPath);
  process.env["LLAMACTL_CONFIG"] = configPath;
  process.env["LLAMACTL_COMPOSITES_DIR"] = compositesDir;
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
});

afterEach(() => {
  __setCompositeApplyTargetsForTests(null);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

// A workload-only composite on the non-local node gpu1, charged 40 GiB. gpu1
// is not in the fresh kubeconfig, so admission takes the verified-nodeFacts
// path where the NodeRun budget beats the residency-sized verified budget.
function gpuComposite(): Composite {
  return CompositeSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name: "noderun-stack" },
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

// No services/rag/gateways/pipelines in the manifest, so the fake backend is
// never exercised beyond satisfying the interface — ensureService rejecting
// proves the wet run did not fall through to a real runtime.
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

// 64 GiB of node memory: default budget 48 GiB (0.75), 32 GiB at a 0.5
// safetyMarginRatio — both straddle the 40 GiB workload charge. A refusal must
// never reach serverStart, so started() is asserted at 0.
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
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 12345, endpoint: "http://127.0.0.1:8080" },
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
    nodeFacts: {
      query: () => Promise.resolve({ memBytes: 64 * 1024 ** 3 }),
    },
  };
  return { client, started: () => started };
}

function seedNodeRun(manifest: Parameters<typeof NodeRunSchema.parse>[0]): void {
  saveNodeRun(NodeRunSchema.parse(manifest), workloadsDir);
}

function workloadMessage(result: {
  componentResults: { ref: { kind: string }; message?: string }[];
}): string {
  return result.componentResults.find((r) => r.ref.kind === "workload")?.message ?? "";
}

async function wetApply(): Promise<{
  ok: boolean;
  message: string;
}> {
  const res = await router.createCaller({}).compositeApply({
    manifestYaml: stringifyYaml(gpuComposite()),
    dryRun: false,
  });
  if (res.dryRun) throw new Error("expected a wet compositeApply");
  return { ok: res.ok, message: workloadMessage(res) };
}

describe("router compositeApply — NodeRun budget/residency wiring (#519)", () => {
  test("wet-run wiring reads NodeRun budget/residency from the default workloads dir", () => {
    const src = readFileSync(join(import.meta.dir, "../src/router.ts"), "utf8");
    const start = src.indexOf("compositeApply: t.procedure");
    const end = src.indexOf("compositeDestroy: t.procedure");
    expect(start, "compositeApply: t.procedure not found").toBeGreaterThanOrEqual(0);
    expect(end, "compositeDestroy: t.procedure not found").toBeGreaterThan(start);
    const lines = src.slice(start, end).split("\n");
    const pins = [
      "        const workloadsDir = workloadStoreMod.defaultWorkloadsDir();",
      "        const result = await applyComposite({",
      "          getNodeBudgetGiB: (nodeName) => nodeRunBudgetGiB(nodeName, workloadsDir),",
      "          getNodeResidency: (nodeName) => nodeRunResidency(nodeName, workloadsDir),",
    ];
    for (const pin of pins) {
      expect(lines, `compositeApply slice line ${pin}`).toContain(pin);
    }
  });

  test("compositeApply reaches a gpu1 workload composite through the real router", async () => {
    // Dry-run returns before the wet-run block, so it needs no runtime backend
    // and no node client — it proves the slice the static pins target is the
    // active compositeApply, not a dead branch.
    const res = await router.createCaller({}).compositeApply({
      manifestYaml: stringifyYaml(gpuComposite()),
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error("type narrowing failed");
    expect(res.manifest.metadata.name).toBe("noderun-stack");
    expect(res.order.some((r) => r.kind === "workload" && r.name === "gpu1")).toBe(true);
  });

  test("wet run: explicit NodeRun budget beats the residency-sized nodeFacts budget", async () => {
    // Kills `nodeRunBudgetGiB(nodeName, workloadsDir) && undefined` (and a
    // `workloadsDir` swap to a bogus path): with the lookup wired the NodeRun
    // budget of 16 GiB is returned verbatim and the 40 GiB charge refuses at
    // "Budget is 16.0 GiB". Dropped, explicit falls through to the 64 GiB node
    // at the 0.75 default (48 GiB) which would admit the charge.
    seedNodeRun({
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "gpu1", labels: {} },
      spec: { node: "gpu1", budget: { memoryGiB: 16 } },
    });
    const { client, started } = makeWorkloadClient();
    __setCompositeApplyTargetsForTests({ runtime: makeBackend(), workloadClient: () => client });

    const { ok, message } = await wetApply();

    expect(ok).toBe(false);
    expect(message).toContain("Budget is 16.0 GiB");
    expect(started()).toBe(0);
  });

  test("wet run: residency margin sizes the nodeFacts budget when no explicit budget", async () => {
    // Kills `nodeRunResidency(nodeName, workloadsDir) && undefined`: the NodeRun
    // safetyMarginRatio 0.5 sizes the verified 64 GiB budget to 32 GiB, below
    // the 40 GiB charge, so the run refuses at "Budget is 32.0 GiB". Dropped,
    // the 0.75 default yields 48 GiB which would admit the charge.
    seedNodeRun({
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "gpu1", labels: {} },
      spec: { node: "gpu1", residency: { safetyMarginRatio: 0.5 } },
    });
    const { client, started } = makeWorkloadClient();
    __setCompositeApplyTargetsForTests({ runtime: makeBackend(), workloadClient: () => client });

    const { ok, message } = await wetApply();

    expect(ok).toBe(false);
    expect(message).toContain("Budget is 32.0 GiB");
    expect(started()).toBe(0);
  });
});
