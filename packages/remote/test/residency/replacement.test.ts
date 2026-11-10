// DF-02 slice 2 (#275): verified ModelRun eviction must persist the
// victim's evicted-by/evicted-at intent before the stop RPC, re-check
// capacity after the victim is released but before the replacement
// starts, and hold the reconcile tick's resurrection guard until the
// replacement lands (or the grace expires). These cases pin that
// contract; at the pinned base the marker is never written, capacity is
// never re-checked, and the reconciler restarts the victim on the next
// tick, so R1-R7 fail by assertion while G1-G4 stay green.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplyEvent, WorkloadClient } from "../../src/workload/apply.js";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { applyOne } from "../../src/workload/apply.js";
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
): { client: WorkloadClient; stops: string[]; starts: string[] } {
  const stops: string[] = [];
  const starts: string[] = [];
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
    modelHostStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
  return { client, stops, starts };
}

function upEntry(port: number): RecordedState {
  return { rel: "a.gguf", args: [], host: "127.0.0.1", port };
}

function reportEvictedBy(report: unknown): unknown {
  return (report as { evictedBy?: unknown }).evictedBy;
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
