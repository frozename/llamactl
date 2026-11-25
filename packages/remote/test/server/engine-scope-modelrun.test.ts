// #806 phase 3: ModelRun scoped launch end-to-end. startServer drives the real
// launch path with a literal launcher (always "scope, here is systemd-run") and
// a spawn spy, so the three pre-exec outcomes are exercised without a systemd
// user manager: a scope that execs the engine (marker seen, sidecar keeps
// scopeUnit), a unit collision (pre-exec failure -> exactly one direct-spawn
// fallback, no scopeUnit in the sidecar), and a teardown landing mid-handshake
// (tombstone blocks the fallback so the engine is never double-booted).
//
// The fake systemd-run is only ever passed as the launcher's systemdRunPath, so
// it never reads PATH; its argv0 is exec'd to `systemd-run` so the wrapper
// expectation verifies the recorded pid the way the real binary would.

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EngineScopeLauncher,
  isScopeUnit,
  readScopePending,
  writeScopePending,
} from "../../../core/src/engines/scope.js";
import { resolveEnv } from "../../../core/src/env.js";
import { type PidIdentityDeps, processCommand } from "../../../core/src/pidIdentity.js";
import {
  readServerPid,
  readServerState,
  type ServerState,
  serverStatus,
  startServer,
  type StartServerResult,
  stopServer,
} from "../../../core/src/server.js";
import { workloadRuntimeDir } from "../../../core/src/workloadRuntime.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import {
  baseEnv,
  ephemeralPort,
  type FixtureDirs,
  makeFixtureDirs,
  waitFor,
} from "../fixtures/engine-survival-helpers.js";
import { writeFakeSystemdRun } from "../fixtures/fake-systemd-run.js";

const TARGET_REL = "survival/survival-model.gguf";
const PENDING = "llama-server.scope-pending";
const STOP = "llama-server.scope-stop";

let scratchRoot = "";
const spawnedPids: number[] = [];
const rawSpawn = nodeSpawn as unknown as (
  command: string,
  args: readonly string[] | undefined,
  options: unknown,
) => ChildProcess;

type Call = [string, string[], number | undefined];

function makeSpawnSpy(calls: Call[]): typeof nodeSpawn {
  const spy = (command: string, args?: readonly string[], options?: unknown): ChildProcess => {
    const child = rawSpawn(command, args, options);
    calls.push([command, [...(args ?? [])], child.pid]);
    if (child.pid !== undefined) {
      spawnedPids.push(child.pid);
    }
    return child;
  };
  return spy as unknown as typeof nodeSpawn;
}

function literalLauncher(systemdRunPath: string, establishTimeoutMs: number): EngineScopeLauncher {
  return {
    establishTimeoutMs,
    unitSuffix: (): string => randomBytes(6).toString("hex"),
    noteFailure: (): void => undefined,
    resolve: () => Promise.resolve({ ok: true, systemdRunPath }),
  };
}

interface Fixture {
  readonly dirs: FixtureDirs;
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  readonly resolved: ReturnType<typeof resolveEnv>;
  readonly endpoint: { host: string; port: number };
}

function newFixture(name: string): Fixture {
  const dirs = makeFixtureDirs(scratchRoot);
  const port = ephemeralPort();
  const env = baseEnv(dirs, port);
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model.gguf"), "");
  return {
    dirs,
    name,
    env,
    resolved: resolveEnv(env),
    endpoint: { host: "127.0.0.1", port },
  };
}

function pendingPath(fixture: Fixture): string {
  return join(fixture.dirs.runtimeDir, "workloads", fixture.name, PENDING);
}

function stopPath(fixture: Fixture): string {
  return join(fixture.dirs.runtimeDir, "workloads", fixture.name, STOP);
}

function writeTrackingRecord(fixture: Fixture, pid: number, scopeUnit?: string): void {
  const dir = workloadRuntimeDir(fixture.resolved, { name: fixture.name });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(pid)}\n`);
  const state: ServerState = {
    rel: TARGET_REL,
    extraArgs: [],
    host: fixture.endpoint.host,
    port: String(fixture.endpoint.port),
    binary: join(fixture.dirs.binDir, "llama-server"),
    pid,
    startedAt: new Date().toISOString(),
    tunedProfile: null,
    ...(scopeUnit !== undefined ? { scopeUnit } : {}),
  };
  writeFileSync(join(dir, "llama-server.state"), JSON.stringify(state, null, 2));
}

function trackSpawned(child: ChildProcess): ChildProcess {
  if (child.pid !== undefined) spawnedPids.push(child.pid);
  return child;
}

function spawnPlainSleeper(): ChildProcess {
  return trackSpawned(
    nodeSpawn("/bin/sleep", ["30"], {
      stdio: "ignore",
      argv0: "llama-server",
      detached: true,
    }),
  );
}

function spawnEngineCommandSleeper(): ChildProcess {
  return trackSpawned(
    nodeSpawn("/bin/bash", ["-c", "while :; do sleep 0.2; done", TARGET_REL], {
      stdio: "ignore",
      argv0: "llama-server",
      detached: true,
    }),
  );
}

function wrapperIdentity(scopeUnit: string): PidIdentityDeps {
  const base = scopeUnit.slice(0, -".scope".length);
  return {
    processCommand: () =>
      `systemd-run --user --scope --unit=${base} --collect -- /opt/llama-server -m model.gguf`,
    expectCommand: { binary: "llama-server", args: [TARGET_REL] },
  };
}

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-scope-modelrun-"));
});

afterAll(async () => {
  const survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: spawnedPids });
  rmSync(scratchRoot, { recursive: true, force: true });
  expect(survivors).toEqual([]);
}, 60_000);

test("scoped ModelRun: a scope that execs records scopeUnit and clears pending", async () => {
  const fixture = newFixture("scope-ok");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const calls: Call[] = [];
  const result: StartServerResult = await startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: makeSpawnSpy(calls),
    engineScope: literalLauncher(fake, 20_000),
    signal: AbortSignal.timeout(30_000),
  });
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toBe(fake);
  const state = readServerState({ name: fixture.name }, fixture.resolved);
  expect(state !== null && isScopeUnit(state.scopeUnit)).toBe(true);
  expect(Object.keys(state ?? {}).at(-1)).toBe("scopeUnit");
  expect(existsSync(pendingPath(fixture))).toBe(false);
  expect(existsSync(stopPath(fixture))).toBe(false);
  await stopServer({ key: { name: fixture.name }, resolved: fixture.resolved });
}, 90_000);

test("scoped ModelRun: a unit collision falls back to exactly one direct spawn", async () => {
  const fixture = newFixture("scope-collision");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "collision");
  const calls: Call[] = [];
  const retryReasons: string[] = [];
  const result: StartServerResult = await startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: makeSpawnSpy(calls),
    engineScope: literalLauncher(fake, 20_000),
    signal: AbortSignal.timeout(30_000),
    onEvent: (e) => {
      if (e.type === "retry") retryReasons.push(e.reason);
    },
  });
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(2);
  expect(calls[0]?.[0]).toBe(fake);
  expect(calls[1]?.[0]).not.toBe(fake);
  const dashDash = (calls[0]?.[1] ?? []).indexOf("--");
  expect(dashDash).toBeGreaterThan(-1);
  const directTail = (calls[0]?.[1] ?? []).slice(dashDash + 1);
  expect([calls[1]?.[0], ...(calls[1]?.[1] ?? [])]).toEqual(directTail);
  const directPid = calls[1]?.[2];
  if (directPid === undefined) throw new Error("direct fallback spawn returned no pid");
  expect(readServerPid({ name: fixture.name }, fixture.resolved)).toBe(directPid);
  expect(retryReasons.some((r) => r.includes("falling back to direct spawn"))).toBe(true);
  const state = readServerState({ name: fixture.name }, fixture.resolved);
  expect(state?.scopeUnit).toBeUndefined();
  await stopServer({ key: { name: fixture.name }, resolved: fixture.resolved });
}, 90_000);

test("scoped ModelRun: a stop mid-handshake tombstones the unit and skips fallback", async () => {
  const fixture = newFixture("scope-term");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "term-exit-1");
  const calls: Call[] = [];
  const startPromise = startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: makeSpawnSpy(calls),
    engineScope: literalLauncher(fake, 20_000),
    signal: AbortSignal.timeout(40_000),
  });
  // The fake re-execs itself with argv0 `systemd-run` before it installs its
  // TERM trap and parks. Wait for the pending record (the spawn landed) and for
  // that identity to be observable, so stopServer verifies the wrapper as alive
  // (and tombstones it) the way the real binary would, instead of racing the
  // exec and reporting an unverifiable pid that skips both signal and tombstone.
  let wrapperPid = 0;
  let pendingUnit = "";
  await waitFor(
    () => {
      const pending = readScopePending(
        workloadRuntimeDir(fixture.resolved, { name: fixture.name }),
        "llama-server",
      );
      if (pending === null) return false;
      wrapperPid = pending.pid;
      pendingUnit = pending.scopeUnit;
      return (processCommand(wrapperPid) ?? "").startsWith("systemd-run ");
    },
    "scope wrapper exec identity",
    15_000,
  );
  const stop = await stopServer({ key: { name: fixture.name }, resolved: fixture.resolved });
  const result: StartServerResult = await startPromise;
  expect(calls.length).toBe(1);
  expect(stop.stopped).toBe(true);
  expect(stop.pid).toBe(wrapperPid);
  const tombstone = JSON.parse(readFileSync(stopPath(fixture), "utf8")) as {
    scopeUnit?: string;
  };
  expect(tombstone.scopeUnit).toBe(pendingUnit);
  expect(result.ok).toBe(false);
}, 90_000);

test("scoped ModelRun: aborting the reaped handshake never SIGTERMs its pid", async () => {
  const fixture = newFixture("scope-abort-reaped");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "hang");
  const controller = new AbortController();
  let wrapperPid = 0;
  let termAttempts = 0;
  const realKill = process.kill.bind(process);
  const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    // Once the wrapper pid is known, answer kill(0) as though the freed pid had
    // been recycled; the pinned defect is whether startServer then tries SIGTERM.
    if (wrapperPid > 0 && pid === wrapperPid) {
      if (signal === "SIGTERM") termAttempts += 1;
      return true;
    }
    return realKill(pid, signal);
  });
  try {
    const startPromise = startServer({
      key: { name: fixture.name },
      target: TARGET_REL,
      endpoint: fixture.endpoint,
      timeoutSeconds: 5,
      skipTuned: true,
      env: fixture.env,
      resolved: fixture.resolved,
      spawn: makeSpawnSpy([]),
      engineScope: literalLauncher(fake, 5_000),
      signal: controller.signal,
    });
    await waitFor(
      () => {
        const pending = readScopePending(
          workloadRuntimeDir(fixture.resolved, { name: fixture.name }),
          "llama-server",
        );
        if (pending === null) return false;
        wrapperPid = pending.pid;
        return true;
      },
      "scope pending record",
      10_000,
    );
    controller.abort();
    const result = await startPromise;
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("Start aborted");
    expect(wrapperPid).toBeGreaterThan(0);
    expect(processCommand(wrapperPid)).toBeNull();
    expect(termAttempts).toBe(0);
  } finally {
    killSpy.mockRestore();
  }
}, 30_000);

test("scoped ModelRun: stopping a replaced pid leaves the replacement record in place", async () => {
  const fixture = newFixture("scope-record-race");
  const childA = spawnEngineCommandSleeper();
  const childB = spawnEngineCommandSleeper();
  const pidA = childA.pid;
  const pidB = childB.pid;
  if (pidA === undefined || pidB === undefined) throw new Error("sleeper spawn returned no pid");
  writeTrackingRecord(fixture, pidA);
  const identity: PidIdentityDeps = {
    probe: (pid) => {
      if (pid === pidA) writeTrackingRecord(fixture, pidB);
      process.kill(pid, 0);
    },
  };

  const stop = await stopServer({
    key: { name: fixture.name },
    resolved: fixture.resolved,
    graceSeconds: 1,
    identity,
  });

  expect(stop.stopped).toBe(true);
  expect(readServerPid({ name: fixture.name }, fixture.resolved)).toBe(pidB);
  expect(readServerState({ name: fixture.name }, fixture.resolved)?.pid).toBe(pidB);
  expect(processCommand(pidB)).not.toBeNull();
}, 30_000);

test("scoped ModelRun: a consistent wrapper is stopped but not treated as the engine", async () => {
  const fixture = newFixture("scope-wrapper-ok");
  const scopeUnit = "llamactl-engine-wrap-0123456789ab.scope";
  const child = spawnPlainSleeper();
  const pid = child.pid;
  if (pid === undefined) throw new Error("sleeper spawn returned no pid");
  writeTrackingRecord(fixture, pid, scopeUnit);
  writeScopePending(
    workloadRuntimeDir(fixture.resolved, { name: fixture.name }),
    "llama-server",
    pid,
    scopeUnit,
  );
  const identity = wrapperIdentity(scopeUnit);

  const status = await serverStatus({ name: fixture.name }, fixture.resolved, identity);
  expect(status.pid).toBeNull();
  expect(status.identityUnknown).toBe(true);

  const stop = await stopServer({
    key: { name: fixture.name },
    resolved: fixture.resolved,
    graceSeconds: 1,
    identity,
  });
  expect(stop.stopped).toBe(true);
  expect(stop.pid).toBe(pid);
  expect(processCommand(pid)).toBeNull();
}, 30_000);

test("scoped ModelRun: a consistent wrapper is not adopted as a live engine", async () => {
  const fixture = newFixture("scope-wrapper-adopt");
  const calls: Call[] = [];
  const first = await startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: makeSpawnSpy(calls),
    engineScope: null,
    signal: AbortSignal.timeout(30_000),
  });
  expect(first.ok).toBe(true);
  const firstPid = first.pid;
  if (firstPid === null) throw new Error("first start returned no pid");
  process.kill(firstPid, "SIGKILL");
  await waitFor(() => processCommand(firstPid) === null, "first engine exit", 10_000);
  const prior = readServerState({ name: fixture.name }, fixture.resolved);
  if (prior?.specHash === undefined) throw new Error("first start wrote no spec hash");

  const scopeUnit = "llamactl-engine-wrap-0123456789ab.scope";
  const child = spawnPlainSleeper();
  const pid = child.pid;
  if (pid === undefined) throw new Error("sleeper spawn returned no pid");
  const dir = workloadRuntimeDir(fixture.resolved, { name: fixture.name });
  const state: ServerState = { ...prior, pid, scopeUnit };
  writeFileSync(join(dir, "llama-server.state"), JSON.stringify(state, null, 2));
  writeFileSync(join(dir, "llama-server.pid"), `${String(pid)}\n`);
  writeScopePending(dir, "llama-server", pid, scopeUnit);
  // Adoption is the only path that requires an exact "alive" verdict before
  // treating the recorded pid as the engine; the listener makes that path reachable.
  const health = Bun.serve({
    hostname: fixture.endpoint.host,
    port: fixture.endpoint.port,
    fetch: () => new Response("ok"),
  });
  try {
    const second = await startServer({
      key: { name: fixture.name },
      target: TARGET_REL,
      endpoint: fixture.endpoint,
      timeoutSeconds: 3,
      skipTuned: true,
      env: fixture.env,
      resolved: fixture.resolved,
      identity: wrapperIdentity(scopeUnit),
      spawn: makeSpawnSpy(calls),
      engineScope: null,
      signal: AbortSignal.timeout(20_000),
    });
    expect(second.adopted).not.toBe(true);
    expect(second.pid).not.toBe(pid);
  } finally {
    void health.stop(true);
  }
}, 90_000);

test("scoped ModelRun: inconsistent pending records do not authorize a wrapper stop", async () => {
  const scopeUnit = "llamactl-engine-wrap-0123456789ab.scope";
  const otherUnit = "llamactl-engine-wrap-abcdef012345.scope";
  for (const mismatch of ["pending-pid", "scope-unit"] as const) {
    const fixture = newFixture(`scope-wrapper-${mismatch}`);
    const child = spawnPlainSleeper();
    const pid = child.pid;
    if (pid === undefined) throw new Error("sleeper spawn returned no pid");
    writeTrackingRecord(fixture, pid, scopeUnit);
    writeScopePending(
      workloadRuntimeDir(fixture.resolved, { name: fixture.name }),
      "llama-server",
      mismatch === "pending-pid" ? pid + 1 : pid,
      mismatch === "scope-unit" ? otherUnit : scopeUnit,
    );
    const sigterms: number[] = [];
    const realKill = process.kill.bind(process);
    const killSpy = spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === "SIGTERM") sigterms.push(target);
      return realKill(target, signal);
    });
    try {
      const stop = await stopServer({
        key: { name: fixture.name },
        resolved: fixture.resolved,
        graceSeconds: 1,
        // In the scope-unit case the wrapper argv names the PENDING unit, so
        // only the sidecar-vs-pending unit check can refuse the stop.
        identity: wrapperIdentity(mismatch === "scope-unit" ? otherUnit : scopeUnit),
      });
      expect(stop.stopped).toBe(false);
      expect(sigterms).not.toContain(pid);
      expect(processCommand(pid)).not.toBeNull();
    } finally {
      killSpy.mockRestore();
    }
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

test("scoped ModelRun: a replaced pid record blocks the direct fallback", async () => {
  const fixture = newFixture("scope-gate-owner");
  const fake = writeDelayedCollisionSystemdRun(fixture.dirs.tmp);
  const calls: Call[] = [];
  const startPromise = startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: 5,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: makeSpawnSpy(calls),
    engineScope: literalLauncher(fake, 20_000),
    signal: AbortSignal.timeout(20_000),
  });
  let wrapperPid = 0;
  await waitFor(
    () => {
      const pending = readScopePending(
        workloadRuntimeDir(fixture.resolved, { name: fixture.name }),
        "llama-server",
      );
      if (pending === null) return false;
      wrapperPid = pending.pid;
      return true;
    },
    "scope pending record",
    3_000,
  );
  writeFileSync(
    join(workloadRuntimeDir(fixture.resolved, { name: fixture.name }), "llama-server.pid"),
    `${String(wrapperPid + 1000)}\n`,
  );
  const result = await startPromise;
  expect(result.ok).toBe(false);
  expect(calls.length).toBe(1);
}, 30_000);
