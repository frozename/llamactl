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
import { applyOne, type WorkloadClient } from "../../src/workload/apply.js";
import { parseWorkload } from "../../src/workload/store.js";

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

function manifestYaml(opts: { workers?: boolean } = {}): string {
  const lines = [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    "  name: chat-a",
    "spec:",
    "  node: gpu1",
    "  enabled: true",
    "  target:",
    "    kind: rel",
    "    value: fake-org/new.gguf",
    "  restartPolicy: Always",
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
});
