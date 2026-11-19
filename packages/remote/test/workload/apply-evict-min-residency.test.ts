// Part of #519: `apply --evict` / the `llamactl.io/evict` annotation honours
// NodeRun spec.residency.minResidencySeconds on both the ModelRun and the
// ModelHost replacement paths. A verified victim whose ready
// residency_states row is younger than the node's minimum is refused
// before any intent marker, stop or start; an unreadable readiness source
// fails closed with EvictMinResidencyUnknown. At the pinned base the evict
// pipeline has no min-residency check, so the refusal cases fail by
// assertion while the guard cases (disabled knob, no ready row, foreign
// serving node) already pass.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
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

// The seam the fix adds to the evict options: the workload's ready-since
// timestamp in ms, or null when no ready lifecycle row exists. It is typed
// structurally and passed through a cast so this file typechecks on the
// base, where the option does not exist yet.
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
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({ ownerId: "seed", incarnation: "seed" });
    let expectedVersion = 0;
    for (const to of ["downloaded", "loading", "warming", "ready"] as const) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        to,
        expectedVersion,
        nowMs: readyAtMs,
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

describe("#519 apply --evict minResidencySeconds", () => {
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

  test("E1: a victim ready for less than minResidencySeconds is refused before any stop", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const result = await applyEvictingB(
        client,
        evictOpts(workloadsDir, () => Date.now() - 10_000),
      );
      expect(result.action).toBe("pending");
      expect(result.statusSection.phase).toBe("Failed");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
      expect(result.error).toMatch(
        /refusing to evict 'a': it has been ready for \d+s, under the node's minResidencySeconds of 3600; retry in \d+s; no eviction, stop, or start was attempted/,
      );
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  test("E2: the ready-age boundary is enforced in seconds, not milliseconds", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const result = await applyEvictingB(
        client,
        evictOpts(workloadsDir, () => Date.now() - 3_595_000),
      );
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const result = await applyEvictingB(
        client,
        evictOpts(workloadsDir, () => Date.now() - 3_605_000),
      );
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
  });

  test("E3: the readiness seam is not consulted while minResidencySeconds is disabled", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const seamCalls: string[] = [];
      const result = await applyEvictingB(client, {
        workloadsDir,
        getNodeBudgetGiB: () => 32,
        evictReadySinceMs: (workload: string) => {
          seamCalls.push(workload);
          return Date.now() - 10_000;
        },
      });
      expect(result.action).toBe("started");
      expect(seamCalls).toEqual([]);
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const seamCalls: string[] = [];
      const result = await applyEvictingB(client, {
        workloadsDir,
        getNodeBudgetGiB: () => 32,
        getNodeResidency: () => ({ minResidencySeconds: 0 }),
        evictReadySinceMs: (workload: string) => {
          seamCalls.push(workload);
          return Date.now() - 10_000;
        },
      });
      expect(result.action).toBe("started");
      expect(seamCalls).toEqual([]);
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
  });

  test("E4: a victim with no ready lifecycle row is evicted normally", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const result = await applyEvictingB(
        client,
        evictOpts(workloadsDir, () => null),
      );
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
  });

  test("E5: an unverifiable readiness read refuses the eviction", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const result = await applyEvictingB(
        client,
        evictOpts(workloadsDir, () => {
          throw new Error("boom");
        }),
      );
      expect(result.action).toBe("pending");
      expect(result.statusSection.phase).toBe("Failed");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidencyUnknown");
      expect(result.error).toMatch(/readiness could not be verified \(boom\)/);
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  test("E6: the default readiness source reads the serving node's residency store", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "local";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedReadyLifecycle(storePath, "a", Date.now() - 10_000);
      const result = await applyEvictingB(client, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  test("E7: a foreign or anonymous serving node does not apply its residency store", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedReadyLifecycle(storePath, "a", Date.now() - 10_000);
      const result = await applyEvictingB(client, evictOpts(workloadsDir));
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "other";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedReadyLifecycle(storePath, "a", Date.now() - 10_000);
      const result = await applyEvictingB(client, evictOpts(workloadsDir));
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
  });

  test("E8: an unreadable residency store refuses the eviction", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "operations.sqlite");
      writeFileSync(storePath, "not sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "local";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      expect("error" in readResidencyStoreSnapshot(storePath)).toBe(true);
      const result = await applyEvictingB(client, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidencyUnknown");
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  test("M1: a ModelHost replacement refuses to evict a victim younger than minResidencySeconds", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-evict-min-residency-m1-"));
    const prevRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
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
      const outcome = await applyOneModelHost(
        mkModelHostManifest("host-b", "a", fakeBinary),
        () => client,
        undefined,
        {
          workloadsDir,
          getNodeBudgetGiB: () => 32,
          getNodeResidency: () => ({ minResidencySeconds: 3600 }),
          evictReadySinceMs: () => Date.now() - 10_000,
        },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("under the node's minResidencySeconds of 3600");
      expect(stops).toEqual([]);
      expect(hostStops).toEqual([]);
      expect(hostStarts).toEqual([]);
      expect(starts).toEqual([]);
    } finally {
      if (prevRuntimeDir === undefined) {
        Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
      } else {
        process.env["LOCAL_AI_RUNTIME_DIR"] = prevRuntimeDir;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
