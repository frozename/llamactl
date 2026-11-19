// Part of #519: `apply --evict` / the `llamactl.io/evict` annotation must
// honour the victim node's minResidencySeconds even when the apply runs on
// a serving node that is not the victim's. When LLAMACTL_NODE_NAME does
// not name the victim's node the readiness source is the victim node's
// residencyStatus procedure — its serving-process lifecycle section,
// prefetched once per apply — and an unavailable section or a rejected
// read fails closed with EvictMinResidencyUnknown, while a payload with no
// lifecycle section (an older agent) carries no readiness. At the pinned
// base apply.ts never calls residencyStatus, so every remote-readiness
// refusal fails by assertion.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  applyManifest,
  applyOne,
  applyOneModelHost,
  type ApplyResult,
  type WorkloadClient,
} from "../../src/workload/apply.js";
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

// The evictReadySinceMs seam on the evict options: the workload's
// ready-since timestamp in ms, or null when no ready lifecycle row exists.
type EvictReadySinceMs = (workload: string) => number | null;

function evictOpts(
  workloadsDir: string,
  evictReadySinceMs?: EvictReadySinceMs,
): Parameters<typeof applyOne>[4] {
  return {
    workloadsDir,
    getNodeBudgetGiB: () => 32,
    getNodeResidency: () => ({ minResidencySeconds: 3600 }),
    ...(evictReadySinceMs !== undefined ? { evictReadySinceMs } : {}),
  };
}

// The standard fixture: victim 'a' saved and up in the fake state, then
// 'b' applied with llamactl.io/evict: a on a distinct port.
function seedVictim(tmp: string): {
  workloadsDir: string;
  client: WorkloadClient;
  stops: string[];
  starts: string[];
} {
  const workloadsDir = join(tmp, "workloads");
  saveWorkload(mkManifest("a"), workloadsDir);
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  return { workloadsDir, client, stops, starts };
}

async function applyEvictingB(
  client: WorkloadClient,
  opts: Parameters<typeof applyOne>[4],
): Promise<ApplyResult> {
  return await applyOne(
    mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
    () => client,
    undefined,
    undefined,
    opts,
  );
}

async function inTempDir(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-evict-min-residency-"));
  try {
    await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

function mkModelHostManifest(name: string, evict: string, binary: string): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name, annotations: { "llamactl.io/evict": evict } },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary,
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

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

// Adds a recording residencyStatus.query to a WorkloadClient fake.
// WorkloadClient has no residencyStatus member at the pinned base, so the
// wrapper is built without a type annotation and cast — the cases fail by
// assertion on the missing remote read, never by a type error.
function withRemoteStatus(
  client: WorkloadClient,
  respond: (input: { node: string }) => Promise<unknown>,
): { client: WorkloadClient; calls: { node: string }[] } {
  const calls: { node: string }[] = [];
  const wrapped = {
    ...client,
    residencyStatus: {
      query: (input: { node: string }): Promise<unknown> => {
        calls.push(input);
        return respond(input);
      },
    },
  };
  return { client: wrapped as unknown as WorkloadClient, calls };
}

describe("#519 apply --evict minResidencySeconds on another node", () => {
  const RESIDENCY_ENV_KEYS = ["LLAMACTL_NODE_NAME", "LLAMACTL_RESIDENCY_STORE"] as const;
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

  // Mutation pinned: dropping the remote-readiness branch in
  // resolveEvictReadySinceMs or the prefetch in admitServerBudget reads no
  // victim-node lifecycle, so the foreign node's young 'a' is evicted
  // (action 'started') and this fails.
  test("X1: a foreign serving node is gated by the victim node's residencyStatus lifecycle", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "other";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 10_000 }]),
        ),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.phase).toBe("Failed");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
      expect(result.error).toMatch(
        /refusing to evict 'a': it has been ready for \d+s, under the node's minResidencySeconds of 3600; retry in \d+s; no eviction, stop, or start was attempted/,
      );
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
      expect(calls).toEqual([{ node: "local" }]);
    });
  });

  // Mutation pinned: always preferring the remote read over the serving
  // node's own store lets the stale remote row override the local young
  // row (phase 2 evicts), and skipping the remote read for an anonymous
  // serving node evicts the young victim (phase 1). Phase 1 fails at the
  // base, which never queries residencyStatus.
  test("X2: an anonymous serving node falls back to residencyStatus; the serving node's own store still wins", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 10_000 }]),
        ),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
      expect(calls).toHaveLength(1);
    });
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "local";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedReadyLifecycle(storePath, "a", Date.now() - 10_000);
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 7_200_000 }]),
        ),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
      expect(calls).toEqual([]);
    });
  });

  // Mutation pinned: dropping the `min <= 0` early return in the prefetch
  // queries residencyStatus on a disabled gate (phase 1), and never
  // querying leaves calls empty on an enabled gate (phase 2 fails at the
  // base on calls).
  test("X3: residencyStatus is queried only while the min-residency gate is enabled", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.reject(new Error("residencyStatus must not be queried while the gate is disabled")),
      );
      const result = await applyEvictingB(remote, {
        workloadsDir,
        getNodeBudgetGiB: () => 32,
        getNodeResidency: () => ({ minResidencySeconds: 0 }),
      });
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
      expect(calls).toEqual([]);
    });
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 7_200_000 }]),
        ),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
      expect(calls).toEqual([{ node: "local" }]);
    });
  });

  // Mutation pinned: treating an unavailable lifecycle section as "no
  // ready row" evicts blind instead of refusing EvictMinResidencyUnknown.
  test("X4: an unavailable remote lifecycle section refuses EvictMinResidencyUnknown", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote } = withRemoteStatus(client, () =>
        Promise.resolve({
          node: "local",
          lifecycle: {
            status: "unavailable",
            scope: "serving-process",
            reason: "LifecycleUnreadable",
          },
        }),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.phase).toBe("Failed");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidencyUnknown");
      expect(result.error).toContain("its residency readiness could not be verified");
      expect(result.error).toContain("LifecycleUnreadable");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  // Mutation pinned: swallowing the residencyStatus rejection as null
  // evicts blind instead of refusing EvictMinResidencyUnknown.
  test("X5: a rejected residencyStatus read refuses EvictMinResidencyUnknown", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote } = withRemoteStatus(client, () =>
        Promise.reject(new Error("agent unreachable")),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.phase).toBe("Failed");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidencyUnknown");
      expect(result.error).toContain("agent unreachable");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  // Mutation pinned: dropping the `state === 'ready'` filter or the
  // `model === target` match in the remote lifecycle mapping protects the
  // wrong rows; here 'a' is only 'loading' and 'zz' holds the ready row,
  // so the eviction must proceed. Fails at the base on calls.
  test("X6: only a ready remote row for the victim gates the eviction", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([
            { model: "a", state: "loading", updatedAtMs: Date.now() - 10_000 },
            { model: "zz", state: "ready", updatedAtMs: Date.now() - 10_000 },
          ]),
        ),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
      expect(calls).toHaveLength(1);
    });
  });

  // Mutation pinned: failing closed on a residencyStatus payload with no
  // lifecycle section (an older agent) refuses this eviction, and
  // consulting the remote before the explicit seam queries residencyStatus
  // despite the seam (phase 2 calls must stay empty). Phase 1 fails at the
  // base on calls.
  test("X7: a payload with no lifecycle section is unprotected, and the explicit seam wins", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve({ node: "local" }),
      );
      const result = await applyEvictingB(remote, evictOpts(workloadsDir));
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
      expect(calls).toHaveLength(1);
    });
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 10_000 }]),
        ),
      );
      const result = await applyEvictingB(
        remote,
        evictOpts(workloadsDir, () => null),
      );
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
      expect(calls).toEqual([]);
    });
  });

  // Mutation pinned: omitting the prefetch in convergeModelHostReplacement
  // reads no victim-node lifecycle on the ModelHost replacement path, so
  // the foreign node's young 'a' is evicted and host-b starts.
  test("X8: a ModelHost replacement is gated by the victim node's residencyStatus lifecycle", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-evict-min-residency-remote-m1-"));
    const prevRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
    process.env["LLAMACTL_NODE_NAME"] = "other";
    process.env["LLAMACTL_RESIDENCY_STORE"] = join(tmp, "residency-state", "operations.sqlite");
    try {
      const workloadsDir = join(tmp, "workloads");
      saveWorkload(mkManifest("a"), workloadsDir);
      const fakeBinary = join(tmp, "omlx");
      writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
      const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
      const { client: rec, stops, starts } = makeRecordingClient(state);
      const hostStops: string[] = [];
      const hostStarts: string[] = [];
      const client: WorkloadClient = {
        ...rec,
        modelHostStop: {
          mutate: (input): Promise<unknown> => {
            hostStops.push(input.workload);
            return rec.modelHostStop.mutate(input);
          },
        },
        modelHostStart: {
          subscribe: (input, callbacks): UnsubscribableLike => {
            hostStarts.push(input.workload);
            queueMicrotask(() => {
              callbacks.onData({
                type: "done",
                result: { ok: true, pid: 12345, state: "Running" },
              });
              callbacks.onComplete();
            });
            return { unsubscribe: () => undefined };
          },
        },
      };
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 10_000 }]),
        ),
      );
      const outcome = await applyOneModelHost(
        mkModelHostManifest("host-b", "a", fakeBinary),
        () => remote,
        undefined,
        {
          workloadsDir,
          getNodeBudgetGiB: () => 32,
          getNodeResidency: () => ({ minResidencySeconds: 3600 }),
        },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("under the node's minResidencySeconds of 3600");
      expect(hostStops).toEqual([]);
      expect(hostStarts).toEqual([]);
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
      expect(calls).toEqual([{ node: "local" }]);
    } finally {
      if (prevRuntimeDir === undefined) {
        Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
      } else {
        process.env["LOCAL_AI_RUNTIME_DIR"] = prevRuntimeDir;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Mutation pinned: applyManifest must carry the remote readiness read
  // into the ModelRun applyOne options — dropping the residencyStatus
  // path there evicts the foreign node's young 'a'.
  test("X9: applyManifest applies the remote min-residency gate to a ModelRun", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "other";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      const { client: remote, calls } = withRemoteStatus(client, () =>
        Promise.resolve(
          lifecycleOf([{ model: "a", state: "ready", updatedAtMs: Date.now() - 10_000 }]),
        ),
      );
      const outcome = await applyManifest({
        manifest: mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
        getClient: () => remote,
        workloadsDir,
        getNodeBudgetGiB: () => 32,
        getNodeResidency: () => ({ minResidencySeconds: 3600 }),
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toMatch(/EvictMinResidency|minResidencySeconds/);
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
      expect(calls).toEqual([{ node: "local" }]);
    });
  });
});
