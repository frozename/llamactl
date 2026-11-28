// #806 require-mode RED: a required ModelHost scope must refuse the direct-spawn
// fallback whenever the scope cannot be established, because an unscoped engine
// would violate the survival invariant the launcher was required to enforce.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  type EngineScopeLauncher,
  isScopeUnit,
  type ScopeResolveResult,
} from "../../../core/src/engines/scope.js";
import { readModelHostStarting, readModelHostState } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { processCommand } from "../../../core/src/pidIdentity.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import { mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { startModelHost, stopModelHost } from "../../src/server/modelhost.js";
import {
  baseEnv,
  ephemeralPort,
  type FixtureDirs,
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

type RequiredLauncher = EngineScopeLauncher & { readonly required: true };

function requiredLauncher(
  systemdRunPath: string,
  establishTimeoutMs: number,
  resolve?: EngineScopeLauncher["resolve"],
): { launcher: RequiredLauncher; noteFailure: ReturnType<typeof mock> } {
  const noteFailure = mock((): void => undefined);
  const launcher: RequiredLauncher = {
    required: true,
    establishTimeoutMs,
    unitSuffix: (): string => randomBytes(6).toString("hex"),
    noteFailure,
    resolve:
      resolve ?? ((): Promise<ScopeResolveResult> => Promise.resolve({ ok: true, systemdRunPath })),
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

// A child the wrapper spawn never gave a pid: no process exists to handshake.
function pidlessChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    unref: (): void => undefined,
    kill: (): boolean => false,
  });
  return child as unknown as ChildProcess;
}

function startHost(
  fixture: Fixture,
  launcher: EngineScopeLauncher,
  calls: SpawnCall[],
  warnings: string[],
  specOverrides: Record<string, unknown> = {},
  override?: (call: SpawnCall) => ChildProcess | null,
): ReturnType<typeof startModelHost> {
  return startModelHost({
    key: { name: fixture.name },
    manifest: manifest(fixture, specOverrides),
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    spawn: spawnSpy(calls, spawnedPids, override),
    engineScope: launcher,
    signal: AbortSignal.timeout(15_000),
    warn: (message) => warnings.push(message),
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
  });
}

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
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-scope-required-modelhost-"));
});

afterAll(async () => {
  const survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: spawnedPids });
  rmSync(scratchRoot, { recursive: true, force: true });
  expect(survivors).toEqual([]);
}, 60_000);

test("required ModelHost scope: a unit collision refuses the direct fallback", async () => {
  const fixture = newFixture("required-collision-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "collision");
  const { launcher, noteFailure } = requiredLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/engine scope required/);
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(1);
  expect(calls[0]?.command).toBe(fake);
  expect(noteFailure).toHaveBeenCalledTimes(1);
  expect(warnings.some((message) => message.includes("falling back to direct spawn"))).toBe(false);
  expect(readModelHostStarting({ name: fixture.name }, fixture.resolved)).toBeNull();
  expect(readModelHostState({ name: fixture.name }, fixture.resolved)).toBeNull();
}, 60_000);

test("required ModelHost scope: a wedged scope refuses the direct fallback", async () => {
  const fixture = newFixture("required-hang-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "hang");
  const { launcher } = requiredLauncher(fake, 300);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(1);
  expect(calls[0]?.command).toBe(fake);
}, 60_000);

test("required ModelHost scope: a failed capability resolve refuses before spawn", async () => {
  const fixture = newFixture("required-resolve-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = requiredLauncher(fake, 20_000, () =>
    Promise.resolve({ ok: false, reason: "no-user-bus" }),
  );
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings);
  expect(result.ok).toBe(false);
  expect(result.error ?? "").toContain("no-user-bus");
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(0);
  expect(readModelHostStarting({ name: fixture.name }, fixture.resolved)).toBeNull();
}, 60_000);

test("required ModelHost scope: a manifest env conflict refuses before spawn", async () => {
  const fixture = newFixture("required-envconflict-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = requiredLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings, {
    env: { XDG_RUNTIME_DIR: "/x" },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/env-conflict/);
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(0);
}, 60_000);

test("required ModelHost scope: a scope that execs still launches", async () => {
  const fixture = newFixture("required-ok-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher } = requiredLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings);
  expect(result.ok).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0]?.command).toBe(fake);
  const state = readModelHostState({ name: fixture.name }, fixture.resolved);
  expect(isScopeUnit(state?.scopeUnit)).toBe(true);
  if (result.pid === null) throw new Error("expected a pid");
  await stopLiveEngine(fixture, result.pid);
}, 60_000);

test("required ModelHost scope: no boot log refuses before resolve or spawn", async () => {
  const fixture = newFixture("required-nobootlog-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  let resolves = 0;
  const { launcher } = requiredLauncher(fake, 20_000, () => {
    resolves += 1;
    return Promise.resolve({ ok: true, systemdRunPath: fake });
  });
  // A directory where the boot log belongs makes the open fail, so the launch
  // has no boot-log fd and no exec marker could ever prove the scope.
  mkdirSync(join(fixture.dirs.runtimeDir, "workloads", fixture.name, "modelhost.boot.log"), {
    recursive: true,
  });
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings);
  expect(result.ok).toBe(false);
  expect(result.error ?? "").toContain("no boot log");
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(resolves).toBe(0);
  expect(calls.length).toBe(0);
  expect(readModelHostStarting({ name: fixture.name }, fixture.resolved)).toBeNull();
  expect(readModelHostState({ name: fixture.name }, fixture.resolved)).toBeNull();
}, 60_000);

test("required ModelHost scope: a wrapper with no pid refuses the direct fallback", async () => {
  const fixture = newFixture("required-nopid-host");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const { launcher, noteFailure } = requiredLauncher(fake, 20_000);
  const calls: SpawnCall[] = [];
  const warnings: string[] = [];
  const result = await startHost(fixture, launcher, calls, warnings, {}, () => pidlessChild());
  expect(result.ok).toBe(false);
  expect(result.error ?? "").toContain("wrapper pid unavailable");
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(1);
  expect(calls[0]?.command).toBe(fake);
  expect(noteFailure).toHaveBeenCalledTimes(1);
  expect(readModelHostStarting({ name: fixture.name }, fixture.resolved)).toBeNull();
  expect(readModelHostState({ name: fixture.name }, fixture.resolved)).toBeNull();
}, 60_000);
