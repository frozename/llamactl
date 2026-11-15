/**
 * #283 DF-10 — populate modelHostStatus.sleep so the reconciler's sleep
 * guard is live. src/residency/llamacpp-sleep-status and the sleep /
 * sleepController members of statusModelHost land with the fix, so the
 * module is reached through a guarded dynamic import — the specifier
 * stays a runtime string so tsc cannot resolve the missing module (a
 * literal would be a resolution error, not an assertion failure) — and
 * the new option through a widened options type the base simply
 * ignores. Every case fails by assertion on the sleep value, a call
 * count, or the reconcile report — never by a missing module or a type
 * error.
 */
import type { PidIdentityDeps } from "@llamactl/core/pidIdentity";
import type {
  LlamacppSleepController,
  SleepMember,
  SleepResidency,
} from "@llamactl/core/residency/llamacpp-sleep";

import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { createLlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";
import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StatusModelHostOptions, StatusModelHostResult } from "../../src/server/modelhost.js";
import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";

import { router } from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { statusModelHost } from "../../src/server/modelhost.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import { reconcileOnce } from "../../src/workload/reconciler.js";

// ── module under test (lands with the fix) ──────────────────────────────

type NodeSleepStatusModule = {
  setNodeLlamacppSleepController(controller: LlamacppSleepController | null): void;
  getNodeLlamacppSleepController(): LlamacppSleepController | null;
};

async function loadSleepStatusModule(): Promise<NodeSleepStatusModule | null> {
  const href = new URL("../../src/residency/llamacpp-sleep-status.ts", import.meta.url).href;
  const mod = (await import(href).catch(() => null)) as Record<string, unknown> | null;
  if (typeof mod?.["setNodeLlamacppSleepController"] !== "function") return null;
  return mod as unknown as NodeSleepStatusModule;
}

// ── statusModelHost seam: the fix adds `sleep` to the result and
// `sleepController` to the options (undefined = the published node
// controller). Both widenings are structural so the base typechecks. ────

type SleepAwareStatus = StatusModelHostResult & { sleep?: SleepResidency };

type StatusOpts = StatusModelHostOptions & {
  sleepController?: LlamacppSleepController | null;
};

function readHostStatus(
  name: string,
  runtimeDir: string,
  identity: PidIdentityDeps,
  sleepController?: LlamacppSleepController | null,
): SleepAwareStatus {
  const opts: StatusOpts = { key: { name }, runtimeDir, identity };
  if (sleepController !== undefined) opts.sleepController = sleepController;
  return statusModelHost(opts);
}

// ── fixtures ────────────────────────────────────────────────────────────

// The sidecar records this test process as the host pid — it cannot be
// killed — so the injected identity reports it started at epoch 0 with
// the engine's argv0 shape and a no-throw probe, the same seam
// releasableSelfIdentity uses in test/server/modelhost.test.ts.
function liveTestIdentity(command: string): PidIdentityDeps {
  return {
    processStartMs: () => 0,
    processCommand: () => command,
    probe: () => undefined,
  };
}

function deadPidIdentity(command: string): PidIdentityDeps {
  return {
    processStartMs: () => 0,
    processCommand: () => command,
    probe: (): never => {
      const err: NodeJS.ErrnoException = new Error(" ESRCH");
      err.code = "ESRCH";
      throw err;
    },
  };
}

function writeHostSidecar(
  runtimeDir: string,
  name: string,
  engine: "llamacpp" | "omlx",
  specHash: string,
): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine,
      pid: process.pid,
      host: "127.0.0.1",
      port: 18094,
      modelAliases: [`${name}.gguf`],
      startedAt: new Date().toISOString(),
      specHash,
    },
    { name },
    resolveEnv({ LOCAL_AI_RUNTIME_DIR: runtimeDir }),
  );
}

function sleepMember(name: string): SleepMember {
  return {
    id: name,
    runtimeKey: `rk-${name}`,
    specDigest: `digest-${name}`,
    allocationGiB: 8,
    capability: { kind: "guarded-sleep", fork: "ggml-org", build: "b6000" },
  };
}

function makeHostManifest(name: string): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "llamacpp",
      node: "mac-mini",
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

const originalEnv = { ...process.env };

afterEach(async () => {
  const sleepStatus = await loadSleepStatusModule();
  sleepStatus?.setNodeLlamacppSleepController(null);
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
});

// #283 sleep-status — kills never populating `sleep` on a Running llamacpp
// host, and honouring only "sleeping" but not the "sleep-pending"
// controller transition.
test("#283 sleep-status S1: a sleeping or sleep-pending llama.cpp host reports sleep", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-mh-sleep-s1-"));
  const runtimeDir = join(tmp, "runtime");
  try {
    const sleepingName = "s1-sleeping-host";
    const pendingName = "s1-pending-host";
    writeHostSidecar(runtimeDir, sleepingName, "llamacpp", "hash-s1-sleeping");
    writeHostSidecar(runtimeDir, pendingName, "llamacpp", "hash-s1-pending");
    const controller = createLlamacppSleepController({ budgetGiB: 64 });
    controller.register(sleepMember(sleepingName), "sleeping");
    controller.register(sleepMember(pendingName), "ready");
    const identity = liveTestIdentity("llama-server --port 18094");

    expect(readHostStatus(sleepingName, runtimeDir, identity, controller)).toEqual({
      state: "Running",
      pid: process.pid,
      specHash: "hash-s1-sleeping",
      sleep: "sleeping",
    });

    expect(controller.requestSleep(pendingName).kind).toBe("sleep");
    expect(readHostStatus(pendingName, runtimeDir, identity, controller)).toEqual({
      state: "Running",
      pid: process.pid,
      specHash: "hash-s1-pending",
      sleep: "sleep-pending",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #283 sleep-status — kills reporting every registered member as sleeping
// and a sticky/cached sleep marker: a ready member and a member that woke
// and settled back to ready must carry no sleep key at all.
test("#283 sleep-status S2: an awake host reports no sleep", () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-mh-sleep-s2-"));
  const runtimeDir = join(tmp, "runtime");
  try {
    const sleepingName = "s2-sleeping-host";
    const readyName = "s2-ready-host";
    const wokeName = "s2-woke-host";
    writeHostSidecar(runtimeDir, sleepingName, "llamacpp", "hash-s2-sleeping");
    writeHostSidecar(runtimeDir, readyName, "llamacpp", "hash-s2-ready");
    writeHostSidecar(runtimeDir, wokeName, "llamacpp", "hash-s2-woke");
    const controller = createLlamacppSleepController({ budgetGiB: 64 });
    controller.register(sleepMember(sleepingName), "sleeping");
    controller.register(sleepMember(readyName), "ready");
    controller.register(sleepMember(wokeName), "sleeping");
    const identity = liveTestIdentity("llama-server --port 18094");

    expect(readHostStatus(sleepingName, runtimeDir, identity, controller).sleep).toBe("sleeping");

    const ready = readHostStatus(readyName, runtimeDir, identity, controller);
    expect(Object.hasOwn(ready, "sleep")).toBe(false);
    expect(ready).toEqual({ state: "Running", pid: process.pid, specHash: "hash-s2-ready" });

    expect(controller.requestWake(wokeName).kind).toBe("wake");
    controller.wakeSettled(wokeName, "ready");
    const woke = readHostStatus(wokeName, runtimeDir, identity, controller);
    expect(Object.hasOwn(woke, "sleep")).toBe(false);
    expect(woke).toEqual({ state: "Running", pid: process.pid, specHash: "hash-s2-woke" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #283 sleep-status — kills dropping the engine gate (an omlx sidecar must
// never report sleep), the membership check (an unregistered host must
// never report sleep), the Running gate (a Stopped host must never report
// sleep), or the published-controller opt-out (sleepController: null and
// no published controller must report no sleep).
test("#283 sleep-status S3: sleep disabled never reports it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-mh-sleep-s3-"));
  const runtimeDir = join(tmp, "runtime");
  try {
    const sleepingName = "s3-sleeping-host";
    const freeName = "s3-unregistered-host";
    const omlxName = "s3-omlx-host";
    const noSidecarName = "s3-no-sidecar-host";
    const deadPidName = "s3-dead-pid-host";
    writeHostSidecar(runtimeDir, sleepingName, "llamacpp", "hash-s3-sleeping");
    writeHostSidecar(runtimeDir, freeName, "llamacpp", "hash-s3-free");
    writeHostSidecar(runtimeDir, omlxName, "omlx", "hash-s3-omlx");
    writeHostSidecar(runtimeDir, deadPidName, "llamacpp", "hash-s3-deadpid");
    const controller = createLlamacppSleepController({ budgetGiB: 64 });
    for (const name of [sleepingName, omlxName, noSidecarName, deadPidName]) {
      controller.register(sleepMember(name), "sleeping");
    }
    const sleepStatus = await loadSleepStatusModule();
    sleepStatus?.setNodeLlamacppSleepController(controller);
    const llamacppIdentity = liveTestIdentity("llama-server --port 18094");

    try {
      // Control: the published controller reports the sleeping member.
      const control = readHostStatus(sleepingName, runtimeDir, llamacppIdentity);
      expect(control).toEqual({
        state: "Running",
        pid: process.pid,
        specHash: "hash-s3-sleeping",
        sleep: "sleeping",
      });

      // sleepController: null disables the read even with a controller
      // published on the node.
      const disabled = readHostStatus(sleepingName, runtimeDir, llamacppIdentity, null);
      expect(Object.hasOwn(disabled, "sleep")).toBe(false);
      expect(disabled).toEqual({
        state: "Running",
        pid: process.pid,
        specHash: "hash-s3-sleeping",
      });

      // No published controller: the default resolution finds nothing.
      sleepStatus?.setNodeLlamacppSleepController(null);
      const unpublished = readHostStatus(sleepingName, runtimeDir, llamacppIdentity);
      expect(Object.hasOwn(unpublished, "sleep")).toBe(false);
      expect(unpublished).toEqual({
        state: "Running",
        pid: process.pid,
        specHash: "hash-s3-sleeping",
      });

      sleepStatus?.setNodeLlamacppSleepController(controller);

      // Membership gate: a llamacpp host the controller does not track.
      const unregistered = readHostStatus(freeName, runtimeDir, llamacppIdentity);
      expect(unregistered.state).toBe("Running");
      expect(Object.hasOwn(unregistered, "sleep")).toBe(false);
      expect(unregistered).toEqual({
        state: "Running",
        pid: process.pid,
        specHash: "hash-s3-free",
      });

      // Engine gate: an omlx sidecar whose name IS registered sleeping.
      const omlxHost = readHostStatus(
        omlxName,
        runtimeDir,
        liveTestIdentity("omlx-server --port 18095"),
      );
      expect(omlxHost.state).toBe("Running");
      expect(Object.hasOwn(omlxHost, "sleep")).toBe(false);
      expect(omlxHost).toEqual({ state: "Running", pid: process.pid, specHash: "hash-s3-omlx" });

      // Running gate: no sidecar at all for a registered sleeping member.
      const noSidecar = readHostStatus(noSidecarName, runtimeDir, llamacppIdentity);
      expect(noSidecar).toEqual({ state: "Stopped" });
      expect(Object.hasOwn(noSidecar, "sleep")).toBe(false);

      // Running gate: a sidecar whose recorded pid fails the probe.
      const deadPid = readHostStatus(
        deadPidName,
        runtimeDir,
        deadPidIdentity("llama-server --port 18094"),
      );
      expect(deadPid).toEqual({ state: "Stopped" });
      expect(Object.hasOwn(deadPid, "sleep")).toBe(false);
    } finally {
      sleepStatus?.setNodeLlamacppSleepController(null);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #283 sleep-status — kills an implementation that wakes, re-observes, or
// probes /health to decide: the read may snapshot the controller but must
// not mutate it or touch the network.
test("#283 sleep-status S4: the status read never touches a wake path", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-mh-sleep-s4-"));
  const runtimeDir = join(tmp, "runtime");
  const name = "s4-recorder-host";
  try {
    writeHostSidecar(runtimeDir, name, "llamacpp", "hash-s4");
    const inner = createLlamacppSleepController({ budgetGiB: 64 });
    inner.register(sleepMember(name), "sleeping");
    const calls = {
      register: 0,
      requestWake: 0,
      wakeSettled: 0,
      requestSleep: 0,
      sleepSettled: 0,
      observe: 0,
      snapshot: 0,
    };
    const wrapped: LlamacppSleepController = {
      register: (member, state) => {
        calls.register += 1;
        inner.register(member, state);
      },
      requestWake: (id, opts) => {
        calls.requestWake += 1;
        return inner.requestWake(id, opts);
      },
      wakeSettled: (id, outcome) => {
        calls.wakeSettled += 1;
        inner.wakeSettled(id, outcome);
      },
      requestSleep: (id) => {
        calls.requestSleep += 1;
        return inner.requestSleep(id);
      },
      sleepSettled: (id, outcome, cacheIdentity) => {
        calls.sleepSettled += 1;
        inner.sleepSettled(id, outcome, cacheIdentity);
      },
      observe: (id, state) => {
        calls.observe += 1;
        inner.observe(id, state);
      },
      snapshot: () => {
        calls.snapshot += 1;
        return inner.snapshot();
      },
    };
    const sleepStatus = await loadSleepStatusModule();
    sleepStatus?.setNodeLlamacppSleepController(wrapped);
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const result = readHostStatus(
        name,
        runtimeDir,
        liveTestIdentity("llama-server --port 18094"),
      );
      expect(result).toEqual({
        state: "Running",
        pid: process.pid,
        specHash: "hash-s4",
        sleep: "sleeping",
      });
      expect(calls.requestWake).toBe(0);
      expect(calls.wakeSettled).toBe(0);
      expect(calls.requestSleep).toBe(0);
      expect(calls.sleepSettled).toBe(0);
      expect(calls.observe).toBe(0);
      expect(calls.register).toBe(0);
      expect(calls.snapshot).toBeGreaterThan(0);
      expect(fetchSpy.mock.calls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      sleepStatus?.setNodeLlamacppSleepController(null);
    }
    expect(inner.snapshot().members[name]).toEqual({
      state: "sleeping",
      reservation: "released",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// #283 sleep-status — end-to-end through the real router caller: kills
// populating sleep somewhere the router procedure does not reach, or the
// procedure stripping the field before the reconciler sees it.
test("#283 sleep-status S5: the reconciler leaves a node-reported sleeping host alone with zero restarts", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-mh-sleep-e2e-"));
  const devStorage = join(tmp, "devstorage");
  const runtimeDir = join(tmp, "runtime");
  const workloadsDir = join(tmp, "workloads");
  mkdirSync(devStorage, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });
  Object.assign(process.env, {
    DEV_STORAGE: devStorage,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
  });

  const name = "e2e-sleeping-host";
  // argv0 stamps "llama-server" so the router's default pid-identity
  // check corroborates the impostor; it is not a group leader, so the
  // SIGKILL below cannot reach the test runner.
  const impostor = spawn("/bin/sleep", ["60"], { stdio: "ignore", argv0: "llama-server" });
  if (impostor.pid === undefined) throw new Error("impostor spawn failed");
  try {
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "llamacpp",
        pid: impostor.pid,
        host: "127.0.0.1",
        port: 18094,
        modelAliases: [`${name}.gguf`],
        startedAt: new Date().toISOString(),
        specHash: "stale-hash",
      },
      { name },
      resolveEnv(process.env),
    );

    const controller = createLlamacppSleepController({ budgetGiB: 64 });
    controller.register(sleepMember(name), "sleeping");
    const sleepStatus = await loadSleepStatusModule();
    sleepStatus?.setNodeLlamacppSleepController(controller);

    saveModelHost(makeHostManifest(name), workloadsDir);

    const caller = router.createCaller({});
    const starts = new Map<string, number>();
    const stops = new Map<string, number>();
    const client: WorkloadClient = {
      serverStatus: {
        query: () =>
          Promise.resolve({
            state: "down",
            rel: null,
            extraArgs: [],
            pid: null,
            host: null,
            port: null,
            binary: null,
            endpoint: "",
          }),
      },
      serverStop: { mutate: () => Promise.resolve({ stopped: true }) },
      serverStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
      modelHostStatus: {
        query: (input) => caller.modelHostStatus({ workload: input.workload }),
      },
      modelHostStop: {
        mutate: (input) => {
          stops.set(input.workload, (stops.get(input.workload) ?? 0) + 1);
          return Promise.resolve({ stopped: true });
        },
      },
      modelHostStart: {
        subscribe: (input, callbacks) => {
          starts.set(input.workload, (starts.get(input.workload) ?? 0) + 1);
          queueMicrotask(() => {
            callbacks.onData({
              type: "done",
              result: { ok: true, pid: 1, state: "Running" },
            });
            callbacks.onComplete();
          });
          return { unsubscribe: () => undefined };
        },
      },
      rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
      rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
      rpcServerDoctor: {
        query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }),
      },
    };

    for (let pass = 0; pass < 3; pass += 1) {
      const result = await reconcileOnce({ workloadsDir, getClient: () => client });
      expect(result.errors).toBe(0);
      expect(result.reports).toEqual([
        {
          kind: "ModelHost",
          name,
          node: "mac-mini",
          action: "unchanged",
          observed: "sleeping",
        },
      ]);
    }
    expect(starts.get(name) ?? 0).toBe(0);
    expect(stops.get(name) ?? 0).toBe(0);

    const status: SleepAwareStatus = await caller.modelHostStatus({ workload: name });
    expect(status.sleep).toBe("sleeping");

    // Control: with no published controller the same router read carries
    // no sleep claim while the host stays Running.
    sleepStatus?.setNodeLlamacppSleepController(null);
    const control: SleepAwareStatus = await caller.modelHostStatus({ workload: name });
    expect(control.state).toBe("Running");
    expect(Object.hasOwn(control, "sleep")).toBe(false);
  } finally {
    try {
      impostor.kill("SIGKILL");
    } catch {
      // already gone
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
