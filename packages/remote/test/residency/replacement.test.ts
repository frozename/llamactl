// DF-02 slices 2+3 (#275): verified eviction must persist the
// victim's evicted-by/evicted-at intent before the stop RPC, re-check
// capacity after the victim is released but before the replacement
// starts, and hold the reconcile tick's resurrection guard until the
// replacement lands (or the grace expires). Slice 2 pins that
// contract for ModelRun victims; slice 3 widens it to ModelHost
// victims and mixed-kind replacements — the markers become legal
// ModelHost metadata, the tick's guard holds a marked host by kind, a
// lapsed marker clears, and a live foreign hold refuses takeover.
// At the pinned base the ModelHost cases fail by assertion (the
// markers are not schema-legal, the stop RPC is never issued, and the
// reconciler has no host-side guard) while the slice-2 cases keep
// their existing verdicts.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ApplyEvent, ApplyResult, WorkloadClient } from "../../src/workload/apply.js";
import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { applyOne, applyOneModelHost } from "../../src/workload/apply.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import { reconcileOnce } from "../../src/workload/reconciler.js";
import { loadWorkloadByName, saveWorkload } from "../../src/workload/store.js";

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

function reportEvictedBy(report: unknown): unknown {
  return (report as { evictedBy?: unknown }).evictedBy;
}

// DF-02 slice 3 (#275): ModelHost victims. An un-annotated victim may go
// through saveModelHost; an annotated one is seeded as raw YAML by
// writeAnnotatedModelHost instead.
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

function writeAnnotatedModelHost(
  dir: string,
  name: string,
  annotations: Record<string, string>,
  overrides: HostOverrides = {},
): void {
  const manifest = mkModelHostManifest(name, overrides);
  writeFileSync(
    join(dir, `${name}.yaml`),
    stringifyYaml({ ...manifest, metadata: { name, annotations } }),
  );
}

function readWorkloadAnnotations(path: string): Record<string, string> | undefined {
  const raw = parseYaml(readFileSync(path, "utf8")) as {
    metadata?: { annotations?: Record<string, string> };
  } | null;
  return raw?.metadata?.annotations;
}

// DF-02 (#275): ModelHost replacements. The replacement is passed to
// applyOneModelHost as a typed manifest carrying llamactl.io/evict, which
// the ModelHost schema accepts (only force-admit is still refused). Hosts
// seeded on disk with annotations go through writeAnnotatedModelHost, which
// writes the YAML directly rather than through saveModelHost. The fake omlx
// binary satisfies validateSpec's existsSync check without touching PATH.
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

// reconcileOnce resolves the ModelHost runtime dir from process.env, so a
// host apply would otherwise write its sidecar wherever the ambient env
// points. Pin it into the test's temp dir for the duration of the pass.
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

// reconcileOnce sizes the `local` node's admission budget from an explicit
// NodeRun spec.budget.memoryGiB, falling back to 75% of the host's
// totalmem(). A test that expects the reconcile pass to restart an 8 GiB
// victim must pin that budget, or the verdict depends on the machine: a
// 7 GB macos-latest runner sizes ~5.25 GiB and refuses the restart, while
// a 16 GB ubuntu runner sizes 12 GiB and admits it.
function writeLocalNodeBudget(dir: string, memoryGiB: number): void {
  writeFileSync(
    join(dir, "local.yaml"),
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local" },
      spec: { node: "local", budget: { memoryGiB }, infra: [] },
    }),
  );
}

test("R1 intent persisted before stop and kept on success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r1-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  let captured: string | undefined;
  const { client, starts } = makeClient(state, {
    stop: (workload) => {
      if (workload === "a") {
        captured = loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"];
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
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(captured).toBe("b");
    expect(starts).toEqual(["b"]);
    expect(result.error).toBeUndefined();
    const storedA = loadWorkloadByName("a", dir);
    expect(storedA.metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    const evictedAt = storedA.metadata.annotations["llamactl.io/evicted-at"];
    expect(typeof evictedAt).toBe("string");
    expect(Number.isNaN(Date.parse(evictedAt ?? ""))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2 victim survives a reconcile tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r2-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 });
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(b, () => client, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 32,
    });
    saveWorkload({ ...b, status: result.statusSection }, dir);
    starts.length = 0;
    stops.length = 0;
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts).not.toContain("a");
    const reportA = tick.reports.find((r) => r.name === "a");
    expect(reportA).toBeDefined();
    expect(reportEvictedBy(reportA)).toBe("b");
    expect(reportA?.error).toBeUndefined();
    expect(state.has("a")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R3 already-down victim is suppressed too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r3-"));
  const state: StateMap = new Map();
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 });
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(b, () => client, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 32,
    });
    expect(starts).toEqual(["b"]);
    expect(stops).toEqual([]);
    saveWorkload({ ...b, status: result.statusSection }, dir);
    starts.length = 0;
    stops.length = 0;
    await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts).not.toContain("a");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4 one shared deadline per victim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r4-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { client, starts } = makeClient(state, {
    status: (workload, delegate) => {
      if (workload !== "a") return undefined;
      return new Promise<StatusReply>((resolve) => {
        setTimeout(() => {
          void delegate().then(resolve);
        }, 100);
      });
    },
    stop: (workload) =>
      workload === "a"
        ? new Promise((resolve) => {
            setTimeout(() => {
              state.delete("a");
              resolve({ stopped: true });
            }, 100);
          })
        : undefined,
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32, evictStopTimeoutMs: 150 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopTimedOut");
    expect(starts).toEqual([]);
    expect(result.statusSection.phase).toBe("Failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5 capacity re-check before start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r5-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const events: ApplyEvent[] = [];
  const { client, starts } = makeClient(state, {
    stop: (workload) => {
      if (workload === "a") {
        saveWorkload(mkManifest("c", { port: 8183, ram: 8 }), dir);
      }
      return undefined;
    },
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 }),
      () => client,
      (e) => {
        events.push(e);
      },
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 8 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictCapacityUnverified");
    expect(result.statusSection.phase).toBe("Failed");
    expect(starts).not.toContain("b");
    expect(events.some((e) => e.type === "evict-failed")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R6 stale marker is cleared and the victim applied normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r6-"));
  const state: StateMap = new Map();
  saveWorkload(
    mkManifest("a", { port: 8182, annotations: { "llamactl.io/evicted-by": "b" } }),
    dir,
  );
  saveWorkload(mkManifest("b", { enabled: false, port: 8090 }), dir);
  const { client, starts } = makeClient(state);
  try {
    await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    const aAfter = loadWorkloadByName("a", dir);
    expect(aAfter.metadata.annotations["llamactl.io/evicted-by"]).toBeUndefined();
    expect(starts.filter((s) => s === "a")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R7 replacement not yet saved still holds the victim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r7-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { client, starts } = makeClient(state);
  try {
    await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    starts.length = 0;
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts).not.toContain("a");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    const reportA = tick.reports.find((r) => r.name === "a");
    expect(reportA).toBeDefined();
    expect(reportEvictedBy(reportA)).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G1 failed replacement start releases the victim to budget-checked recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g1-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { client, stops, starts } = makeClient(state, {
    start: (workload) => workload === "b",
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toBeTruthy();
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    expect(
      loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"],
    ).toBeUndefined();
    await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts.filter((s) => s === "a")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2 repeated apply is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g2-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { client, stops, starts } = makeClient(state);
  const opts = { workloadsDir: dir, getNodeBudgetGiB: (): number => 32 };
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 });
  try {
    await applyOne(b, () => client, undefined, undefined, opts);
    starts.length = 0;
    stops.length = 0;
    const result = await applyOne(b, () => client, undefined, undefined, opts);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(result.action).toBe("unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G3 refused stop leaves no marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g3-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { client } = makeClient(state, {
    stop: (workload) => (workload === "a" ? Promise.resolve({ stopped: false }) : undefined),
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopRefused");
    expect(
      loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"],
    ).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G4 expired grace with missing replacement releases the victim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g4-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const { client, starts } = makeClient(state);
  try {
    await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    starts.length = 0;
    await reconcileOnce({
      workloadsDir: dir,
      getClient: () => client,
      now: () => new Date(Date.now() + 24 * 3600_000),
    });
    expect(
      loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"],
    ).toBeUndefined();
    expect(starts.filter((s) => s === "a")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R8 a same-tick eviction holds the victim for the rest of the pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r8-"));
  const state: StateMap = new Map([
    ["z", { rel: "z.gguf", args: [], host: "127.0.0.1", port: 8182 }],
  ]);
  saveWorkload(mkManifest("b", { annotations: { "llamactl.io/evict": "z" }, port: 8090 }), dir);
  saveWorkload(mkManifest("z", { port: 8182 }), dir);
  const { client, stops, starts } = makeClient(state);
  try {
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts).toEqual(["b"]);
    expect(stops).toEqual(["z"]);
    expect(state.has("b")).toBe(true);
    expect(state.has("z")).toBe(false);
    const reportZ = tick.reports.find((r) => r.name === "z");
    expect(reportZ).toBeDefined();
    expect(reportEvictedBy(reportZ)).toBe("b");
    expect(loadWorkloadByName("z", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G5 expired grace releases the victim once the replacement drops it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g5-"));
  const state: StateMap = new Map();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "b",
        "llamactl.io/evicted-at": "2020-01-01T00:00:00.000Z",
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("b", { annotations: { "llamactl.io/evict": "c" }, port: 8090 }), dir);
  const { client, starts } = makeClient(state);
  try {
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(
      loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"],
    ).toBeUndefined();
    expect(starts.filter((s) => s === "a")).toHaveLength(1);
    const reportA = tick.reports.find((r) => r.name === "a");
    expect(reportA).toBeDefined();
    expect(reportEvictedBy(reportA)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9 a live foreign eviction owner refuses the takeover and survives rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r9-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  const evictedAt = "2020-01-01T00:00:00.000Z";
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: { "llamactl.io/evicted-by": "c", "llamactl.io/evicted-at": evictedAt },
    }),
    dir,
  );
  saveWorkload(mkManifest("c", { annotations: { "llamactl.io/evict": "a" }, port: 8183 }), dir);
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictIntentHeld");
    expect(result.error).toContain("EvictIntentHeld");
    const storedA = loadWorkloadByName("a", dir);
    expect(storedA.metadata.annotations["llamactl.io/evicted-by"]).toBe("c");
    expect(storedA.metadata.annotations["llamactl.io/evicted-at"]).toBe(evictedAt);
    expect(state.has("a")).toBe(true);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10 a lapsed foreign eviction owner is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r10-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "c",
        "llamactl.io/evicted-at": "2020-01-01T00:00:00.000Z",
      },
    }),
    dir,
  );
  saveWorkload(
    mkManifest("c", { enabled: false, annotations: { "llamactl.io/evict": "a" }, port: 8183 }),
    dir,
  );
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
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G6 a failure before the eviction stage keeps the existing hold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g6-"));
  const state: StateMap = new Map([
    ["b", { rel: "b.gguf", args: [], host: "127.0.0.1", port: 8090 }],
  ]);
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "b",
        "llamactl.io/evicted-at": "2020-01-01T00:00:00.000Z",
      },
    }),
    dir,
  );
  saveWorkload(
    mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 }),
    dir,
  );
  saveWorkload(mkManifest("d", { port: 8183, ram: 8 }), dir);
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 10 },
    );
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.error).toContain("eviction");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R11 an apply exception releases only the markers it claimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r11-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  saveWorkload(
    mkManifest("d", {
      port: 8184,
      annotations: {
        "llamactl.io/evicted-by": "b",
        "llamactl.io/evicted-at": "2020-01-01T00:00:00.000Z",
      },
    }),
    dir,
  );
  const { client, stops, starts } = makeClient(state);
  try {
    let failure = "";
    try {
      await applyOne(
        mkManifest("b", { annotations: { "llamactl.io/evict": "a,d" }, port: 8090 }),
        () => client,
        (e) => {
          if (e.type === "stop" && e.message.includes("evicting a")) {
            throw new Error("injected evict-event failure");
          }
        },
        undefined,
        { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
      );
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure).toContain("injected evict-event failure");
    expect(
      loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"],
    ).toBeUndefined();
    const storedD = loadWorkloadByName("d", dir);
    expect(storedD.metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    expect(storedD.metadata.annotations["llamactl.io/evicted-at"]).toBe("2020-01-01T00:00:00.000Z");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(state.has("a")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R12 a self-owned eviction marker is reaffirmed across a re-apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r12-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  const evictedAt = new Date(Date.now() - 60_000).toISOString();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "b",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }), dir);
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
    expect(result.statusSection.phase).toBe("Running");
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    const storedA = loadWorkloadByName("a", dir);
    expect(storedA.metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    expect(storedA.metadata.annotations["llamactl.io/evicted-at"]).toBe(evictedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R13 a lapsed foreign owner that dropped the victim is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r13-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "c",
        "llamactl.io/evicted-at": "2020-01-01T00:00:00.000Z",
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("c", { annotations: { "llamactl.io/evict": "x" }, port: 8183 }), dir);
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
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R14 a fresh foreign marker with no owner manifest refuses the takeover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r14-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  const evictedAt = new Date().toISOString();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "ghost",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictIntentHeld");
    expect(result.error).toContain("EvictIntentHeld");
    const storedA = loadWorkloadByName("a", dir);
    expect(storedA.metadata.annotations["llamactl.io/evicted-by"]).toBe("ghost");
    expect(storedA.metadata.annotations["llamactl.io/evicted-at"]).toBe(evictedAt);
    expect(state.has("a")).toBe(true);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R15 a fresh foreign marker held by an enabled owner refuses the takeover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r15-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  const evictedAt = new Date().toISOString();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "c",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("c", { annotations: { "llamactl.io/evict": "x" }, port: 8183 }), dir);
  const { client, stops, starts } = makeClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictIntentHeld");
    expect(result.error).toContain("EvictIntentHeld");
    const storedA = loadWorkloadByName("a", dir);
    expect(storedA.metadata.annotations["llamactl.io/evicted-by"]).toBe("c");
    expect(storedA.metadata.annotations["llamactl.io/evicted-at"]).toBe(evictedAt);
    expect(state.has("a")).toBe(true);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R16 apply honours a non-default eviction grace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-r16-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  const evictedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "c",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("c", { annotations: { "llamactl.io/evict": "x" }, port: 8183 }), dir);
  const { client, stops, starts } = makeClient(state);
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 });
  try {
    const held = await applyOne(b, () => client, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 32,
    });
    expect(held.statusSection.conditions[0]?.reason).toBe("EvictIntentHeld");
    expect(held.error).toContain("EvictIntentHeld");
    starts.length = 0;
    stops.length = 0;
    const taken = await applyOne(b, () => client, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 32,
      evictionGraceMs: 5 * 60_000,
    });
    expect(taken.error).toBeUndefined();
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G7 rollback leaves a marker re-owned by another replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g7-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  const foreignAt = "2020-01-01T00:00:00.000Z";
  const { client, stops, starts } = makeClient(state, {
    stop: (workload) => {
      if (workload !== "a") return undefined;
      const victim = loadWorkloadByName("a", dir);
      saveWorkload(
        {
          ...victim,
          metadata: {
            ...victim.metadata,
            annotations: {
              ...victim.metadata.annotations,
              "llamactl.io/evicted-by": "c",
              "llamactl.io/evicted-at": foreignAt,
            },
          },
        },
        dir,
      );
      return undefined;
    },
    start: (workload) => workload === "b",
  });
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.error).toBeTruthy();
    expect(result.statusSection.phase).toBe("Failed");
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    const storedA = loadWorkloadByName("a", dir);
    expect(storedA.metadata.annotations["llamactl.io/evicted-by"]).toBe("c");
    expect(storedA.metadata.annotations["llamactl.io/evicted-at"]).toBe(foreignAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G8 the reconcile guard honours a marker stamped earlier in the pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g8-"));
  const state: StateMap = new Map();
  saveWorkload(
    mkManifest("z", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "ghost",
        "llamactl.io/evicted-at": "2020-01-01T00:00:00.000Z",
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("b", { annotations: { "llamactl.io/evict": "z" }, port: 8090 }), dir);
  const { client, starts } = makeClient(state);
  try {
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts).toContain("b");
    expect(starts).not.toContain("z");
    const reportZ = tick.reports.find((r) => r.name === "z");
    expect(reportZ).toBeDefined();
    expect(reportEvictedBy(reportZ)).toBe("b");
    const storedZ = loadWorkloadByName("z", dir);
    expect(storedZ.metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    expect(storedZ.metadata.annotations["llamactl.io/evicted-at"]).not.toBe(
      "2020-01-01T00:00:00.000Z",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G9 the reconcile pass shares its eviction grace with apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g9-"));
  const state: StateMap = new Map();
  const evictedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  saveWorkload(
    mkManifest("z", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "c",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  saveWorkload(mkManifest("c", { annotations: { "llamactl.io/evict": "x" }, port: 8183 }), dir);
  saveWorkload(mkManifest("b", { annotations: { "llamactl.io/evict": "z" }, port: 8090 }), dir);
  const { client, starts } = makeClient(state);
  try {
    const tick = await reconcileOnce({
      workloadsDir: dir,
      getClient: () => client,
      evictionGraceMs: 5 * 60_000,
    });
    const reportB = tick.reports.find((r) => r.name === "b");
    expect(reportB).toBeDefined();
    expect(reportB?.error).toBeUndefined();
    expect(starts).toContain("b");
    expect(loadWorkloadByName("z", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    const reportZ = tick.reports.find((r) => r.name === "z");
    expect(reportZ).toBeDefined();
    expect(reportEvictedBy(reportZ)).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G10 the reconcile guard honours an evicted-at stamped on disk mid-pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-g10-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182 }), dir);
  saveWorkload(mkManifest("z", { port: 8183 }), dir);
  const { client, starts } = makeClient(state, {
    status: (workload) => {
      if (workload !== "a") return undefined;
      const fresh = loadWorkloadByName("z", dir);
      saveWorkload(
        {
          ...fresh,
          metadata: {
            ...fresh.metadata,
            annotations: {
              ...fresh.metadata.annotations,
              "llamactl.io/evicted-by": "ghost",
              "llamactl.io/evicted-at": new Date().toISOString(),
            },
          },
        },
        dir,
      );
      return undefined;
    },
  });
  try {
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    expect(starts).not.toContain("z");
    const reportZ = tick.reports.find((r) => r.name === "z");
    expect(reportZ).toBeDefined();
    expect(reportZ?.error).toBeUndefined();
    expect(reportEvictedBy(reportZ)).toBe("ghost");
    const storedZ = loadWorkloadByName("z", dir);
    expect(storedZ.metadata.annotations["llamactl.io/evicted-by"]).toBe("ghost");
    expect(storedZ.metadata.annotations["llamactl.io/evicted-at"]).not.toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MK-R1 a mixed-kind replacement survives a reconcile tick", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mkr1-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = join(tmp, "omlx");
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  saveModelHost(mkModelHostManifest("victim", { binary: fakeBinary }), dir);
  let victimDown = false;
  const state: StateMap = new Map();
  const { client, stops, starts, hostStops, hostStarts } = makeClient(state, {
    hostStatus: (workload) => {
      if (workload !== "victim") return undefined;
      return victimDown ? { state: "Stopped", pid: null } : { state: "Running", pid: 4242 };
    },
    hostStop: (workload) => {
      if (workload !== "victim") return undefined;
      victimDown = true;
      return { ok: true, pid: 4242 };
    },
  });
  const incoming = mkManifest("incoming", {
    annotations: { "llamactl.io/evict": "victim" },
    port: 8090,
    ram: 8,
  });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const result = await applyOne(incoming, () => client, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 64,
    });
    saveWorkload({ ...incoming, status: result.statusSection }, dir);
    starts.length = 0;
    stops.length = 0;
    hostStops.length = 0;
    hostStarts.length = 0;
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    const reportVictim = tick.reports.find((r) => r.name === "victim");
    expect(reportVictim).toBeDefined();
    expect(reportVictim?.kind).toBe("ModelHost");
    expect(reportVictim?.action).toBe("unchanged");
    expect(reportEvictedBy(reportVictim)).toBe("incoming");
    expect(hostStarts).toEqual([]);
    expect(starts).not.toContain("incoming");
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MK-R2 a stale ModelHost marker is cleared", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mkr2-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = join(tmp, "omlx");
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  writeAnnotatedModelHost(
    dir,
    "victim",
    {
      "llamactl.io/evicted-by": "ghost-repl",
      "llamactl.io/evicted-at": "2000-01-01T00:00:00Z",
    },
    { binary: fakeBinary },
  );
  const state: StateMap = new Map();
  const { client } = makeClient(state);
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const tick = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
    const reportVictim = tick.reports.find((r) => r.name === "victim");
    expect(reportVictim).toBeDefined();
    expect(reportVictim?.kind).toBe("ModelHost");
    expect(reportEvictedBy(reportVictim)).toBeUndefined();
    const annotations = readWorkloadAnnotations(join(dir, "victim.yaml"));
    expect(annotations?.["llamactl.io/evicted-by"]).toBeUndefined();
    expect(annotations?.["llamactl.io/evicted-at"]).toBeUndefined();
    expect(annotations).toBeUndefined();
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MK-R3 a live foreign hold on a ModelHost victim is respected", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mkr3-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  writeAnnotatedModelHost(dir, "victim", {
    "llamactl.io/evicted-by": "other",
    "llamactl.io/evicted-at": new Date().toISOString(),
  });
  saveWorkload(
    mkManifest("other", {
      port: 8091,
      annotations: { "llamactl.io/evict": "victim" },
    }),
    dir,
  );
  const state: StateMap = new Map();
  const { client, hostStops, starts } = makeClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        annotations: { "llamactl.io/evict": "victim" },
        port: 8090,
        ram: 8,
      }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 64 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictIntentHeld");
    expect(hostStops).toEqual([]);
    expect(starts).toEqual([]);
    const annotations = readWorkloadAnnotations(join(dir, "victim.yaml"));
    expect(annotations?.["llamactl.io/evicted-by"]).toBe("other");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// DF-02 AC4 (#275): failed replacement readiness never leaves both
// or neither running silently — a readiness-failed start whose
// process may still be alive is torn down before the victim's
// eviction intent is released, a start-subscription error is
// reported rather than thrown, and an unverified replacement
// teardown keeps the victim held instead of releasing it.
type ServerStartCallbacks = Parameters<WorkloadClient["serverStart"]["subscribe"]>[1];

// Overrides only serverStart.subscribe for workload 'b': the attempt
// is recorded, a live entry stays in the state map (the process
// spawned but readiness never verified), then `script` drives the
// outcome on a microtask like the makeClient subscribe does. Every
// other verb keeps the shared fake's behaviour.
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

test("RB1 a readiness timeout that leaves the replacement alive is torn down before the victim is released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-rb1-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  writeLocalNodeBudget(dir, 8);
  const before = loadWorkloadByName("a", dir);
  const { client, stops, starts } = makeClient(state);
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
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain("readiness check timed out");
    expect(result.error).toContain("released eviction intent on 'a'");
    expect(stops).toEqual(["a", "b"]);
    expect(state.has("b")).toBe(false);
    expect(loadWorkloadByName("a", dir)).toEqual(before);
    expect(existsSync(join(dir, "b.yaml"))).toBe(false);
    starts.length = 0;
    await reconcileOnce({ workloadsDir: dir, getClient: () => wrapped });
    expect(starts.filter((s) => s === "a")).toHaveLength(1);
    expect([...state.keys()].sort()).toEqual(["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RB2 a readiness failure raised by the start subscription is reported, not thrown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-rb2-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const before = loadWorkloadByName("a", dir);
  const { client, starts } = makeClient(state);
  const wrapped = clientWithScriptedBStart(client, state, starts, (callbacks) => {
    callbacks.onError(new Error("readiness probe failed: connection reset"));
  });
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 });
  try {
    const outcome = await applyOne(b, () => wrapped, undefined, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
    }).catch((err: unknown) => err);
    expect(outcome).not.toBeInstanceOf(Error);
    const result = outcome as ApplyResult;
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain("readiness probe failed: connection reset");
    expect(result.error).toContain("released eviction intent on 'a'");
    expect(state.has("b")).toBe(false);
    expect(loadWorkloadByName("a", dir)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RB3 an unverified replacement teardown keeps the victim held instead of releasing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-df02-rb3-"));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  writeLocalNodeBudget(dir, 8);
  const { client, starts } = makeClient(state, {
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
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain(
      "replacement 'b' teardown after failed start unverified (refused to stop)",
    );
    expect(result.error).toContain("eviction intent on 'a' kept");
    expect(result.error).not.toContain("released eviction intent on 'a'");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
    starts.length = 0;
    await reconcileOnce({ workloadsDir: dir, getClient: () => wrapped });
    expect(starts).not.toContain("a");
    expect([...state.keys()].sort()).toEqual(["b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Drives a readiness-failed eviction start for 'b' (victim 'a') through
// `faults`, and returns the apply result plus the shared fake's state.
async function applyFailedReplacementWith(
  label: string,
  faults: (state: StateMap) => Faults,
): Promise<{ result: ApplyResult; state: StateMap; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `llamactl-df02-${label}-`));
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { client, starts } = makeClient(state, faults(state));
  const wrapped = clientWithScriptedBStart(client, state, starts, (callbacks) => {
    callbacks.onData({
      type: "done",
      result: { ok: false, pid: 4321, error: "llama-server readiness check timed out after 60s" },
    });
    callbacks.onComplete();
  });
  const b = mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 });
  const result = await applyOne(b, () => wrapped, undefined, undefined, {
    workloadsDir: dir,
    getNodeBudgetGiB: () => 8,
  });
  return { result, state, dir };
}

// Kills mutant P6 (dropping the post-stop 'still up after stop' check).
test("RB4 a stop that reports success while the replacement stays up keeps the victim held", async () => {
  const { result, state, dir } = await applyFailedReplacementWith(
    "rb4",
    (): Faults => ({
      // 'b' claims to stop but the state map keeps it up.
      stop: (workload) => (workload === "b" ? Promise.resolve({ stopped: true }) : undefined),
    }),
  );
  try {
    expect(result.statusSection.phase).toBe("Failed");
    expect(state.has("b")).toBe(true);
    expect(result.error).toContain(
      "replacement 'b' teardown after failed start unverified (still up after stop)",
    );
    expect(result.error).toContain("eviction intent on 'a' kept");
    expect(result.error).not.toContain("released eviction intent");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Kills mutant P7 (dropping the foreign-listener guard).
test("RB5 a foreign listener on the replacement is not stopped and keeps the victim held", async () => {
  const { result, state, dir } = await applyFailedReplacementWith(
    "rb5",
    (st): Faults => ({
      // Only once 'b' is recorded up (after its start) does it read foreign.
      status: (workload, delegate) =>
        workload === "b" && st.has("b")
          ? delegate().then((reply) => ({ ...reply, foreign: true }))
          : undefined,
    }),
  );
  try {
    expect(result.statusSection.phase).toBe("Failed");
    expect(state.has("b")).toBe(true);
    expect(result.error).toContain(
      "replacement 'b' teardown after failed start unverified (the recorded server is foreign to this workload)",
    );
    expect(result.error).toContain("eviction intent on 'a' kept");
    expect(result.error).not.toContain("released eviction intent");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Kills mutant P8 (the teardown catch returning null, so an RPC or
// deadline error would count as a verified teardown).
test("RB6 an RPC error during the replacement teardown keeps the victim held", async () => {
  const { result, dir } = await applyFailedReplacementWith(
    "rb6",
    (): Faults => ({
      stop: (workload) => (workload === "b" ? Promise.reject(new Error("rpc down")) : undefined),
    }),
  );
  try {
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain(
      "replacement 'b' teardown after failed start unverified (rpc down)",
    );
    expect(result.error).toContain("eviction intent on 'a' kept");
    expect(result.error).not.toContain("released eviction intent");
    expect(loadWorkloadByName("a", dir).metadata.annotations["llamactl.io/evicted-by"]).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// DF-02 (#275): ModelHost replacements. A ModelHost manifest carrying
// llamactl.io/evict follows the same verified-eviction contract a
// ModelRun replacement does — the victim's intent marker lands before
// its stop RPC, capacity is re-checked after release, and a failed
// replacement start tears the half-started host down before the
// markers are released or kept. Every case is wrapped in
// pinLocalRuntimeDir because applyOneModelHost / reconcileOnce reach
// readModelHostState and writeModelHostSidecar.
test("MH1 a ModelHost replacement evicts a running ModelRun victim, then starts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh1-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { client, stops, starts, hostStops, hostStarts, callLog } = makeClient(state);
  const hostB = hostReplacement("host-b", "a", { ram: 8, binary: fakeBinary });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
    });
    expect(outcome.ok).toBe(true);
    expect(stops).toEqual(["a"]);
    expect(hostStops).toEqual([]);
    expect(starts).toEqual([]);
    expect(hostStarts).toEqual(["host-b"]);
    expect(callLog.indexOf("stop:a")).toBeLessThan(callLog.indexOf("hostStart:host-b"));
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("host-b");
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH2 a ModelHost replacement evicts a running ModelHost victim, then starts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh2-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  saveModelHost(mkModelHostManifest("resident-host", { ram: 8, binary: fakeBinary }), dir);
  let victimDown = false;
  const state: StateMap = new Map();
  const { client, stops, starts, hostStops, hostStarts, callLog } = makeClient(state, {
    hostStatus: (workload) => {
      if (workload !== "resident-host") return undefined;
      return victimDown ? { state: "Stopped", pid: null } : { state: "Running", pid: 4242 };
    },
    hostStop: (workload) => {
      if (workload !== "resident-host") return undefined;
      victimDown = true;
      return { ok: true, pid: 4242 };
    },
  });
  const hostB = hostReplacement("host-b", "resident-host", {
    ram: 8,
    binary: fakeBinary,
  });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
    });
    expect(outcome.ok).toBe(true);
    expect(hostStops).toEqual(["resident-host"]);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(hostStarts).toEqual(["host-b"]);
    expect(callLog.indexOf("hostStop:resident-host")).toBeLessThan(
      callLog.indexOf("hostStart:host-b"),
    );
    expect(
      readWorkloadAnnotations(join(dir, "resident-host.yaml"))?.["llamactl.io/evicted-by"],
    ).toBe("host-b");
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH3 #677: a ModelHost replacement readiness failure whose teardown is unverified keeps the victim held", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh3-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
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
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("readiness timeout");
    expect(outcome.error).toContain("teardown after failed start unverified");
    expect(outcome.error).toContain("eviction intent on 'a' kept");
    expect(stops).toEqual(["a"]);
    expect(hostStarts).toEqual(["host-b"]);
    expect(hostStops).toContain("host-b");
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("host-b");
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH4 #677: a ModelHost replacement readiness failure with a verified teardown releases the victim", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh4-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  let hostBDown = false;
  const { client, stops, hostStops, hostStarts } = makeClient(state, {
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
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("readiness timeout");
    expect(outcome.error).toContain("released eviction intent on 'a'");
    expect(stops).toEqual(["a"]);
    expect(hostStarts).toEqual(["host-b"]);
    expect(hostStops).toContain("host-b");
    expect(
      readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"],
    ).toBeUndefined();
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH5 #678: a lease-fenced victim stop refuses the ModelHost replacement as EvictVictimBusy", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh5-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { client, stops, hostStarts } = makeClient(state, {
    stop: (workload) =>
      workload === "a"
        ? Promise.resolve({
            stopped: false,
            refused: { reason: "LeasesActive", active: ["r1"] },
          })
        : undefined,
  });
  const hostB = hostReplacement("host-b", "a", { ram: 8, binary: fakeBinary });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("(EvictVictimBusy)");
    expect(outcome.error).toContain("LeasesActive: r1");
    expect(outcome.error).toContain("replacement was not started");
    expect(stops).toEqual(["a"]);
    expect(hostStarts).toEqual([]);
    expect(
      readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"],
    ).toBeUndefined();
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH6 #671: an identity-unknown ModelRun victim blocks the ModelHost replacement before any stop", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh6-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
  const { client, stops, hostStarts } = makeClient(state, {
    status: (workload, delegate) =>
      workload === "a"
        ? delegate().then((reply) => ({ ...reply, identityUnknown: true }))
        : undefined,
  });
  const hostB = hostReplacement("host-b", "a", { ram: 8, binary: fakeBinary });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("EvictStatusUnknown");
    expect(stops).toEqual([]);
    expect(hostStarts).toEqual([]);
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH7 a ModelHost replacement holds its ModelRun victim across a reconcile tick past the grace", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh7-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  writeLocalNodeBudget(dir, 8);
  const evictedAt = new Date(Date.now() - 3600_000).toISOString();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "host-b",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  writeAnnotatedModelHost(dir, "host-b", { "llamactl.io/evict": "a" }, { binary: fakeBinary });
  const state: StateMap = new Map();
  const { client, starts } = makeClient(state);
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const tick = await reconcileOnce({
      workloadsDir: dir,
      getClient: () => client,
      evictionGraceMs: 1000,
    });
    expect(starts).not.toContain("a");
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("host-b");
    const reportA = tick.reports.find((r) => r.name === "a");
    expect(reportA).toBeDefined();
    expect(reportEvictedBy(reportA)).toBe("host-b");
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("MH8 an apply does not take over a hold owned by a live ModelHost replacement", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-df02-mh8-"));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  const evictedAt = new Date(Date.now() - 3600_000).toISOString();
  saveWorkload(
    mkManifest("a", {
      port: 8182,
      annotations: {
        "llamactl.io/evicted-by": "host-b",
        "llamactl.io/evicted-at": evictedAt,
      },
    }),
    dir,
  );
  writeAnnotatedModelHost(dir, "host-b", { "llamactl.io/evict": "a" }, { binary: fakeBinary });
  const state: StateMap = new Map();
  const { client, stops, starts } = makeClient(state);
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const result = await applyOne(
      mkManifest("c", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      { workloadsDir: dir, getNodeBudgetGiB: () => 32, evictionGraceMs: 1000 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictIntentHeld");
    expect(result.error).toContain("EvictIntentHeld");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(readWorkloadAnnotations(join(dir, "a.yaml"))?.["llamactl.io/evicted-by"]).toBe("host-b");
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// DF-02 (#275): ModelHost replacement eviction authorization. Each case
// seeds a victim that authorizeEvictTargets must refuse and pins that the
// refusal is final: no budget credit, no intent marker, no stop, no
// start. MH9 and MH10 kill a mutant that skips authorization (R1): the
// node-ownership and manifest-read checks run only in authorization. All
// three kill a mutant that ignores its refusal and treats every target as
// verified (R1b). MH11 covers the session refusal but cannot tell
// authorization from the pre-stop session re-check: its gate refuses only
// the first call, so with authorization skipped the re-check refuses
// instead, with the same error and before anything destructive.
async function applyRefusedHostReplacement(
  label: string,
  seed: (dir: string) => void,
  sessionGate?: NonNullable<Parameters<typeof applyOneModelHost>[3]>["sessionGate"],
): Promise<{
  outcome: Awaited<ReturnType<typeof applyOneModelHost>>;
  stops: string[];
  hostStops: string[];
  starts: string[];
  hostStarts: string[];
  victimAnnotations: Record<string, string> | undefined;
}> {
  const tmp = mkdtempSync(join(tmpdir(), `llamactl-df02-${label}-`));
  const dir = join(tmp, "workloads");
  mkdirSync(dir, { recursive: true });
  const fakeBinary = mkFakeOmlxBinary(tmp);
  seed(dir);
  const state: StateMap = new Map([["a", upEntry(8182)]]);
  const { client, stops, starts, hostStops, hostStarts } = makeClient(state);
  const hostB = hostReplacement("host-b", "a", { ram: 8, binary: fakeBinary });
  const restoreRuntimeDir = pinLocalRuntimeDir(join(tmp, "runtime"));
  try {
    const outcome = await applyOneModelHost(hostB, () => client, undefined, {
      workloadsDir: dir,
      getNodeBudgetGiB: () => 8,
      ...(sessionGate !== undefined ? { sessionGate } : {}),
    });
    const victimAnnotations = existsSync(join(dir, "a.yaml"))
      ? readWorkloadAnnotations(join(dir, "a.yaml"))
      : undefined;
    return { outcome, stops, hostStops, starts, hostStarts, victimAnnotations };
  } finally {
    restoreRuntimeDir();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("MH9 a ModelHost replacement refuses to evict a victim owned by a different node", async () => {
  const { outcome, stops, hostStops, starts, hostStarts, victimAnnotations } =
    await applyRefusedHostReplacement("mh9", (dir) => {
      saveWorkload(mkManifest("a", { port: 8182, ram: 8, node: "other-node" }), dir);
    });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error).toBe(
    "refusing to evict 'a': it is owned by node 'other-node', which is not verifiably the incoming manifest's node 'local'; no eviction, stop, or start was attempted",
  );
  expect(stops).toEqual([]);
  expect(hostStops).toEqual([]);
  expect(starts).toEqual([]);
  expect(hostStarts).toEqual([]);
  expect(victimAnnotations?.["llamactl.io/evicted-by"]).toBeUndefined();
  expect(victimAnnotations?.["llamactl.io/evicted-at"]).toBeUndefined();
});

test("MH10 a ModelHost replacement refuses to evict a victim whose manifest cannot be read", async () => {
  const { outcome, stops, hostStops, starts, hostStarts, victimAnnotations } =
    await applyRefusedHostReplacement("mh10", (dir) => {
      // Parses as YAML but fails the ModelRun schema: its kind cannot be confirmed.
      writeFileSync(
        join(dir, "a.yaml"),
        stringifyYaml({
          apiVersion: "llamactl/v1",
          kind: "ModelRun",
          metadata: { name: "a" },
          spec: { node: "local" },
        }),
      );
    });
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error).toStartWith(
    "refusing to evict 'a': it could not be read to confirm its kind (",
  );
  expect(outcome.error).toEndWith("; no eviction, stop, or start was attempted");
  expect(stops).toEqual([]);
  expect(hostStops).toEqual([]);
  expect(starts).toEqual([]);
  expect(hostStarts).toEqual([]);
  expect(victimAnnotations?.["llamactl.io/evicted-by"]).toBeUndefined();
  expect(victimAnnotations?.["llamactl.io/evicted-at"]).toBeUndefined();
});

test("MH11 a ModelHost replacement refuses to evict a victim with an active session at authorization", async () => {
  // The session is active when authorization checks it and gone by the
  // pre-stop re-check: authorization's refusal must stand on its own.
  const gateCalls: string[] = [];
  const sessionGate = {
    checkUnload: (workload: string): { ok: true } | { ok: false; sessions?: readonly string[] } => {
      gateCalls.push(workload);
      return gateCalls.length === 1 ? { ok: false, sessions: ["s1"] } : { ok: true };
    },
  };
  const { outcome, stops, hostStops, starts, hostStarts, victimAnnotations } =
    await applyRefusedHostReplacement(
      "mh11",
      (dir) => {
        saveWorkload(mkManifest("a", { port: 8182, ram: 8 }), dir);
      },
      sessionGate,
    );
  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error).toBe(
    "refusing to evict 'a': sessions s1 are still active; no eviction, stop, or start was attempted",
  );
  expect(gateCalls).toEqual(["a"]);
  expect(stops).toEqual([]);
  expect(hostStops).toEqual([]);
  expect(starts).toEqual([]);
  expect(hostStarts).toEqual([]);
  expect(victimAnnotations?.["llamactl.io/evicted-by"]).toBeUndefined();
  expect(victimAnnotations?.["llamactl.io/evicted-at"]).toBeUndefined();
});
