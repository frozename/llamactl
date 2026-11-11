/**
 * #278 (DF-05) — serverStop/modelHostStop must be fenced by the opt-in
 * residency lease registry: beginDrain blocks new acquires, held leases
 * refuse the stop, a verified stop commits the unload and stays `unloaded`
 * (a stopped engine must refuse new acquires, not 503 model_not_loaded
 * against a dead server), and only a later load reopens it. An unverified
 * or failed stop cancels the drain back to open. The fence helper and the
 * router wiring land with the fix, so the helper is reached through a
 * guarded dynamic import and the specifier stays a `string` (not a literal)
 * so `tsc` cannot resolve it at base — every RED case fails by assertion,
 * never by a missing module or a type error.
 */
import { server as serverMod } from "@llamactl/core";
import {
  createResidencyLeases,
  type Lease,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { stopModelHost } from "../../src/server/modelhost.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { parseWorkload, saveWorkload, workloadPath } from "../../src/workload/store.js";

const FENCE_MODULE = "../../src/residency/stop-fence.js" as string;
const W = "absent";
const HOST = "mlx-host";
const RUN = "gemma-solo";
const RUN_REL = "gemma.gguf";

const modelHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${HOST}
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /usr/bin/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

type FenceRefusal = {
  reason: string;
  active: string[];
};

type FenceModule = {
  fenceWorkloadStop: <T, R>(options: {
    workload: string;
    registry?: ResidencyLeases | null;
    stop: () => Promise<T>;
    isVerifiedStop: (result: T) => boolean;
    refuse: (refusal: FenceRefusal) => R;
  }) => Promise<T | R>;
  reopenWorkloadAfterLoad: (
    workload: string,
    loaded: boolean,
    registry?: ResidencyLeases | null,
  ) => void;
};

type ServerStopOutcome = {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
  refused?: FenceRefusal;
};

type ModelHostStopOutcome = {
  ok: boolean;
  pid: number | null;
  error?: string;
};

type StopCaller = {
  serverStop: (input: { workload: string; graceSeconds?: number }) => Promise<ServerStopOutcome>;
  modelHostStop: (input: { workload: string }) => Promise<ModelHostStopOutcome>;
};

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-stop-fence-"));
  Object.assign(process.env, {
    DEV_STORAGE: join(tmp, "dev"),
    LOCAL_AI_RUNTIME_DIR: join(tmp, "dev", "ai-models", "local-ai"),
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    LLAMACTL_WORKLOADS_DIR: tmp,
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

async function requireFence(): Promise<FenceModule> {
  const fenceModule = (await import(FENCE_MODULE).catch(() => null)) as FenceModule | null;
  expect(typeof fenceModule?.fenceWorkloadStop).toBe("function");
  return fenceModule!;
}

function stopCaller(): StopCaller {
  const caller = router.createCaller({}) as unknown as StopCaller;
  return caller;
}

function acquireHeldLease(reg: ResidencyLeases): Lease {
  const acquired = reg.acquire(W);
  if (!acquired.ok) {
    throw new Error("expected lease acquire to succeed");
  }
  return acquired.lease;
}

function makeRefuse(): {
  refuse: (refusal: FenceRefusal) => { refused: FenceRefusal };
  calls: FenceRefusal[];
} {
  const calls: FenceRefusal[] = [];
  return {
    calls,
    refuse: (refusal): { refused: FenceRefusal } => {
      calls.push(refusal);
      return { refused: refusal };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("serverStop/modelHostStop lease fence (#278)", () => {
  test("serverStop refuses with LeasesActive while a lease is held", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const lease = acquireHeldLease(reg);

    const result = await stopCaller().serverStop({ workload: W });

    expect(result).toEqual({
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "LeasesActive", active: [lease.id] },
    });
    expect(reg.snapshot(W).phase).toBe("open");
    expect(lease.signal.aborted).toBe(false);
    expect(lease.release()).toBe(true);
  });

  test("a verified modelHostStop on an open workload parks it unloaded", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const hostStopped = await stopCaller().modelHostStop({ workload: W });
    expect(hostStopped).toEqual({ ok: true, pid: null });
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });
  });

  test("a verified stop commits unload and refuses new acquires until a load", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const call = stopCaller();

    const stopped = await call.serverStop({ workload: W });
    expect(stopped).toEqual({ stopped: true, pid: null, killed: false });
    expect("refused" in stopped).toBe(false);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });

    const hostStopped = await call.modelHostStop({ workload: W });
    expect(hostStopped).toEqual({ ok: true, pid: null });
    // Already unloaded: beginDrain refuses with Unloaded, so the stop runs
    // unfenced and the epoch does not advance.
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });
  });

  test("a start after a verified stop reopens admission at the same epoch", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const stopped = await stopCaller().serverStop({ workload: W });
    expect(stopped).toEqual({ stopped: true, pid: null, killed: false });
    expect(reg.snapshot(W).phase).toBe("unloaded");

    (await requireFence()).reopenWorkloadAfterLoad(W, true, reg);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    const lease = acquireHeldLease(reg);
    expect(lease.epoch).toBe(1);
    expect(lease.release()).toBe(true);
  });

  test("an unverified stop leaves the workload open and admits new leases", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const fence = await requireFence();

    await fence.fenceWorkloadStop({
      workload: W,
      registry: reg,
      stop: () => Promise.resolve({ ok: false }),
      isVerifiedStop: (r) => r.ok,
      refuse: (refusal) => ({ refused: refusal }),
    });

    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    const lease = acquireHeldLease(reg);
    expect(lease.epoch).toBe(1);
    expect(lease.release()).toBe(true);
  });

  test("modelHostStop refuses with LeasesActive while a lease is held", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const lease = acquireHeldLease(reg);

    const result = await stopCaller().modelHostStop({ workload: W });

    expect(result).toEqual({ ok: false, pid: null, error: `LeasesActive: ${lease.id}` });
    expect(reg.snapshot(W).phase).toBe("open");
    expect(lease.release()).toBe(true);
  });

  test("a verified stop refuses acquires until a load reopens at the drain epoch", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const stopped = await stopCaller().serverStop({ workload: W });
    expect(stopped).toEqual({ stopped: true, pid: null, killed: false });
    expect(reg.snapshot(W).phase).toBe("unloaded");
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });

    (await requireFence()).reopenWorkloadAfterLoad(W, true, reg);
    const lease = acquireHeldLease(reg);
    expect(lease.epoch).toBe(1);
    expect(lease.release()).toBe(true);
  });

  test("inert default: no published registry leaves stop results untouched", async () => {
    setResidencyLeaseRegistry(null);
    const call = stopCaller();

    const directStop = await serverMod.stopServer({ key: { name: W } });
    expect(await call.serverStop({ workload: W })).toEqual(directStop);

    const directHostStop = await stopModelHost({ key: { name: W } });
    expect(await call.modelHostStop({ workload: W })).toEqual(directHostStop);
  });
});

describe("fenceWorkloadStop", () => {
  test("drain window blocks acquires and refuses a concurrent stop", async () => {
    const fence = await requireFence();
    const reg = createResidencyLeases();
    const stopResult = deferred<{ ok: boolean }>();
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = (): void => {
        resolve();
      };
    });
    let stopCalls = 0;
    const stop = (): Promise<{ ok: boolean }> => {
      stopCalls += 1;
      markStopEntered();
      return stopResult.promise;
    };
    const { refuse, calls } = makeRefuse();

    const pending = fence.fenceWorkloadStop({
      workload: W,
      registry: reg,
      stop,
      isVerifiedStop: (result) => result.ok,
      refuse,
    });
    await stopEntered;

    expect(reg.snapshot(W).phase).toBe("draining");
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Draining", workload: W, epoch: 1 });

    let secondStopCalls = 0;
    const second = fence.fenceWorkloadStop({
      workload: W,
      registry: reg,
      stop: () => {
        secondStopCalls += 1;
        return Promise.resolve({ ok: true });
      },
      isVerifiedStop: (result) => result.ok,
      refuse,
    });
    expect(await second).toEqual({ refused: { reason: "DrainInProgress", active: [] } });
    expect(secondStopCalls).toBe(0);
    expect(calls).toEqual([{ reason: "DrainInProgress", active: [] }]);

    const obj = { ok: true };
    stopResult.resolve(obj);
    expect(await pending).toBe(obj);
    expect(stopCalls).toBe(1);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });
    fence.reopenWorkloadAfterLoad(W, true, reg);
    const reacquired = reg.acquire(W);
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) {
      reacquired.lease.release();
    }
  });

  test("an unverified stop result cancels the drain and is returned as-is", async () => {
    const fence = await requireFence();
    const reg = createResidencyLeases();
    const obj = { ok: false };
    const { refuse, calls } = makeRefuse();

    const result = await fence.fenceWorkloadStop({
      workload: W,
      registry: reg,
      stop: () => Promise.resolve(obj),
      isVerifiedStop: (r) => r.ok,
      refuse,
    });

    expect(result).toBe(obj);
    expect(reg.snapshot(W).phase).toBe("open");
    expect(calls).toEqual([]);
  });

  test("a rejecting stop cancels the drain and rethrows", async () => {
    const fence = await requireFence();
    const reg = createResidencyLeases();
    const err = new Error("stop exploded");
    let stopCalls = 0;

    let caught: unknown;
    try {
      await fence.fenceWorkloadStop({
        workload: W,
        registry: reg,
        stop: () => {
          stopCalls += 1;
          return Promise.reject<{ ok: boolean }>(err);
        },
        isVerifiedStop: (r) => r.ok,
        refuse: (refusal) => ({ refused: refusal }),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(err);
    expect(stopCalls).toBe(1);
    expect(reg.snapshot(W).phase).toBe("open");
  });

  test("a held lease at entry refuses without calling stop", async () => {
    const fence = await requireFence();
    const reg = createResidencyLeases();
    const lease = acquireHeldLease(reg);
    const { refuse, calls } = makeRefuse();
    let stopCalls = 0;

    const result = await fence.fenceWorkloadStop({
      workload: W,
      registry: reg,
      stop: () => {
        stopCalls += 1;
        return Promise.resolve({ ok: true });
      },
      isVerifiedStop: (r) => r.ok,
      refuse,
    });

    expect(result).toEqual({ refused: { reason: "LeasesActive", active: [lease.id] } });
    expect(stopCalls).toBe(0);
    expect(calls).toEqual([{ reason: "LeasesActive", active: [lease.id] }]);
    expect(reg.snapshot(W).phase).toBe("open");
    expect(lease.signal.aborted).toBe(false);
    expect(lease.release()).toBe(true);
  });

  test("an already-unloaded workload runs stop unfenced", async () => {
    const fence = await requireFence();
    const reg = createResidencyLeases();
    const drain = reg.beginDrain(W);
    if (!drain.ok) {
      throw new Error("expected beginDrain to succeed");
    }
    const commit = reg.commitUnload(drain.token);
    if (!commit.ok) {
      throw new Error("expected commitUnload to succeed");
    }
    expect(reg.snapshot(W).phase).toBe("unloaded");

    const obj = { ok: true };
    let stopCalls = 0;
    let verifiedCalls = 0;
    const { refuse, calls } = makeRefuse();

    const result = await fence.fenceWorkloadStop({
      workload: W,
      registry: reg,
      stop: () => {
        stopCalls += 1;
        return Promise.resolve(obj);
      },
      isVerifiedStop: (r) => {
        verifiedCalls += 1;
        return r.ok;
      },
      refuse,
    });

    expect(result).toBe(obj);
    expect(stopCalls).toBe(1);
    expect(verifiedCalls).toBe(0);
    expect(calls).toEqual([]);
    expect(reg.snapshot(W).phase).toBe("unloaded");
  });

  test("inert without a registry returns the stop promise unwrapped", async () => {
    const fence = await requireFence();
    setResidencyLeaseRegistry(null);
    const obj = { ok: true };
    const inertCases: { registry?: ResidencyLeases | null }[] = [{}, { registry: null }];

    for (const options of inertCases) {
      const p = Promise.resolve(obj);
      let stopCalls = 0;
      let verifiedCalls = 0;
      const { refuse, calls } = makeRefuse();

      const result = fence.fenceWorkloadStop({
        workload: W,
        ...options,
        stop: () => {
          stopCalls += 1;
          return p;
        },
        isVerifiedStop: (r) => {
          verifiedCalls += 1;
          return r.ok;
        },
        refuse,
      });

      expect(result).toBe(p);
      expect(stopCalls).toBe(1);
      expect(verifiedCalls).toBe(0);
      expect(calls).toEqual([]);
    }
  });
});

describe("workloadDelete lease refusal (#278)", () => {
  test("a held lease keeps the ModelHost manifest and surfaces LeasesActive", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    saveModelHost(parseModelHost(modelHostYaml), tmp);
    const acquired = reg.acquire(HOST);
    if (!acquired.ok) {
      throw new Error("expected lease acquire to succeed");
    }

    const result = await router.createCaller({}).workloadDelete({ name: HOST });

    if (!("error" in result)) {
      throw new Error(`expected workloadDelete refusal, got ${JSON.stringify(result)}`);
    }
    expect(result.error).toContain("LeasesActive");
    expect(result.ok).toBe(false);
    expect(result.stops).toEqual([]);
    expect(existsSync(workloadPath(HOST, tmp))).toBe(true);
    expect(acquired.lease.signal.aborted).toBe(false);
    expect(acquired.lease.release()).toBe(true);
  });

  test("a held lease keeps the ModelRun manifest and surfaces LeasesActive", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    saveWorkload(
      parseWorkload(
        `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ${RUN}
spec:
  node: local
  target:
    kind: rel
    value: ${RUN_REL}
`,
      ),
      tmp,
    );
    const acquired = reg.acquire(RUN);
    if (!acquired.ok) {
      throw new Error("expected lease acquire to succeed");
    }
    // A tracked pid equal to the live test-runner pid, with a sidecar record
    // mtime at/after its start, reads as "alive": serverStatus reports `up`
    // with the matching rel, so the delete reaches the fenced serverStop.
    const dir = join(process.env["LOCAL_AI_RUNTIME_DIR"] ?? "", "workloads", RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify({
        rel: RUN_REL,
        extraArgs: [],
        host: "127.0.0.1",
        port: "0",
        binary: "/usr/bin/llama-server",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );

    const result = await router.createCaller({}).workloadDelete({ name: RUN });

    if (!("error" in result)) {
      throw new Error(`expected workloadDelete refusal, got ${JSON.stringify(result)}`);
    }
    expect(result.error).toContain("LeasesActive");
    expect(result.ok).toBe(false);
    expect(existsSync(workloadPath(RUN, tmp))).toBe(true);
    expect(acquired.lease.signal.aborted).toBe(false);
    expect(acquired.lease.release()).toBe(true);
  });
});
