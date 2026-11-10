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
