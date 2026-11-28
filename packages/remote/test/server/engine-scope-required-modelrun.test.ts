// #806 require-mode RED: a required ModelRun scope must refuse the direct-spawn
// fallback whenever the scope cannot be established, because an unscoped engine
// would violate the survival invariant the launcher was required to enforce.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineScopeLauncher, ScopeResolveResult } from "../../../core/src/engines/scope.js";

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

function startRequiredServer(
  fixture: Fixture,
  launcher: EngineScopeLauncher,
  calls: Call[],
): ReturnType<typeof startServer> {
  return startServer({
    key: { name: fixture.name },
    target: TARGET_REL,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    resolved: fixture.resolved,
    spawn: makeSpawnSpy(calls),
    engineScope: launcher,
    signal: AbortSignal.timeout(30_000),
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
