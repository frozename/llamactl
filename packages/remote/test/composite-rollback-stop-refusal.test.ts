// packages/remote/test/composite-rollback-stop-refusal.test.ts
//
// Part of #520: rollback after a failed composite apply must surface a node
// stop-fence refusal instead of discarding the structured serverStop result,
// while keeping the still-running workload Ready so the operator can release
// the fence and retry. The fake RuntimeBackend never touches docker and the
// fake WorkloadClient never spawns inference; all state lives in temp dirs.
import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Composite, CompositeStatusComponent } from "../src/composite/schema.js";
import type { CompositeApplyEvent, CompositeApplyResult } from "../src/composite/types.js";
import type {
  ImageRef,
  RemoveServiceOptions,
  RuntimeBackend,
  ServiceDeployment,
  ServiceFilter,
  ServiceInstance,
  ServiceRef,
} from "../src/runtime/backend.js";
import type { WorkloadClient } from "../src/workload/apply.js";

import { applyComposite } from "../src/composite/apply.js";
import { CompositeSchema } from "../src/composite/schema.js";
import { loadComposite } from "../src/composite/store.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
let configPath = "";
let compositesDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-composite-rollback-fence-"));
  configPath = join(tmp, "config");
  compositesDir = join(tmp, "composites");
  saveConfig(freshConfig(), configPath);
  process.env["LLAMACTL_CONFIG"] = configPath;
  process.env["LLAMACTL_COMPOSITES_DIR"] = compositesDir;
  process.env["LLAMACTL_SIRIUS_PROVIDERS"] = join(tmp, "sirius-providers.yaml");
  process.env["LLAMACTL_EMBERSYNTH_CONFIG"] = join(tmp, "embersynth.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

// ---- fakes ---------------------------------------------------------------

class FakeRuntimeBackend implements RuntimeBackend {
  readonly kind = "fake";
  readonly calls: { op: string; arg: unknown }[] = [];
  readonly services = new Map<string, ServiceInstance>();
  /** When set, the next ensureService call throws. */
  failNextEnsure: string | null = null;

  async ping(): Promise<void> {
    await Promise.resolve();
    this.calls.push({ op: "ping", arg: null });
  }
  async ensureService(spec: ServiceDeployment): Promise<ServiceInstance> {
    await Promise.resolve();
    this.calls.push({ op: "ensureService", arg: spec });
    if (this.failNextEnsure) {
      const msg = this.failNextEnsure;
      this.failNextEnsure = null;
      throw new Error(msg);
    }
    const instance: ServiceInstance = {
      ref: { name: spec.name },
      running: true,
      health: "healthy",
      specHash: spec.specHash,
      createdAt: new Date().toISOString(),
      endpoint: { host: "127.0.0.1", port: spec.ports?.[0]?.hostPort ?? 8000 },
    };
    this.services.set(spec.name, instance);
    return instance;
  }
  async removeService(ref: ServiceRef, opts?: RemoveServiceOptions): Promise<void> {
    await Promise.resolve();
    this.calls.push({ op: "removeService", arg: { ref, opts: opts ?? {} } });
    this.services.delete(ref.name);
  }
  async inspectService(ref: ServiceRef): Promise<ServiceInstance | null> {
    await Promise.resolve();
    this.calls.push({ op: "inspectService", arg: ref });
    return this.services.get(ref.name) ?? null;
  }
  async listServices(filter?: ServiceFilter): Promise<ServiceInstance[]> {
    await Promise.resolve();
    this.calls.push({ op: "listServices", arg: filter });
    return Array.from(this.services.values());
  }
  async pullImage(ref: ImageRef): Promise<void> {
    await Promise.resolve();
    this.calls.push({ op: "pullImage", arg: ref });
  }
}

type StopInput = { workload: string; graceSeconds?: number };

function makeFakeWorkloadClient(stop: (input: StopInput) => Promise<unknown>): {
  client: WorkloadClient;
  stopKeys: string[];
} {
  const stopKeys: string[] = [];
  const client: WorkloadClient = {
    serverStatus: {
      async query() {
        await Promise.resolve();
        return {
          state: "stopped",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "http://127.0.0.1:8080",
        };
      },
    },
    serverStop: {
      async mutate(input) {
        await Promise.resolve();
        stopKeys.push(input.workload);
        return await stop(input);
      },
    },
    serverStart: {
      subscribe(_input, callbacks) {
        queueMicrotask(() => {
          callbacks.onData({
            type: "started",
            pid: 12345,
            endpoint: "http://127.0.0.1:8080",
            model: "test",
          });
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
    modelHostStart: {
      subscribe() {
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: {
      async mutate() {
        await Promise.resolve();
        return {};
      },
    },
    modelHostStatus: {
      async query() {
        await Promise.resolve();
        return { state: "Stopped", pid: null };
      },
    },
    rpcServerStart: {
      subscribe() {
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStop: {
      async mutate() {
        await Promise.resolve();
        return {};
      },
    },
    rpcServerDoctor: {
      async query() {
        await Promise.resolve();
        return { ok: true, path: "/fake", llamaCppBin: "/fake" };
      },
    },
  };
  return { client, stopKeys };
}

// ---- manifest + helpers ----------------------------------------------------

function rollbackComposite(): Composite {
  return CompositeSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name: "stack" },
    spec: {
      services: [
        {
          kind: "chroma",
          name: "chroma-1",
          node: "local",
          runtime: "docker",
          port: 8001,
          image: { repository: "chromadb/chroma", tag: "1.5.8" },
        },
      ],
      workloads: [
        {
          node: "local",
          target: { kind: "rel", value: "m.gguf" },
        },
      ],
      ragNodes: [],
      gateways: [],
      pipelines: [],
      dependencies: [
        {
          from: { kind: "service", name: "chroma-1" },
          to: { kind: "workload", name: "local" },
        },
      ],
      onFailure: "rollback",
    },
  });
}

async function runRollbackApply(stop: (input: StopInput) => Promise<unknown>): Promise<{
  result: CompositeApplyResult;
  events: CompositeApplyEvent[];
  stopKeys: string[];
}> {
  const backend = new FakeRuntimeBackend();
  const fake = makeFakeWorkloadClient(stop);
  const events: CompositeApplyEvent[] = [];
  backend.failNextEnsure = "boom";

  const result = await applyComposite({
    manifest: rollbackComposite(),
    backend,
    getWorkloadClient: () => fake.client,
    configPath,
    compositesDir,
    onEvent: (e) => events.push(e),
  });
  return { result, events, stopKeys: fake.stopKeys };
}

function workloadFailureEvents(events: CompositeApplyEvent[]): CompositeApplyEvent[] {
  return events.filter(
    (e) => e.type === "component-failed" && e.ref.kind === "workload" && e.ref.name === "local",
  );
}

function workloadStatus(result: CompositeApplyResult): CompositeStatusComponent | undefined {
  return result.status.components.find((c) => c.ref.kind === "workload" && c.ref.name === "local");
}

function expectCommonRollbackOutcome(
  result: CompositeApplyResult,
  stopKeys: readonly string[],
): void {
  expect(result.rolledBack).toBe(true);
  expect(result.status.phase).toBe("Failed");
  const service = result.status.components.find(
    (c) => c.ref.kind === "service" && c.ref.name === "chroma-1",
  );
  expect(service?.state).toBe("Failed");
  expect(service?.message).toContain("boom");
  expect(stopKeys).toEqual(["local"]);
}

const R1_MESSAGE =
  "rollback failed for workload/local: serverStop on local refused (SessionsActive: sess-a, sess-b); workload left running";
const R2_MESSAGE =
  "rollback failed for workload/local: serverStop on local refused (SessionsUnknown); workload left running";
const R3_MESSAGE =
  "rollback failed for workload/local: serverStop on local refused (LeasesActive: lease-1); workload left running";

// ---- tests -----------------------------------------------------------------

describe("applyComposite rollback — stop-fence refusal (#520)", () => {
  test("R1: SessionsActive refusal emits one workload rollback failure with the active ids", async () => {
    // Kills: teardownComponent discarding the serverStop result — the base
    // swallows it, so the rollback failure event is missing entirely.
    const { result, events, stopKeys } = await runRollbackApply(() =>
      Promise.resolve({
        stopped: false,
        pid: 4242,
        killed: false,
        refused: { reason: "SessionsActive", active: ["sess-a", "sess-b"] },
      }),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    expect(workloadFailureEvents(events)).toEqual([
      {
        type: "component-failed",
        ref: { kind: "workload", name: "local" },
        message: R1_MESSAGE,
      },
    ]);
  });

  test("R2: SessionsUnknown with an empty active list omits the id suffix", async () => {
    // Kills: always appending the ids suffix, or the rollback path not reusing
    // the refusal-detail formatter.
    const { result, events, stopKeys } = await runRollbackApply(() =>
      Promise.resolve({
        stopped: false,
        pid: 4242,
        killed: false,
        refused: { reason: "SessionsUnknown", active: [] },
      }),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    expect(workloadFailureEvents(events)).toEqual([
      {
        type: "component-failed",
        ref: { kind: "workload", name: "local" },
        message: R2_MESSAGE,
      },
    ]);
  });

  test("R3: LeasesActive refusal is surfaced like a session refusal", async () => {
    // Kills: a session-only check that ignores lease and drain refusals.
    const { result, events, stopKeys } = await runRollbackApply(() =>
      Promise.resolve({
        stopped: false,
        pid: 4242,
        killed: false,
        refused: { reason: "LeasesActive", active: ["lease-1"] },
      }),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    expect(workloadFailureEvents(events)).toEqual([
      {
        type: "component-failed",
        ref: { kind: "workload", name: "local" },
        message: R3_MESSAGE,
      },
    ]);
  });

  test("R4: the refusal is persisted on the still-Ready workload component", async () => {
    // Kills: emitting the event without recording the refusal in the status,
    // or flipping the still-running workload to Failed.
    const { result, stopKeys } = await runRollbackApply(() =>
      Promise.resolve({
        stopped: false,
        pid: 4242,
        killed: false,
        refused: { reason: "SessionsActive", active: ["sess-a", "sess-b"] },
      }),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    const componentResult = result.componentResults.find(
      (c) => c.ref.kind === "workload" && c.ref.name === "local",
    );
    expect(componentResult?.state).toBe("Ready");
    expect(componentResult?.message).toBe(R1_MESSAGE);

    const statusComponent = workloadStatus(result);
    expect(statusComponent?.state).toBe("Ready");
    expect(statusComponent?.message).toBe(R1_MESSAGE);

    const persisted = loadComposite("stack", compositesDir);
    const persistedComponent = persisted?.status?.components.find(
      (c) => c.ref.kind === "workload" && c.ref.name === "local",
    );
    expect(persistedComponent?.state).toBe("Ready");
    expect(persistedComponent?.message).toBe(R1_MESSAGE);
  });

  test("G1 guard: a verified stop emits no workload rollback failure or status message", async () => {
    const { result, events, stopKeys } = await runRollbackApply(() =>
      Promise.resolve({ stopped: true, pid: 1, killed: false }),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    expect(workloadFailureEvents(events)).toEqual([]);
    const statusComponent = workloadStatus(result);
    expect(statusComponent?.state).toBe("Ready");
    expect(statusComponent?.message).toBeUndefined();
  });

  test("G2 guard: a rejected stop stays swallowed as a transport failure", async () => {
    const { result, events, stopKeys } = await runRollbackApply(() =>
      Promise.reject(new Error("transport down")),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    expect(workloadFailureEvents(events)).toEqual([]);
  });

  test("G3 guard: stopped:false without refused is not a fence refusal", async () => {
    const { result, events, stopKeys } = await runRollbackApply(() =>
      Promise.resolve({ stopped: false, pid: null, killed: false }),
    );

    expectCommonRollbackOutcome(result, stopKeys);
    expect(workloadFailureEvents(events)).toEqual([]);
  });

  test("G4 guard: every outcome rolls back once, fails the service, and stops the node key once", async () => {
    const outcomes: (() => Promise<unknown>)[] = [
      (): Promise<unknown> =>
        Promise.resolve({
          stopped: false,
          pid: 4242,
          killed: false,
          refused: { reason: "SessionsActive", active: ["sess-a"] },
        }),
      (): Promise<unknown> => Promise.resolve({ stopped: true, pid: 1, killed: false }),
      (): Promise<unknown> => Promise.reject(new Error("transport down")),
      (): Promise<unknown> => Promise.resolve({ stopped: false, pid: null, killed: false }),
    ];

    for (const stop of outcomes) {
      const { result, stopKeys } = await runRollbackApply(stop);
      expectCommonRollbackOutcome(result, stopKeys);
    }
  });
});
