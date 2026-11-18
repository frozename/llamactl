import { readModelHostRuntimeStatus } from "@llamactl/core/engines/conditions";
import { resolveEnv } from "@llamactl/core/env";
// #519: the durable idle hold. idleEvictSeconds becomes operator-enforced:
// a wet `residency evict-idle` stamps llamactl.io/idle-evicted-at on the
// victim before the fenced stop, clears it on a verified stop, and leaves
// it on a refused/failed stop so the reconciler keeps the workload down.
// The reconciler therefore skips any enabled manifest carrying the
// annotation — reporting action "unchanged" with the stamped timestamp —
// while disabled manifests still take the ordinary disable path.
//
// At the pinned base none of IDLE_EVICTED_AT_ANNOTATION,
// stampIdleEvictionHold or clearIdleEvictionHold exist and the reconciler
// applies annotated manifests, so every case fails BY ASSERTION on
// structural probes — never by import or type error.
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ReconcileNodeReport } from "../../src/workload/reconciler.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { LOCAL_NODE_ID, type ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import { loadModelHostByName, saveModelHost } from "../../src/workload/modelhost-store.js";
import * as reconcilerModule from "../../src/workload/reconciler.js";
import { loadWorkloadByName, saveWorkload } from "../../src/workload/store.js";

const { reconcileOnce: reconcile } = reconcilerModule;

// The annotation key and helpers the fix adds; probed structurally so the
// file typechecks while they are absent.
const reconcilerRecord = reconcilerModule as unknown as Record<string, unknown>;
const IDLE_EVICTED_AT_ANNOTATION = reconcilerRecord["IDLE_EVICTED_AT_ANNOTATION"];

type StampIdleEvictionHold = (
  name: string,
  iso: string,
  dir: string,
) => "ModelRun" | "ModelHost" | null;
const stampIdleEvictionHold = reconcilerRecord["stampIdleEvictionHold"] as
  | StampIdleEvictionHold
  | undefined;

type ClearIdleEvictionHold = (name: string, dir: string) => "cleared" | "not-held" | "missing";
const clearIdleEvictionHold = reconcilerRecord["clearIdleEvictionHold"] as
  | ClearIdleEvictionHold
  | undefined;

// The stamped instant a wet run writes: 1_000_000_000 ms, the fixed test
// clock the #519 fixtures share.
const HELD_AT_ISO = "1970-01-12T13:46:40.000Z";
const HELD_AT_ANNOTATION = "llamactl.io/idle-evicted-at";

// The report row gains idleEvictedAt with the fix; the base report type
// predates the field, so expectations check this widened shape.
type IdleAwareReport = ReconcileNodeReport & { idleEvictedAt?: string };

function makeRunManifest(
  name: string,
  opts: {
    enabled?: boolean;
    restartPolicy?: "Always" | "OnFailure" | "Never";
    annotations?: Record<string, string>;
  } = {},
): ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name, labels: {}, annotations: opts.annotations ?? {} },
    spec: {
      node: "local",
      enabled: opts.enabled ?? true,
      target: { kind: "rel", value: `${name}.gguf` },
      extraArgs: [],
      workers: [],
      restartPolicy: opts.restartPolicy ?? "Always",
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

function makeHostManifest(
  name: string,
  opts: { enabled?: boolean; restartPolicy?: "Always" | "OnFailure" | "Never" } = {},
): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "llamacpp",
      node: LOCAL_NODE_ID,
      enabled: opts.enabled ?? true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs: [],
      restartPolicy: opts.restartPolicy ?? "Never",
      timeoutSeconds: 60,
    },
  };
}

function downServerStatus(
  state = "down",
): Awaited<ReturnType<WorkloadClient["serverStatus"]["query"]>> {
  return {
    state,
    rel: null,
    extraArgs: [],
    pid: null,
    host: null,
    port: null,
    binary: null,
    endpoint: "",
  };
}

/**
 * A WorkloadClient that records every RPC name so a held workload can be
 * proven to have touched nothing. Starts report an immediate successful
 * done so an unheld manifest converges to "started"/"restarted".
 */
function makeRecordingClient(calls: string[], serverState = "down"): WorkloadClient {
  return {
    serverStatus: {
      query: ({ workload }): ReturnType<WorkloadClient["serverStatus"]["query"]> => {
        calls.push(`serverStatus:${workload}`);
        return Promise.resolve(downServerStatus(serverState));
      },
    },
    serverStop: {
      mutate: ({ workload }): ReturnType<WorkloadClient["serverStop"]["mutate"]> => {
        calls.push(`serverStop:${workload}`);
        return Promise.resolve({ stopped: true });
      },
    },
    serverStart: {
      subscribe: (
        { workload },
        callbacks,
      ): ReturnType<WorkloadClient["serverStart"]["subscribe"]> => {
        calls.push(`serverStart:${workload}`);
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 111, endpoint: "http://127.0.0.1:18080" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStatus: {
      query: ({ workload }): ReturnType<WorkloadClient["modelHostStatus"]["query"]> => {
        calls.push(`modelHostStatus:${workload}`);
        return Promise.resolve({ state: "Stopped", pid: null });
      },
    },
    modelHostStop: {
      mutate: ({ workload }): ReturnType<WorkloadClient["modelHostStop"]["mutate"]> => {
        calls.push(`modelHostStop:${workload}`);
        return Promise.resolve({ stopped: true });
      },
    },
    modelHostStart: {
      subscribe: (
        { workload },
        callbacks,
      ): ReturnType<WorkloadClient["modelHostStart"]["subscribe"]> => {
        calls.push(`modelHostStart:${workload}`);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
    },
  };
}

function withRuntimeDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
  return fn().finally(() => {
    if (previous === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
    else process.env["LOCAL_AI_RUNTIME_DIR"] = previous;
  });
}

test("H1: the idle-hold exports exist with the pinned names", () => {
  // kills: a differently named annotation or helper signatures.
  expect(IDLE_EVICTED_AT_ANNOTATION).toBe("llamactl.io/idle-evicted-at");
  expect(typeof stampIdleEvictionHold).toBe("function");
  expect(typeof clearIdleEvictionHold).toBe("function");
});

test("H2: an enabled restartPolicy-Always ModelRun carrying the hold is skipped unchanged", async () => {
  // kills: dropping the ModelRun idle-hold guard (the base applies it).
  expect(typeof stampIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-hold-run-"));
  try {
    const manifest = makeRunManifest("held-run", {
      restartPolicy: "Always",
      annotations: { [HELD_AT_ANNOTATION]: HELD_AT_ISO, "example.com/keep": "yes" },
    });
    saveWorkload(manifest, dir);
    const calls: string[] = [];
    const result = await withRuntimeDir(dir, () =>
      reconcile({ workloadsDir: dir, getClient: () => makeRecordingClient(calls) }),
    );
    expect(result.errors).toBe(0);
    expect(result.reports as IdleAwareReport[]).toEqual([
      {
        kind: "ModelRun",
        name: "held-run",
        node: "local",
        action: "unchanged",
        idleEvictedAt: HELD_AT_ISO,
      },
    ]);
    expect(calls).toEqual([]);
    // The hold is durable: the on-disk manifest still carries the stamp.
    const onDisk = loadWorkloadByName("held-run", dir);
    expect(onDisk.metadata.annotations[HELD_AT_ANNOTATION]).toBe(HELD_AT_ISO);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H3: an enabled restartPolicy-Never ModelRun carrying the hold is skipped unchanged", async () => {
  // kills: applying the hold only to restartPolicy Always.
  expect(typeof stampIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-hold-never-"));
  try {
    saveWorkload(
      makeRunManifest("held-never", {
        restartPolicy: "Never",
        annotations: { [HELD_AT_ANNOTATION]: HELD_AT_ISO },
      }),
      dir,
    );
    const calls: string[] = [];
    const result = await withRuntimeDir(dir, () =>
      reconcile({ workloadsDir: dir, getClient: () => makeRecordingClient(calls) }),
    );
    expect(result.errors).toBe(0);
    expect(result.reports as IdleAwareReport[]).toEqual([
      {
        kind: "ModelRun",
        name: "held-never",
        node: "local",
        action: "unchanged",
        idleEvictedAt: HELD_AT_ISO,
      },
    ]);
    expect(calls).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H4: a disabled ModelRun carrying the hold still takes the disable path", async () => {
  // kills: holding disabled manifests — enabled:false must keep running the
  // ordinary stopDisabledWorkload path and report no idleEvictedAt.
  expect(typeof stampIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-hold-disabled-"));
  try {
    saveWorkload(
      makeRunManifest("held-disabled", {
        enabled: false,
        annotations: { [HELD_AT_ANNOTATION]: HELD_AT_ISO },
      }),
      dir,
    );
    const calls: string[] = [];
    const result = await withRuntimeDir(dir, () =>
      reconcile({
        workloadsDir: dir,
        getClient: () => makeRecordingClient(calls, "up"),
      }),
    );
    expect(result.reports as IdleAwareReport[]).toEqual([
      { kind: "ModelRun", name: "held-disabled", node: "local", action: "unchanged" },
    ]);
    expect(calls).toContain("serverStatus:held-disabled");
    expect(calls).toContain("serverStop:held-disabled");
    expect(calls).not.toContain("serverStart:held-disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H5: an enabled local restartPolicy-Never ModelHost carrying the hold is skipped unchanged", async () => {
  // kills: guarding only ModelRuns — a held ModelHost must not be queried,
  // started or have controller history written for it.
  expect(typeof stampIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-hold-host-"));
  try {
    const manifest: ModelHostManifest = {
      ...makeHostManifest("held-host", { restartPolicy: "Never" }),
      metadata: {
        name: "held-host",
        annotations: { [HELD_AT_ANNOTATION]: HELD_AT_ISO },
      },
    };
    saveModelHost(manifest, dir);
    const calls: string[] = [];
    const result = await withRuntimeDir(dir, () =>
      reconcile({ workloadsDir: dir, getClient: () => makeRecordingClient(calls) }),
    );
    expect(result.errors).toBe(0);
    expect(result.reports as IdleAwareReport[]).toEqual([
      {
        kind: "ModelHost",
        name: "held-host",
        node: "local",
        action: "unchanged",
        idleEvictedAt: HELD_AT_ISO,
      },
    ]);
    expect(calls).toEqual([]);
    // No controller-history/conditions write for the held host.
    const status = readModelHostRuntimeStatus(
      { name: "held-host" },
      resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }),
    );
    expect(status).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H6a: stampIdleEvictionHold stamps ModelRun and ModelHost manifests and preserves other annotations", () => {
  // kills: a stamp that drops existing annotations or returns the wrong kind.
  expect(typeof stampIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-stamp-"));
  try {
    saveWorkload(makeRunManifest("stamp-run", { annotations: { "example.com/keep": "yes" } }), dir);
    saveModelHost(
      {
        ...makeHostManifest("stamp-host"),
        metadata: { name: "stamp-host", annotations: { "example.com/host": "yes" } },
      },
      dir,
    );

    expect(stampIdleEvictionHold!("stamp-run", HELD_AT_ISO, dir)).toBe("ModelRun");
    const run = loadWorkloadByName("stamp-run", dir);
    expect(run.metadata.annotations[HELD_AT_ANNOTATION]).toBe(HELD_AT_ISO);
    expect(run.metadata.annotations["example.com/keep"]).toBe("yes");

    expect(stampIdleEvictionHold!("stamp-host", HELD_AT_ISO, dir)).toBe("ModelHost");
    const host = loadModelHostByName("stamp-host", dir);
    expect(host.metadata.annotations?.[HELD_AT_ANNOTATION]).toBe(HELD_AT_ISO);
    expect(host.metadata.annotations?.["example.com/host"]).toBe("yes");

    expect(stampIdleEvictionHold!("no-such-workload", HELD_AT_ISO, dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H6b: stampIdleEvictionHold on an unknown name creates no file", () => {
  expect(typeof stampIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-stamp-missing-"));
  try {
    expect(stampIdleEvictionHold!("ghost", HELD_AT_ISO, dir)).toBeNull();
    expect(() => loadWorkloadByName("ghost", dir)).toThrow();
    expect(() => loadModelHostByName("ghost", dir)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H6c: clearIdleEvictionHold clears once, reports not-held, and reports missing", () => {
  // kills: a clear that removes the wrong annotation or cannot distinguish
  // held / not-held / absent manifests.
  expect(typeof clearIdleEvictionHold).toBe("function");
  const dir = mkdtempSync(join(tmpdir(), "llamactl-idle-clear-"));
  try {
    saveWorkload(
      makeRunManifest("clear-run", {
        annotations: { [HELD_AT_ANNOTATION]: HELD_AT_ISO, "example.com/keep": "yes" },
      }),
      dir,
    );
    saveModelHost(
      {
        ...makeHostManifest("clear-host"),
        metadata: { name: "clear-host", annotations: { [HELD_AT_ANNOTATION]: HELD_AT_ISO } },
      },
      dir,
    );

    expect(clearIdleEvictionHold!("clear-run", dir)).toBe("cleared");
    const run = loadWorkloadByName("clear-run", dir);
    expect(run.metadata.annotations[HELD_AT_ANNOTATION]).toBeUndefined();
    expect(run.metadata.annotations["example.com/keep"]).toBe("yes");
    expect(clearIdleEvictionHold!("clear-run", dir)).toBe("not-held");

    expect(clearIdleEvictionHold!("clear-host", dir)).toBe("cleared");
    const host = loadModelHostByName("clear-host", dir);
    // With no other annotations the key is dropped entirely.
    expect(host.metadata.annotations).toBeUndefined();

    expect(clearIdleEvictionHold!("ghost", dir)).toBe("missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
