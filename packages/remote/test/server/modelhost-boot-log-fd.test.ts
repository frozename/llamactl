// #806 regression pin: the boot-log fd belongs to launchModelHost, not to the
// engine child. These tests inject a spawn boundary that records ownership at
// handoff, then require the parent-side fd to be closed on success and on every
// launch-failure path.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import { fstatSync, mkdtempSync, rmSync, statSync } from "../../src/safe-fs.js";
import { startModelHost } from "../../src/server/modelhost.js";
import {
  baseEnv,
  ephemeralPort,
  type FixtureDirs,
  makeFixtureDirs,
  manifestFor,
} from "../fixtures/engine-survival-helpers.js";
import { writeFakeSystemdRun } from "../fixtures/fake-systemd-run.js";

let scratchRoot = "";
const spawnedPids: number[] = [];

function fdRefersTo(fd: number, path: string): boolean {
  let fdStat: ReturnType<typeof fstatSync>;
  try {
    fdStat = fstatSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") return false;
    throw error;
  }
  const pathStat = statSync(path);
  return fdStat.dev === pathStat.dev && fdStat.ino === pathStat.ino;
}

function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter() as ChildProcess, { pid });
}

function stdoutFd(options: SpawnOptions | undefined): number {
  const stdio = options?.stdio;
  if (!Array.isArray(stdio) || typeof stdio[1] !== "number") {
    throw new Error("modelhost spawn did not receive a numeric stdout fd");
  }
  return stdio[1];
}

interface BootLogFixture {
  dirs: FixtureDirs;
  name: string;
  port: number;
  binary: string;
  env: NodeJS.ProcessEnv;
  manifest: unknown;
  bootLogPath: string;
}

function newFixture(name: string): BootLogFixture {
  const dirs = makeFixtureDirs(scratchRoot);
  const port = ephemeralPort();
  const binary = join(dirs.binDir, "llama-server");
  const env: NodeJS.ProcessEnv = baseEnv(dirs, port);
  return {
    dirs,
    name,
    port,
    binary,
    env,
    manifest: manifestFor(name, binary, dirs.modelsDir, port),
    bootLogPath: join(dirs.runtimeDir, "workloads", name, "modelhost.boot.log"),
  };
}

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-modelhost-bootfd-"));
});

afterAll(async () => {
  const survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: spawnedPids });
  rmSync(scratchRoot, { recursive: true, force: true });
  expect(survivors).toEqual([]);
}, 60_000);

test("A. Direct launch success closes the fd", async () => {
  const fixture = newFixture("bootfd-direct-success");
  let fd = -1;
  let openAtSpawn = false;
  const spawn = mock(
    (_command: string, _args: readonly string[], options: SpawnOptions): ChildProcess => {
      fd = stdoutFd(options);
      openAtSpawn = fdRefersTo(fd, fixture.bootLogPath);
      return fakeChild(4321);
    },
  ) as unknown as typeof nodeSpawn;
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: fixture.manifest,
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn,
      engineScope: null,
      findListenerPid: () => Promise.resolve(null),
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
    });

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(openAtSpawn).toBe(true);
    expect(fdRefersTo(fd, fixture.bootLogPath)).toBe(false);
  } finally {
    rmSync(fixture.dirs.tmp, { recursive: true, force: true });
  }
});

test("B. A spawn that throws closes the fd", async () => {
  const fixture = newFixture("bootfd-spawn-throw");
  let fd = -1;
  const spawn = mock(
    (_command: string, _args: readonly string[], options: SpawnOptions): ChildProcess => {
      fd = stdoutFd(options);
      throw new Error("fake spawn failure");
    },
  ) as unknown as typeof nodeSpawn;
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: fixture.manifest,
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn,
      engineScope: null,
      findListenerPid: () => Promise.resolve(null),
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
    });

    expect(result.ok).toBe(false);
    expect(fdRefersTo(fd, fixture.bootLogPath)).toBe(false);
  } finally {
    rmSync(fixture.dirs.tmp, { recursive: true, force: true });
  }
});

test("C. A failed readiness probe closes the fd", async () => {
  const fixture = newFixture("bootfd-readiness-fail");
  const engine = ENGINES.llamacpp;
  const originalTeardown = engine.teardown.bind(engine);
  const tornDown: number[] = [];
  let fd = -1;
  let openAtSpawn = false;
  const spawn = mock(
    (_command: string, _args: readonly string[], options: SpawnOptions): ChildProcess => {
      fd = stdoutFd(options);
      openAtSpawn = fdRefersTo(fd, fixture.bootLogPath);
      return fakeChild(4321);
    },
  ) as unknown as typeof nodeSpawn;
  try {
    engine.teardown = mock((pid: number) => {
      tornDown.push(pid);
      return Promise.resolve();
    });
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: fixture.manifest,
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn,
      engineScope: null,
      findListenerPid: () => Promise.resolve(null),
      probeReady: () => Promise.resolve({ ready: false, modelIds: [] }),
    });

    expect(result.ok).toBe(false);
    expect(openAtSpawn).toBe(true);
    expect(tornDown).toEqual([4321]);
    expect(fdRefersTo(fd, fixture.bootLogPath)).toBe(false);
  } finally {
    engine.teardown = originalTeardown;
    rmSync(fixture.dirs.tmp, { recursive: true, force: true });
  }
});

test("D. A scoped pre-exec fallback hands an OPEN fd to the direct spawn, then closes it", async () => {
  const fixture = newFixture("bootfd-scope-fallback");
  fixture.env["XDG_RUNTIME_DIR"] = join(fixture.dirs.tmp, "xdg");
  fixture.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus";
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "collision");
  const warnings: string[] = [];
  const commands: string[] = [];
  const fds: number[] = [];
  let openAtFallback: boolean | undefined;
  const spawn = mock(
    (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      const fd = stdoutFd(options);
      commands.push(command);
      fds.push(fd);
      if (fds.length === 1) {
        const child = nodeSpawn(command, args, options);
        if (child.pid !== undefined) spawnedPids.push(child.pid);
        return child;
      }
      openAtFallback = fdRefersTo(fd, fixture.bootLogPath);
      return fakeChild(4321);
    },
  ) as unknown as typeof nodeSpawn;
  try {
    const result = await startModelHost({
      key: { name: fixture.name },
      manifest: fixture.manifest,
      workloadsDir: fixture.dirs.workloadsDir,
      runtimeDir: fixture.dirs.runtimeDir,
      env: fixture.env,
      spawn,
      engineScope: {
        establishTimeoutMs: 20_000,
        unitSuffix: () => randomBytes(6).toString("hex"),
        noteFailure: mock(),
        resolve: () => Promise.resolve({ ok: true, systemdRunPath: fake }),
      },
      signal: AbortSignal.timeout(15_000),
      warn: (message) => warnings.push(message),
      findListenerPid: () => Promise.resolve(null),
      probeReady: () => Promise.resolve({ ready: true, modelIds: ["survival-model.gguf"] }),
    });

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(commands).toEqual([fake, fixture.binary]);
    expect(fds).toHaveLength(2);
    expect(fds[1]).toBe(fds[0]);
    expect(openAtFallback).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/falling back to direct spawn/);
    expect(fdRefersTo(fds[1] ?? -1, fixture.bootLogPath)).toBe(false);
  } finally {
    rmSync(fixture.dirs.tmp, { recursive: true, force: true });
  }
}, 30_000);
