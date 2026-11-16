// DF-01 (#274): node aliases must share one admission capacity. These
// tests pin the identity-aware serialization + accounting contract for
// applyOne / applyOneModelHost: aliases of one physical node take the
// same in-flight lock, count each other's committed reservations, and
// fail closed when a non-local node name cannot be resolved to an
// identity. Resolver-less callers keep name-keyed behavior.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import {
  applyOne,
  applyOneModelHost,
  type ApplyResult,
  type WorkloadClient,
} from "../../src/workload/apply.js";
import { saveWorkload } from "../../src/workload/store.js";

type StartCallbacks = Parameters<WorkloadClient["serverStart"]["subscribe"]>[1];

const RUN_DONE = {
  type: "done",
  result: { ok: true, pid: 100, endpoint: "http://127.0.0.1:8181" },
} as const;
const HOST_DONE = {
  type: "done",
  result: { ok: true, pid: 12345, state: "Running" },
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function poll(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("poll timed out");
    await sleep(5);
  }
}

/**
 * One fake node client for every node name. serverStatus always reports
 * down; serverStart / modelHostStart record the workload name and then
 * either complete on the next tick (hold: false) or park until
 * releaseAll() fires the held callbacks (hold: true). The fake never
 * commits manifests — production callers persist outside the lock.
 */
function makeHeldClient(hold: boolean): {
  client: WorkloadClient;
  starts: string[];
  hostStarts: string[];
  releaseAll: () => void;
  drain: (promises: Promise<unknown>[]) => Promise<void>;
} {
  const starts: string[] = [];
  const hostStarts: string[] = [];
  const heldRun: StartCallbacks[] = [];
  const heldHost: StartCallbacks[] = [];

  const releaseAll = (): void => {
    for (const callbacks of heldRun.splice(0)) {
      callbacks.onData(RUN_DONE);
      callbacks.onComplete();
    }
    for (const callbacks of heldHost.splice(0)) {
      callbacks.onData(HOST_DONE);
      callbacks.onComplete();
    }
  };

  const drain = async (promises: Promise<unknown>[]): Promise<void> => {
    const settled = promises.map(() => false);
    for (const [index, promise] of promises.entries()) {
      void promise.then(
        () => {
          settled[index] = true;
        },
        () => {
          settled[index] = true;
        },
      );
    }
    while (!settled.every(Boolean)) {
      releaseAll();
      await sleep(5);
    }
  };

  const client: WorkloadClient = {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "down",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({ ok: true }) },
    serverStart: {
      subscribe: (input, callbacks) => {
        starts.push(input.workload);
        if (hold) {
          heldRun.push(callbacks);
        } else {
          queueMicrotask(() => {
            callbacks.onData(RUN_DONE);
            callbacks.onComplete();
          });
        }
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe: (input, callbacks) => {
        hostStarts.push(input.workload);
        if (hold) {
          heldHost.push(callbacks);
        } else {
          queueMicrotask(() => {
            callbacks.onData(HOST_DONE);
            callbacks.onComplete();
          });
        }
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ ok: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Running" }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
    },
  };
  return { client, starts, hostStarts, releaseAll, drain };
}

const mkManifest = (
  name: string,
  overrides: Partial<{ node: string; ram: number; port: number }> = {},
): ModelRun => ({
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name, labels: {}, annotations: {} },
  spec: {
    node: overrides.node ?? "local",
    enabled: true,
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

const mkModelHostManifest = (
  name: string,
  overrides: Partial<ModelHostManifest["spec"]> = {},
): ModelHostManifest => ({
  apiVersion: "llamactl/v1",
  kind: "ModelHost",
  metadata: { name },
  spec: {
    engine: "omlx",
    node: "local",
    enabled: true,
    binary: "/usr/bin/true",
    endpoint: { host: "127.0.0.1", port: 18094 },
    hostedModels: [{ rel: `${name}.gguf` }],
    extraArgs: [],
    restartPolicy: "Always",
    timeoutSeconds: 60,
    resources: { expectedMemoryGiB: 8 },
    ...overrides,
  },
});

const ALIAS_RESOLVER = (n: string): string | null =>
  n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null;

/** Attach a nodeFacts stub reporting `memBytes` to a fake client. */
function withNodeFacts(client: WorkloadClient, memBytes: number | null): WorkloadClient {
  return { ...client, nodeFacts: { query: () => Promise.resolve({ memBytes }) } };
}

const GIB = 1024 ** 3;

function budgetSpy(): { budgetCalls: string[]; getNodeBudgetGiB: (n: string) => number } {
  const budgetCalls: string[] = [];
  return {
    budgetCalls,
    getNodeBudgetGiB: (n: string): number => {
      budgetCalls.push(n);
      return 24;
    },
  };
}

describe("DF-01 #274 node-alias admission identity", () => {
  test("a ModelRun on alias B does not reach admission while alias A's start is in flight", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts, releaseAll, drain } = makeHeldClient(true);
    const { budgetCalls, getNodeBudgetGiB } = budgetSpy();
    const opts = {
      env,
      workloadsDir,
      getNodeBudgetGiB,
      resolveNodeIdentity: ALIAS_RESOLVER,
    };
    let pa: Promise<ApplyResult> | undefined;
    let pb: Promise<ApplyResult> | undefined;
    try {
      pa = applyOne(
        mkManifest("alias-run-a", { node: "mac-mini", ram: 16, port: 8090 }),
        () => client,
        undefined,
        undefined,
        opts,
      );
      await poll(() => starts.length === 1);
      expect(starts).toEqual(["alias-run-a"]);

      let bSettled = false;
      pb = applyOne(
        mkManifest("alias-run-b", { node: "mac-mini.local", ram: 16, port: 8091 }),
        () => client,
        undefined,
        undefined,
        opts,
      ).then((result) => {
        bSettled = true;
        return result;
      });

      await sleep(100);
      expect(starts).toEqual(["alias-run-a"]);
      expect(budgetCalls).not.toContain("mac-mini.local");
      expect(bSettled).toBe(false);

      await drain([pa, pb]);
      const [resultA, resultB] = await Promise.all([pa, pb]);
      expect(resultA.action).toBe("started");
      expect(resultB.action).toBe("started");
      expect(starts).toEqual(["alias-run-a", "alias-run-b"]);
    } finally {
      releaseAll();
      await sleep(10);
      releaseAll();
      temp.cleanup();
    }
  });

  test("a ModelRun on alias B does not reach admission while a ModelHost start on alias A is in flight", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts, hostStarts, releaseAll, drain } = makeHeldClient(true);
    const { budgetCalls, getNodeBudgetGiB } = budgetSpy();
    const opts = {
      env,
      workloadsDir,
      getNodeBudgetGiB,
      resolveNodeIdentity: ALIAS_RESOLVER,
    };
    let ph: ReturnType<typeof applyOneModelHost> | undefined;
    let pr: Promise<ApplyResult> | undefined;
    try {
      ph = applyOneModelHost(
        mkModelHostManifest("alias-host", {
          node: "mac-mini",
          resources: { expectedMemoryGiB: 16 },
        }),
        () => client,
        undefined,
        opts,
      );
      await poll(() => hostStarts.length === 1);
      expect(hostStarts).toEqual(["alias-host"]);

      pr = applyOne(
        mkManifest("alias-run", { node: "mac-mini.local", ram: 16, port: 8092 }),
        () => client,
        undefined,
        undefined,
        opts,
      );

      await sleep(100);
      expect(starts).toEqual([]);
      expect(budgetCalls).not.toContain("mac-mini.local");

      await drain([ph, pr]);
      const hostResult = await ph;
      const runResult = await pr;
      expect(hostResult.ok).toBe(true);
      expect(runResult.action).toBe("started");
      expect(starts).toEqual(["alias-run"]);
    } finally {
      releaseAll();
      await sleep(10);
      releaseAll();
      temp.cleanup();
    }
  });

  test("ModelHost admission counts a committed ModelRun on another alias of the same node", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, hostStarts } = makeHeldClient(false);
    const { getNodeBudgetGiB } = budgetSpy();
    try {
      saveWorkload(mkManifest("resident-run", { node: "mac-mini.local", ram: 16 }), workloadsDir);
      const result = await applyOneModelHost(
        mkModelHostManifest("alias-host-2", {
          node: "mac-mini",
          resources: { expectedMemoryGiB: 16 },
        }),
        () => client,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("resident-run");
      expect(result.error).toContain("Budget is 24.0 GiB");
      expect(result.reason).toBe("BudgetExceeded");
      expect(hostStarts).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelRun on a non-local node whose identity does not resolve fails closed", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts } = makeHeldClient(false);
    const { getNodeBudgetGiB } = budgetSpy();
    try {
      const result = await applyOne(
        mkManifest("ghost-run", { node: "ghost", ram: 8, port: 8093 }),
        () => client,
        undefined,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("BudgetUnknown");
      expect(result.error).toContain("does not resolve to a node identity");
      expect(starts).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelHost on a non-local node whose identity does not resolve fails closed", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, hostStarts } = makeHeldClient(false);
    const { getNodeBudgetGiB } = budgetSpy();
    try {
      const result = await applyOneModelHost(
        mkModelHostManifest("ghost-host", {
          node: "ghost",
          resources: { expectedMemoryGiB: 8 },
        }),
        () => client,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("BudgetUnknown");
      expect(result.error).toContain("does not resolve to a node identity");
      expect(hostStarts).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  test("a resolver-supplying and a resolver-less apply on the same node name stay serialized", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts, releaseAll, drain } = makeHeldClient(true);
    const { getNodeBudgetGiB } = budgetSpy();
    let pa: Promise<ApplyResult> | undefined;
    let pb: Promise<ApplyResult> | undefined;
    try {
      pa = applyOne(
        mkManifest("mixed-a", { node: "mac-mini", ram: 16, port: 8094 }),
        () => client,
        undefined,
        undefined,
        { env, workloadsDir, getNodeBudgetGiB, resolveNodeIdentity: ALIAS_RESOLVER },
      );
      await poll(() => starts.length === 1);

      pb = applyOne(
        mkManifest("mixed-b", { node: "mac-mini", ram: 16, port: 8095 }),
        () => client,
        undefined,
        undefined,
        { env, workloadsDir, getNodeBudgetGiB },
      );

      await sleep(100);
      expect(starts).toHaveLength(1);

      await drain([pa, pb]);
      const [resultA, resultB] = await Promise.all([pa, pb]);
      expect(resultA.action).toBe("started");
      expect(resultB.action).toBe("started");
    } finally {
      releaseAll();
      await sleep(10);
      releaseAll();
      temp.cleanup();
    }
  });

  test("distinct nodes keep independent locks and budgets", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts, releaseAll, drain } = makeHeldClient(true);
    const { getNodeBudgetGiB } = budgetSpy();
    const gpuResolver = (n: string): string | null =>
      n === "gpu-a" ? "id-a" : n === "gpu-b" ? "id-b" : null;
    const opts = {
      env,
      workloadsDir,
      getNodeBudgetGiB,
      resolveNodeIdentity: gpuResolver,
    };
    let pa: Promise<ApplyResult> | undefined;
    let pb: Promise<ApplyResult> | undefined;
    try {
      pa = applyOne(
        mkManifest("gpu-run-a", { node: "gpu-a", ram: 16, port: 8110 }),
        () => client,
        undefined,
        undefined,
        opts,
      );
      pb = applyOne(
        mkManifest("gpu-run-b", { node: "gpu-b", ram: 16, port: 8111 }),
        () => client,
        undefined,
        undefined,
        opts,
      );

      await poll(() => starts.length === 2);
      expect(starts).toHaveLength(2);

      await drain([pa, pb]);
      const [resultA, resultB] = await Promise.all([pa, pb]);
      expect(resultA.action).toBe("started");
      expect(resultB.action).toBe("started");
    } finally {
      releaseAll();
      await sleep(10);
      releaseAll();
      temp.cleanup();
    }
  });

  test("the local node with a null-resolving identity keeps its finite budget", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts } = makeHeldClient(false);
    const { getNodeBudgetGiB } = budgetSpy();
    const opts = {
      env,
      workloadsDir,
      getNodeBudgetGiB,
      resolveNodeIdentity: ALIAS_RESOLVER,
    };
    try {
      const first = await applyOne(
        mkManifest("local-a", { node: "local", ram: 8, port: 8300 }),
        () => client,
        undefined,
        undefined,
        opts,
      );
      expect(first.action).toBe("started");

      saveWorkload(
        mkManifest("resident-local", { node: "local", ram: 16, port: 8301 }),
        workloadsDir,
      );

      const second = await applyOne(
        mkManifest("local-b", { node: "local", ram: 16, port: 8302 }),
        () => client,
        undefined,
        undefined,
        opts,
      );
      expect(second.action).toBe("pending");
      expect(second.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
      expect(starts).toEqual(["local-a"]);
    } finally {
      temp.cleanup();
    }
  });

  test("a zero-declared workload on an unresolvable node with no living reservation still starts", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts } = makeHeldClient(false);
    const { getNodeBudgetGiB } = budgetSpy();
    try {
      const result = await applyOne(
        mkManifest("ghost-zero", { node: "ghost", ram: 0, port: 8120 }),
        () => client,
        undefined,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.action).toBe("started");
      expect(starts).toEqual(["ghost-zero"]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelRun on an unresolved node verified by nodeFacts admits on the verified budget", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const held = makeHeldClient(false);
    const client = withNodeFacts(held.client, 64 * GIB);
    try {
      const result = await applyOne(
        mkManifest("ghost-verified", { node: "ghost", ram: 8, port: 8130 }),
        () => client,
        undefined,
        undefined,
        { env, workloadsDir, resolveNodeIdentity: ALIAS_RESOLVER },
      );
      expect(result.action).toBe("started");
      expect(held.starts).toEqual(["ghost-verified"]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelRun on an unresolved node verified by nodeFacts refuses on a smaller explicit budget", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const held = makeHeldClient(false);
    const client = withNodeFacts(held.client, 64 * GIB);
    try {
      const result = await applyOne(
        mkManifest("ghost-explicit", { node: "ghost", ram: 8, port: 8131 }),
        () => client,
        undefined,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB: () => 4,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
      expect(result.error).toContain("Budget is 4.0 GiB");
      expect(held.starts).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelRun on an unresolved node whose nodeFacts reports no memory fails closed", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const held = makeHeldClient(false);
    const client = withNodeFacts(held.client, null);
    try {
      const result = await applyOne(
        mkManifest("ghost-nofacts", { node: "ghost", ram: 8, port: 8132 }),
        () => client,
        undefined,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB: () => 24,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("BudgetUnknown");
      expect(held.starts).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelHost on an unresolved node verified by nodeFacts admits on the verified budget", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const held = makeHeldClient(false);
    const client = withNodeFacts(held.client, 64 * GIB);
    try {
      const result = await applyOneModelHost(
        mkModelHostManifest("ghost-host-verified", {
          node: "ghost",
          resources: { expectedMemoryGiB: 8 },
        }),
        () => client,
        undefined,
        { env, workloadsDir, resolveNodeIdentity: ALIAS_RESOLVER },
      );
      expect(result.ok).toBe(true);
      expect(held.hostStarts).toEqual(["ghost-host-verified"]);
    } finally {
      temp.cleanup();
    }
  });

  test("ModelHost on an unresolved node verified by nodeFacts refuses on a smaller explicit budget", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const held = makeHeldClient(false);
    const client = withNodeFacts(held.client, 64 * GIB);
    try {
      const result = await applyOneModelHost(
        mkModelHostManifest("ghost-host-explicit", {
          node: "ghost",
          resources: { expectedMemoryGiB: 8 },
        }),
        () => client,
        undefined,
        {
          env,
          workloadsDir,
          getNodeBudgetGiB: () => 4,
          resolveNodeIdentity: ALIAS_RESOLVER,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("BudgetExceeded");
      expect(result.error).toContain("Budget is 4.0 GiB");
      expect(held.hostStarts).toEqual([]);
    } finally {
      temp.cleanup();
    }
  });

  test("an empty-string identity does not collapse distinct nodes onto one admission lock", async () => {
    const temp = makeTempRuntime();
    const env = envForTemp(temp);
    const workloadsDir = join(temp.devStorage, "workloads");
    const { client, starts, releaseAll, drain } = makeHeldClient(true);
    const { getNodeBudgetGiB } = budgetSpy();
    const opts = {
      env,
      workloadsDir,
      getNodeBudgetGiB,
      resolveNodeIdentity: (): string | null => "",
    };
    let pa: Promise<ApplyResult> | undefined;
    let pb: Promise<ApplyResult> | undefined;
    try {
      pa = applyOne(
        mkManifest("empty-id-a", { node: "gpu-a", ram: 8, port: 8140 }),
        () => client,
        undefined,
        undefined,
        opts,
      );
      pb = applyOne(
        mkManifest("empty-id-b", { node: "gpu-b", ram: 8, port: 8141 }),
        () => client,
        undefined,
        undefined,
        opts,
      );

      await poll(() => starts.length === 2);
      expect(starts).toHaveLength(2);

      await drain([pa, pb]);
      const [resultA, resultB] = await Promise.all([pa, pb]);
      expect(resultA.action).toBe("started");
      expect(resultB.action).toBe("started");
    } finally {
      releaseAll();
      await sleep(10);
      releaseAll();
      temp.cleanup();
    }
  });
});
