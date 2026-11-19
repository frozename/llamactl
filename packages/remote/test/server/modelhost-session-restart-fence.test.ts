/**
 * #520 — startModelHost restart fence. When a restart would tear down a
 * live prior host — the recorded-pid reap path or the spec-drift adopt
 * path — the DF-05 lease drain and the session-refcount registry must
 * refuse it first: LeasesActive keeps precedence, an idle-live session
 * refuses SessionsActive, a throwing session check SessionsUnknown, and a
 * foreign drain DrainInProgress. A refusal tears nothing down and spawns
 * nothing; the drain is cancelled so the workload returns to open. The
 * helpers below are copied from modelhost.test.ts rather than imported so
 * this file stays self-contained.
 */
import type { spawn as nodeSpawn } from "node:child_process";

import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  currentSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PidIdentityDeps } from "../../../core/src/pidIdentity.js";

import { ENGINES } from "../../../core/src/engines/index.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { startModelHost } from "../../src/server/modelhost.js";

interface ManifestFixture {
  manifest: {
    readonly apiVersion: "llamactl/v1";
    readonly kind: "ModelHost";
    readonly metadata: { readonly name: "mlx-host-server" };
    readonly spec: {
      readonly engine: "omlx";
      readonly node: "local";
      readonly enabled: true;
      readonly binary: string;
      readonly endpoint: { readonly host: "127.0.0.1"; readonly port: 8094 };
      readonly hostedModels: readonly [{ readonly rel: "mlx-community/Qwen3-8B-MLX-4bit" }];
      readonly extraArgs: readonly ["--max-concurrent-requests", "1"];
      readonly restartPolicy: "Always";
      readonly timeoutSeconds: 60;
    };
  };
  workloadsDir: string;
  runtimeDir: string;
}

function makeManifest(tmp: string): ManifestFixture {
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  const fakeBinary = join(tmp, "omlx");
  mkdirSync(workloadsDir, { recursive: true });
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  const manifest = {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: "mlx-host-server" },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: fakeBinary,
      endpoint: { host: "127.0.0.1", port: 8094 },
      hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
      extraArgs: ["--max-concurrent-requests", "1"],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  } as const;
  writeFileSync(
    join(workloadsDir, "mlx-host-server.yaml"),
    `apiVersion: llamactl/v1\nkind: ModelHost\nmetadata:\n  name: mlx-host-server\nspec:\n  engine: omlx\n  node: local\n  enabled: true\n  binary: ${fakeBinary}\n  endpoint:\n    host: 127.0.0.1\n    port: 8094\n  hostedModels:\n    - rel: mlx-community/Qwen3-8B-MLX-4bit\n  extraArgs:\n    - --max-concurrent-requests\n    - '1'\n  restartPolicy: Always\n  timeoutSeconds: 60\n`,
  );
  return { manifest, workloadsDir, runtimeDir };
}

function modelHostEnv(tmp: string): NodeJS.ProcessEnv {
  const modelsDir = join(tmp, "models");
  mkdirSync(modelsDir, { recursive: true });
  return {
    ...process.env,
    LLAMACTL_MODELS_DIR: modelsDir,
    LLAMA_CPP_MODELS: modelsDir,
  };
}

// These tests record this test process as the host pid — it cannot be
// killed — so the injected probe reports it gone once teardown ran,
// standing in for the confirmed release a real teardown produces.
function releasableSelfIdentity(command: string): {
  identity: PidIdentityDeps;
  release: () => void;
} {
  let released = false;
  return {
    identity: {
      processStartMs: () => 0,
      processCommand: () => command,
      probe: (): void => {
        if (released) {
          const err: NodeJS.ErrnoException = new Error(" ESRCH");
          err.code = "ESRCH";
          throw err;
        }
      },
    },
    release: (): void => {
      released = true;
    },
  };
}

// A pid that is essentially never alive (above any plausible pid_max), so
// process.kill(pid, 0) reliably throws ESRCH → treated as dead.
const DEAD_PID = 2 ** 31 - 1;

function seedDeadSidecar(runtimeDir: string, specHash?: string): string {
  const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
  mkdirSync(hostDir, { recursive: true });
  const state = {
    kind: "ModelHost",
    engine: "omlx",
    pid: DEAD_PID,
    host: "127.0.0.1",
    port: 8094,
    modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
    startedAt: new Date().toISOString(),
    ...(specHash !== undefined ? { specHash } : {}),
  };
  writeFileSync(join(hostDir, "modelhost.state"), JSON.stringify(state));
  writeFileSync(join(hostDir, "modelhost.pid"), `${String(DEAD_PID)}\n`);
  return hostDir;
}

// A prior LIVE host recorded as this test process: the pid file and sidecar
// name process.pid, which the injected releasableSelfIdentity probe reports
// alive until teardown releases it.
function seedLiveSelfHost(runtimeDir: string): string {
  const hostDir = join(runtimeDir, "workloads", "mlx-host-server");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "modelhost.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(hostDir, "modelhost.state"),
    JSON.stringify({
      kind: "ModelHost",
      engine: "omlx",
      pid: process.pid,
      host: "127.0.0.1",
      port: 8094,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
      startedAt: new Date().toISOString(),
    }),
  );
  return hostDir;
}

// Acquire then release leaves the session idle but still bound: refs 0 with
// a fresh lastActivityMs, so checkUnload reports it until the idle timeout.
function bindIdleSession(sessions: SessionRefcounts, id: string, workload: string): void {
  const acquired = sessions.acquire(id, workload);
  if (!acquired.ok) {
    throw new Error(`session acquire(${id} on ${workload}) refused`);
  }
  sessions.release(id, acquired.generation);
}

function installRegistries(now: () => number): {
  leases: ResidencyLeases;
  sessions: SessionRefcounts;
  restore: () => void;
} {
  const previousLeases = getResidencyLeaseRegistry();
  const previousSessions = currentSessionRefcounts();
  const leases = createResidencyLeases();
  const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000, now });
  setResidencyLeaseRegistry(leases);
  setSessionRefcountRegistry(sessions);
  return {
    leases,
    sessions,
    restore: (): void => {
      setResidencyLeaseRegistry(previousLeases);
      setSessionRefcountRegistry(previousSessions);
    },
  };
}

function stubOmxTeardown(tornDown: number[], release?: () => void): () => void {
  const engine = ENGINES.omlx;
  const originalTeardown = engine.teardown.bind(engine);
  engine.teardown = mock((pid: number) => {
    tornDown.push(pid);
    release?.();
    return Promise.resolve();
  });
  return (): void => {
    engine.teardown = originalTeardown;
  };
}

describe("server/modelhost restart session fence (#520)", () => {
  test("refuses the restart as SessionsActive while an idle-live session is bound", async () => {
    // Kills: dropping the session check on the recorded-pid reap path,
    // force-releasing sessions instead of refusing, a missing cancelDrain
    // (the workload stays draining), or a refusal that still tears down.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-sessions-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const clock = 0;
    const { leases, sessions, restore } = installRegistries(() => clock);
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    const hostDir = seedLiveSelfHost(runtimeDir);
    bindIdleSession(sessions, "s1", "mlx-host-server");
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        "SessionsActive: s1 — refusing to restart ModelHost mlx-host-server while a session is bound to its running instance",
      );
      expect(result.refused).toEqual({ reason: "SessionsActive", active: ["s1"] });
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      const state = JSON.parse(readFileSync(join(hostDir, "modelhost.state"), "utf8")) as {
        pid?: number;
      };
      expect(state.pid).toBe(process.pid);
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
      expect(sessions.activeSessions("mlx-host-server")).toEqual(["s1"]);
    } finally {
      restoreTeardown();
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("fails closed as SessionsUnknown when the session check throws", async () => {
    // Kills: swallowing a checkUnload throw (the restart proceeds to
    // teardown) or treating the throw as an empty-ok check.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-unknown-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const previousLeases = getResidencyLeaseRegistry();
    const previousSessions = currentSessionRefcounts();
    const leases = createResidencyLeases();
    const real = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 0 });
    const broken: SessionRefcounts = {
      ...real,
      checkUnload: () => {
        throw new Error("boom");
      },
    };
    setResidencyLeaseRegistry(leases);
    setSessionRefcountRegistry(broken);
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    seedLiveSelfHost(runtimeDir);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.refused).toEqual({ reason: "SessionsUnknown", active: [] });
      expect(result.error).toStartWith("SessionsUnknown:");
      expect(result.error).toContain(
        "refusing to restart ModelHost mlx-host-server while a session is bound to its running instance",
      );
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
    } finally {
      restoreTeardown();
      setResidencyLeaseRegistry(previousLeases);
      setSessionRefcountRegistry(previousSessions);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("keeps LeasesActive precedence over a bound session", async () => {
    // Kills: dropping the active-lease check, swapped refusal tails,
    // consulting sessions before leases (the session would win instead), or
    // deleting registry.cancelDrain(drain.token) in the LeasesActive branch
    // of fencePriorHostTeardown (the workload is left draining forever).
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-leases-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const clock = 0;
    const { leases, sessions, restore } = installRegistries(() => clock);
    const acquired = leases.acquire("mlx-host-server");
    if (!acquired.ok) {
      throw new Error("expected lease acquire to succeed");
    }
    const lease = acquired.lease;
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    seedLiveSelfHost(runtimeDir);
    bindIdleSession(sessions, "s1", "mlx-host-server");
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.refused).toEqual({ reason: "LeasesActive", active: [lease.id] });
      expect(result.error).toBe(
        `LeasesActive: ${lease.id} — refusing to restart ModelHost mlx-host-server while residency leases are held`,
      );
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(leases.active("mlx-host-server")).toContain(lease.id);
      // The refusal cancelled its drain: the workload is open again while
      // the lease is still held, and stays open once the lease is released.
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
      lease.release();
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
    } finally {
      restoreTeardown();
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("holds the DF-05 drain while the prior host is torn down", async () => {
    // Kills: running the teardown outside the drain (cancelling it before
    // run(), or skipping beginDrain once the fence checks pass) — the
    // in-teardown acquire would succeed — and deleting the finally
    // registry.cancelDrain(drain.token) in fencePriorHostTeardown (the
    // workload stays draining after startModelHost returns).
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-held-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const clock = 0;
    const { leases, restore } = installRegistries(() => clock);
    const { identity } = releasableSelfIdentity("omlx");
    const duringTeardown: { ok: boolean; reason?: string; phase: string }[] = [];
    const engine = ENGINES.omlx;
    const originalTeardown = engine.teardown.bind(engine);
    // The stub never releases the self pid, so the prior host survives
    // teardown and the restart defers without spawning a replacement.
    engine.teardown = mock(() => {
      const attempt = leases.acquire("mlx-host-server");
      if (attempt.ok) {
        attempt.lease.release();
        duringTeardown.push({ ok: true, phase: leases.snapshot("mlx-host-server").phase });
      } else {
        duringTeardown.push({
          ok: false,
          reason: attempt.reason,
          phase: leases.snapshot("mlx-host-server").phase,
        });
      }
      return Promise.resolve();
    });
    seedLiveSelfHost(runtimeDir);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(duringTeardown).toEqual([{ ok: false, reason: "Draining", phase: "draining" }]);
      expect(result.ok).toBe(false);
      expect(result.refused).toBeUndefined();
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
    } finally {
      engine.teardown = originalTeardown;
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses as DrainInProgress on a foreign drain", async () => {
    // Kills: treating an AlreadyDraining beginDrain as unfenced — the
    // restart would tear down a host another drain already fenced.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-drain-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const clock = 0;
    const { leases, restore } = installRegistries(() => clock);
    const foreign = leases.beginDrain("mlx-host-server");
    if (!foreign.ok) {
      throw new Error("expected foreign beginDrain to succeed");
    }
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    seedLiveSelfHost(runtimeDir);
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(false);
      expect(result.refused).toEqual({ reason: "DrainInProgress", active: [] });
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(leases.snapshot("mlx-host-server").phase).toBe("draining");
    } finally {
      leases.cancelDrain(foreign.token);
      restoreTeardown();
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("fences the spec-drift adopt branch before any teardown", async () => {
    // Kills: fencing only the recorded-pid branch — the drift path finds a
    // live listener via findListenerPid and would tear it down with a
    // session bound.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-drift-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const clock = 0;
    const { leases, sessions, restore } = installRegistries(() => clock);
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown);
    const spawn = mock(() => ({ pid: 4321 }));
    const findListenerPid = mock(() => Promise.resolve(process.pid));
    // 'stale' never equals the applied spec hash, so the live listener is
    // spec-drifted and the restart path tears it down — unless fenced.
    seedDeadSidecar(runtimeDir, "stale");
    bindIdleSession(sessions, "s1", "mlx-host-server");
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () =>
          Promise.resolve({
            ready: true,
            modelIds: ["mlx-community/Qwen3-8B-MLX-4bit"],
          }),
        findListenerPid,
      });

      expect(result.ok).toBe(false);
      expect(result.refused).toEqual({ reason: "SessionsActive", active: ["s1"] });
      expect(result.error).toContain(
        "refusing to restart ModelHost mlx-host-server while a session is bound to its running instance",
      );
      expect(findListenerPid).toHaveBeenCalledTimes(1);
      expect(tornDown).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
    } finally {
      restoreTeardown();
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("guard: an expired session does not block the restart", async () => {
    // GUARD — passes at base: pins that the session check prunes on the
    // idle timeout, killing a fence keyed on raw entries rather than
    // checkUnload, and a missing finally cancelDrain after a successful
    // teardown.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-expired-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    let clock = 0;
    const { leases, sessions, restore } = installRegistries(() => clock);
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    seedLiveSelfHost(runtimeDir);
    bindIdleSession(sessions, "s1", "mlx-host-server");
    clock = 60_000;
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([process.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(leases.snapshot("mlx-host-server").phase).toBe("open");
      const drain = leases.beginDrain("mlx-host-server");
      expect(drain.ok).toBe(true);
      if (drain.ok) {
        leases.cancelDrain(drain.token);
      }
    } finally {
      restoreTeardown();
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("guard: a session bound to another workload does not block", async () => {
    // GUARD — passes at base: pins that the session check is scoped to the
    // restarted workload, killing a mutant that checks the wrong workload.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-other-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const clock = 0;
    const { sessions, restore } = installRegistries(() => clock);
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    seedLiveSelfHost(runtimeDir);
    bindIdleSession(sessions, "s1", "other-wl");
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([process.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      restoreTeardown();
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("guard: sessions are not consulted without a lease registry", async () => {
    // GUARD — passes at base, mirroring core #734: the session check runs
    // only under a DF-05 drain, so with no lease registry installed a bound
    // session must not block the restart.
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-fence-nolease-"));
    const { workloadsDir, runtimeDir } = makeManifest(tmp);
    const previousLeases = getResidencyLeaseRegistry();
    const previousSessions = currentSessionRefcounts();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 0 });
    setResidencyLeaseRegistry(null);
    setSessionRefcountRegistry(sessions);
    const { identity, release } = releasableSelfIdentity("omlx");
    const tornDown: number[] = [];
    const restoreTeardown = stubOmxTeardown(tornDown, release);
    const spawn = mock(() => ({ pid: 4321 }));
    seedLiveSelfHost(runtimeDir);
    bindIdleSession(sessions, "s1", "mlx-host-server");
    try {
      const result = await startModelHost({
        key: { name: "mlx-host-server" },
        workloadsDir,
        runtimeDir,
        env: modelHostEnv(tmp),
        identity,
        spawn: spawn as unknown as typeof nodeSpawn,
        probeReady: () => Promise.resolve({ ready: true, modelIds: [] }),
      });

      expect(result.ok).toBe(true);
      expect(tornDown).toEqual([process.pid]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      restoreTeardown();
      setResidencyLeaseRegistry(previousLeases);
      setSessionRefcountRegistry(previousSessions);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
