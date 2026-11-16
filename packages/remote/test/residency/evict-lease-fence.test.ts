/**
 * #278 (DF-05) — applyOne's verified-eviction teardown must classify the
 * residency lease fence's stop refusal as EvictVictimBusy instead of the
 * generic EvictStopRefused: a held lease (LeasesActive) or an in-progress
 * drain (DrainInProgress) on the victim refuses the fenced
 * serverStop/modelHostStop, the apply fails pending with the lease detail
 * surfaced in the error and the evict-failed event, the evicted-by marker
 * rolls back, and a retry after the lease drains completes the eviction
 * and parks the victim unloaded at the advanced epoch. The stop mutations
 * route through the real router procedures so the #613 fence decides;
 * status probes and starts are faked — no processes, no network, no
 * sleeps. Each busy case fails by assertion at base 1b83685: the condition
 * reason is EvictStopRefused and the ModelRun detail is the bare
 * "refused to stop". The mid-string LeasesActive case is a negative guard
 * (it must stay EvictStopRefused) and the non-string active case injects
 * a malformed refusal; both pin the classifier's edges against mutants.
 */
import {
  createResidencyLeases,
  type Lease,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { router } from "../../src/router.js";
import { mkdirSync } from "../../src/safe-fs.js";
import { type ApplyEvent, applyOne, type WorkloadClient } from "../../src/workload/apply.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import { loadWorkloadByNameAny, saveWorkload } from "../../src/workload/store.js";

type ServerStopOutcome = {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
  refused?: { reason: string; active: string[] };
};

type ModelHostStopOutcome = {
  ok: boolean;
  pid: number | null;
  error?: string;
};

type LeaseStopCaller = {
  serverStop: (input: { workload: string; graceSeconds?: number }) => Promise<ServerStopOutcome>;
  modelHostStop: (input: {
    workload: string;
    graceSeconds?: number;
  }) => Promise<ModelHostStopOutcome>;
};

type EvictVictimSpec = {
  name: string;
  kind: "ModelRun" | "ModelHost";
  rel: string;
  port: number;
};

type EvictClientRig = {
  client: WorkloadClient;
  starts: string[];
  serverStops: { workload: string; result: ServerStopOutcome }[];
  modelHostStops: { workload: string; result: ModelHostStopOutcome }[];
  serverStatusCalls: Map<string, number>;
  modelHostStatusCalls: Map<string, number>;
  readonly victimDown: boolean;
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

function mkModelHostManifest(
  name: string,
  overrides: Partial<ModelHostManifest["spec"]> = {},
): ModelHostManifest {
  return {
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
      ...overrides,
    },
  };
}

function makeEventRecorder(): {
  events: { type: string; message: string }[];
  onEvent: (event: ApplyEvent) => void;
} {
  const events: { type: string; message: string }[] = [];
  return {
    events,
    onEvent: (event: ApplyEvent): void => {
      events.push({ type: event.type, message: event.message });
    },
  };
}

function acquireHeldLease(reg: ResidencyLeases, workload: string): Lease {
  const acquired = reg.acquire(workload);
  if (!acquired.ok) {
    throw new Error(`expected lease acquire to succeed for '${workload}'`);
  }
  return acquired.lease;
}

function idleLiveSession(sessions: SessionRefcounts, id: string, workload: string): void {
  const acquired = sessions.acquire(id, workload);
  if (!acquired.ok) {
    throw new Error(`session acquire(${id} on ${workload}) refused`);
  }
  sessions.release(id, acquired.generation);
}

/**
 * Hybrid WorkloadClient for the evict-lease fence: status queries are
 * scripted per workload (the victim reports up until its fenced stop
 * verifies), while serverStop/modelHostStop route through the real
 * router.createCaller procedures so the #613 lease fence decides. A
 * verified stop flips victimDown; a refused result never does. Any stop
 * aimed at a workload other than the victim throws.
 */
function makeEvictClient(
  victim: EvictVictimSpec,
  hooks?: { onVictimStatus?: () => void },
): EvictClientRig {
  const caller = router.createCaller({}) as unknown as LeaseStopCaller;
  const state = { victimDown: false };
  const starts: string[] = [];
  const serverStops: EvictClientRig["serverStops"] = [];
  const modelHostStops: EvictClientRig["modelHostStops"] = [];
  const serverStatusCalls = new Map<string, number>();
  const modelHostStatusCalls = new Map<string, number>();
  const count = (calls: Map<string, number>, workload: string): void => {
    calls.set(workload, (calls.get(workload) ?? 0) + 1);
  };

  const client: WorkloadClient = {
    serverStatus: {
      query: (input): ReturnType<WorkloadClient["serverStatus"]["query"]> => {
        if (input.workload === victim.name) hooks?.onVictimStatus?.();
        count(serverStatusCalls, input.workload);
        if (victim.kind === "ModelRun" && input.workload === victim.name && !state.victimDown) {
          return Promise.resolve({
            state: "up",
            rel: victim.rel,
            extraArgs: [],
            pid: 4242,
            host: "127.0.0.1",
            port: victim.port,
            binary: null,
            endpoint: `http://127.0.0.1:${String(victim.port)}`,
            foreign: false,
          });
        }
        return Promise.resolve({
          state: "down",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        });
      },
    },
    serverStop: {
      mutate: async (input): Promise<unknown> => {
        if (victim.kind !== "ModelRun" || input.workload !== victim.name) {
          throw new Error(`unexpected serverStop for '${input.workload}'`);
        }
        const result = await caller.serverStop({
          workload: input.workload,
          ...(input.graceSeconds !== undefined ? { graceSeconds: input.graceSeconds } : {}),
        });
        serverStops.push({ workload: input.workload, result });
        if (result.stopped) state.victimDown = true;
        return result;
      },
    },
    serverStart: {
      subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
        starts.push(input.workload);
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
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
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
    modelHostStop: {
      mutate: async (input): Promise<unknown> => {
        if (victim.kind !== "ModelHost" || input.workload !== victim.name) {
          throw new Error(`unexpected modelHostStop for '${input.workload}'`);
        }
        const result = await caller.modelHostStop({
          workload: input.workload,
          ...(input.graceSeconds !== undefined ? { graceSeconds: input.graceSeconds } : {}),
        });
        modelHostStops.push({ workload: input.workload, result });
        if (result.ok) state.victimDown = true;
        return result;
      },
    },
    modelHostStatus: {
      query: (input): ReturnType<WorkloadClient["modelHostStatus"]["query"]> => {
        if (input.workload === victim.name) hooks?.onVictimStatus?.();
        count(modelHostStatusCalls, input.workload);
        if (victim.kind === "ModelHost" && input.workload === victim.name && !state.victimDown) {
          return Promise.resolve({ state: "Running", pid: 4242 });
        }
        return Promise.resolve({ state: "Stopped", pid: null });
      },
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
    },
  };

  return {
    client,
    starts,
    serverStops,
    modelHostStops,
    serverStatusCalls,
    modelHostStatusCalls,
    get victimDown(): boolean {
      return state.victimDown;
    },
  };
}

let temp: ReturnType<typeof makeTempRuntime>;
let env: NodeJS.ProcessEnv;
let workloadsDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  temp = makeTempRuntime();
  env = envForTemp(temp);
  workloadsDir = join(temp.devStorage, "workloads");
  mkdirSync(workloadsDir, { recursive: true });
  savedEnv = { ...process.env };
  // process.env must be mutated because the router's serverStop/modelHostStop
  // procedures call stopServer/stopModelHost, which resolve their runtime
  // paths from process.env and not from applyOne's opts.env — the same
  // reason stop-fence.test.ts mutates process.env.
  Object.assign(process.env, env, {
    LLAMACTL_CONFIG: join(temp.devStorage, "config-missing"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, savedEnv);
  temp.cleanup();
});

describe("applyOne evict lease fence (#278 DF-05)", () => {
  test("a held lease on a ModelRun victim refuses the eviction with EvictVictimBusy until the lease drains", async () => {
    // Kills M1 — the base behaviour: EVICT_VICTIM_OPS.ModelRun.stop ignores
    // `stopResult.refused` and always returns evictStopFailure(...,
    // "EvictStopRefused", "refused to stop").
    saveWorkload(mkManifest("victim", { port: 8182 }), workloadsDir);
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const lease = acquireHeldLease(reg, "victim");
    const rig = makeEvictClient({
      name: "victim",
      kind: "ModelRun",
      rel: "victim.gguf",
      port: 8182,
    });
    const { events, onEvent } = makeEventRecorder();
    const incoming = mkManifest("replacement", {
      annotations: { "llamactl.io/evict": "victim" },
      port: 8090,
    });
    const opts = { workloadsDir, env, getNodeBudgetGiB: (): number => 32 };

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, opts);

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictVictimBusy");
    expect(result.error).toContain("LeasesActive");
    expect(result.error).toContain(lease.id);
    const evictFailed = events.find((e) => e.type === "evict-failed");
    expect(evictFailed?.message).toContain("LeasesActive");
    expect(evictFailed?.message).toContain(lease.id);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(rig.serverStops).toHaveLength(1);
    const stopRecord = rig.serverStops[0];
    expect(stopRecord?.workload).toBe("victim");
    expect(stopRecord?.result.stopped).toBe(false);
    expect(stopRecord?.result.refused?.reason).toBe("LeasesActive");
    expect(stopRecord?.result.refused?.active).toEqual([lease.id]);
    expect(rig.serverStatusCalls.get("victim")).toBe(1);
    expect(reg.snapshot("victim")).toEqual({
      workload: "victim",
      phase: "open",
      epoch: 1,
      active: [lease.id],
      waiters: 0,
    });
    expect(lease.signal.aborted).toBe(false);
    expect(reg.audit()).toEqual([]);
    expect(
      loadWorkloadByNameAny("victim", workloadsDir).metadata.annotations?.[
        "llamactl.io/evicted-by"
      ],
    ).toBeUndefined();

    expect(lease.release()).toBe(true);
    const retry = await applyOne(incoming, () => rig.client, onEvent, undefined, opts);

    expect(retry.action).toBe("started");
    expect(rig.starts).toEqual(["replacement"]);
    expect(rig.victimDown).toBe(true);
    expect(reg.snapshot("victim")).toEqual({
      workload: "victim",
      phase: "unloaded",
      epoch: 2,
      active: [],
      waiters: 0,
    });
    expect(reg.audit()).toEqual([]);
  });

  test("a held lease on a ModelHost victim refuses the eviction with EvictVictimBusy until the lease drains", async () => {
    // Kills M2 — removes the busy classification from
    // EVICT_VICTIM_OPS.ModelHost.stop, so a "LeasesActive: <id>" refusal is
    // reported as generic EvictStopRefused.
    saveModelHost(
      mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
      workloadsDir,
    );
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const lease = acquireHeldLease(reg, "resident-host");
    const rig = makeEvictClient({
      name: "resident-host",
      kind: "ModelHost",
      rel: "resident-host.gguf",
      port: 18094,
    });
    const { onEvent } = makeEventRecorder();
    const incoming = mkManifest("incoming-run", {
      ram: 8,
      annotations: { "llamactl.io/evict": "resident-host" },
    });
    const opts = { workloadsDir, env, getNodeBudgetGiB: (): number => 24 };

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, opts);

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictVictimBusy");
    expect(result.error).toContain(`LeasesActive: ${lease.id}`);
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(rig.modelHostStops).toHaveLength(1);
    expect(rig.modelHostStops[0]?.workload).toBe("resident-host");
    expect(rig.modelHostStops[0]?.result.ok).toBe(false);
    expect(reg.snapshot("resident-host")).toEqual({
      workload: "resident-host",
      phase: "open",
      epoch: 1,
      active: [lease.id],
      waiters: 0,
    });
    expect(reg.audit()).toEqual([]);
    expect(
      loadWorkloadByNameAny("resident-host", workloadsDir).metadata.annotations?.[
        "llamactl.io/evicted-by"
      ],
    ).toBeUndefined();

    expect(lease.release()).toBe(true);
    const retry = await applyOne(incoming, () => rig.client, onEvent, undefined, opts);

    expect(retry.action).toBe("started");
    expect(rig.starts).toEqual(["incoming-run"]);
    expect(rig.victimDown).toBe(true);
    expect(reg.snapshot("resident-host")).toEqual({
      workload: "resident-host",
      phase: "unloaded",
      epoch: 2,
      active: [],
      waiters: 0,
    });
    expect(reg.audit()).toEqual([]);
  });

  test("a drain already in progress on the ModelRun victim refuses the eviction as EvictVictimBusy with DrainInProgress", async () => {
    // Kills M3 — classifies only reason === "LeasesActive" as busy and
    // leaves out DrainInProgress.
    saveWorkload(mkManifest("victim", { port: 8182 }), workloadsDir);
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const d = reg.beginDrain("victim");
    expect(d.ok).toBe(true);
    if (!d.ok) {
      throw new Error("expected beginDrain to succeed");
    }
    expect(d.active).toEqual([]);
    const rig = makeEvictClient({
      name: "victim",
      kind: "ModelRun",
      rel: "victim.gguf",
      port: 8182,
    });
    const { onEvent } = makeEventRecorder();
    const incoming = mkManifest("replacement", {
      annotations: { "llamactl.io/evict": "victim" },
      port: 8090,
    });

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, {
      workloadsDir,
      env,
      getNodeBudgetGiB: () => 32,
    });

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictVictimBusy");
    expect(result.error).toContain("DrainInProgress");
    expect(result.error).not.toContain("DrainInProgress: ");
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(reg.snapshot("victim")).toEqual({
      workload: "victim",
      phase: "draining",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.cancelDrain(d.token)).toBe(true);
    expect(reg.snapshot("victim")).toEqual({
      workload: "victim",
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
  });

  test("a drain already in progress on the ModelHost victim refuses the eviction as EvictVictimBusy with DrainInProgress", async () => {
    // Kills P4 — drops DrainInProgress from the ModelHost busy regex
    // (/^(?:LeasesActive)(?::|$)/), so the fence's "DrainInProgress: "
    // refusal falls through to generic EvictStopRefused.
    saveModelHost(
      mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
      workloadsDir,
    );
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const d = reg.beginDrain("resident-host");
    expect(d.ok).toBe(true);
    if (!d.ok) {
      throw new Error("expected beginDrain to succeed");
    }
    expect(d.active).toEqual([]);
    const rig = makeEvictClient({
      name: "resident-host",
      kind: "ModelHost",
      rel: "resident-host.gguf",
      port: 18094,
    });
    const { events, onEvent } = makeEventRecorder();
    const incoming = mkManifest("incoming-run", {
      ram: 8,
      annotations: { "llamactl.io/evict": "resident-host" },
    });

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, {
      workloadsDir,
      env,
      getNodeBudgetGiB: () => 24,
    });

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictVictimBusy");
    expect(result.error).toContain("(EvictVictimBusy): DrainInProgress");
    expect(result.error).not.toContain("DrainInProgress: ");
    const evictFailed = events.find((e) => e.type === "evict-failed");
    expect(evictFailed?.message).toContain("DrainInProgress");
    expect(result.action).toBe("pending");
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(rig.modelHostStops).toHaveLength(1);
    expect(rig.modelHostStops[0]?.result.ok).toBe(false);
    expect(rig.modelHostStops[0]?.result.error).toBe("DrainInProgress: ");
    expect(reg.snapshot("resident-host")).toEqual({
      workload: "resident-host",
      phase: "draining",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(
      loadWorkloadByNameAny("resident-host", workloadsDir).metadata.annotations?.[
        "llamactl.io/evicted-by"
      ],
    ).toBeUndefined();
    expect(reg.cancelDrain(d.token)).toBe(true);
  });

  test("a ModelHost stop error that only mentions LeasesActive mid-string stays EvictStopRefused", async () => {
    // Kills P7 — unanchors the ModelHost busy regex
    // (/(?:LeasesActive|DrainInProgress)(?::|$)/ without ^), so an error
    // that embeds "LeasesActive:" after other text is misclassified as busy.
    // The reason word is followed by ":" so only the ^ anchor rejects it.
    saveModelHost(
      mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
      workloadsDir,
    );
    const rig = makeEvictClient({
      name: "resident-host",
      kind: "ModelHost",
      rel: "resident-host.gguf",
      port: 18094,
    });
    const stopCalls: string[] = [];
    const client: WorkloadClient = {
      ...rig.client,
      modelHostStop: {
        mutate: (input): Promise<unknown> => {
          stopCalls.push(input.workload);
          return Promise.resolve({
            ok: false,
            pid: null,
            error: "stop failed: upstream LeasesActive: lease-x",
          });
        },
      },
    };
    const { onEvent } = makeEventRecorder();
    const incoming = mkManifest("incoming-run", {
      ram: 8,
      annotations: { "llamactl.io/evict": "resident-host" },
    });

    const result = await applyOne(incoming, () => client, onEvent, undefined, {
      workloadsDir,
      env,
      getNodeBudgetGiB: () => 24,
    });

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopRefused");
    expect(result.error).toContain(
      "(EvictStopRefused): stop failed: upstream LeasesActive: lease-x",
    );
    expect(result.action).toBe("pending");
    expect(stopCalls).toEqual(["resident-host"]);
    expect(rig.starts).toEqual([]);
  });

  test("a ModelRun refusal whose active list holds a non-string entry surfaces only the string lease ids", async () => {
    // Kills P11 — drops the typeof-string filter on refused.active, so the
    // busy detail renders the bogus entry ("LeasesActive: 42, lease-a").
    saveWorkload(mkManifest("victim", { port: 8182 }), workloadsDir);
    const rig = makeEvictClient({
      name: "victim",
      kind: "ModelRun",
      rel: "victim.gguf",
      port: 8182,
    });
    const stopCalls: string[] = [];
    const client: WorkloadClient = {
      ...rig.client,
      serverStop: {
        mutate: (input): Promise<unknown> => {
          stopCalls.push(input.workload);
          return Promise.resolve({
            stopped: false,
            pid: 4242,
            killed: false,
            refused: { reason: "LeasesActive", active: [42, "lease-a"] },
          });
        },
      },
    };
    const { events, onEvent } = makeEventRecorder();
    const incoming = mkManifest("replacement", {
      annotations: { "llamactl.io/evict": "victim" },
      port: 8090,
    });

    const result = await applyOne(incoming, () => client, onEvent, undefined, {
      workloadsDir,
      env,
      getNodeBudgetGiB: () => 32,
    });

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictVictimBusy");
    expect(result.error).toContain("(EvictVictimBusy): LeasesActive: lease-a");
    expect(result.error).not.toContain("42");
    const evictFailed = events.find((e) => e.type === "evict-failed");
    expect(evictFailed?.message).toContain("LeasesActive: lease-a");
    expect(evictFailed?.message).not.toContain("42");
    expect(result.action).toBe("pending");
    expect(stopCalls).toEqual(["victim"]);
    expect(rig.starts).toEqual([]);
  });
});

describe("#520 session fence on eviction (DF-05 composition)", () => {
  test("E1: a session arriving between the gate re-check and the fenced ModelRun stop refuses the eviction until it idles out", async () => {
    // Kills: no session check inside the DF-05 stop fence (the fenced
    // serverStop proceeds and the apply starts the replacement), or no
    // SessionsActive classification in EVICT_VICTIM_OPS.ModelRun.stop
    // (the refusal degrades to EvictStopRefused).
    saveWorkload(mkManifest("victim", { port: 8182 }), workloadsDir);
    const leases = createResidencyLeases();
    setResidencyLeaseRegistry(leases);
    let clock = 0;
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    setSessionRefcountRegistry(sessions);
    let sessionArrived = false;
    const rig = makeEvictClient(
      { name: "victim", kind: "ModelRun", rel: "victim.gguf", port: 8182 },
      {
        onVictimStatus: () => {
          if (sessionArrived) return;
          sessionArrived = true;
          idleLiveSession(sessions, "sess-late", "victim");
        },
      },
    );
    const { events, onEvent } = makeEventRecorder();
    const incoming = mkManifest("replacement", {
      annotations: { "llamactl.io/evict": "victim" },
      port: 8090,
    });
    const opts = { workloadsDir, env, getNodeBudgetGiB: (): number => 32 };

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, opts);

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionActive");
    expect(result.error).toContain("(EvictSessionActive): SessionsActive: sess-late");
    expect(result.action).toBe("pending");
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(rig.serverStops).toHaveLength(1);
    expect(rig.serverStops[0]?.result.refused).toEqual({
      reason: "SessionsActive",
      active: ["sess-late"],
    });
    expect(leases.snapshot("victim")).toEqual({
      workload: "victim",
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(
      loadWorkloadByNameAny("victim", workloadsDir).metadata.annotations?.[
        "llamactl.io/evicted-by"
      ],
    ).toBeUndefined();
    expect(sessions.activeSessions("victim")).toEqual(["sess-late"]);
    const evictFailed = events.find((e) => e.type === "evict-failed");
    expect(evictFailed?.message).toContain("SessionsActive");

    clock += 1000;
    const retry = await applyOne(incoming, () => rig.client, onEvent, undefined, opts);

    expect(retry.action).toBe("started");
    expect(rig.victimDown).toBe(true);
    expect(leases.snapshot("victim")).toEqual({
      workload: "victim",
      phase: "unloaded",
      epoch: 2,
      active: [],
      waiters: 0,
    });
  });

  test("E2: a session arriving before a ModelHost victim's fenced stop refuses the eviction as EvictSessionActive", async () => {
    // Kills: a missing SessionsActive classification in the ModelHost
    // stop-error mapping (the refusal degrades to EvictStopRefused).
    saveModelHost(
      mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
      workloadsDir,
    );
    const leases = createResidencyLeases();
    setResidencyLeaseRegistry(leases);
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    setSessionRefcountRegistry(sessions);
    let sessionArrived = false;
    const rig = makeEvictClient(
      { name: "resident-host", kind: "ModelHost", rel: "resident-host.gguf", port: 18094 },
      {
        onVictimStatus: () => {
          if (sessionArrived) return;
          sessionArrived = true;
          idleLiveSession(sessions, "sess-late", "resident-host");
        },
      },
    );
    const { onEvent } = makeEventRecorder();
    const incoming = mkManifest("incoming-run", {
      ram: 8,
      annotations: { "llamactl.io/evict": "resident-host" },
    });

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, {
      workloadsDir,
      env,
      getNodeBudgetGiB: (): number => 24,
    });

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionActive");
    expect(result.error).toContain("(EvictSessionActive): SessionsActive: sess-late");
    expect(result.action).toBe("pending");
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(rig.modelHostStops).toHaveLength(1);
    expect(rig.modelHostStops[0]?.result.ok).toBe(false);
    expect(leases.snapshot("resident-host")).toMatchObject({
      phase: "open",
      epoch: 1,
      active: [],
    });
    expect(sessions.activeSessions("resident-host")).toEqual(["sess-late"]);
  });

  test("E3: a session registry whose checkUnload throws at the fenced stop refuses the eviction as EvictSessionUnknown", async () => {
    // Kills: an unmapped SessionsUnknown refusal (degrades to
    // EvictStopRefused) or a fence that fails open on a throwing
    // registry.
    saveWorkload(mkManifest("victim", { port: 8182 }), workloadsDir);
    const leases = createResidencyLeases();
    setResidencyLeaseRegistry(leases);
    const real = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    let broken = false;
    const wrapped: SessionRefcounts = {
      ...real,
      checkUnload: (w: string, o?: { force?: boolean }) => {
        if (broken) {
          throw new Error("registry offline");
        }
        return real.checkUnload(w, o);
      },
    };
    setSessionRefcountRegistry(wrapped);
    const rig = makeEvictClient(
      { name: "victim", kind: "ModelRun", rel: "victim.gguf", port: 8182 },
      {
        onVictimStatus: () => {
          broken = true;
        },
      },
    );
    const { onEvent } = makeEventRecorder();
    const incoming = mkManifest("replacement", {
      annotations: { "llamactl.io/evict": "victim" },
      port: 8090,
    });

    const result = await applyOne(incoming, () => rig.client, onEvent, undefined, {
      workloadsDir,
      env,
      getNodeBudgetGiB: (): number => 32,
    });

    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionUnknown");
    expect(result.error).toContain("(EvictSessionUnknown): SessionsUnknown");
    expect(result.action).toBe("pending");
    expect(rig.starts).toEqual([]);
    expect(rig.victimDown).toBe(false);
    expect(rig.serverStops).toHaveLength(1);
    expect(rig.serverStops[0]?.result.refused).toEqual({
      reason: "SessionsUnknown",
      active: [],
    });
    expect(leases.snapshot("victim")).toMatchObject({
      phase: "open",
      epoch: 1,
      active: [],
    });
  });
});
