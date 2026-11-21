// Part of #519. The controller's ModelRun reconcile must honour the
// NodeRun minResidencySeconds evict gate. At base f7cc97e1,
// reconcileModelRun (reconciler.ts:589-601) passes no getNodeResidency to
// applyOne, so the gate (apply.ts evictMinResidencySeconds) resolves 0
// and evicts blind. RC1 and RC2 fail by assertion at the base; RC3 and
// RC4 are no-regression guards that pass at base and fix.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { NodeRunSchema } from "../../src/workload/noderun-schema.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { reconcileOnce, type ReconcileResult } from "../../src/workload/reconciler.js";
import { saveWorkload } from "../../src/workload/store.js";

type WorkloadState = { up: boolean; rel: string; args: string[] };
type WorkloadStateMap = Map<string, WorkloadState>;

function makeClient(state: WorkloadStateMap): WorkloadClient {
  return {
    serverStatus: {
      query: ({ workload }): ReturnType<WorkloadClient["serverStatus"]["query"]> => {
        const s = state.get(workload);
        return Promise.resolve(
          s
            ? {
                state: "up",
                pid: 1,
                rel: s.rel,
                extraArgs: s.args,
                host: "127.0.0.1",
                port: 8181,
                binary: null,
                endpoint: "http://127.0.0.1:8181",
              }
            : {
                state: "down",
                pid: null,
                rel: null,
                extraArgs: [],
                host: null,
                port: null,
                binary: null,
                endpoint: "http://127.0.0.1:8181",
              },
        );
      },
    },
    serverStop: {
      mutate: ({ workload }): Promise<{ stopped: boolean }> => {
        state.delete(workload);
        return Promise.resolve({ stopped: true });
      },
    },
    serverStart: {
      subscribe: ({ workload, target, extraArgs }, callbacks): { unsubscribe: () => undefined } => {
        state.set(workload, { up: true, rel: target, args: extraArgs ?? [] });
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 100, endpoint: "http://127.0.0.1:8181" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
}

function makeRecordingClient(state: WorkloadStateMap): {
  client: WorkloadClient;
  stops: string[];
  starts: string[];
} {
  const stops: string[] = [];
  const starts: string[] = [];
  const base = makeClient(state);
  const client: WorkloadClient = {
    ...base,
    serverStop: {
      mutate: (input): Promise<unknown> => {
        stops.push(input.workload);
        return base.serverStop.mutate(input);
      },
    },
    serverStart: {
      subscribe: (input, callbacks): UnsubscribableLike => {
        starts.push(input.workload);
        return base.serverStart.subscribe(input, callbacks);
      },
    },
  };
  return { client, stops, starts };
}

type UnsubscribableLike = ReturnType<WorkloadClient["serverStart"]["subscribe"]>;

const mkManifest = (
  name: string,
  overrides: Partial<{
    annotations: Record<string, string>;
    enabled: boolean;
    port: number;
    ram: number;
    node: string;
  }> = {},
): ModelRun => ({
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name, labels: {}, annotations: overrides.annotations ?? {} },
  spec: {
    node: overrides.node ?? "local",
    enabled: overrides.enabled ?? true,
    target: { kind: "rel", value: `${name}.gguf` },
    extraArgs: [],
    workers: [],
    restartPolicy: "Always",
    gateway: false,
    allowExternalBind: false,
    timeoutSeconds: 60,
    endpoint: { host: "127.0.0.1", port: overrides.port ?? 8181 },
    resources: { expectedMemoryGiB: overrides.ram ?? 8 },
  },
});

// The residencyStatus payload the victim-node read consumes, reduced to
// its lifecycle section: the serving process's residency_states rows in
// the public projection (no fence identity).
function lifecycleOf(
  rows: readonly { model: string; state: string; updatedAtMs: number }[],
): unknown {
  return {
    node: "local",
    lifecycle: {
      status: "available",
      scope: "serving-process",
      workloads: rows.map((row) => ({
        model: row.model,
        group: null,
        state: row.state,
        occupying: row.state === "ready",
        version: 4,
        updatedAtMs: row.updatedAtMs,
      })),
      exclusiveViolations: [],
    },
  };
}

// Adds a residencyStatus.query to a WorkloadClient fake. withNodeRpcDeadline
// calls it as query(input, {signal}); the counter records invocations, not
// arguments. WorkloadClient.residencyStatus is optional, so the wrapper is
// built without a type annotation and cast — the cases fail by assertion
// on the missing wiring, never by a type error.
function withRemoteStatus(
  client: WorkloadClient,
  respond: () => unknown,
): { client: WorkloadClient; calls: { count: number } } {
  const calls = { count: 0 };
  const wrapped = {
    ...client,
    residencyStatus: {
      query: (_input: unknown, _opts?: unknown): Promise<unknown> => {
        calls.count += 1;
        return Promise.resolve(respond());
      },
    },
  };
  return { client: wrapped as unknown as WorkloadClient, calls };
}

// Walks a residency_states row unavailable -> downloaded -> loading ->
// warming -> ready, every hop stamped readyAtMs, so the ready row's
// updatedAtMs is the load time minResidencySeconds measures against.
function seedReadyLifecycle(storePath: string, model: string, readyAtMs: number): void {
  seedLifecycle(storePath, model, readyAtMs, ["downloaded", "loading", "warming", "ready"]);
}

type LifecycleHop = "downloaded" | "loading" | "warming" | "ready";

// Walks a residency_states row from unavailable through `hops`, every hop
// stamped atMs.
function seedLifecycle(
  storePath: string,
  model: string,
  atMs: number,
  hops: readonly LifecycleHop[],
): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({ ownerId: "seed", incarnation: "seed" });
    let expectedVersion = 0;
    for (const to of hops) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        to,
        expectedVersion,
        nowMs: atMs,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expectedVersion = result.record.version;
      }
    }
  } finally {
    store.close();
  }
}

// Saves a NodeRun manifest; residencyByName in reconcileOnce keys on
// metadata.name, so `name` is the lookup key the reconciler's
// getNodeResidency(nodeName) resolves against.
function saveNodeRunPolicy(
  workloadsDir: string,
  name: string,
  spec: { node: string; memoryGiB?: number; minResidencySeconds?: number },
): void {
  saveNodeRun(
    NodeRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name },
      spec: {
        node: spec.node,
        infra: [],
        ...(spec.memoryGiB !== undefined ? { budget: { memoryGiB: spec.memoryGiB } } : {}),
        ...(spec.minResidencySeconds !== undefined
          ? { residency: { minResidencySeconds: spec.minResidencySeconds } }
          : {}),
      },
    }),
    workloadsDir,
  );
}

interface ReconcileFixture {
  tmp: string;
  workloadsDir: string;
  client: WorkloadClient;
  stops: string[];
  starts: string[];
}

// The standard fixture: victim 'a' saved and up in the fake state, 'b'
// saved with llamactl.io/evict: a on a distinct port, then one
// reconcileOnce pass filtered to 'b'.
async function inReconcileCase(fn: (fixture: ReconcileFixture) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-reconciler-evict-min-residency-"));
  const prevRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  try {
    const workloadsDir = join(tmp, "workloads");
    saveWorkload(mkManifest("a"), workloadsDir);
    saveWorkload(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      workloadsDir,
    );
    const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
    const { client, stops, starts } = makeRecordingClient(state);
    await fn({ tmp, workloadsDir, client, stops, starts });
  } finally {
    if (prevRuntimeDir === undefined) {
      Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
    } else {
      process.env["LOCAL_AI_RUNTIME_DIR"] = prevRuntimeDir;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function reconcileB(workloadsDir: string, client: WorkloadClient): Promise<ReconcileResult> {
  return reconcileOnce({
    workloadsDir,
    getClient: () => client,
    filter: (m) => m.metadata.name === "b",
  });
}

function reportError(result: ReconcileResult, name: string): string {
  return result.reports.find((r) => r.name === name)?.error ?? "";
}

describe("#519 reconcileOnce evict minResidencySeconds", () => {
  const RESIDENCY_ENV_KEYS = [
    "LLAMACTL_NODE_NAME",
    "LLAMACTL_RESIDENCY_STORE",
    "LOCAL_AI_RUNTIME_DIR",
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of RESIDENCY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    for (const key of RESIDENCY_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  // Mutation pinned: dropping getNodeResidency from reconcileModelRun's
  // applyOne options resolves the gate to 0, so the controller evicts the
  // victim node's young 'a' blind instead of refusing EvictMinResidency.
  test("RC1: an anonymous controller is gated by the victim node's residencyStatus lifecycle", async () => {
    await inReconcileCase(async ({ workloadsDir, client, stops, starts }) => {
      saveNodeRunPolicy(workloadsDir, "local", {
        node: "local",
        memoryGiB: 64,
        minResidencySeconds: 3600,
      });
      const { client: remote, calls } = withRemoteStatus(client, () =>
        lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() }]),
      );
      const result = await reconcileB(workloadsDir, remote);
      expect(stops).not.toContain("a");
      expect(starts).not.toContain("b");
      expect(calls.count).toBeGreaterThanOrEqual(1);
      const error = reportError(result, "b");
      expect(error).toContain("minResidencySeconds of 3600");
      expect(error).toContain("retry in");
    });
  });

  // Mutation pinned: the same drop, through the serving-node store
  // branch — LLAMACTL_NODE_NAME names the victim's node, so the gate
  // reads the node-local residency store rather than residencyStatus.
  test("RC2: the serving node's own residency store gates the reconcile evict", async () => {
    await inReconcileCase(async ({ tmp, workloadsDir, client, stops }) => {
      const storePath = join(tmp, "rs", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "local";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedReadyLifecycle(storePath, "a", Date.now());
      saveNodeRunPolicy(workloadsDir, "local", {
        node: "local",
        memoryGiB: 64,
        minResidencySeconds: 3600,
      });
      const result = await reconcileB(workloadsDir, client);
      expect(stops).toEqual([]);
      expect(reportError(result, "b")).toContain("minResidencySeconds of 3600");
    });
  });

  // No-regression guard: a disabled gate never reads residencyStatus and
  // evicts exactly as before. Passes at base and fix.
  test("RC3: minResidencySeconds 0 leaves the reconcile evict untouched", async () => {
    await inReconcileCase(async ({ workloadsDir, client, stops, starts }) => {
      saveNodeRunPolicy(workloadsDir, "local", {
        node: "local",
        memoryGiB: 64,
        minResidencySeconds: 0,
      });
      const { client: remote, calls } = withRemoteStatus(client, () =>
        lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() }]),
      );
      const result = await reconcileB(workloadsDir, remote);
      expect(stops).toContain("a");
      expect(starts).toContain("b");
      expect(calls.count).toBe(0);
      for (const report of result.reports) {
        expect(report.error ?? "").not.toContain("minResidencySeconds");
      }
    });
  });

  // No-regression guard: residency is keyed by NodeRun name — another
  // node's minResidencySeconds must not gate this node's evict. Passes at
  // base and fix; kills a fix that leaks a foreign node's residency.
  test("RC4: another node's minResidencySeconds does not gate the local evict", async () => {
    await inReconcileCase(async ({ workloadsDir, client, stops }) => {
      saveNodeRunPolicy(workloadsDir, "other-node", {
        node: "other-node",
        minResidencySeconds: 3600,
      });
      saveNodeRunPolicy(workloadsDir, "local", { node: "local", memoryGiB: 64 });
      const { client: remote } = withRemoteStatus(client, () =>
        lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() }]),
      );
      const result = await reconcileB(workloadsDir, remote);
      expect(stops).toContain("a");
    });
  });
});
