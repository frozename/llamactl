// #806 phase 3: ModelHost scoped launch end-to-end. startModelHost drives the
// real launch path with a literal launcher (always "scope, here is
// systemd-run") and a spawn spy, so the pre-exec outcomes are exercised
// without a systemd user manager: a scope that execs the engine (marker seen,
// state keeps scopeUnit), a unit collision (pre-exec failure -> exactly one
// direct-spawn fallback, no scopeUnit in the state), a wedged scope (killed,
// then fallback), an engine that exits after exec during the readiness wait,
// and stops landing mid-handshake (the tombstone blocks the fallback so the
// engine is never double-booted).
//
// The fake systemd-run is only ever passed as the launcher's systemdRunPath,
// so it never reads PATH; its argv0 is exec'd to `systemd-run` so the wrapper
// expectation verifies the recorded pid the way the real binary would.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { type EngineScopeLauncher, isScopeUnit } from "../../../core/src/engines/scope.js";
import {
  readModelHostStarting,
  readModelHostState,
  writeModelHostStarting,
} from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { processCommand } from "../../../core/src/pidIdentity.js";
import { workloadRuntimeDir } from "../../../core/src/workloadRuntime.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, stopModelHost } from "../../src/server/modelhost.js";
import {
  baseEnv,
  ephemeralPort,
  type FixtureDirs,
  isProcessAlive,
  killQuiet,
  makeFixtureDirs,
  manifestFor,
  waitFor,
} from "../fixtures/engine-survival-helpers.js";
import { writeFakeSystemdRun } from "../fixtures/fake-systemd-run.js";

const API_KEY = "super-secret-key-value";

let scratchRoot = "";
const spawnedPids: number[] = [];

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  pid: number | undefined;
}

// Records every spawn (command, argv and env) and tracks child pids for the
// afterAll reaper. `override` may substitute a fake child for one call (the
// pid-undefined gate); returning null delegates to the real spawn.
function spawnSpy(
  calls: SpawnCall[],
  spawnedPids: number[],
  override?: (call: SpawnCall) => ChildProcess | null,
): typeof nodeSpawn {
  const spy = mock((command: string, ...rest: unknown[]): ChildProcess => {
    const args = rest[0] as readonly string[] | undefined;
    const options = rest[1] as SpawnOptions | undefined;
    const call: SpawnCall = {
      command,
      args: [...(args ?? [])],
      env: options?.env,
      pid: undefined,
    };
    calls.push(call);
    const child = override?.(call) ?? nodeSpawn(command, args ?? [], options ?? {});
    call.pid = child.pid;
    if (child.pid !== undefined) spawnedPids.push(child.pid);
    return child;
  });
  return spy as typeof nodeSpawn;
}

function literalLauncher(
  systemdRunPath: string,
  establishTimeoutMs: number,
): { launcher: EngineScopeLauncher; noteFailure: ReturnType<typeof mock> } {
  const noteFailure = mock((): void => undefined);
  const launcher: EngineScopeLauncher = {
    establishTimeoutMs,
    unitSuffix: (): string => randomBytes(6).toString("hex"),
    noteFailure,
    resolve: () => Promise.resolve({ ok: true, systemdRunPath }),
  };
  return { launcher, noteFailure };
}

interface Fixture {
  dirs: FixtureDirs;
  name: string;
  env: NodeJS.ProcessEnv;
  resolved: ReturnType<typeof resolveEnv>;
  binary: string;
  port: number;
}

function newFixture(name: string): Fixture {
  const dirs = makeFixtureDirs(scratchRoot);
  const port = ephemeralPort();
  const env = {
    ...baseEnv(dirs, port),
    XDG_RUNTIME_DIR: join(dirs.tmp, "xdg"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    SYSTEMD_LOG_LEVEL: "err",
    OTHER_TOKEN: "other-token-value",
    K: API_KEY,
  };
  return {
    dirs,
    name,
    env,
    resolved: resolveEnv(env),
    binary: join(dirs.binDir, "llama-server"),
    port,
  };
}

function manifest(fixture: Fixture, specOverrides: Record<string, unknown> = {}): unknown {
  return manifestFor(fixture.name, fixture.binary, fixture.dirs.modelsDir, fixture.port, {
    apiKeyRef: "env:K",
    timeoutSeconds: 30,
    ...specOverrides,
  });
}

function scopeStopPath(fixture: Fixture): string {
  return join(workloadRuntimeDir(fixture.resolved, { name: fixture.name }), "modelhost.scope-stop");
}

async function waitForGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for pid ${String(pid)} to exit`);
}

// The stubbed probeReady resolves without waiting for the real engine, so the
// bash wrapper may still be mid-exec when the start returns. stopModelHost's
// pid-identity check needs the post-exec argv0 (`llama-server`), so wait for
// it before stopping — the same observable the identity contract keys on.
async function stopLiveEngine(fixture: Fixture, pid: number): Promise<void> {
  await waitFor(
    () => basename((processCommand(pid) ?? "").split(/\s+/)[0] ?? "") === "llama-server",
    "engine argv0",
    5_000,
  );
  const stop = await stopModelHost({
    key: { name: fixture.name },
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
  });
  expect(stop.ok).toBe(true);
}

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-scope-modelhost-"));
});

afterAll(async () => {
  const survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: spawnedPids });
  rmSync(scratchRoot, { recursive: true, force: true });
  expect(survivors).toEqual([]);
}, 60_000);

test("scoped ModelHost: a scope that execs records scopeUnit and serves the engine", async () => {
  const fixture = newFixture("scope-ok-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  let startingScopeUnit: string | undefined;
  let probeCalls = 0;
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    warn: (message) => warnings.push(message),
    probeReady: (endpoint, timeoutMs, readiness) => {
      probeCalls += 1;
      if (probeCalls === 1) {
        startingScopeUnit = readModelHostStarting(
          { name: fixture.name },
          fixture.resolved,
        )?.scopeUnit;
      }
      return ENGINES.llamacpp.probeReady(endpoint, timeoutMs, readiness);
    },
  });
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("expected a pid");
  expect(calls.length).toBe(1);
  expect(calls[0]?.command).toBe(fake);
  expect(startingScopeUnit !== undefined && isScopeUnit(startingScopeUnit)).toBe(true);
  const state = readModelHostState({ name: fixture.name }, fixture.resolved);
  expect(state?.scopeUnit).toBe(startingScopeUnit);
  expect(Object.keys(state ?? {}).at(-1)).toBe("scopeUnit");
  const command = processCommand(result.pid) ?? "";
  expect(basename(command.split(/\s+/)[0] ?? "")).toBe("llama-server");
  const spawnEnv = calls[0]?.env ?? {};
  expect(Object.keys(spawnEnv).sort()).toEqual(
    [
      "PATH",
      "HOME",
      "LLAMACTL_MODELS_DIR",
      "LLAMA_CPP_MODELS",
      "LLAMA_CPP_BIN",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "LLAMA_API_KEY",
    ].sort(),
  );
  expect(spawnEnv["XDG_RUNTIME_DIR"]).toBe(fixture.env["XDG_RUNTIME_DIR"]);
  expect(spawnEnv["DBUS_SESSION_BUS_ADDRESS"]).toBe(fixture.env["DBUS_SESSION_BUS_ADDRESS"]);
  expect(spawnEnv["LLAMA_API_KEY"]).toBe(API_KEY);
  expect(spawnEnv["OTHER_TOKEN"]).toBeUndefined();
  expect(spawnEnv["SYSTEMD_LOG_LEVEL"]).toBeUndefined();
  expect(spawnEnv["K"]).toBeUndefined();
  expect((calls[0]?.args ?? []).join("\n")).not.toContain(API_KEY);
  expect(warnings).toEqual([]);
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("scoped ModelHost: a unit collision falls back to exactly one direct spawn", async () => {
  const fixture = newFixture("scope-collision-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "collision");
  const { launcher, noteFailure } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const aliveAtSecondCall: boolean[] = [];
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids, (call) => {
      if (calls.length === 2) {
        const firstPid = calls[0]?.pid;
        aliveAtSecondCall.push(firstPid !== undefined && isProcessAlive(firstPid));
      }
      return null;
    }),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    warn: (message) => warnings.push(message),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]?.command).toBe(fake);
  expect(calls[1]?.command).toBe(fixture.binary);
  const dashDash = (calls[0]?.args ?? []).indexOf("--");
  expect(dashDash).toBeGreaterThan(-1);
  const directTail = (calls[0]?.args ?? []).slice(dashDash + 1);
  expect([calls[1]?.command, ...(calls[1]?.args ?? [])]).toEqual(directTail);
  expect(aliveAtSecondCall).toEqual([false]);
  expect(noteFailure).toHaveBeenCalledTimes(1);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/falling back to direct spawn/);
  const state = readModelHostState({ name: fixture.name }, fixture.resolved);
  expect(state !== null && "scopeUnit" in state).toBe(false);
  if (result.pid === null) throw new Error("expected a pid");
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("scoped ModelHost: a refusal before fallback preserves the earlier dispatch", async () => {
  const fixture = newFixture("scope-refused-fallback-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "collision");
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const checkSpawn = (): string | undefined =>
    calls.length === 0 ? undefined : "admission changed before direct spawn";
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    warn: () => undefined,
    checkSpawn,
  });
  expect(calls.map((call) => call.command)).toEqual([fake]);
  expect(result).toMatchObject({
    ok: false,
    pid: null,
    error: "admission changed before direct spawn",
  });
  expect(result.preDispatchRefusal).toBeUndefined();
}, 60_000);

test("scoped ModelHost: a manifest env conflict stays direct", async () => {
  const fixture = newFixture("scope-envconflict-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture, { env: { XDG_RUNTIME_DIR: "/x" } }),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    warn: (message) => warnings.push(message),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(1);
  expect(basename(calls[0]?.command ?? "")).toBe("llama-server");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/env-conflict/);
  if (result.pid === null) throw new Error("expected a pid");
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("scoped ModelHost: engineScope null stays direct without bus env", async () => {
  const fixture = newFixture("scope-null-host");
  const calls: SpawnCall[] = [];
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: null,
    signal: AbortSignal.timeout(15_000),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(1);
  expect(basename(calls[0]?.command ?? "")).toBe("llama-server");
  expect(calls[0]?.env?.["XDG_RUNTIME_DIR"]).toBeUndefined();
  expect(calls[0]?.env?.["DBUS_SESSION_BUS_ADDRESS"]).toBeUndefined();
  if (result.pid === null) throw new Error("expected a pid");
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("scoped ModelHost: a pid-less wrapper spawn falls back direct", async () => {
  const fixture = newFixture("scope-nopid-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher, noteFailure } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  let firstCall = true;
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids, (call) => {
      if (firstCall && call.command === fake) {
        firstCall = false;
        return new EventEmitter() as ChildProcess;
      }
      return null;
    }),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]?.command).toBe(fake);
  expect(calls[1]?.command).toBe(fixture.binary);
  expect(noteFailure).toHaveBeenCalledTimes(1);
  if (result.pid === null) throw new Error("expected a pid");
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("scoped ModelHost: a wedged scope is killed then falls back", async () => {
  const fixture = newFixture("scope-hang-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "hang");
  const { launcher } = literalLauncher(fake, 300);
  const calls: SpawnCall[] = [];
  const aliveAtSecondCall: boolean[] = [];
  const started = Date.now();
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids, (call) => {
      if (calls.length === 2) {
        const firstPid = calls[0]?.pid;
        aliveAtSecondCall.push(firstPid !== undefined && isProcessAlive(firstPid));
      }
      return null;
    }),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  expect(Date.now() - started).toBeLessThan(7_000);
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]?.command).toBe(fake);
  expect(aliveAtSecondCall).toEqual([false]);
  if (result.pid === null) throw new Error("expected a pid");
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("scoped ModelHost: an engine exit during readiness fails fast", async () => {
  const fixture = newFixture("scope-exit-host");
  const sleepyBin = join(fixture.dirs.tmp, "llama-server-sleepy");
  writeFileSync(sleepyBin, "#!/bin/bash\nsleep 0.3\nexit 2\n", { mode: 0o755 });
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher, noteFailure } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const started = Date.now();
  const engine = ENGINES.llamacpp;
  const originalTeardown = engine.teardown.bind(engine);
  const tornDown: number[] = [];
  engine.teardown = mock((target: number) => {
    tornDown.push(target);
    return Promise.resolve();
  });
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: manifestFor(fixture.name, sleepyBin, fixture.dirs.modelsDir, fixture.port, {
        timeoutSeconds: 30,
      }),
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn: spawnSpy(calls, spawnedPids),
      engineScope: launcher,
      signal: AbortSignal.timeout(10_000),
      probeReady: () =>
        new Promise<{ ready: boolean; modelIds: string[] }>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ ready: false, modelIds: [] });
          }, 30_000);
          timer.unref();
        }),
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited before readiness \(code 2/);
    expect(result.error).not.toBe("modelHostStart aborted");
    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toBe(fake);
    expect(noteFailure).not.toHaveBeenCalled();
    expect(
      existsSync(
        join(workloadRuntimeDir(fixture.resolved, { name: fixture.name }), "modelhost.starting"),
      ),
    ).toBe(false);
    expect(result.spawnedPid).not.toBeUndefined();
    expect(tornDown).toEqual([]);
  } finally {
    engine.teardown = originalTeardown;
  }
}, 30_000);

test("scoped ModelHost: a stop mid-handshake tombstones the unit and skips fallback", async () => {
  const fixture = newFixture("scope-term-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "term-exit-1");
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const startPromise = startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: AbortSignal.timeout(40_000),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  // The fake re-execs itself with argv0 `systemd-run` before it installs its
  // TERM trap and parks. Wait for BOTH the starting record (the spawn landed)
  // and that identity to be observable, so stopModelHost verifies the wrapper
  // as alive (and tombstones it) instead of racing the exec and reporting an
  // unverifiable pid that skips both signal and tombstone.
  let wrapperPid = 0;
  let scopeUnit = "";
  await waitFor(
    () => {
      const starting = readModelHostStarting({ name: fixture.name }, fixture.resolved);
      if (starting?.scopeUnit === undefined) return false;
      wrapperPid = starting.pid;
      scopeUnit = starting.scopeUnit;
      const command = processCommand(wrapperPid) ?? "";
      return basename(command.split(/\s+/)[0] ?? "") === "systemd-run";
    },
    "scoped wrapper identity",
    3_000,
  );
  const stop = await stopModelHost({
    key: { name: fixture.name },
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
  });
  const result = await startPromise;
  expect(stop).toEqual({ ok: true, pid: wrapperPid });
  const tombstone = JSON.parse(readFileSync(scopeStopPath(fixture), "utf8")) as {
    scopeUnit?: unknown;
  };
  expect(tombstone.scopeUnit).toBe(scopeUnit);
  expect(result.ok).toBe(false);
  expect(calls.length).toBe(1);
  const hostDir = workloadRuntimeDir(fixture.resolved, { name: fixture.name });
  expect(existsSync(join(hostDir, "modelhost.starting"))).toBe(false);
  expect(existsSync(join(hostDir, "modelhost.state"))).toBe(false);
  expect(isProcessAlive(wrapperPid)).toBe(false);
}, 60_000);

test("scoped ModelHost: a gated stop teardown still blocks the fallback", async () => {
  const fixture = newFixture("scope-gated-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "term-exit-1");
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const startPromise = startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: AbortSignal.timeout(40_000),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  let wrapperPid = 0;
  let scopeUnit = "";
  await waitFor(
    () => {
      const starting = readModelHostStarting({ name: fixture.name }, fixture.resolved);
      if (starting?.scopeUnit === undefined) return false;
      wrapperPid = starting.pid;
      scopeUnit = starting.scopeUnit;
      const command = processCommand(wrapperPid) ?? "";
      return basename(command.split(/\s+/)[0] ?? "") === "systemd-run";
    },
    "scoped wrapper identity",
    3_000,
  );
  // The teardown spy writes the tombstone and SIGTERMs the wrapper but holds
  // its promise until the start has settled, so the starting record is still
  // on disk while the launch evaluates its fallback gate — the deterministic
  // shape the M5 mutant (ignoring the tombstone) cannot survive.
  let releaseTeardown: () => void = () => undefined;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const hostDir = workloadRuntimeDir(fixture.resolved, { name: fixture.name });
  const teardownSpy = mock((pid: number, _graceSeconds?: number): Promise<void> => {
    writeFileSync(join(hostDir, "modelhost.scope-stop"), JSON.stringify({ scopeUnit }));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    return teardownGate.then(() => waitForGone(pid));
  });
  const stopPromise = stopModelHost({
    key: { name: fixture.name },
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    teardown: teardownSpy,
  });
  const startResult = await startPromise;
  expect(startResult.ok).toBe(false);
  expect(calls.length).toBe(1);
  releaseTeardown();
  const stopResult = await stopPromise;
  expect(stopResult).toEqual({ ok: true, pid: wrapperPid });
  expect(existsSync(join(hostDir, "modelhost.starting"))).toBe(false);
  expect(existsSync(join(hostDir, "modelhost.state"))).toBe(false);
}, 60_000);

test("direct ModelHost: a failed starting-record write tears down the spawned engine", async () => {
  const fixture = newFixture("scope-writefail-direct-host");
  const hostDir = workloadRuntimeDir(fixture.resolved, { name: fixture.name });
  let launchedPid: number | undefined;
  const spawn = mock((command: string, ...rest: unknown[]): ChildProcess => {
    const args = rest[0] as readonly string[] | undefined;
    const options = rest[1] as SpawnOptions | undefined;
    const child = nodeSpawn(command, args ?? [], options ?? {});
    if (child.pid !== undefined) {
      launchedPid = child.pid;
      spawnedPids.push(child.pid);
    }
    mkdirSync(hostDir, { recursive: true });
    chmodSync(hostDir, 0o555);
    return child;
  });
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: manifest(fixture),
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn: spawn as typeof nodeSpawn,
      engineScope: null,
      signal: AbortSignal.timeout(15_000),
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("modelhost.starting");
    expect(launchedPid).toBeDefined();
    expect(result.spawnedPid).toBe(launchedPid);
    if (launchedPid !== undefined) await waitForGone(launchedPid);
  } finally {
    if (existsSync(hostDir)) chmodSync(hostDir, 0o755);
  }
}, 30_000);

test("scoped ModelHost: a failed starting-record write tears down the spawned wrapper", async () => {
  const fixture = newFixture("scope-writefail-scoped-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = literalLauncher(fake, 20_000);
  const hostDir = workloadRuntimeDir(fixture.resolved, { name: fixture.name });
  let launchedPid: number | undefined;
  const spawn = mock((command: string, ...rest: unknown[]): ChildProcess => {
    const args = rest[0] as readonly string[] | undefined;
    const options = rest[1] as SpawnOptions | undefined;
    const child = nodeSpawn(command, args ?? [], options ?? {});
    if (child.pid !== undefined) {
      launchedPid = child.pid;
      spawnedPids.push(child.pid);
    }
    mkdirSync(hostDir, { recursive: true });
    chmodSync(hostDir, 0o555);
    return child;
  });
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: manifest(fixture),
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn: spawn as typeof nodeSpawn,
      engineScope: launcher,
      signal: AbortSignal.timeout(15_000),
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("modelhost.starting");
    expect(launchedPid).toBeDefined();
    expect(result.spawnedPid).toBe(launchedPid);
    if (launchedPid !== undefined) await waitForGone(launchedPid);
  } finally {
    if (existsSync(hostDir)) chmodSync(hostDir, 0o755);
  }
}, 30_000);

test("scoped ModelHost: aborting the handshake clears the starting record", async () => {
  const fixture = newFixture("scope-abort-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "hang");
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const controller = new AbortController();
  const started = Date.now();
  const startPromise = startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: controller.signal,
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  let wrapperPid = 0;
  await waitFor(
    () => {
      const starting = readModelHostStarting({ name: fixture.name }, fixture.resolved);
      if (starting?.scopeUnit === undefined) return false;
      wrapperPid = starting.pid;
      return true;
    },
    "scoped starting record",
    3_000,
  );
  const remaining = 300 - (Date.now() - started);
  if (remaining > 0) await Bun.sleep(remaining);
  controller.abort();
  const result = await startPromise;
  expect(result.ok).toBe(false);
  expect(result.error).toBe("modelHostStart aborted");
  expect(result.spawnedPid).toBe(wrapperPid);
  expect(readModelHostStarting({ name: fixture.name }, fixture.resolved)).toBeNull();
  expect(isProcessAlive(wrapperPid)).toBe(false);
}, 30_000);

test("scoped ModelHost: a hung-unreaped wrapper keeps its starting record", async () => {
  const fixture = newFixture("scope-unreaped-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = literalLauncher(fake, 50);
  const sleeper = nodeSpawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
  const pid = sleeper.pid;
  if (pid === undefined) throw new Error("sleeper spawn returned no pid");
  const unreapedChild = Object.assign(new EventEmitter() as ChildProcess, {
    pid,
    exitCode: null,
    signalCode: null,
  });
  const calls: SpawnCall[] = [];
  let firstCall = true;
  const engine = ENGINES.llamacpp;
  const originalTeardown = engine.teardown.bind(engine);
  engine.teardown = mock((_target: number) => Promise.resolve());
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: manifest(fixture),
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn: spawnSpy(calls, spawnedPids, (call) => {
        if (firstCall && call.command === fake) {
          firstCall = false;
          return unreapedChild;
        }
        return null;
      }),
      engineScope: launcher,
      signal: AbortSignal.timeout(15_000),
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("scope did not exit after SIGKILL");
    expect(result.spawnedPid).toBe(pid);
    expect(calls.length).toBe(1);
    const starting = readModelHostStarting({ name: fixture.name }, fixture.resolved);
    expect(starting?.pid).toBe(pid);
    expect(starting?.scopeUnit !== undefined && isScopeUnit(starting.scopeUnit)).toBe(true);
  } finally {
    engine.teardown = originalTeardown;
    killQuiet(pid);
  }
}, 30_000);

function writeDelayedCollisionSystemdRun(dir: string): string {
  const path = join(dir, "fake-systemd-run-collision-delayed.sh");
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      'if [ -z "$__FAKE_SDRUN" ]; then export __FAKE_SDRUN=1; exec -a systemd-run /bin/bash "$0" "$@"; fi',
      "unset __FAKE_SDRUN",
      'unit=""; while [ $# -gt 0 ]; do case "$1" in --unit=*) unit="${1#--unit=}";; --) shift; break;; esac; shift; done',
      'echo "Failed to start transient scope unit: Unit ${unit}.scope was already loaded or has a fragment file." >&2',
      "sleep 0.5",
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

test("scoped ModelHost: a replaced starting record blocks the direct fallback", async () => {
  const fixture = newFixture("scope-gate-owner-host");
  const fake = writeDelayedCollisionSystemdRun(fixture.dirs.tmp);
  const { launcher } = literalLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const startPromise = startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
  let wrapperPid = 0;
  await waitFor(
    () => {
      const starting = readModelHostStarting({ name: fixture.name }, fixture.resolved);
      if (starting?.scopeUnit === undefined) return false;
      wrapperPid = starting.pid;
      return true;
    },
    "scoped starting record",
    3_000,
  );
  writeModelHostStarting(
    {
      kind: "ModelHostStarting",
      engine: "llamacpp",
      pid: wrapperPid + 1000,
      startedAt: new Date().toISOString(),
      scopeUnit: "llamactl-engine-foreign-0123456789ab.scope",
    },
    { name: fixture.name },
    fixture.resolved,
  );
  const result = await startPromise;
  expect(result.ok).toBe(false);
  expect(calls.length).toBe(1);
}, 30_000);
