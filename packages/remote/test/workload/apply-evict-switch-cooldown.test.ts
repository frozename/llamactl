// Part of #519: `apply --evict` / the `llamactl.io/evict` annotation honours
// NodeRun spec.residency.switchCooldownSeconds on both the ModelRun and the
// ModelHost replacement paths. A victim on a node whose last succeeded
// profile switch is younger than the cooldown is refused before any intent
// marker, stop or start; an unreadable own-store or victim-node switch-gates
// section fails closed with EvictCooldownUnknown. At the pinned base the
// evict pipeline has no switch-cooldown check, so every refusal arm fails by
// assertion while the pass-through arms (disabled gate, exact boundary,
// absent store, missing/disabled/NotServingNode remote sections) already
// pass.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import {
  buildResidencyLifecycleSnapshot,
  buildSwitchGatesSnapshot,
} from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  applyOne,
  applyOneModelHost,
  type ApplyResult,
  type WorkloadClient,
} from "../../src/workload/apply.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
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

function evictOpts(workloadsDir: string): Parameters<typeof applyOne>[4] {
  return {
    workloadsDir,
    getNodeBudgetGiB: () => 32,
    getNodeResidency: () => ({ switchCooldownSeconds: 3600 }),
  };
}

function evictBothOpts(workloadsDir: string): Parameters<typeof applyOne>[4] {
  return {
    workloadsDir,
    getNodeBudgetGiB: () => 32,
    getNodeResidency: () => ({ minResidencySeconds: 3600, switchCooldownSeconds: 3600 }),
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
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-evict-switch-cooldown-"));
  try {
    await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function useTempBaseEnv(tmp: string): void {
  process.env["DEV_STORAGE"] = join(tmp, "dev-storage");
  Reflect.deleteProperty(process.env, "LLAMACTL_WORKLOADS_DIR");
}

// same-node: this process serves 'local' and its residency store is the
// victim node's store.
function useSameNode(tmp: string): string {
  useTempBaseEnv(tmp);
  const storePath = join(tmp, "ops.sqlite");
  process.env["LLAMACTL_NODE_NAME"] = "local";
  process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
  return storePath;
}

// foreign: this process serves another node; its own store path is absent
// and the victim node's residencyStatus is the only switch-gate source.
function useForeignNode(tmp: string): string {
  useTempBaseEnv(tmp);
  const storePath = join(tmp, "foreign-store", "ops.sqlite");
  process.env["LLAMACTL_NODE_NAME"] = "other";
  process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
  return storePath;
}

// anonymous-local: this process has no serving-node name, but a victim on
// the intrinsic 'local' node is still answered by this process's own store.
function useAnonymousLocal(tmp: string): string {
  useTempBaseEnv(tmp);
  const storePath = join(tmp, "ops.sqlite");
  Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
  process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
  return storePath;
}

// Walks a residency_states row unavailable -> downloaded -> loading ->
// warming -> ready, every hop stamped readyAtMs, so the ready row's
// updatedAtMs is the load time minResidencySeconds measures against.
function seedReadyLifecycle(storePath: string, model: string, readyAtMs: number): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({ ownerId: "seed-lifecycle", incarnation: "seed" });
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

function seedSwitchFor(path: string, node: string, atMs: number): void {
  const key = `profile-switch:${node}`;
  const operationId = `op-switch-${node}-${String(atMs)}`;
  const store = openResidencyOperationStore({ path });
  try {
    const fence = store.claimOwnership({ ownerId: "seed-switch", incarnation: "seed" });
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId,
      model: key,
      targetState: "profile:chat",
      desiredRevision: 0,
      reservationGiB: 0,
      nowMs: atMs,
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) {
      throw new Error(`seed switch begin failed: ${begun.reason}`);
    }
    const finished = store.finishOperation({
      fenceToken: fence.fenceToken,
      operationId,
      expectedVersion: begun.record.version,
      nowMs: atMs,
      outcome: "succeeded",
    });
    expect(finished).toEqual({ ok: true });
  } finally {
    store.close();
  }
  const snapshot = readResidencyStoreSnapshot(path);
  expect(snapshot.present).toBe(true);
  if (!snapshot.present || "error" in snapshot) {
    throw new Error(`expected a readable seeded switch store at ${path}`);
  }
  expect(snapshot.lastSucceededAtMs?.[key]).toBe(atMs);
}

function seedSwitch(path: string, atMs: number): void {
  seedSwitchFor(path, "local", atMs);
}

const agentStoreDirs: string[] = [];

function seededAgentStoreSnapshot(atMs: number): ResidencyStoreSnapshot {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-evict-switch-agent-"));
  agentStoreDirs.push(dir);
  const path = join(dir, "ops.sqlite");
  seedSwitch(path, atMs);
  return readResidencyStoreSnapshot(path);
}

// The exact switchGates section a correctly configured agent serving
// 'local' returns when its node-local store recorded a switch at atMs.
function agentGates(atMs: number): ReturnType<typeof buildSwitchGatesSnapshot> {
  return buildSwitchGatesSnapshot({
    residency: { switchCooldownSeconds: 3600 },
    servingNode: "local",
    node: "local",
    store: seededAgentStoreSnapshot(atMs),
    nowMs: Date.now(),
  });
}

function lifecyclePayload(): unknown {
  return {
    lifecycle: {
      status: "available",
      scope: "serving-process",
      workloads: [],
    },
  };
}

function payloadWithGates(switchGates: unknown): unknown {
  return {
    lifecycle: {
      status: "available",
      scope: "serving-process",
      workloads: [],
    },
    switchGates,
  };
}

// Adds a recording residencyStatus.query to a WorkloadClient fake. The
// payload is unknown so a pre-fix WorkloadClient type that does not yet
// model switchGates never turns these RED cases into type errors.
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

type ApplyRun = {
  result: ApplyResult;
  stops: string[];
  starts: string[];
};

type StoreSeed = (storePath: string, tmp: string) => void;
type OptsFor = (workloadsDir: string) => Parameters<typeof applyOne>[4];

async function runStoreBackedEvict(
  mode: "same-node" | "anonymous-local",
  seedStore: StoreSeed = () => undefined,
  makeOpts: OptsFor = evictOpts,
): Promise<ApplyRun> {
  let run: ApplyRun | undefined;
  await inTempDir(async (tmp) => {
    const fixture = seedVictim(tmp);
    const storePath = mode === "same-node" ? useSameNode(tmp) : useAnonymousLocal(tmp);
    seedStore(storePath, tmp);
    const result = await applyEvictingB(fixture.client, makeOpts(fixture.workloadsDir));
    run = { result, stops: fixture.stops, starts: fixture.starts };
  });
  if (run === undefined) {
    throw new Error("store-backed evict fixture did not run");
  }
  return run;
}

type ForeignApplyRun = ApplyRun & { calls: { node: string }[] };

async function runForeignEvict(
  respond: (input: { node: string }) => Promise<unknown>,
  makeOpts: OptsFor = evictOpts,
): Promise<ForeignApplyRun> {
  let run: ForeignApplyRun | undefined;
  await inTempDir(async (tmp) => {
    const fixture = seedVictim(tmp);
    useForeignNode(tmp);
    const { client: remote, calls } = withRemoteStatus(fixture.client, respond);
    const result = await applyEvictingB(remote, makeOpts(fixture.workloadsDir));
    run = { result, stops: fixture.stops, starts: fixture.starts, calls };
  });
  if (run === undefined) {
    throw new Error("foreign evict fixture did not run");
  }
  return run;
}

const COOLDOWN_ERROR_RE =
  /refusing to evict 'a': the node's last profile switch was \d+s ago, under the node's switchCooldownSeconds of 3600; retry in \d+s; no eviction, stop, or start was attempted/;

function expectCooldownRefusal(result: ApplyResult): void {
  expect(result.action).toBe("pending");
  expect(result.statusSection.phase).toBe("Failed");
  expect(result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
  expect(result.error).toMatch(COOLDOWN_ERROR_RE);
}

function expectPassThrough(run: ApplyRun): void {
  expect(run.result.action).toBe("started");
  expect(run.result.error).toBeUndefined();
  expect(run.stops).toEqual(["a"]);
  expect(run.starts).toEqual(["b"]);
}

function switchGatesOf(payload: unknown): { status?: string; reason?: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as { switchGates?: { status?: string; reason?: string } }).switchGates;
}

function seedNodeRunWithSwitchCooldown(workloadsDir: string): void {
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: {
        node: "local",
        budget: { memoryGiB: 24 },
        residency: { switchCooldownSeconds: 3600 },
        infra: [],
      },
    },
    workloadsDir,
  );
}

describe("#519 apply --evict switchCooldownSeconds", () => {
  const RESIDENCY_ENV_KEYS = [
    "LLAMACTL_NODE_NAME",
    "LLAMACTL_RESIDENCY_STORE",
    "LLAMACTL_WORKLOADS_DIR",
    "DEV_STORAGE",
  ] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of RESIDENCY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    setSystemTime();
    for (const key of RESIDENCY_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    while (agentStoreDirs.length > 0) {
      const dir = agentStoreDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  // kills: no checkEvictSwitchCooldown call in checkEvictTarget.
  test("C1: same-node evict is refused while the last profile switch is inside the cooldown", async () => {
    const run = await runStoreBackedEvict("same-node", (storePath) => {
      seedSwitch(storePath, Date.now() - 10_000);
    });
    expectCooldownRefusal(run.result);
    expect(run.stops).toEqual([]);
    expect(run.starts).toEqual([]);
  });

  // kills: ms/s confusion, or <= instead of <.
  test("C2: the switch-cooldown boundary is enforced in milliseconds with exact retry text", async () => {
    const fixedMs = Date.parse("2026-01-01T00:00:00.000Z");
    setSystemTime(new Date(fixedMs));
    const atBoundary = await runStoreBackedEvict("same-node", (storePath) => {
      seedSwitch(storePath, fixedMs - 3_600_000);
    });
    expectPassThrough(atBoundary);

    const oneMsShort = await runStoreBackedEvict("same-node", (storePath) => {
      seedSwitch(storePath, fixedMs - 3_599_999);
    });
    expect(oneMsShort.result.action).toBe("pending");
    expect(oneMsShort.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(oneMsShort.result.error).toContain("the node's last profile switch was 3599s ago");
    expect(oneMsShort.result.error).toContain("retry in 1s");
    expect(oneMsShort.stops).toEqual([]);
    expect(oneMsShort.starts).toEqual([]);
  });

  // kills: reading any profile-switch key, or the max over keys.
  test("C3: only the victim node's profile-switch key starts its evict cooldown", async () => {
    const otherKeys = await runStoreBackedEvict("same-node", (storePath) => {
      seedSwitchFor(storePath, "other", Date.now() - 10_000);
      seedSwitchFor(storePath, "local", Date.now() - 7_200_000);
    });
    expectPassThrough(otherKeys);

    const localKey = await runStoreBackedEvict("same-node", (storePath) => {
      seedSwitch(storePath, Date.now() - 10_000);
    });
    expect(localKey.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(localKey.stops).toEqual([]);
    expect(localKey.starts).toEqual([]);
  });

  // kills: dropping the `cooldown <= 0` early return for own-store evicts
  // (an unreadable store would then fail closed EvictCooldownUnknown).
  test("C4b: a disabled switch cooldown skips the unreadable own store for same-node and anonymous-local", async () => {
    const disabledResidencies: { label: string; residency: { switchCooldownSeconds?: number } }[] =
      [
        { label: "switchCooldownSeconds 0", residency: { switchCooldownSeconds: 0 } },
        { label: "no switchCooldownSeconds", residency: {} },
      ];
    for (const mode of ["same-node", "anonymous-local"] as const) {
      for (const { label, residency } of disabledResidencies) {
        const run = await runStoreBackedEvict(
          mode,
          (storePath) => {
            writeFileSync(storePath, "not sqlite");
            expect("error" in readResidencyStoreSnapshot(storePath)).toBe(true);
          },
          (workloadsDir) => ({
            workloadsDir,
            getNodeBudgetGiB: (): number => 32,
            getNodeResidency: (): { switchCooldownSeconds?: number } => residency,
          }),
        );
        const reasons = run.result.statusSection.conditions.map((c) => c.reason);
        expect({ mode, label, error: run.result.error }).toEqual({ mode, label, error: undefined });
        expect(reasons).not.toContain("EvictCooldownUnknown");
        expectPassThrough(run);
      }
    }

    const enabled = await runStoreBackedEvict("anonymous-local", (storePath) => {
      writeFileSync(storePath, "not sqlite");
    });
    expect(enabled.result.statusSection.conditions[0]?.reason).toBe("EvictCooldownUnknown");
    expect(enabled.stops).toEqual([]);
    expect(enabled.starts).toEqual([]);
  });

  // kills: swallowing store errors.
  test("C4:an unreadable same-node residency store fails closed EvictCooldownUnknown", async () => {
    const run = await runStoreBackedEvict("same-node", (storePath) => {
      writeFileSync(storePath, "not sqlite");
      expect("error" in readResidencyStoreSnapshot(storePath)).toBe(true);
    });
    expect(run.result.action).toBe("pending");
    expect(run.result.statusSection.phase).toBe("Failed");
    expect(run.result.statusSection.conditions[0]?.reason).toBe("EvictCooldownUnknown");
    expect(run.result.error).toContain("its node's last profile switch could not be verified (");
    expect(run.stops).toEqual([]);
    expect(run.starts).toEqual([]);
  });

  // kills: gating at 0, or reading when disabled.
  test("C5: switchCooldownSeconds 0 disables the foreign read and the gate", async () => {
    const disabled = await runForeignEvict(
      () => Promise.resolve(payloadWithGates(agentGates(Date.now() - 10_000))),
      (workloadsDir) => ({
        workloadsDir,
        getNodeBudgetGiB: (): number => 32,
        getNodeResidency: (): { switchCooldownSeconds: number } => ({ switchCooldownSeconds: 0 }),
      }),
    );
    expectPassThrough(disabled);
    expect(disabled.calls).toEqual([]);

    const enabled = await runForeignEvict(() =>
      Promise.resolve(payloadWithGates(agentGates(Date.now() - 10_000))),
    );
    expect(enabled.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(enabled.stops).toEqual([]);
    expect(enabled.starts).toEqual([]);
  });

  // kills: prefetch still skipped when minResidencySeconds is 0; ignoring the remote section.
  test("C6: a foreign victim is gated by the remote switchGates section even without min-residency", async () => {
    const switchAtMs = Date.now() - 10_000;
    const gates = agentGates(switchAtMs);
    expect(gates.status).toBe("available");
    if (gates.status !== "available") {
      throw new Error(`expected available agent gates, got ${gates.status}`);
    }
    expect(gates.lastSwitchAtMs).toBe(switchAtMs);

    const run = await runForeignEvict(() => Promise.resolve(payloadWithGates(gates)));
    expect(run.result.action).toBe("pending");
    expect(run.result.statusSection.phase).toBe("Failed");
    expect(run.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(run.stops).toEqual([]);
    expect(run.starts).toEqual([]);
    expect(run.calls).toEqual([{ node: "local" }]);
  });

  // kills: treating these unavailable reasons as no switch.
  test("C7: StoreUnreadable and LifecycleUnreadable remote switch gates fail closed", async () => {
    const storeUnreadable = await runForeignEvict(() =>
      Promise.resolve(
        payloadWithGates({
          status: "unavailable",
          scope: "serving-process",
          reason: "StoreUnreadable",
        }),
      ),
    );
    const lifecycleUnreadable = await runForeignEvict(() =>
      Promise.resolve(
        payloadWithGates({
          status: "unavailable",
          scope: "serving-process",
          reason: "LifecycleUnreadable",
        }),
      ),
    );

    for (const [run, reason] of [
      [storeUnreadable, "StoreUnreadable"],
      [lifecycleUnreadable, "LifecycleUnreadable"],
    ] as const) {
      expect(run.result.action).toBe("pending");
      expect(run.result.statusSection.conditions[0]?.reason).toBe("EvictCooldownUnknown");
      expect(run.result.error).toContain(`victim node switch gates unavailable (${reason})`);
      expect(run.stops).toEqual([]);
      expect(run.starts).toEqual([]);
    }
  });

  // kills: dropping the rejection/timeout fail-closed branches.
  test("C8: a rejected or timed-out foreign switch-gates read fails closed", async () => {
    const rejected = await runForeignEvict(() => Promise.reject(new Error("boom")));
    const timedOut = await runForeignEvict(
      () =>
        new Promise<unknown>(() => {
          // Never settles; the evict-read deadline must answer instead.
        }),
      (workloadsDir) => ({
        workloadsDir,
        getNodeBudgetGiB: (): number => 32,
        getNodeResidency: (): { switchCooldownSeconds: number } => ({
          switchCooldownSeconds: 3600,
        }),
        evictReadinessTimeoutMs: 20,
      }),
    );

    expect(rejected.result.action).toBe("pending");
    expect(rejected.result.statusSection.conditions[0]?.reason).toBe("EvictCooldownUnknown");
    expect(rejected.result.error).toContain("boom");
    expect(rejected.stops).toEqual([]);
    expect(rejected.starts).toEqual([]);

    expect(timedOut.result.action).toBe("pending");
    expect(timedOut.result.statusSection.conditions[0]?.reason).toBe("EvictCooldownUnknown");
    expect(timedOut.result.error).toContain("residencyStatus timed out after 20ms");
    expect(timedOut.stops).toEqual([]);
    expect(timedOut.starts).toEqual([]);
  });

  // kills: treating a missing or disabled section as unknown.
  test("C9: a missing or disabled remote switchGates section carries no cooldown", async () => {
    const missing = await runForeignEvict(() => Promise.resolve(lifecyclePayload()));
    expectPassThrough(missing);

    const disabled = await runForeignEvict(() =>
      Promise.resolve(payloadWithGates({ status: "disabled", scope: "serving-process" })),
    );
    expectPassThrough(disabled);

    const enabled = await runForeignEvict(() =>
      Promise.resolve(payloadWithGates(agentGates(Date.now() - 10_000))),
    );
    expect(enabled.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(enabled.stops).toEqual([]);
    expect(enabled.starts).toEqual([]);
  });

  // kills: one read per gate.
  test("C10: min-residency and switch-cooldown share one foreign residencyStatus prefetch", async () => {
    const run = await runForeignEvict(
      () => Promise.resolve(payloadWithGates(agentGates(Date.now() - 10_000))),
      evictBothOpts,
    );
    expect(run.result.action).toBe("pending");
    expect(run.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(run.stops).toEqual([]);
    expect(run.starts).toEqual([]);
    expect(run.calls).toEqual([{ node: "local" }]);
  });

  // precedence pin: min-residency is reported before switch-cooldown when both hold.
  test("C11: EvictMinResidency wins while both minimum residency and switch cooldown hold", async () => {
    const youngVictim = await runStoreBackedEvict(
      "same-node",
      (storePath) => {
        seedReadyLifecycle(storePath, "a", Date.now() - 10_000);
        seedSwitch(storePath, Date.now() - 10_000);
      },
      evictBothOpts,
    );
    expect(youngVictim.result.statusSection.conditions[0]?.reason).toBe("EvictMinResidency");
    expect(youngVictim.stops).toEqual([]);
    expect(youngVictim.starts).toEqual([]);

    const oldVictim = await runStoreBackedEvict(
      "same-node",
      (storePath) => {
        seedReadyLifecycle(storePath, "a", Date.now() - 7_200_000);
        seedSwitch(storePath, Date.now() - 10_000);
      },
      evictBothOpts,
    );
    expect(oldVictim.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(oldVictim.stops).toEqual([]);
    expect(oldVictim.starts).toEqual([]);
  });

  // kills: gate missing on the ModelHost replacement path.
  test("C12: a ModelHost replacement refuses to evict inside the switch cooldown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-evict-switch-cooldown-mh-"));
    const prevRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
    try {
      const workloadsDir = join(tmp, "workloads");
      saveWorkload(mkManifest("a"), workloadsDir);
      const storePath = useSameNode(tmp);
      seedSwitch(storePath, Date.now() - 10_000);
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
          getNodeResidency: () => ({ switchCooldownSeconds: 3600 }),
        },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain("switchCooldownSeconds of 3600");
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

  // kills: failing closed on an absent store.
  test("C13: an absent same-node store does not start a cooldown", async () => {
    const absent = await runStoreBackedEvict("same-node", (storePath) => {
      expect(existsSync(storePath)).toBe(false);
      expect(readResidencyStoreSnapshot(storePath).present).toBe(false);
    });
    expectPassThrough(absent);

    const seeded = await runStoreBackedEvict("same-node", (storePath) => {
      seedSwitch(storePath, Date.now() - 10_000);
    });
    expect(seeded.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(seeded.stops).toEqual([]);
    expect(seeded.starts).toEqual([]);
  });

  // kills: mapping NotServingNode to unknown for the in-process local client,
  // ignoring this process's own store when LLAMACTL_NODE_NAME is unset, and
  // prefetching when the own store answers.
  test("C14: anonymous-local uses this process's own local store without querying residencyStatus", async () => {
    const runArm = async (switchAtMs?: number): Promise<ForeignApplyRun & { direct: unknown }> => {
      let run: (ForeignApplyRun & { direct: unknown }) | undefined;
      await inTempDir(async (tmp) => {
        const fixture = seedVictim(tmp);
        const storePath = useAnonymousLocal(tmp);
        if (switchAtMs !== undefined) seedSwitch(storePath, switchAtMs);
        const respond = (input: { node: string }): Promise<unknown> => {
          void input;
          const snap = readResidencyStoreSnapshot(storePath);
          return Promise.resolve({
            lifecycle: buildResidencyLifecycleSnapshot(snap),
            switchGates: buildSwitchGatesSnapshot({
              residency: { switchCooldownSeconds: 3600 },
              servingNode: null,
              node: "local",
              store: snap,
              nowMs: Date.now(),
            }),
          });
        };
        const { client: remote, calls } = withRemoteStatus(fixture.client, respond);
        const direct = await respond({ node: "local" });
        const result = await applyEvictingB(remote, evictOpts(fixture.workloadsDir));
        run = { result, stops: fixture.stops, starts: fixture.starts, calls, direct };
      });
      if (run === undefined) {
        throw new Error("anonymous-local evict fixture did not run");
      }
      return run;
    };

    const noSwitch = await runArm();
    const directGates = switchGatesOf(noSwitch.direct);
    expect(directGates?.status).toBe("unavailable");
    expect(directGates?.reason).toBe("NotServingNode");
    expectPassThrough(noSwitch);
    expect(noSwitch.calls).toEqual([]);

    const recentSwitch = await runArm(Date.now() - 10_000);
    expect(recentSwitch.result.action).toBe("pending");
    expect(recentSwitch.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(recentSwitch.stops).toEqual([]);
    expect(recentSwitch.starts).toEqual([]);
    expect(recentSwitch.calls).toEqual([]);
  });

  // kills: failing closed on a remote NotServingNode, and reading NotServingNode as recent.
  test("C15: a remote NotServingNode switch-gates section records no profile switch", async () => {
    const switchAtMs = Date.now() - 10_000;
    const notServing = buildSwitchGatesSnapshot({
      residency: { switchCooldownSeconds: 3600 },
      servingNode: null,
      node: "local",
      store: seededAgentStoreSnapshot(switchAtMs),
      nowMs: Date.now(),
    });
    expect(notServing.status).toBe("unavailable");
    if (notServing.status !== "unavailable") {
      throw new Error(`expected unavailable NotServingNode gates, got ${notServing.status}`);
    }
    expect(notServing.reason).toBe("NotServingNode");

    const passThrough = await runForeignEvict(() => Promise.resolve(payloadWithGates(notServing)));
    expectPassThrough(passThrough);

    const enabled = await runForeignEvict(() =>
      Promise.resolve(payloadWithGates(agentGates(Date.now() - 10_000))),
    );
    expect(enabled.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(enabled.stops).toEqual([]);
    expect(enabled.starts).toEqual([]);
  });

  // kills: the in-process router shape not being accepted as the victim-node read.
  test("C16: the real in-process router can answer residencyStatus but anonymous-local still prefers its own store", async () => {
    type ResidencyStatusCaller = {
      residencyStatus: (input: { node: string }) => Promise<unknown>;
    };
    const runArm = async (switchAtMs?: number): Promise<ForeignApplyRun & { direct: unknown }> => {
      let run: (ForeignApplyRun & { direct: unknown }) | undefined;
      await inTempDir(async (tmp) => {
        const fixture = seedVictim(tmp);
        const storePath = useAnonymousLocal(tmp);
        process.env["LLAMACTL_WORKLOADS_DIR"] = fixture.workloadsDir;
        seedNodeRunWithSwitchCooldown(fixture.workloadsDir);
        if (switchAtMs !== undefined) seedSwitch(storePath, switchAtMs);
        const caller = router.createCaller({}) as unknown as ResidencyStatusCaller;
        const { client: remote, calls } = withRemoteStatus(fixture.client, (input) =>
          caller.residencyStatus(input),
        );
        const direct = await caller.residencyStatus({ node: "local" });
        const result = await applyEvictingB(remote, evictOpts(fixture.workloadsDir));
        run = { result, stops: fixture.stops, starts: fixture.starts, calls, direct };
      });
      if (run === undefined) {
        throw new Error("in-process router evict fixture did not run");
      }
      return run;
    };

    const noSwitch = await runArm();
    const directGates = switchGatesOf(noSwitch.direct);
    expect(directGates?.status).toBe("unavailable");
    expect(directGates?.reason).toBe("NotServingNode");
    expectPassThrough(noSwitch);
    expect(noSwitch.calls).toEqual([]);

    const recentSwitch = await runArm(Date.now() - 10_000);
    expect(recentSwitch.result.action).toBe("pending");
    expect(recentSwitch.result.statusSection.conditions[0]?.reason).toBe("EvictCooldown");
    expect(recentSwitch.stops).toEqual([]);
    expect(recentSwitch.starts).toEqual([]);
    expect(recentSwitch.calls).toEqual([]);
  });
});
