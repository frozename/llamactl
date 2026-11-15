// Part of #275: DF-02 eviction intent recorded in the DF-03 fenced residency store
//
// RED suite for persisting DF-02 eviction intent in the DF-03 fenced
// residency store: applyOne / applyOneModelHost take an
// `evictionOperation` option that opens an `evict:<victim>` operation
// before the first victim stop and terminalizes it on a settled outcome
// (succeeded, or failed with a `rolled-back:` detail) while an
// unverifiable teardown or a mid-apply crash leaves it nonterminal.
// The client/state harness is copied from replacement.test.ts because
// its helpers are not exported; every store is a real SQLite file in a
// mkdtemp dir, claimed through claimOwnership.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { EvictionOperationOpts } from "../../src/residency/eviction-operation.js";
import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";

import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  type ResidencyOperationRecord,
  type ResidencyOperationStore,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { applyOne, applyOneModelHost } from "../../src/workload/apply.js";
import { saveWorkload } from "../../src/workload/store.js";

type ModelRunManifest = Parameters<typeof saveWorkload>[0];
type StatusReply = Awaited<ReturnType<WorkloadClient["serverStatus"]["query"]>>;

type RecordedState = { rel: string; args: string[]; host: string; port: number | undefined };
type StateMap = Map<string, RecordedState>;

type Faults = {
  status?: (
    workload: string,
    delegate: () => Promise<StatusReply>,
  ) => Promise<StatusReply> | undefined;
  stop?: (workload: string, delegate: () => Promise<unknown>) => Promise<unknown> | undefined;
  start?: (workload: string) => boolean;
  hostStatus?: (
    workload: string,
  ) => ModelHostStatusReply | Promise<ModelHostStatusReply> | undefined;
  hostStop?: (workload: string) => unknown;
  hostStart?: (workload: string) => { ok: false; error: string } | undefined;
};

type ModelHostStatusReply = {
  state: string;
  pid?: number | null;
  specHash?: string;
  identityUnknown?: boolean;
};

const mkManifest = (
  name: string,
  overrides: Partial<{
    annotations: Record<string, string>;
    enabled: boolean;
    port: number;
    ram: number;
    node: string;
  }> = {},
): ModelRunManifest => ({
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
    ...(overrides.ram !== undefined ? { resources: { expectedMemoryGiB: overrides.ram } } : {}),
  },
});

function makeClient(
  state: StateMap,
  faults: Faults = {},
): {
  client: WorkloadClient;
  stops: string[];
  starts: string[];
  hostStops: string[];
  hostStarts: string[];
  callLog: string[];
} {
  const stops: string[] = [];
  const starts: string[] = [];
  const hostStops: string[] = [];
  const hostStarts: string[] = [];
  const callLog: string[] = [];
  const upReply = (s: RecordedState): StatusReply => ({
    state: "up",
    pid: 100,
    rel: s.rel,
    extraArgs: s.args,
    host: s.host,
    port: s.port ?? null,
    binary: null,
    endpoint: `http://${s.host}:${String(s.port ?? 0)}`,
  });
  const downReply = (): StatusReply => ({
    state: "down",
    pid: null,
    rel: null,
    extraArgs: [],
    host: null,
    port: null,
    binary: null,
    endpoint: "",
  });
  const client: WorkloadClient = {
    serverStatus: {
      query: (input) => {
        const delegate = (): Promise<StatusReply> => {
          const s = state.get(input.workload);
          return Promise.resolve(s ? upReply(s) : downReply());
        };
        return faults.status?.(input.workload, delegate) ?? delegate();
      },
    },
    serverStop: {
      mutate: (input) => {
        stops.push(input.workload);
        callLog.push(`stop:${input.workload}`);
        const delegate = (): Promise<unknown> => {
          state.delete(input.workload);
          return Promise.resolve({ stopped: true });
        };
        return faults.stop?.(input.workload, delegate) ?? delegate();
      },
    },
    serverStart: {
      subscribe: (input, callbacks) => {
        starts.push(input.workload);
        callLog.push(`start:${input.workload}`);
        if (faults.start?.(input.workload) === true) {
          queueMicrotask(() => {
            callbacks.onData({ type: "done", result: { ok: false, error: "boom" } });
            callbacks.onComplete();
          });
          return { unsubscribe: () => undefined };
        }
        const host = input.endpoint?.host ?? "127.0.0.1";
        const port = input.endpoint?.port;
        state.set(input.workload, {
          rel: input.target,
          args: input.extraArgs ?? [],
          host,
          port,
        });
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: {
              ok: true,
              pid: 100,
              endpoint: `http://${host}:${String(port ?? 0)}`,
            },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe: (input, callbacks) => {
        hostStarts.push(input.workload);
        callLog.push(`hostStart:${input.workload}`);
        const scripted = faults.hostStart?.(input.workload);
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: scripted ?? { ok: true, pid: 12345, state: "Running" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: {
      mutate: (input) => {
        hostStops.push(input.workload);
        callLog.push(`hostStop:${input.workload}`);
        const scripted = faults.hostStop?.(input.workload);
        return Promise.resolve(scripted ?? { ok: true, pid: null });
      },
    },
    modelHostStatus: {
      query: (input) => {
        const scripted = faults.hostStatus?.(input.workload);
        return Promise.resolve(scripted ?? { state: "Stopped", pid: null });
      },
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
  return { client, stops, starts, hostStops, hostStarts, callLog };
}

function upEntry(port: number): RecordedState {
  return { rel: "a.gguf", args: [], host: "127.0.0.1", port };
}

type HostOverrides = Partial<{
  enabled: boolean;
  node: string;
  binary: string;
  port: number;
  ram: number;
}>;

function mkModelHostManifest(name: string, overrides: HostOverrides = {}): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: overrides.node ?? "local",
      enabled: overrides.enabled ?? true,
      binary: overrides.binary ?? "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: overrides.port ?? 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      ...(overrides.ram !== undefined ? { resources: { expectedMemoryGiB: overrides.ram } } : {}),
    },
  };
}

function mkFakeOmlxBinary(dir: string): string {
  const binary = join(dir, "omlx");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  return binary;
}

function hostReplacement(
  name: string,
  evict: string,
  overrides: HostOverrides = {},
): ModelHostManifest {
  return {
    ...mkModelHostManifest(name, overrides),
    metadata: { name, annotations: { "llamactl.io/evict": evict } },
  };
}

function pinLocalRuntimeDir(dir: string): () => void {
  const prev = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
  return () => {
    if (prev === undefined) {
      delete process.env["LOCAL_AI_RUNTIME_DIR"];
    } else {
      process.env["LOCAL_AI_RUNTIME_DIR"] = prev;
    }
  };
}

function readWorkloadAnnotations(path: string): Record<string, string> | undefined {
  const raw = parseYaml(readFileSync(path, "utf8")) as {
    metadata?: { annotations?: Record<string, string> };
  } | null;
  return raw?.metadata?.annotations;
}

type ServerStartCallbacks = Parameters<WorkloadClient["serverStart"]["subscribe"]>[1];

// Overrides only serverStart.subscribe for workload 'b': the attempt is
// recorded, a live entry stays in the state map (the process spawned but
// readiness never verified), then `script` drives the outcome on a
// microtask like the makeClient subscribe does.
function clientWithScriptedBStart(
  client: WorkloadClient,
  state: StateMap,
  starts: string[],
  script: (callbacks: ServerStartCallbacks) => void,
): WorkloadClient {
  return {
    ...client,
    serverStart: {
      ...client.serverStart,
      subscribe: (input, callbacks): ReturnType<WorkloadClient["serverStart"]["subscribe"]> => {
        if (input.workload !== "b") return client.serverStart.subscribe(input, callbacks);
        starts.push(input.workload);
        state.set("b", upEntry(8090));
        queueMicrotask(() => {
          script(callbacks);
        });
        return { unsubscribe: () => undefined };
      },
    },
  };
}

type ResidencyStore = ReturnType<typeof openResidencyOperationStore>;
type EvictionOperationStore = Pick<ResidencyOperationStore, "beginOperation" | "finishOperation">;

function openClaimedStore(path: string): { store: ResidencyStore; fenceToken: number } {
  const store = openResidencyOperationStore({ path });
  const fence = store.claimOwnership({ ownerId: "test-apply", incarnation: "inc-1" });
  return { store, fenceToken: fence.fenceToken };
}

function mkEvictionOperation<Store extends EvictionOperationStore>(
  store: Store,
  fenceToken: number,
  desiredRevision: number,
): Omit<EvictionOperationOpts, "store"> & { store: Store } {
  return {
    store,
    fenceToken,
    desiredRevision,
    nowMs: (): number => 1_000,
    operationIdFor: (victim: string): string => `op-${victim}`,
  };
}

function snapshotNonterminal(snapshot: ResidencyStoreSnapshot): ResidencyOperationRecord[] {
  if (!snapshot.present) return [];
  return "nonterminal" in snapshot ? snapshot.nonterminal : [];
}

test("E1 ModelRun eviction with a store begins evict:<victim> before the first stop and terminalizes it succeeded", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e1-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  let capturedNonterminal: ResidencyOperationRecord[] | undefined;
  const { client, stops, starts } = makeClient(state, {
    stop: (workload) => {
      if (workload === "a") {
        capturedNonterminal = snapshotNonterminal(readResidencyStoreSnapshot(storePath));
      }
      return undefined;
    },
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        workloadsDir: dir,
        getNodeBudgetGiB: () => 32,
        evictionOperation: mkEvictionOperation(store, fenceToken, 7),
      },
    );
    expect(capturedNonterminal).toHaveLength(1);
    const row = capturedNonterminal?.[0];
    expect(row?.operationId).toBe("op-a");
    expect(row?.model).toBe("evict:a");
    expect(row?.phase).toBe("pending");
    expect(row?.targetState).toBe("evicted-by:b");
    expect(row?.desiredRevision).toBe(7);
    expect(row?.reservationGiB).toBe(0);
    expect(result.error).toBeUndefined();
    expect(starts).toEqual(["b"]);
    expect(stops).toEqual(["a"]);
    const op = store.getOperation("op-a");
    expect(op?.phase).toBe("terminal");
    expect(op?.outcome).toBe("succeeded");
    expect(store.listNonterminal()).toEqual([]);
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// NON-RED regression guard: this case passes at the pinned base. With no
// evictionOperation option the apply must leave the claimed store
// untouched — no operation rows, terminal or not.
test("E1-guard NON-RED: apply without evictionOperation leaves the fenced store untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e1g-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { store } = openClaimedStore(storePath);
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.error).toBeUndefined();
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("b");
    expect(store.listNonterminal()).toEqual([]);
    expect(store.getOperation("op-a")).toBeNull();
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E2 a second eviction of a victim already held by a nonterminal store operation is refused with a typed reason and zero stops", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e2-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const { client, stops, starts } = makeClient(state);
  try {
    const seeded = store.beginOperation({
      fenceToken,
      operationId: "other-op",
      model: "evict:a",
      targetState: "evicted-by:c",
      desiredRevision: 7,
      reservationGiB: 0,
      nowMs: 1,
    });
    expect(seeded.ok).toBe(true);
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        workloadsDir: dir,
        getNodeBudgetGiB: () => 32,
        evictionOperation: mkEvictionOperation(store, fenceToken, 7),
      },
    );
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(result.error).toContain("EvictOperationRefused");
    expect(result.error).toContain("reservation-conflict");
    expect(result.statusSection.phase).toBe("Failed");
    const applied = result.statusSection.conditions.find((c) => c.type === "Applied");
    expect(applied?.reason).toBe("EvictOperationRefused");
    expect(state.has("a")).toBe(true);
    expect(
      readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"],
    ).toBeUndefined();
    expect(store.listNonterminal().map((r) => r.operationId)).toEqual(["other-op"]);
    expect(store.getOperation("op-a")).toBeNull();
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E3 a store refusal on any victim cancels the victims begun before it, before any stop", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e3-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([
    ["a", upEntry(8182)],
    ["c", upEntry(8183)],
  ]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  saveWorkload(mkManifest("c", { port: 8183 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const { client, stops, starts } = makeClient(state);
  try {
    const seeded = store.beginOperation({
      fenceToken,
      operationId: "other-op",
      model: "evict:c",
      targetState: "evicted-by:d",
      desiredRevision: 7,
      reservationGiB: 0,
      nowMs: 1,
    });
    expect(seeded.ok).toBe(true);
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a,c" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        workloadsDir: dir,
        getNodeBudgetGiB: () => 64,
        evictionOperation: mkEvictionOperation(store, fenceToken, 7),
      },
    );
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(result.error).toContain("EvictOperationRefused");
    expect(result.error).toContain("'c'");
    const opA = store.getOperation("op-a");
    expect(opA?.phase).toBe("terminal");
    expect(opA?.outcome).toBe("cancelled");
    expect(opA?.detail).toMatch(/^refused: /);
    expect(store.listNonterminal().map((r) => r.operationId)).toEqual(["other-op"]);
    expect(
      readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"],
    ).toBeUndefined();
    expect(
      readWorkloadAnnotations(join(dir, "c.yaml"))?.["llamactl.io/evicted-by"],
    ).toBeUndefined();
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E4 a crash after the stop leaves a recoverable nonterminal row", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e4-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const crashingStore: EvictionOperationStore = {
    beginOperation: (input) => store.beginOperation(input),
    finishOperation: () => {
      throw new Error("simulated crash before finish");
    },
  };
  const { client, stops, starts } = makeClient(state);
  let storeClosed = false;
  const closeStore = (): void => {
    if (!storeClosed) {
      storeClosed = true;
      store.close();
    }
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        workloadsDir: dir,
        getNodeBudgetGiB: () => 32,
        evictionOperation: mkEvictionOperation(crashingStore, fenceToken, 7),
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.statusSection.phase).toBe("Running");
    expect(starts).toEqual(["b"]);
    expect(stops).toEqual(["a"]);
    closeStore();
    const reopened = openResidencyOperationStore({ path: storePath });
    try {
      const rows = reopened.listNonterminal();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.model).toBe("evict:a");
      expect(rows[0]?.phase).toBe("pending");
      expect(rows[0]?.ownerId).toBe("test-apply");
      expect(rows[0]?.fenceToken).toBe(fenceToken);
    } finally {
      reopened.close();
    }
  } finally {
    closeStore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E5 a failed ModelRun replacement start whose teardown is verified terminalizes the operation as rolled back", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e5-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const { client, stops, starts } = makeClient(state, {
    start: (workload) => workload === "b",
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        workloadsDir: dir,
        getNodeBudgetGiB: () => 32,
        evictionOperation: mkEvictionOperation(store, fenceToken, 7),
      },
    );
    expect(result.statusSection.phase).toBe("Failed");
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    expect(
      readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"],
    ).toBeUndefined();
    const op = store.getOperation("op-a");
    expect(op?.phase).toBe("terminal");
    expect(op?.outcome).toBe("failed");
    expect(op?.detail).toMatch(/^rolled-back: /);
    expect(store.listNonterminal()).toEqual([]);
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E6 a ModelHost replacement records and rolls back its eviction operation", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e6-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  let hostBDown = false;
  const { client, stops, hostStarts } = makeClient(state, {
    hostStart: (workload) =>
      workload === "host-b" ? { ok: false, error: "readiness timeout" } : undefined,
    hostStatus: (workload) => {
      if (workload !== "host-b") return undefined;
      return hostBDown ? { state: "Stopped", pid: null } : { state: "Running", pid: 12345 };
    },
    hostStop: (workload) => {
      if (workload !== "host-b") return undefined;
      hostBDown = true;
      return { ok: true, pid: 12345 };
    },
  });
  const hostB = hostReplacement("host-b", "a", { ram: 8, binary: fakeBinary });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
      evictionOperation: mkEvictionOperation(store, fenceToken, 7),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(stops).toEqual(["a"]);
    expect(hostStarts).toEqual(["host-b"]);
    expect(outcome.error).toContain("released eviction intent on 'a'");
    const op = store.getOperation("op-a");
    expect(op?.phase).toBe("terminal");
    expect(op?.outcome).toBe("failed");
    expect(op?.detail).toMatch(/^rolled-back: /);
  } finally {
    restoreRuntimeDir();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E7 a stale desired revision is refused by the store before any stop", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e7-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const { client, stops, starts } = makeClient(state);
  try {
    const seeded = store.beginOperation({
      fenceToken,
      operationId: "seed",
      model: "unrelated",
      targetState: "x",
      desiredRevision: 9,
      reservationGiB: 0,
      nowMs: 1,
    });
    expect(seeded.ok).toBe(true);
    const finished = store.finishOperation({
      fenceToken,
      operationId: "seed",
      expectedVersion: 1,
      nowMs: 1,
      outcome: "succeeded",
    });
    expect(finished.ok).toBe(true);
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        workloadsDir: dir,
        getNodeBudgetGiB: () => 32,
        evictionOperation: mkEvictionOperation(store, fenceToken, 3),
      },
    );
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(result.error).toContain("EvictOperationRefused");
    expect(result.error).toContain("stale-revision");
    expect(result.statusSection.phase).toBe("Failed");
    expect(store.getOperation("op-a")).toBeNull();
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E8a an unverified ModelRun replacement teardown keeps the eviction operation nonterminal alongside the held marker", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e8a-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const { client, stops, starts } = makeClient(state, {
    stop: (workload) => (workload === "b" ? Promise.resolve({ stopped: false }) : undefined),
  });
  const wrapped = clientWithScriptedBStart(client, state, starts, (callbacks) => {
    callbacks.onData({
      type: "done",
      result: {
        ok: false,
        pid: 4321,
        error: "llama-server readiness check timed out after 60s",
      },
    });
    callbacks.onComplete();
  });
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 });
  try {
    const result = await applyOne(b, () => wrapped, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
      evictionOperation: mkEvictionOperation(store, fenceToken, 7),
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain("eviction intent on 'a' kept");
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("b");
    const op = store.getOperation("op-a");
    expect(op).not.toBeNull();
    expect(op?.phase).not.toBe("terminal");
    const rows = store.listNonterminal();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operationId).toBe("op-a");
    expect(rows[0]?.model).toBe("evict:a");
    expect(stops).toEqual(["a", "b"]);
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("E8b an unverified ModelHost replacement teardown keeps the eviction operation nonterminal alongside the held marker", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-e8b-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const storePath = join(tmp, "residency", "operations.sqlite");
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { store, fenceToken } = openClaimedStore(storePath);
  const { client, stops, hostStops, hostStarts } = makeClient(state, {
    hostStart: (workload) =>
      workload === "host-b" ? { ok: false, error: "readiness timeout" } : undefined,
    hostStatus: (workload) =>
      workload === "host-b" ? { state: "Running", pid: 12345 } : undefined,
  });
  const hostB = hostReplacement("host-b", "a", { ram: 8, binary: fakeBinary });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
      evictionOperation: mkEvictionOperation(store, fenceToken, 7),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(stops).toEqual(["a"]);
    expect(hostStarts).toEqual(["host-b"]);
    expect(hostStops).toContain("host-b");
    expect(outcome.error).toContain("eviction intent on 'a' kept");
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("host-b");
    const rows = store.listNonterminal();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operationId).toBe("op-a");
    expect(rows[0]?.model).toBe("evict:a");
    expect(rows[0]?.phase).not.toBe("terminal");
  } finally {
    restoreRuntimeDir();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
