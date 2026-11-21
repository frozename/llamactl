// Part of #520: `llamactl apply` (and the controller reconciler) restart a
// running ModelRun whose spec drifted through convergeClaimedServer, which
// calls serverStop and discards the outcome. When the node stop fence
// refuses (SessionsActive, SessionsUnknown, LeasesActive, DrainInProgress)
// the apply must report the refusal, keep the live Running status and
// never start workers or a replacement — the same shape
// stopDisabledWorkload returns for #522. At the pinned base the outcome is
// ignored, so every refusal case fails by assertion while the verified-stop
// and already-matching guards pass.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ModelRun } from "../../src/workload/schema.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import { mkdirSync } from "../../src/safe-fs.js";
import { createTargetAdmissionAuthority } from "../../src/workload/admission.js";
import { applyOne, type WorkloadClient } from "../../src/workload/apply.js";
import { loadWorkloadByNameAny, parseWorkload, saveWorkload } from "../../src/workload/store.js";

type StatusResult = Awaited<ReturnType<WorkloadClient["serverStatus"]["query"]>>;

const STATUS_UP_MISMATCH: StatusResult = {
  state: "up",
  rel: "fake-org/old.gguf",
  extraArgs: [],
  pid: 4242,
  host: "127.0.0.1",
  port: 8080,
  binary: null,
  endpoint: "http://127.0.0.1:8080",
};

const STATUS_UP_MATCH: StatusResult = { ...STATUS_UP_MISMATCH, rel: "fake-org/new.gguf" };

const STATUS_DOWN: StatusResult = {
  state: "down",
  rel: null,
  extraArgs: [],
  pid: null,
  host: null,
  port: null,
  binary: null,
  endpoint: "",
};

function manifestYaml(
  opts: {
    evict?: string;
    memory?: number;
    name?: string;
    rel?: string;
    workers?: boolean;
  } = {},
): string {
  const lines = [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    `  name: ${opts.name ?? "chat-a"}`,
    ...(opts.evict !== undefined ? ["  annotations:", `    llamactl.io/evict: ${opts.evict}`] : []),
    "spec:",
    "  node: gpu1",
    "  enabled: true",
    "  target:",
    "    kind: rel",
    `    value: ${opts.rel ?? "fake-org/new.gguf"}`,
    "  restartPolicy: Always",
    ...(opts.memory !== undefined
      ? ["  resources:", `    expectedMemoryGiB: ${String(opts.memory)}`]
      : []),
  ];
  if (opts.workers === true) {
    lines.push(
      "  workers:",
      "    - node: w1",
      "      rpcHost: 10.0.0.21",
      "      rpcPort: 50052",
      "      extraArgs: []",
      "      timeoutSeconds: 20",
    );
  }
  lines.push("");
  return lines.join("\n");
}

interface StopCall {
  workload: string;
  graceSeconds?: number;
}

interface Trace {
  serverStops: StopCall[];
  serverStarts: unknown[];
  rpcServerStarts: unknown[];
}

function noopSubscription(): { unsubscribe(): undefined } {
  return {
    unsubscribe(): undefined {
      return undefined;
    },
  };
}

const SERVER_DONE = { ok: true, pid: 5151, endpoint: "127.0.0.1:8080" };
const RPC_DONE = { ok: true, pid: 99, endpoint: "127.0.0.1:50052" };

function makeClient(opts: {
  status: StatusResult;
  stopOutcome?: unknown;
  trace: Trace;
}): WorkloadClient {
  return {
    serverStatus: {
      query: () => Promise.resolve(opts.status),
    },
    serverStop: {
      mutate: (input: StopCall): Promise<unknown> => {
        opts.trace.serverStops.push(input);
        return Promise.resolve(opts.stopOutcome ?? { stopped: true, pid: 4242, killed: false });
      },
    },
    serverStart: {
      subscribe: (_input, callbacks): { unsubscribe(): undefined } => {
        opts.trace.serverStarts.push(_input);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: SERVER_DONE });
          callbacks.onComplete();
        });
        return noopSubscription();
      },
    },
    modelHostStart: { subscribe: () => noopSubscription() },
    modelHostStop: { mutate: () => Promise.resolve({}) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: {
      subscribe: (_input, callbacks): { unsubscribe(): undefined } => {
        opts.trace.rpcServerStarts.push(_input);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: RPC_DONE });
          callbacks.onComplete();
        });
        return noopSubscription();
      },
    },
    rpcServerStop: { mutate: () => Promise.resolve({}) },
    rpcServerDoctor: {
      query: () =>
        Promise.resolve({ ok: true, path: "/fake/bin/rpc-server", llamaCppBin: "/fake/bin" }),
    },
  };
}

function makeFleet(opts: { status?: StatusResult; stopOutcome?: unknown }): {
  getClient: (nodeName: string) => WorkloadClient;
  trace: Trace;
} {
  const trace: Trace = { serverStops: [], serverStarts: [], rpcServerStarts: [] };
  const status = opts.status ?? STATUS_UP_MISMATCH;
  const getClient = (nodeName: string): WorkloadClient =>
    makeClient({
      status: nodeName === "gpu1" ? status : STATUS_DOWN,
      trace,
      ...(opts.stopOutcome !== undefined ? { stopOutcome: opts.stopOutcome } : {}),
    });
  return { getClient, trace };
}

const STATUS_VICTIM_UP: StatusResult = {
  state: "up",
  rel: "fake-org/victim.gguf",
  extraArgs: [],
  pid: 777,
  host: "127.0.0.1",
  port: 8090,
  binary: null,
  endpoint: "http://127.0.0.1:8090",
};

// Workload-aware client for the admission-claim tests: the victim reports
// up until its evict stop, chat-a always reports the mismatched running
// server and any stop aimed at it answers with the scripted refusal.
function makeAdmissionClient(opts: { refusal: unknown; trace: Trace }): WorkloadClient {
  const state = { victimDown: false };
  return {
    serverStatus: {
      query: (input): Promise<StatusResult> => {
        if (input.workload === "victim" && !state.victimDown) {
          return Promise.resolve(STATUS_VICTIM_UP);
        }
        if (input.workload === "chat-a") {
          return Promise.resolve(STATUS_UP_MISMATCH);
        }
        return Promise.resolve(STATUS_DOWN);
      },
    },
    serverStop: {
      mutate: (input: StopCall): Promise<unknown> => {
        opts.trace.serverStops.push(input);
        if (input.workload === "victim") {
          state.victimDown = true;
          return Promise.resolve({ stopped: true, pid: 777, killed: false });
        }
        return Promise.resolve(opts.refusal);
      },
    },
    serverStart: {
      subscribe: (_input, callbacks): { unsubscribe(): undefined } => {
        opts.trace.serverStarts.push(_input);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: SERVER_DONE });
          callbacks.onComplete();
        });
        return noopSubscription();
      },
    },
    modelHostStart: { subscribe: () => noopSubscription() },
    modelHostStop: { mutate: () => Promise.resolve({}) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: {
      subscribe: (_input, callbacks): { unsubscribe(): undefined } => {
        opts.trace.rpcServerStarts.push(_input);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: RPC_DONE });
          callbacks.onComplete();
        });
        return noopSubscription();
      },
    },
    rpcServerStop: { mutate: () => Promise.resolve({}) },
    rpcServerDoctor: {
      query: () =>
        Promise.resolve({ ok: true, path: "/fake/bin/rpc-server", llamaCppBin: "/fake/bin" }),
    },
  };
}

function makeAdmissionFleet(refusal: unknown): {
  getClient: (nodeName: string) => WorkloadClient;
  trace: Trace;
} {
  const trace: Trace = { serverStops: [], serverStarts: [], rpcServerStarts: [] };
  return {
    getClient: (): WorkloadClient => makeAdmissionClient({ refusal, trace }),
    trace,
  };
}

// Each applyOne needs its own scoped store + env so a seeded ambient store
// (isolation harness) or a developer's real $DEV_STORAGE can never satisfy
// the port preflight, budget listing, or evict lookup.
function scopedStore(): {
  opts: { env: NodeJS.ProcessEnv; workloadsDir: string };
  cleanup: () => void;
} {
  const temp = makeTempRuntime();
  const workloadsDir = join(temp.devStorage, "workloads");
  mkdirSync(workloadsDir, { recursive: true });
  return {
    opts: { env: envForTemp(temp), workloadsDir },
    cleanup: (): void => {
      temp.cleanup();
    },
  };
}

/** The refused-restart status every refusal reason must produce. */
function refusedConditions(message: string): unknown[] {
  return [
    {
      type: "Applied",
      status: "False",
      reason: "StopRefused",
      message,
      lastTransitionTime: "<ignored>",
    },
  ];
}

function stableConditions(result: { statusSection: { conditions: object[] } }): unknown[] {
  return result.statusSection.conditions.map((c) => ({ ...c, lastTransitionTime: "<ignored>" }));
}

async function applyChatA(
  manifest: ModelRun,
  getClient: (nodeName: string) => WorkloadClient,
): Promise<{ result: Awaited<ReturnType<typeof applyOne>>; cleanup: () => void }> {
  const store = scopedStore();
  try {
    const result = await applyOne(manifest, getClient, undefined, undefined, store.opts);
    return { result, cleanup: store.cleanup };
  } catch (err) {
    store.cleanup();
    throw err;
  }
}

describe("#520 ModelRun apply restart stop-fence refusal", () => {
  // Kills: ignoring the serverStop outcome in convergeClaimedServer — the
  // refusal must fail the apply, keep the live Running status and stamp
  // StopRefused instead of reporting a restart over a refused stop.
  test("R1: SessionsActive refusal fails the restart and preserves live status", async () => {
    const { getClient, trace } = makeFleet({
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsActive", active: ["s1"] },
      },
    });

    const { result, cleanup } = await applyChatA(parseWorkload(manifestYaml()), getClient);
    try {
      expect(result.error).toBe("serverStop refused: SessionsActive: s1");
      expect(result.action).toBe("unchanged");
      expect(result.statusSection.phase).toBe("Running");
      expect(result.statusSection.serverPid).toBe(4242);
      expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8080");
      expect(stableConditions(result)).toEqual(
        refusedConditions("serverStop refused: SessionsActive: s1"),
      );
      expect(trace.serverStarts).toEqual([]);
      expect(trace.serverStops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
    } finally {
      cleanup();
    }
  });

  // Kills: an unconditional `: ${active.join(", ")}` suffix — an empty id
  // list must leave no trailing colon.
  test("R2: SessionsUnknown refusal reports the reason without an id suffix", async () => {
    const { getClient, trace } = makeFleet({
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsUnknown", active: [] },
      },
    });

    const { result, cleanup } = await applyChatA(parseWorkload(manifestYaml()), getClient);
    try {
      expect(result.error).toBe("serverStop refused: SessionsUnknown");
      expect(result.action).toBe("unchanged");
      expect(result.statusSection.phase).toBe("Running");
      expect(result.statusSection.serverPid).toBe(4242);
      expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8080");
      expect(stableConditions(result)).toEqual(
        refusedConditions("serverStop refused: SessionsUnknown"),
      );
      expect(trace.serverStarts).toEqual([]);
      expect(trace.serverStops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
    } finally {
      cleanup();
    }
  });

  // Kills: placing the refusal check after startWorkers, or matching only
  // the session reasons — a lease refusal must stop the restart before any
  // worker rpc-server or coordinator serverStart runs.
  test("R3: LeasesActive refusal on a workered manifest starts nothing", async () => {
    const { getClient, trace } = makeFleet({
      stopOutcome: {
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "LeasesActive", active: ["lease-1"] },
      },
    });

    const { result, cleanup } = await applyChatA(
      parseWorkload(manifestYaml({ workers: true })),
      getClient,
    );
    try {
      expect(result.error).toBe("serverStop refused: LeasesActive: lease-1");
      expect(result.action).toBe("unchanged");
      expect(result.statusSection.phase).toBe("Running");
      expect(result.statusSection.serverPid).toBe(4242);
      expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8080");
      expect(stableConditions(result)).toEqual(
        refusedConditions("serverStop refused: LeasesActive: lease-1"),
      );
      expect(trace.rpcServerStarts).toEqual([]);
      expect(trace.serverStarts).toEqual([]);
      expect(trace.serverStops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
    } finally {
      cleanup();
    }
  });

  // Guard: a verified stop keeps the existing restarted outcome — the
  // refusal check must only fire on a `refused` stop-fence outcome.
  test("G1: a verified stop still restarts the mismatched server", async () => {
    const { getClient, trace } = makeFleet({
      stopOutcome: { stopped: true, pid: 4242, killed: false },
    });

    const { result, cleanup } = await applyChatA(parseWorkload(manifestYaml()), getClient);
    try {
      expect(result.error).toBeUndefined();
      expect(result.action).toBe("restarted");
      expect(result.statusSection.phase).toBe("Running");
      expect(trace.serverStarts).toHaveLength(1);
      expect(trace.serverStops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
    } finally {
      cleanup();
    }
  });

  // Guard: an already-matching running server is a no-op — serverStop is
  // never invoked and the live status is preserved.
  test("G2: a matching running server is left unchanged without a stop", async () => {
    const { getClient, trace } = makeFleet({ status: STATUS_UP_MATCH });

    const { result, cleanup } = await applyChatA(parseWorkload(manifestYaml()), getClient);
    try {
      expect(result.error).toBeUndefined();
      expect(result.action).toBe("unchanged");
      expect(result.statusSection.phase).toBe("Running");
      expect(result.statusSection.serverPid).toBe(4242);
      expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8080");
      expect(trace.serverStops).toEqual([]);
      expect(trace.serverStarts).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // Kills: dropping, forcing true or forcing false the
  // `lifecycle.destructive = wasDestructive;` restore in
  // convergeClaimedServer — with no prior evictions the refused restart ran
  // nothing destructive, so the pending target-admission claim must be
  // released rather than marked uncertain.
  test("R4: a refused restart with no evictions releases the admission claim", async () => {
    const authority = createTargetAdmissionAuthority();
    const { getClient, trace } = makeAdmissionFleet({
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsActive", active: ["s1"] },
    });
    const store = scopedStore();
    try {
      const result = await applyOne(
        parseWorkload(manifestYaml({ memory: 8 })),
        getClient,
        undefined,
        undefined,
        {
          ...store.opts,
          getNodeBudgetGiB: (): number => 24,
          targetAdmission: authority,
        },
      );
      expect(result.error).toBe("serverStop refused: SessionsActive: s1");
      expect(result.action).toBe("unchanged");
      expect(result.statusSection.phase).toBe("Running");
      expect(trace.serverStops).toEqual([{ workload: "chat-a", graceSeconds: 5 }]);
      expect(trace.serverStarts).toEqual([]);
      const snapshot = authority.snapshot("gpu1");
      expect(snapshot.filter((c) => c.state === "pending" || c.state === "uncertain")).toEqual([]);
      expect(snapshot).toEqual([]);
    } finally {
      store.cleanup();
    }
  });

  // Kills: forcing the restore to false — after verified evictions the
  // apply already tore victims down, so a refused restart leaves the claim
  // uncertain while the DF-02 rollback releases the eviction markers.
  test("R5: a refused restart after verified evictions marks the claim uncertain and rolls back markers", async () => {
    const authority = createTargetAdmissionAuthority();
    const { getClient, trace } = makeAdmissionFleet({
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsActive", active: ["s1"] },
    });
    const store = scopedStore();
    try {
      saveWorkload(
        parseWorkload(manifestYaml({ name: "victim", rel: "fake-org/victim.gguf", memory: 8 })),
        store.opts.workloadsDir,
      );
      const result = await applyOne(
        parseWorkload(manifestYaml({ memory: 8, evict: "victim" })),
        getClient,
        undefined,
        undefined,
        {
          ...store.opts,
          getNodeBudgetGiB: (): number => 24,
          targetAdmission: authority,
        },
      );
      expect(result.error, result.error ?? "no error").toContain(
        "serverStop refused: SessionsActive: s1",
      );
      expect(result.error).toContain("released eviction intent on 'victim'");
      expect(result.action).toBe("unchanged");
      expect(result.statusSection.phase).toBe("Running");
      expect(trace.serverStops).toEqual([
        { workload: "victim", graceSeconds: 5 },
        { workload: "chat-a", graceSeconds: 5 },
      ]);
      expect(trace.serverStarts).toEqual([]);
      const snapshot = authority.snapshot("gpu1");
      expect(snapshot.map((c) => c.state)).toEqual(["uncertain"]);
      expect(snapshot[0]?.runtimeKey).toBe("chat-a");
      const victim = loadWorkloadByNameAny("victim", store.opts.workloadsDir);
      expect(victim.metadata.annotations?.["llamactl.io/evicted-by"]).toBeUndefined();
      expect(victim.metadata.annotations?.["llamactl.io/evicted-at"]).toBeUndefined();
    } finally {
      store.cleanup();
    }
  });
});
