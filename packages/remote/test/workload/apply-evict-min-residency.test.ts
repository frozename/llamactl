// Part of #519: `apply --evict` / the `llamactl.io/evict` annotation honours
// NodeRun spec.residency.minResidencySeconds on both the ModelRun and the
// ModelHost replacement paths. A verified victim whose ready
// residency_states row is younger than the node's minimum is refused
// before any intent marker, stop or start; an unreadable readiness source
// fails closed with EvictMinResidencyUnknown. At the pinned base the evict
// pipeline has no min-residency check, so the refusal cases fail by
// assertion while the guard cases (disabled knob, no ready row, foreign
// serving node) already pass.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
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

  // Mutation pinned: dropping `row.state === "ready"` from the filter in
  // resolveEvictReadySinceMs (apply.ts) treats this fresh 'loading' row as
  // ready, so the eviction is refused EvictMinResidency and this fails.
  test("E9: a victim whose lifecycle row is not ready is evicted normally", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "local";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedLifecycle(storePath, "a", Date.now() - 10_000, ["downloaded", "loading"]);
      const snap = readResidencyStoreSnapshot(storePath);
      const rows = snap.present && !("error" in snap) ? (snap.lifecycle ?? []) : [];
      expect(rows.map((row) => [row.model, row.state])).toEqual([["a", "loading"]]);
      const result = await applyEvictingB(client, evictOpts(workloadsDir));
      expect(result.action).toBe("started");
      expect(stops).toEqual(["a"]);
      expect(starts).toEqual(["b"]);
    });
  });

  // Mutation pinned: deleting the `snap.lifecycleError` throw in
  // resolveEvictReadySinceMs (apply.ts) makes an unreadable lifecycle read
  // look like "no ready row", so the eviction proceeds and this fails.
  test("E10: a residency store whose lifecycle read fails refuses the eviction", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      process.env["LLAMACTL_NODE_NAME"] = "local";
      process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
      seedReadyLifecycle(storePath, "a", Date.now() - 10_000);
      // Keep the operations table intact but replace residency_states with a
      // table missing its columns, so only the lifecycle read fails.
      const db = new Database(storePath);
      try {
        db.run("DROP TABLE residency_states");
        db.run("CREATE TABLE residency_states (model TEXT PRIMARY KEY)");
      } finally {
        db.close();
      }
      const snap = readResidencyStoreSnapshot(storePath);
      expect(snap.present && !("error" in snap) && snap.lifecycleError !== undefined).toBe(true);
      const result = await applyEvictingB(client, evictOpts(workloadsDir));
      expect(result.action).toBe("pending");
      expect(result.statusSection.phase).toBe("Failed");
      expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidencyUnknown");
      expect(result.error).toMatch(/readiness could not be verified/);
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  // Mutation pinned: dropping `evictReadySinceMs: opts.evictReadySinceMs`
  // from applyModelRunManifest's applyOne options (apply.ts) loses the seam;
  // with no serving node set the default source reports no readiness, so the
  // eviction proceeds and this fails.
  test("E11: applyManifest forwards the readiness seam for a ModelRun", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const seamCalls: string[] = [];
      const outcome = await applyManifest({
        manifest: mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
        getClient: () => client,
        workloadsDir,
        getNodeBudgetGiB: () => 32,
        getNodeResidency: () => ({ minResidencySeconds: 3600 }),
        evictReadySinceMs: (workload: string) => {
          seamCalls.push(workload);
          return Date.now() - 10_000;
        },
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("under the node's minResidencySeconds of 3600");
      expect(seamCalls).toEqual(["a"]);
      expect(stops).toEqual([]);
      expect(starts).toEqual([]);
    });
  });

  // Mutation pinned (M14): dropping `row.model === target` from the filter in
  // resolveEvictReadySinceMs (apply.ts) lets another model's fresh ready row
  // ('c') stand in for the victim, so the eviction is refused
  // EvictMinResidency and this fails.
  test("E12: a fresh ready row for a different model does not gate the victim", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "residency-state", "operations.sqlite");
      try {
        process.env["LLAMACTL_NODE_NAME"] = "local";
        process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
        seedReadyLifecycle(storePath, "c", Date.now() - 10_000);
        const snap = readResidencyStoreSnapshot(storePath);
        const rows = snap.present && !("error" in snap) ? (snap.lifecycle ?? []) : [];
        expect(rows.map((row) => [row.model, row.state])).toEqual([["c", "ready"]]);
        const result = await applyEvictingB(client, evictOpts(workloadsDir));
        expect(result.action).toBe("started");
        expect(stops).toEqual(["a"]);
        expect(starts).toEqual(["b"]);
      } finally {
        Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
        Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_STORE");
      }
    });
  });

  // Mutation pinned (M15): changing `if (!snap.present) return null` in
  // resolveEvictReadySinceMs (apply.ts) to fail closed refuses this eviction
  // EvictMinResidencyUnknown even though the serving node simply has no
  // residency store yet, so this fails.
  test("E13: an absent residency store on the victim's serving node does not block eviction", async () => {
    await inTempDir(async (tmp) => {
      const { workloadsDir, client, stops, starts } = seedVictim(tmp);
      const storePath = join(tmp, "missing", "operations.sqlite");
      try {
        process.env["LLAMACTL_NODE_NAME"] = "local";
        process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
        expect(existsSync(storePath)).toBe(false);
        expect(readResidencyStoreSnapshot(storePath).present).toBe(false);
        const result = await applyEvictingB(client, evictOpts(workloadsDir));
        expect(result.action).toBe("started");
        expect(result.error).toBeUndefined();
        expect(stops).toEqual(["a"]);
        expect(starts).toEqual(["b"]);
      } finally {
        Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
        Reflect.deleteProperty(process.env, "LLAMACTL_RESIDENCY_STORE");
      }
    });
  });

  // Mutation pinned (M20): changing `ageMs < min * 1000` to `<=` in
  // checkEvictMinResidency (apply.ts) refuses a victim ready for exactly
  // minResidencySeconds, so this fails. The docs say "fewer than".
  test("E14: a victim ready for exactly minResidencySeconds is evicted", async () => {
    const FIXED_MS = Date.parse("2026-01-01T00:00:00.000Z");
    setSystemTime(new Date(FIXED_MS));
    try {
      await inTempDir(async (tmp) => {
        const { workloadsDir, client, stops, starts } = seedVictim(tmp);
        const result = await applyEvictingB(
          client,
          evictOpts(workloadsDir, () => FIXED_MS - 3_600_000),
        );
        expect(result.action).toBe("started");
        expect(stops).toEqual(["a"]);
        expect(starts).toEqual(["b"]);
      });
    } finally {
      setSystemTime();
    }
  });

  // Mutation pinned (M19): replacing `Math.min(readySinceMs, nowMs)` with
  // `readySinceMs` in checkEvictMinResidency (apply.ts) lets a future
  // ready-since produce a negative age, so the message reports -60s and
  // retry in 3660s and this fails.
  test("E15: a future ready-since timestamp is clamped to now", async () => {
    const FIXED_MS = Date.parse("2026-01-01T00:00:00.000Z");
    setSystemTime(new Date(FIXED_MS));
    try {
      await inTempDir(async (tmp) => {
        const { workloadsDir, client, stops, starts } = seedVictim(tmp);
        const result = await applyEvictingB(
          client,
          evictOpts(workloadsDir, () => FIXED_MS + 60_000),
        );
        expect(result.action).toBe("pending");
        expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
        expect(result.error).toContain(
          "it has been ready for 0s, under the node's minResidencySeconds of 3600; retry in 3600s",
        );
        expect(stops).toEqual([]);
        expect(starts).toEqual([]);
      });
    } finally {
      setSystemTime();
    }
  });

  // Kills, all at once: `ageMs < min * 1000` -> `ageMs < min * 1000 - 1000` (evicts at
  // 3599.999s); readyForS Math.floor -> Math.ceil (3600s); retryInS Math.ceil -> Math.floor
  // (0s); retryInS `min*1000 - ageMs` -> `+ ageMs` (7200s); retryInS -> String(min) (3600s);
  // readyForS -> "0".
  test("E16: a victim 1 ms short of minResidencySeconds is refused with exact ready/retry text", async () => {
    const FIXED_MS = Date.parse("2026-01-01T00:00:00.000Z");
    setSystemTime(new Date(FIXED_MS));
    try {
      await inTempDir(async (tmp) => {
        const { workloadsDir, client, stops, starts } = seedVictim(tmp);
        const result = await applyEvictingB(
          client,
          evictOpts(workloadsDir, () => FIXED_MS - 3_599_999),
        );
        expect(result.action).toBe("pending");
        expect(result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
        expect(result.error).toContain(
          "it has been ready for 3599s, under the node's minResidencySeconds of 3600; retry in 1s",
        );
        expect(stops).toEqual([]);
        expect(starts).toEqual([]);
      });
    } finally {
      setSystemTime();
    }
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
