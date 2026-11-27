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
import { env as envMod, server as serverMod } from "@llamactl/core";
import { type ModelHostState, writeModelHostState } from "@llamactl/core/engines/state";
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
import { listWorkloadRoutes } from "@llamactl/core/workloadRuntime";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAdmissionAuthority } from "../../src/residency/admission-authority.js";
import { createManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";
import { openLocalAdmissionRuntime } from "../../src/residency/process-generation.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
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

// Fake engines left running by the reopen-through-router tests. Killed before
// the temp runtime dir is torn down so a failed assertion cannot leak a Bun
// listener (and its bound loopback port) across iterations.
const spawnedServerPids = new Set<number>();

function killSpawnedServers(): void {
  for (const pid of spawnedServerPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone or not ours to signal; nothing to clean.
    }
  }
  spawnedServerPids.clear();
}

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
  killSpawnedServers();
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
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

  test("without a registry the stop runs unfenced, withdrawing routes only for its duration", async () => {
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

      expect(await result).toBe(obj);
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

const HOST_REOPEN = "reopen-host";

// A bash + Bun fake that impersonates a serving engine: it binds a loopback
// port and answers `/health` (llama-server readiness) and `/v1/models`
// (ModelHost readiness) with 200, then blocks until SIGTERM. The router's
// start subscriptions spawn it exactly like the real binaries, so a start
// resolves `ok` and `reopenWorkloadAfterLoad(..., true)` fires for real.
function writeFakeServer(path: string, host: string, port: number): void {
  const js =
    "const s=Bun.serve({hostname:" +
    JSON.stringify(host) +
    ",port:" +
    String(port) +
    ",fetch(req){const u=new URL(req.url);" +
    "if(u.pathname==='/health')return new Response('ok',{status:200});" +
    "if(u.pathname==='/v1/models')return Response.json({data:[{id:'m'}]});" +
    "return new Response('stub',{status:200});}});" +
    "process.on('SIGTERM',()=>{s.stop(true);process.exit(0);});" +
    "await new Promise(()=>undefined);";
  const script =
    "#!/bin/bash\nexec -a llama-server " +
    JSON.stringify(process.execPath) +
    " -e " +
    JSON.stringify(js) +
    "\n";
  writeFileSync(path, script, { mode: 0o755 });
}

function pickPort(): number {
  return 18200 + Math.floor(Math.random() * 80);
}

function registerSpawnedPid(pidFile: string): void {
  if (!existsSync(pidFile)) {
    return;
  }
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (Number.isFinite(pid) && pid > 0) {
    spawnedServerPids.add(pid);
  }
}

function runtimeRoot(): string {
  return process.env["LOCAL_AI_RUNTIME_DIR"] ?? "";
}

describe("load reopens admission through the router (#278 DF-05)", () => {
  test("a verified stop then serverStart reopens the workload at the drain epoch", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const binDir = join(tmp, "bin");
    const modelsDir = join(tmp, "models");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });
    const port = pickPort();
    writeFakeServer(join(binDir, "llama-server"), "127.0.0.1", port);
    writeFileSync(join(modelsDir, "fake-model.gguf"), "GGUF-fake");
    Object.assign(process.env, {
      LLAMA_CPP_BIN: binDir,
      LLAMA_CPP_MODELS: modelsDir,
      LLAMA_CPP_LOGS: join(tmp, "logs"),
      LLAMA_CPP_HOST: "127.0.0.1",
      LLAMA_CPP_PORT: String(port),
      LLAMA_CPP_USE_TUNED_ARGS: "false",
    });

    const stopped = await stopCaller().serverStop({ workload: W });
    expect(stopped).toEqual({ stopped: true, pid: null, killed: false });
    expect(reg.snapshot(W).phase).toBe("unloaded");

    const stream = await router.createCaller({}).serverStart({
      workload: W,
      target: "fake-model.gguf",
      endpoint: { host: "127.0.0.1", port },
      timeoutSeconds: 10,
      skipTuned: true,
    });
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    registerSpawnedPid(join(runtimeRoot(), "workloads", W, "llama-server.pid"));

    expect(events.length).toBeGreaterThan(0);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    const acquired = reg.acquire(W);
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.lease.epoch).toBe(1);
      expect(acquired.lease.release()).toBe(true);
    }
  });

  test("a verified stop then modelHostStart reopens the workload at the drain epoch", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const binDir = join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(tmp, "models"), { recursive: true });
    const port = pickPort();
    const binary = join(binDir, "llama-host");
    writeFakeServer(binary, "127.0.0.1", port);
    Object.assign(process.env, { LLAMA_CPP_MODELS: join(tmp, "models") });
    saveModelHost(
      parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${HOST_REOPEN}
spec:
  engine: llamacpp
  node: local
  enabled: true
  binary: ${binary}
  endpoint:
    host: 127.0.0.1
    port: ${String(port)}
  hostedModels:
    - rel: m.gguf
`),
      tmp,
    );

    const stopped = await stopCaller().modelHostStop({ workload: HOST_REOPEN });
    expect(stopped).toEqual({ ok: true, pid: null });
    expect(reg.snapshot(HOST_REOPEN).phase).toBe("unloaded");

    const stream = await router
      .createCaller({})
      .modelHostStart({ workload: HOST_REOPEN, timeoutSeconds: 10 });
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    registerSpawnedPid(join(runtimeRoot(), "workloads", HOST_REOPEN, "modelhost.pid"));

    expect(events.length).toBeGreaterThan(0);
    expect(reg.snapshot(HOST_REOPEN)).toEqual({
      workload: HOST_REOPEN,
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    const acquired = reg.acquire(HOST_REOPEN);
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.lease.epoch).toBe(1);
      expect(acquired.lease.release()).toBe(true);
    }
  });
});

describe("unverified and failed stops keep the fence honest (#278 DF-05)", () => {
  test("an unverified serverStop through the router leaves admission open", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const dir = join(runtimeRoot(), "workloads", W);
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

    const result = await stopCaller().serverStop({ workload: W });

    expect(result.stopped).toBe(false);
    expect(result.pid).toBe(process.pid);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    const acquired = reg.acquire(W);
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.lease.epoch).toBe(1);
      expect(acquired.lease.release()).toBe(true);
    }
  });

  test("an unverified modelHostStop through the router leaves admission open", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const state: ModelHostState = {
      kind: "ModelHost",
      engine: "llamacpp",
      pid: process.pid,
      host: "127.0.0.1",
      port: 8094,
      modelAliases: ["m"],
      startedAt: new Date().toISOString(),
    };
    writeModelHostState(state, { name: W });

    const result = await stopCaller().modelHostStop({ workload: W });

    expect(result.ok).toBe(false);
    expect(result.pid).toBe(process.pid);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "open",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    const acquired = reg.acquire(W);
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.lease.epoch).toBe(1);
      expect(acquired.lease.release()).toBe(true);
    }
  });

  test("a load that did not succeed leaves a verified stop unloaded", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const stopped = await stopCaller().serverStop({ workload: W });
    expect(stopped).toEqual({ stopped: true, pid: null, killed: false });
    expect(reg.snapshot(W).phase).toBe("unloaded");

    (await requireFence()).reopenWorkloadAfterLoad(W, false, reg);

    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });
  });

  test("a failed serverStart through the router leaves a verified stop unloaded", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const modelsDir = join(tmp, "models");
    mkdirSync(modelsDir, { recursive: true });
    Object.assign(process.env, {
      LLAMA_CPP_BIN: join(tmp, "bin-missing"),
      LLAMA_CPP_MODELS: modelsDir,
      LLAMA_CPP_LOGS: join(tmp, "logs"),
      LLAMA_CPP_USE_TUNED_ARGS: "false",
    });

    const stopped = await stopCaller().serverStop({ workload: W });
    expect(stopped).toEqual({ stopped: true, pid: null, killed: false });
    expect(reg.snapshot(W).phase).toBe("unloaded");

    const stream = await router.createCaller({}).serverStart({
      workload: W,
      target: "missing.gguf",
      skipTuned: true,
    });
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    const done = events.find(
      (e): e is { type: "done"; result: { ok: boolean } } =>
        typeof e === "object" && e !== null && (e as { type?: unknown }).type === "done",
    );
    expect(done?.result.ok).toBe(false);
    expect(reg.snapshot(W)).toEqual({
      workload: W,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(W)).toEqual({ ok: false, reason: "Unloaded", workload: W, epoch: 1 });
  });

  test("a failed modelHostStart through the router leaves a verified stop unloaded", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const binDir = join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(tmp, "models"), { recursive: true });
    Object.assign(process.env, { LLAMA_CPP_MODELS: join(tmp, "models") });
    const port = pickPort();
    // A binary that exits at once without ever serving: the start can never
    // reach readiness, so startModelHost resolves ok:false.
    const binary = join(binDir, "llama-host");
    writeFileSync(binary, "#!/bin/bash\nexit 1\n", { mode: 0o755 });
    saveModelHost(
      parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${HOST_REOPEN}
spec:
  engine: llamacpp
  node: local
  enabled: true
  binary: ${binary}
  endpoint:
    host: 127.0.0.1
    port: ${String(port)}
  hostedModels:
    - rel: m.gguf
`),
      tmp,
    );

    const stopped = await stopCaller().modelHostStop({ workload: HOST_REOPEN });
    expect(stopped).toEqual({ ok: true, pid: null });
    expect(reg.snapshot(HOST_REOPEN).phase).toBe("unloaded");

    const stream = await router
      .createCaller({})
      .modelHostStart({ workload: HOST_REOPEN, timeoutSeconds: 2 });
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    registerSpawnedPid(join(runtimeRoot(), "workloads", HOST_REOPEN, "modelhost.pid"));

    const done = events.find(
      (e): e is { type: "done"; result: { ok: boolean } } =>
        typeof e === "object" && e !== null && (e as { type?: unknown }).type === "done",
    );
    expect(done?.result.ok).toBe(false);
    expect(reg.snapshot(HOST_REOPEN)).toEqual({
      workload: HOST_REOPEN,
      phase: "unloaded",
      epoch: 1,
      active: [],
      waiters: 0,
    });
    expect(reg.acquire(HOST_REOPEN)).toEqual({
      ok: false,
      reason: "Unloaded",
      workload: HOST_REOPEN,
      epoch: 1,
    });
  });
});

describe("#520 session refcounts under the DF-05 stop fence", () => {
  function idleLiveSession(sessions: SessionRefcounts, id: string, workload: string): void {
    const acquired = sessions.acquire(id, workload);
    if (!acquired.ok) {
      throw new Error(`session acquire(${id} on ${workload}) refused`);
    }
    sessions.release(id, acquired.generation);
  }

  function countingStop(): { stop: () => Promise<{ stopped: boolean }>; calls: () => number } {
    let calls = 0;
    return {
      calls: (): number => calls,
      stop: (): Promise<{ stopped: boolean }> => {
        calls += 1;
        return Promise.resolve({ stopped: true });
      },
    };
  }

  function runSessionFence(
    fence: FenceModule,
    leases: ResidencyLeases,
    stop: () => Promise<{ stopped: boolean }>,
  ): Promise<{ stopped: boolean } | { refused: FenceRefusal }> {
    return fence.fenceWorkloadStop({
      workload: "w",
      registry: leases,
      stop,
      isVerifiedStop: () => true,
      refuse: (f: FenceRefusal) => ({ refused: f }),
    });
  }

  test("S1: an idle-live session refuses the stop as SessionsActive and cancels the drain", async () => {
    // Kills: the fence ignoring the installed session registry (the stop
    // runs and commits the unload), force-releasing sessions instead of
    // refusing, or a missing cancelDrain (the workload stays draining).
    const fence = await requireFence();
    const leases = createResidencyLeases();
    const clock = 0;
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    setSessionRefcountRegistry(sessions);
    idleLiveSession(sessions, "sess-1", "w");
    const counter = countingStop();

    const result = await runSessionFence(fence, leases, counter.stop);

    expect(result).toEqual({ refused: { reason: "SessionsActive", active: ["sess-1"] } });
    expect(counter.calls()).toBe(0);
    expect(leases.snapshot("w")).toMatchObject({ phase: "open", epoch: 1, active: [] });
    expect(sessions.activeSessions("w")).toEqual(["sess-1"]);
  });

  test("S2: a session registry whose checkUnload throws refuses as SessionsUnknown without stopping", async () => {
    // Kills: swallowing the checkUnload throw (the stop proceeds to
    // unload) or treating the throw as an empty-ok check.
    const fence = await requireFence();
    const leases = createResidencyLeases();
    const real = createSessionRefcounts({ idleTimeoutMs: 1000 });
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
    broken = true;
    const counter = countingStop();

    const result = await runSessionFence(fence, leases, counter.stop);

    expect(result).toEqual({ refused: { reason: "SessionsUnknown", active: [] } });
    expect(counter.calls()).toBe(0);
    expect(leases.snapshot("w")).toMatchObject({ phase: "open", epoch: 1, active: [] });
  });

  test("S3: the same fence stops once the idle-live session has expired", async () => {
    // Kills: a fence keyed on raw session entries rather than
    // checkUnload's idle prune — an expired session must not keep
    // refusing the stop.
    const fence = await requireFence();
    const leases = createResidencyLeases();
    let clock = 0;
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    setSessionRefcountRegistry(sessions);
    idleLiveSession(sessions, "sess-1", "w");
    const counter = countingStop();

    const refused = await runSessionFence(fence, leases, counter.stop);
    expect(refused).toEqual({ refused: { reason: "SessionsActive", active: ["sess-1"] } });
    expect(counter.calls()).toBe(0);

    clock += 1000;
    const stopped = await runSessionFence(fence, leases, counter.stop);

    expect(stopped).toEqual({ stopped: true });
    expect(counter.calls()).toBe(1);
    expect(leases.snapshot("w")).toEqual({
      workload: "w",
      phase: "unloaded",
      epoch: 2,
      active: [],
      waiters: 0,
    });
    expect(sessions.activeSessions("w")).toEqual([]);
  });

  test("S4: a session on another workload does not block the stop", async () => {
    // GUARD — passes at base: pins that the session check (and any
    // release) is scoped to the stopped workload, killing a mutant that
    // checks or releases the wrong workload.
    const fence = await requireFence();
    const leases = createResidencyLeases();
    const clock = 0;
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    setSessionRefcountRegistry(sessions);
    idleLiveSession(sessions, "sess-1", "other");
    const counter = countingStop();

    const result = await runSessionFence(fence, leases, counter.stop);

    expect(result).toEqual({ stopped: true });
    expect(counter.calls()).toBe(1);
    expect(leases.snapshot("w")).toMatchObject({ phase: "unloaded", epoch: 1, active: [] });
    expect(sessions.activeSessions("other")).toEqual(["sess-1"]);
  });

  test("S5: a held lease still refuses as LeasesActive ahead of the session check", async () => {
    // GUARD — passes at base: pins the refusal order — the lease drain
    // refusal must pre-empt the session refusal, killing a mutant that
    // checks sessions before leases.
    const fence = await requireFence();
    const leases = createResidencyLeases();
    const clock = 0;
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    setSessionRefcountRegistry(sessions);
    idleLiveSession(sessions, "sess-1", "w");
    const acquired = leases.acquire("w");
    if (!acquired.ok) {
      throw new Error("expected lease acquire to succeed");
    }
    const counter = countingStop();

    const result = await runSessionFence(fence, leases, counter.stop);

    expect(result).toEqual({ refused: { reason: "LeasesActive", active: ["w#1"] } });
    expect(counter.calls()).toBe(0);
    expect(leases.snapshot("w")).toMatchObject({ phase: "open", epoch: 1, active: ["w#1"] });
    expect(sessions.activeSessions("w")).toEqual(["sess-1"]);
    expect(acquired.lease.release()).toBe(true);
  });
});

test.each([
  ["ModelRun", false],
  ["ModelRun", true],
  ["ModelHost", false],
  ["ModelHost", true],
] as const)(
  "managed %s publishes routes and reopens leases only after commit=%s",
  async (kind, accept) => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const workload = "managed-readiness-fixture";
    const reserver = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("fixture"),
    });
    const port = Number(reserver.port);
    await reserver.stop(true);
    const endpoint = { host: "127.0.0.1", port };
    const bin = join(tmp, "fake-llama-server");
    const models = join(tmp, "models");
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, "fake.gguf"), "GGUF-fake");
    writeFakeServer(bin, endpoint.host, port);
    Object.assign(process.env, {
      LLAMA_CPP_MODELS: models,
      LLAMA_CPP_LOGS: join(tmp, "logs"),
      LLAMA_CPP_USE_TUNED_ARGS: "false",
    });
    const authority = openAdmissionAuthority({
      storePath: join(tmp, "admission.db"),
      budgetGiB: () => 24,
      observe: () => undefined,
      readPidFile: () => undefined,
      owner: { pid: process.pid },
    });
    const lifecycle = openResidencyOperationStore({ path: defaultResidencyStorePath() });
    const observations: { routeCount: number; phase: string; residency: string | undefined }[] = [];
    const gate = createManagedLaunchAdmission({
      authority: {
        ...authority,
        completeReady: (id, token) => {
          observations.push({
            routeCount: listWorkloadRoutes(envMod.resolveEnv(), workload).length,
            phase: reg.snapshot(workload).phase,
            residency: lifecycle.getResidencyState(workload)?.state,
          });
          return accept && authority.completeReady(id, token);
        },
      },
      resolve: () => ({ specDigest: "fixture", allocationGiB: 16 }),
      capture: (_request, pid) => {
        spawnedServerPids.add(pid);
        return { pid, startTimeMs: 100 };
      },
    });
    const caller = router.createCaller({ managedLaunchAdmission: gate });
    try {
      if (kind === "ModelRun") {
        expect((await caller.serverStop({ workload })).stopped).toBe(true);
        const events = await caller.serverStart({
          workload,
          target: "fake.gguf",
          binary: bin,
          endpoint,
          timeoutSeconds: 5,
        });
        for await (const event of events) {
          if (event.type === "launch") spawnedServerPids.add(event.pid);
        }
      } else {
        expect((await caller.modelHostStop({ workload })).ok).toBe(true);
        const events = await caller.modelHostStart({
          workload,
          timeoutSeconds: 5,
          manifest: {
            apiVersion: "llamactl/v1",
            kind: "ModelHost",
            metadata: { name: workload },
            spec: {
              engine: "llamacpp",
              node: "local",
              binary: bin,
              endpoint,
              hostedModels: [{ rel: "fake.gguf" }],
            },
          },
        });
        for await (const _event of events) {
          // Wait for readiness and claim settlement.
        }
      }
      expect(observations).toEqual([{ routeCount: 0, phase: "unloaded", residency: "loading" }]);
      expect(lifecycle.getResidencyState(workload)?.state).toBe(accept ? "ready" : "failed");
      expect(listWorkloadRoutes(envMod.resolveEnv(), workload).length > 0).toBe(accept);
      expect(reg.snapshot(workload).phase).toBe(accept ? "open" : "unloaded");
      expect(authority.snapshot().map((row) => row.state)).toEqual([
        accept ? "resident" : "uncertain",
      ]);
    } finally {
      authority.close();
      lifecycle.close();
    }
  },
);

async function freshLoopbackPort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(probe.port);
  await probe.stop(true);
  return port;
}

function fixturePid(name: string): number | undefined {
  for (const file of ["llama-server.pid", "modelhost.pid"]) {
    const path = join(runtimeRoot(), "workloads", name, file);
    if (existsSync(path)) return Number(readFileSync(path, "utf8").trim());
  }
  return undefined;
}

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "a mixed-engine switch drains leases and releases capacity only after the stopped generation is gone",
  async () => {
    const run = "managed-switch-run";
    const host = "managed-switch-host";
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const runPort = await freshLoopbackPort();
    const hostPort = await freshLoopbackPort();
    const models = join(tmp, "models");
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, "fake.gguf"), "GGUF-fake");
    const runBinary = join(tmp, "llama-server");
    const hostBinary = join(tmp, "host-llama-server");
    writeFakeServer(runBinary, "127.0.0.1", runPort);
    // Keep the actual model arguments visible to the verified ModelRun stop.
    const script = readFileSync(runBinary, "utf8").trimEnd();
    writeFileSync(runBinary, script + ' -- "$@"\n', { mode: 0o755 });
    writeFakeServer(hostBinary, "127.0.0.1", hostPort);
    Object.assign(process.env, {
      LLAMA_CPP_MODELS: models,
      LLAMA_CPP_LOGS: join(tmp, "logs"),
      LLAMA_CPP_USE_TUNED_ARGS: "false",
    });

    const runtime = await openLocalAdmissionRuntime({
      storePath: join(tmp, "mixed-admission.db"),
      budgetGiB: () => 24,
      readPidFile: fixturePid,
    });
    const gate = createManagedLaunchAdmission({
      authority: runtime.authority,
      resolve: ({ runtimeKey }) => ({ specDigest: runtimeKey, allocationGiB: 16 }),
      capture: (_request, pid) => {
        spawnedServerPids.add(pid);
        return runtime.capture(pid);
      },
    });
    const caller = router.createCaller({ managedLaunchAdmission: gate });
    const manifest = parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${host}
spec:
  engine: llamacpp
  node: local
  enabled: true
  binary: ${hostBinary}
  endpoint:
    host: 127.0.0.1
    port: ${String(hostPort)}
  hostedModels:
    - rel: fake.gguf
`);
    try {
      const first = await caller.serverStart({
        workload: run,
        target: "fake.gguf",
        binary: runBinary,
        endpoint: { host: "127.0.0.1", port: runPort },
        timeoutSeconds: 5,
      });
      for await (const event of first) {
        if (event.type === "launch") spawnedServerPids.add(event.pid);
      }
      expect(listWorkloadRoutes(envMod.resolveEnv(), run)).toHaveLength(1);

      const blocked = [];
      for await (const event of await caller.modelHostStart({ workload: host, manifest })) {
        blocked.push(event);
      }
      expect(blocked).toEqual([
        {
          type: "done",
          result: {
            ok: false,
            pid: null,
            error: "BudgetExceeded: committed 16 GiB plus incoming 16 GiB exceeds budget 24 GiB",
          },
        },
      ]);
      expect(fixturePid(host)).toBeUndefined();

      const active = reg.acquire(run);
      if (!active.ok) throw new Error("fixture lease refused");
      try {
        expect(await caller.serverStop({ workload: run })).toMatchObject({
          stopped: false,
          refused: { reason: "LeasesActive" },
        });
        expect(runtime.authority.snapshot()).toMatchObject([
          { runtimeKey: run, state: "resident", allocationGiB: 16 },
        ]);
      } finally {
        active.lease.release();
      }
      const stopped = await caller.serverStop({ workload: run, graceSeconds: 2 });
      expect(stopped.stopped).toBe(true);
      if (stopped.pid !== null) spawnedServerPids.delete(stopped.pid);
      expect(runtime.authority.snapshot()).toEqual([]);
      expect(listWorkloadRoutes(envMod.resolveEnv(), run)).toEqual([]);

      const resumed = await caller.modelHostStart({ workload: host, manifest, timeoutSeconds: 5 });
      for await (const _event of resumed) {
        // Wait for the host to commit and publish.
      }
      expect(listWorkloadRoutes(envMod.resolveEnv(), host)).toHaveLength(1);
      expect(runtime.authority.snapshot()).toMatchObject([
        { runtimeKey: host, state: "resident", allocationGiB: 16 },
      ]);
    } finally {
      runtime.authority.close();
    }
  },
  20_000,
);
