// #806 require-mode RED: a required ModelRun scope must refuse the direct-spawn
// fallback whenever the scope cannot be established, because an unscoped engine
// would violate the survival invariant the launcher was required to enforce.

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineScopeLauncher, ScopeResolveResult } from "../../../core/src/engines/scope.js";

import * as realScope from "../../../core/src/engines/scope.js";
import { resolveEnv } from "../../../core/src/env.js";
import { readServerPid, startServer } from "../../../core/src/server.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  baseEnv,
  ephemeralPort,
  type FixtureDirs,
  makeFixtureDirs,
} from "../fixtures/engine-survival-helpers.js";
import { writeFakeSystemdRun } from "../fixtures/fake-systemd-run.js";

// ModelRun shapes its scope env with no declared keys, so a real env conflict
// cannot arise there today; the require-mode refusal for one is still a branch
// of resolveScopePlan. This passthrough mock forces a conflict only while
// `forceEnvConflict` is set, so every other caller (and every other test file
// sharing the process) sees the real shapeScopeEnv.
const realShapeScopeEnv = realScope.shapeScopeEnv;
let forceEnvConflict: string | null = null;
void mock.module("../../../core/src/engines/scope.js", () => ({
  ...realScope,
  shapeScopeEnv: (
    ...args: Parameters<typeof realShapeScopeEnv>
  ): ReturnType<typeof realShapeScopeEnv> =>
    forceEnvConflict === null ? realShapeScopeEnv(...args) : { conflict: forceEnvConflict },
}));

const TARGET_REL = "survival/survival-model.gguf";
const PENDING = "llama-server.scope-pending";

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

type RequiredLauncher = EngineScopeLauncher & { readonly required: true };

function requiredLauncher(
  systemdRunPath: string,
  establishTimeoutMs: number,
  resolve?: EngineScopeLauncher["resolve"],
): RequiredLauncher {
  return {
    required: true,
    establishTimeoutMs,
    unitSuffix: (): string => randomBytes(6).toString("hex"),
    noteFailure: (): void => undefined,
    resolve:
      resolve ?? ((): Promise<ScopeResolveResult> => Promise.resolve({ ok: true, systemdRunPath })),
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

// A spawn whose child never got a pid: the wrapper could not be started, so
// there is no process to handshake with.
function makePidlessSpawn(calls: Call[]): typeof nodeSpawn {
  const spy = (command: string, args?: readonly string[]): ChildProcess => {
    calls.push([command, [...(args ?? [])], undefined]);
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      unref: (): void => undefined,
      kill: (): boolean => false,
    });
    return child as unknown as ChildProcess;
  };
  return spy as unknown as typeof nodeSpawn;
}

function startRequiredServer(
  fixture: Fixture,
  launcher: EngineScopeLauncher,
  calls: Call[],
  overrides: { spawn?: typeof nodeSpawn; extraArgs?: string[]; timeoutSeconds?: number } = {},
): ReturnType<typeof startServer> {
  return startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: overrides.timeoutSeconds ?? 30,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: overrides.spawn ?? makeSpawnSpy(calls),
    engineScope: launcher,
    signal: AbortSignal.timeout(30_000),
    ...(overrides.extraArgs === undefined ? {} : { extraArgs: overrides.extraArgs }),
  });
}

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-scope-required-modelrun-"));
});

afterAll(async () => {
  let survivors: Awaited<ReturnType<typeof reapFakeProcesses>>;
  try {
    survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: spawnedPids });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  expect(survivors).toEqual([]);
}, 60_000);

test("required ModelRun scope: a unit collision refuses the direct fallback", async () => {
  const fixture = newFixture("required-collision");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "collision");
  const calls: Call[] = [];
  const result = await startRequiredServer(fixture, requiredLauncher(fake, 20_000), calls);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toBe(fake);
  expect(readServerPid({ name: fixture.name }, fixture.resolved)).toBeNull();
  expect(existsSync(pendingPath(fixture))).toBe(false);
}, 90_000);

test("required ModelRun scope: a failed capability resolve refuses before spawn", async () => {
  const fixture = newFixture("required-resolve");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const launcher = requiredLauncher(fake, 20_000, () =>
    Promise.resolve({ ok: false, reason: "probe-failed" }),
  );
  const calls: Call[] = [];
  const result = await startRequiredServer(fixture, launcher, calls);
  expect(result.ok).toBe(false);
  expect(result.error ?? "").toContain("probe-failed");
  expect(calls.length).toBe(0);
  expect(readServerPid({ name: fixture.name }, fixture.resolved)).toBeNull();
}, 90_000);

test("required ModelRun scope: an env conflict refuses before resolve or spawn", async () => {
  const fixture = newFixture("required-envconflict");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  let resolves = 0;
  const launcher = requiredLauncher(fake, 20_000, () => {
    resolves += 1;
    return Promise.resolve({ ok: true, systemdRunPath: fake });
  });
  const calls: Call[] = [];
  forceEnvConflict = "XDG_RUNTIME_DIR";
  let result: Awaited<ReturnType<typeof startServer>>;
  try {
    result = await startRequiredServer(fixture, launcher, calls);
  } finally {
    forceEnvConflict = null;
  }
  expect(result.ok).toBe(false);
  expect(result.error ?? "").toContain("env-conflict XDG_RUNTIME_DIR");
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(resolves).toBe(0);
  expect(calls.length).toBe(0);
  expect(readServerPid({ name: fixture.name }, fixture.resolved)).toBeNull();
}, 90_000);

test("required ModelRun scope: a wrapper with no pid refuses the direct fallback", async () => {
  const fixture = newFixture("required-nopid");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  const calls: Call[] = [];
  const result = await startRequiredServer(fixture, requiredLauncher(fake, 20_000), calls, {
    spawn: makePidlessSpawn(calls),
  });
  expect(result.ok).toBe(false);
  expect(result.error ?? "").toContain("wrapper pid unavailable");
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toBe(fake);
  expect(readServerPid({ name: fixture.name }, fixture.resolved)).toBeNull();
  expect(existsSync(pendingPath(fixture))).toBe(false);
}, 90_000);

test("required ModelRun scope: the mmproj safe-flag retry refuses an unscoped relaunch", async () => {
  const fixture = newFixture("required-mmproj-retry");
  const fake = writeFakeSystemdRun(fixture.dirs.tmp, "ok");
  // The engine execs inside the scope and dies at once, so the first launch
  // never comes up and the mmproj retry runs.
  writeFileSync(join(fixture.dirs.binDir, "llama-server"), "#!/bin/bash\nexit 1\n", {
    mode: 0o755,
  });
  let resolves = 0;
  const launcher = requiredLauncher(fake, 20_000, () => {
    resolves += 1;
    return Promise.resolve(
      resolves === 1 ? { ok: true, systemdRunPath: fake } : { ok: false, reason: "no-user-bus" },
    );
  });
  const calls: Call[] = [];
  const result = await startRequiredServer(fixture, launcher, calls, {
    extraArgs: ["--mmproj", join(fixture.dirs.modelsDir, "survival", "mmproj.gguf")],
    timeoutSeconds: 5,
  });
  expect(result.ok).toBe(false);
  expect(result.retried).toBe(true);
  expect(result.error ?? "").toContain("no-user-bus");
  expect(result.error).toMatch(/refusing direct spawn/);
  expect(resolves).toBe(2);
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toBe(fake);
}, 90_000);
