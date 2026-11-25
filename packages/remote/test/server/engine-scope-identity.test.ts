// #806 phase 3: pid-identity contract for scoped ModelHost records. A
// starting record that names a scope unit may still hold the pre-exec
// systemd-run wrapper, so the starting-record verify sites (stop, the
// reap/adopt pre-checks) accept the wrapper argv0 as an ALTERNATIVE to the
// engine argv0 — but only for the unit the record names. State-sidecar sites
// (status, stop on modelhost.state, and the adopt promote's engine-only
// re-verify) never accept the wrapper: a wrapper pid can be deferred inside
// its load budget but is never promoted into modelhost.state, and a scoped
// state keeps its scopeUnit through the unchanged-spec refresh.
//
// The "engine" is a /bin/sleep impostor whose argv0 is set to `llama-server`
// or `systemd-run` via spawn's argv0 option; identity.processCommand stubs
// supply the wrapper command line where the real ps output would not match.

import { expect, mock, test } from "bun:test";
import {
  type ChildProcess,
  type spawn as nodeSpawn,
  spawn as spawnImpostor,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINES } from "../../../core/src/engines/index.js";
import { computeModelHostSpecHash } from "../../../core/src/engines/state.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, statusModelHost, stopModelHost } from "../../src/server/modelhost.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
  specForHash,
} from "../../src/workload/modelhost-schema.js";

const NAME = "scope-identity-host";

// launchModelHost reads only pid, exitCode and unref off the spawned child;
// the EventEmitter downcast supplies the ChildProcess shape without a real
// process (engine-adopt-modelhost.test.ts pattern).
function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter() as ChildProcess, { pid });
}

function scopeUnit(tag: string): string {
  return `llamactl-engine-${tag}-0123456789ab.scope`;
}

function wrapperCmd(unit: string): string {
  const base = unit.slice(0, -".scope".length);
  return `systemd-run --user --scope --unit=${base} -- /opt/llama-server -m /models/m.gguf`;
}

interface RecordDirs {
  runtimeDir: string;
  hostDir: string;
}

function recordDirs(tmp: string): RecordDirs {
  const runtimeDir = join(tmp, "runtime");
  return { runtimeDir, hostDir: join(runtimeDir, "workloads", NAME) };
}

function seedStartingRecord(hostDir: string, record: Record<string, unknown>): void {
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "modelhost.starting"), JSON.stringify(record));
}

function seedLiveHost(hostDir: string, pid: number, state: Record<string, unknown>): void {
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "modelhost.pid"), `${String(pid)}\n`);
  writeFileSync(join(hostDir, "modelhost.state"), JSON.stringify(state));
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

function killQuiet(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// A live process whose argv0 reads as `llama-server`; the pid is real so the
// liveness probe and start-time anchor are genuine — only the command line is
// what ps reports for the impostor.
function spawnSleeper(argv0: string): { proc: ChildProcess; pid: number } {
  const proc = spawnImpostor("/bin/sleep", ["60"], { stdio: "ignore", argv0 });
  if (proc.pid === undefined) throw new Error("impostor spawn failed");
  return { proc, pid: proc.pid };
}

// Records are seeded AFTER the spawn so the record mtime postdates the
// process start — the pid-identity anchor the verify paths require.
function startingRecord(pid: number, unit: string | undefined): Record<string, unknown> {
  return {
    kind: "ModelHostStarting",
    engine: "llamacpp",
    pid,
    startedAt: new Date().toISOString(),
    ...(unit === undefined ? {} : { scopeUnit: unit }),
  };
}

async function stopStartingCase(
  unit: string | undefined,
  cmd: string,
): Promise<{
  ok: boolean;
  pid: number | null;
  spawnedPid: number;
  error?: string;
  tornDown: number[];
  recordKept: boolean;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-ident-"));
  const { proc, pid } = spawnSleeper("llama-server");
  const tornDown: number[] = [];
  try {
    const { hostDir, runtimeDir } = recordDirs(tmp);
    seedStartingRecord(hostDir, startingRecord(pid, unit));
    const stop = await stopModelHost({
      key: { name: NAME },
      runtimeDir,
      teardown: (target) => {
        tornDown.push(target);
        proc.kill("SIGKILL");
        return waitForGone(target);
      },
      identity: { processCommand: (p): string | null => (p === pid ? cmd : null) },
    });
    return {
      ok: stop.ok,
      pid: stop.pid,
      spawnedPid: pid,
      ...(stop.error === undefined ? {} : { error: stop.error }),
      tornDown,
      recordKept: existsSync(join(hostDir, "modelhost.starting")),
    };
  } finally {
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("stop accepts the wrapper argv0 for the unit a scoped starting record names", async () => {
  const unit = scopeUnit("t11a");
  const result = await stopStartingCase(unit, wrapperCmd(unit));
  expect(result.ok).toBe(true);
  expect(result.pid).toBe(result.spawnedPid);
  expect(result.tornDown).toEqual([result.spawnedPid]);
  expect(result.recordKept).toBe(false);
}, 60_000);

test("stop refuses the wrapper argv0 on an unscoped starting record", async () => {
  const unit = scopeUnit("t11b");
  const result = await stopStartingCase(undefined, wrapperCmd(unit));
  expect(result.ok).toBe(false);
  expect(result.error).toBe("pid identity unknown");
  expect(result.tornDown).toEqual([]);
  expect(result.recordKept).toBe(true);
}, 60_000);

test("stop refuses a wrapper naming a different unit than the record", async () => {
  const recordUnit = scopeUnit("t11c");
  const foreignUnit = scopeUnit("t11c-f");
  const result = await stopStartingCase(recordUnit, wrapperCmd(foreignUnit));
  expect(result.ok).toBe(false);
  expect(result.error).toBe("pid identity unknown");
  expect(result.tornDown).toEqual([]);
  expect(result.recordKept).toBe(true);
}, 60_000);

function stateRecord(pid: number, unit: string | undefined): Record<string, unknown> {
  return {
    kind: "ModelHost",
    engine: "llamacpp",
    pid,
    host: "127.0.0.1",
    port: 8080,
    modelAliases: ["fork/model.gguf", "model.gguf"],
    startedAt: new Date().toISOString(),
    slotSavePath: null,
    specHash: "seeded-hash",
    ...(unit === undefined ? {} : { scopeUnit: unit }),
  };
}

test("a scoped state sidecar keeps engine-only identity for stop and status", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-ident-"));
  const unit = scopeUnit("t11d");
  const { proc, pid } = spawnSleeper("systemd-run");
  const tornDown: number[] = [];
  try {
    const { hostDir, runtimeDir } = recordDirs(tmp);
    seedLiveHost(hostDir, pid, stateRecord(pid, unit));
    const cmd = wrapperCmd(unit);
    const identity = { processCommand: (p: number): string | null => (p === pid ? cmd : null) };
    const status = statusModelHost({ key: { name: NAME }, runtimeDir, identity });
    expect(status.state).toBe("Stopped");
    expect(status.identityUnknown).toBe(true);
    const stop = await stopModelHost({
      key: { name: NAME },
      runtimeDir,
      teardown: (target) => {
        tornDown.push(target);
        proc.kill("SIGKILL");
        return waitForGone(target);
      },
      identity,
    });
    expect(stop).toEqual({ ok: false, pid, error: "pid identity unknown" });
    expect(tornDown).toEqual([]);
    expect(existsSync(join(hostDir, "modelhost.state"))).toBe(true);
  } finally {
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

interface AdoptFixture {
  manifest: ModelHostManifest;
  workloadsDir: string;
  runtimeDir: string;
  hostDir: string;
  env: NodeJS.ProcessEnv;
}

function adoptFixture(tmp: string, specOverrides: Record<string, unknown> = {}): AdoptFixture {
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  const modelsDir = join(tmp, "models");
  const fakeBinary = join(tmp, "llama-server");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
  const manifest = ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: NAME },
    spec: {
      engine: "llamacpp",
      node: "local",
      enabled: true,
      binary: fakeBinary,
      endpoint: { host: "127.0.0.1", port: 8080 },
      hostedModels: [{ rel: "fork/model.gguf" }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      binaryNames: ["llama-server"],
      ...specOverrides,
    },
  });
  return {
    manifest,
    workloadsDir,
    runtimeDir,
    hostDir: join(runtimeDir, "workloads", NAME),
    env: { ...process.env, LLAMACTL_MODELS_DIR: modelsDir, LLAMA_CPP_MODELS: modelsDir },
  };
}

function hashOf(manifest: ModelHostManifest): string {
  return computeModelHostSpecHash(specForHash(manifest.spec));
}

function startingAdoptRecord(pid: number, unit: string, hash: string): Record<string, unknown> {
  return {
    kind: "ModelHostStarting",
    engine: "llamacpp",
    pid,
    startedAt: new Date().toISOString(),
    specHash: hash,
    scopeUnit: unit,
  };
}

// Sidecar in the exact key order validateModelHostState rebuilds, so a
// same-spec adopt (nothing out-of-hash changed) stays byte-identical.
function stateAdoptRecord(
  pid: number,
  hash: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "ModelHost",
    engine: "llamacpp",
    pid,
    host: "127.0.0.1",
    port: 8080,
    modelAliases: ["fork/model.gguf", "model.gguf"],
    startedAt: new Date().toISOString(),
    slotSavePath: null,
    specHash: hash,
    binaryNames: ["llama-server"],
    ...extra,
  };
}

function readyProbe(): () => Promise<{ ready: boolean; modelIds: string[] }> {
  return () => Promise.resolve({ ready: true, modelIds: ["model.gguf"] });
}

test("a scoped starting record promotes only after the engine itself verifies", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-adopt-"));
  const unit = scopeUnit("t12a");
  const { proc, pid } = spawnSleeper("llama-server");
  const spawn = mock((_command: string): ChildProcess => fakeChild(1));
  try {
    const fx = adoptFixture(tmp);
    seedStartingRecord(fx.hostDir, startingAdoptRecord(pid, unit, hashOf(fx.manifest)));
    const result = await startModelHost({
      key: { name: NAME },
      manifest: fx.manifest,
      workloadsDir: fx.workloadsDir,
      runtimeDir: fx.runtimeDir,
      env: fx.env,
      spawn: spawn as typeof nodeSpawn,
      probeReady: readyProbe(),
    });
    expect(result).toEqual({ ok: true, pid, adopted: true });
    expect(spawn).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(join(fx.hostDir, "modelhost.state"), "utf8")) as {
      scopeUnit?: string;
    };
    expect(state.scopeUnit).toBe(unit);
    expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(false);
  } finally {
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("a scoped starting record held by the wrapper defers instead of promoting", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-adopt-"));
  const unit = scopeUnit("t12b");
  const { proc, pid } = spawnSleeper("llama-server");
  const engine = ENGINES.llamacpp;
  const originalTeardown = engine.teardown.bind(engine);
  const spawn = mock((_command: string): ChildProcess => fakeChild(1));
  const tornDown: number[] = [];
  try {
    const fx = adoptFixture(tmp);
    seedStartingRecord(fx.hostDir, startingAdoptRecord(pid, unit, hashOf(fx.manifest)));
    engine.teardown = mock((target: number) => {
      tornDown.push(target);
      return Promise.resolve();
    });
    // The starting-record verify accepts the wrapper argv (the record names
    // the unit), but ps reports the impostor argv0 — so identity.processCommand
    // supplies the wrapper command line the pre-exec pid would show.
    const result = await startModelHost({
      key: { name: NAME },
      manifest: fx.manifest,
      workloadsDir: fx.workloadsDir,
      runtimeDir: fx.runtimeDir,
      env: fx.env,
      spawn: spawn as typeof nodeSpawn,
      probeReady: readyProbe(),
      identity: { processCommand: (p): string | null => (p === pid ? wrapperCmd(unit) : null) },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/still loading; deferring restart/);
    expect(spawn).not.toHaveBeenCalled();
    expect(tornDown).toEqual([]);
    expect(existsSync(join(fx.hostDir, "modelhost.state"))).toBe(false);
    expect(existsSync(join(fx.hostDir, "modelhost.starting"))).toBe(true);
  } finally {
    engine.teardown = originalTeardown;
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("an unchanged scoped state adopt stays byte-identical and keeps scopeUnit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-adopt-"));
  const unit = scopeUnit("t12c");
  const { proc, pid } = spawnSleeper("llama-server");
  const spawn = mock((_command: string): ChildProcess => fakeChild(1));
  try {
    const fx = adoptFixture(tmp, {
      readiness: { path: "/ready" },
      binaryNames: ["llama-server"],
    });
    seedLiveHost(
      fx.hostDir,
      pid,
      stateAdoptRecord(pid, hashOf(fx.manifest), {
        readiness: { path: "/ready", expectStatus: 200 },
        scopeUnit: unit,
      }),
    );
    const statePath = join(fx.hostDir, "modelhost.state");
    const pidPath = join(fx.hostDir, "modelhost.pid");
    const stateBefore = readFileSync(statePath, "utf8");
    const stateMtimeBefore = statSync(statePath, { bigint: true }).mtimeNs;
    const pidMtimeBefore = statSync(pidPath, { bigint: true }).mtimeNs;

    const result = await startModelHost({
      key: { name: NAME },
      manifest: fx.manifest,
      workloadsDir: fx.workloadsDir,
      runtimeDir: fx.runtimeDir,
      env: fx.env,
      spawn: spawn as typeof nodeSpawn,
      probeReady: readyProbe(),
    });

    expect(result).toEqual({ ok: true, pid, adopted: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(statSync(statePath, { bigint: true }).mtimeNs).toBe(stateMtimeBefore);
    expect(statSync(pidPath, { bigint: true }).mtimeNs).toBe(pidMtimeBefore);
    const state = JSON.parse(stateBefore) as { scopeUnit?: string };
    expect(state.scopeUnit).toBe(unit);
  } finally {
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("an unchanged unscoped state adopt stays byte-identical without scopeUnit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-adopt-"));
  const { proc, pid } = spawnSleeper("llama-server");
  const spawn = mock((_command: string): ChildProcess => fakeChild(1));
  try {
    const fx = adoptFixture(tmp, {
      readiness: { path: "/ready" },
      binaryNames: ["llama-server"],
    });
    seedLiveHost(
      fx.hostDir,
      pid,
      stateAdoptRecord(pid, hashOf(fx.manifest), {
        readiness: { path: "/ready", expectStatus: 200 },
      }),
    );
    const statePath = join(fx.hostDir, "modelhost.state");
    const pidPath = join(fx.hostDir, "modelhost.pid");
    const stateBefore = readFileSync(statePath, "utf8");
    const stateMtimeBefore = statSync(statePath, { bigint: true }).mtimeNs;
    const pidMtimeBefore = statSync(pidPath, { bigint: true }).mtimeNs;

    const result = await startModelHost({
      key: { name: NAME },
      manifest: fx.manifest,
      workloadsDir: fx.workloadsDir,
      runtimeDir: fx.runtimeDir,
      env: fx.env,
      spawn: spawn as typeof nodeSpawn,
      probeReady: readyProbe(),
    });

    expect(result).toEqual({ ok: true, pid, adopted: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(statSync(statePath, { bigint: true }).mtimeNs).toBe(stateMtimeBefore);
    expect(statSync(pidPath, { bigint: true }).mtimeNs).toBe(pidMtimeBefore);
    expect(stateBefore).not.toContain("scopeUnit");
  } finally {
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("a scoped state refresh on a readiness change preserves scopeUnit", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-adopt-"));
  const unit = scopeUnit("t12e");
  const { proc, pid } = spawnSleeper("llama-server");
  const spawn = mock((_command: string): ChildProcess => fakeChild(1));
  try {
    const fx = adoptFixture(tmp, { readiness: { path: "/new-ready" } });
    seedLiveHost(
      fx.hostDir,
      pid,
      stateAdoptRecord(pid, hashOf(fx.manifest), {
        readiness: { path: "/old-ready" },
        scopeUnit: unit,
      }),
    );
    const statePath = join(fx.hostDir, "modelhost.state");
    const pidPath = join(fx.hostDir, "modelhost.pid");
    const pidMtimeBefore = statSync(pidPath, { bigint: true }).mtimeNs;

    const result = await startModelHost({
      key: { name: NAME },
      manifest: fx.manifest,
      workloadsDir: fx.workloadsDir,
      runtimeDir: fx.runtimeDir,
      env: fx.env,
      spawn: spawn as typeof nodeSpawn,
      probeReady: readyProbe(),
    });

    expect(result).toEqual({ ok: true, pid, adopted: true });
    expect(spawn).not.toHaveBeenCalled();
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      scopeUnit?: string;
      readiness?: { path?: string };
    };
    expect(state.scopeUnit).toBe(unit);
    expect(state.readiness?.path).toBe("/new-ready");
    expect(statSync(pidPath, { bigint: true }).mtimeNs).toBe(pidMtimeBefore);
  } finally {
    killQuiet(pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("stop leaves a replacement starting record it does not own", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-stop-race-"));
  const unit = scopeUnit("t12-stop-race");
  const replacementUnit = scopeUnit("t12-stop-race-next");
  const first = spawnSleeper("llama-server");
  const replacement = spawnSleeper("llama-server");
  try {
    const { hostDir, runtimeDir } = recordDirs(tmp);
    seedStartingRecord(hostDir, startingRecord(first.pid, unit));
    const stop = await stopModelHost({
      key: { name: NAME },
      runtimeDir,
      teardown: (target) => {
        first.proc.kill("SIGKILL");
        return waitForGone(target).then(() => {
          seedStartingRecord(hostDir, startingRecord(replacement.pid, replacementUnit));
        });
      },
    });
    expect(stop).toEqual({ ok: true, pid: first.pid });
    const kept = JSON.parse(readFileSync(join(hostDir, "modelhost.starting"), "utf8")) as {
      pid?: number;
      scopeUnit?: string;
    };
    expect(kept.pid).toBe(replacement.pid);
    expect(kept.scopeUnit).toBe(replacementUnit);
  } finally {
    killQuiet(first.pid);
    killQuiet(replacement.pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);

test("reap tombstones the scope and leaves a replacement starting record it does not own", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-scope-reap-race-"));
  const unit = scopeUnit("t12-reap-race");
  const replacementUnit = scopeUnit("t12-reap-race-next");
  const first = spawnSleeper("llama-server");
  const replacement = spawnSleeper("llama-server");
  const engine = ENGINES.llamacpp;
  const originalTeardown = engine.teardown.bind(engine);
  try {
    const fx = adoptFixture(tmp, { timeoutSeconds: 1 });
    seedStartingRecord(fx.hostDir, {
      ...startingAdoptRecord(first.pid, unit, hashOf(fx.manifest)),
      startedAt: new Date(Date.now() - 10_000).toISOString(),
    });
    engine.teardown = mock((target: number) => {
      first.proc.kill("SIGKILL");
      return waitForGone(target).then(() => {
        seedStartingRecord(fx.hostDir, startingRecord(replacement.pid, replacementUnit));
      });
    });
    const throwingSpawn = ((_command: string): ChildProcess => {
      throw new Error("stop after reap");
    }) as typeof nodeSpawn;
    const result = await startModelHost({
      key: { name: NAME },
      manifest: fx.manifest,
      workloadsDir: fx.workloadsDir,
      runtimeDir: fx.runtimeDir,
      env: fx.env,
      engineScope: null,
      spawn: throwingSpawn,
      probeReady: readyProbe(),
      identity: {
        processCommand: (p): string | null => (p === first.pid ? wrapperCmd(unit) : null),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stop after reap");
    const tombstone = JSON.parse(
      readFileSync(join(fx.hostDir, "modelhost.scope-stop"), "utf8"),
    ) as {
      scopeUnit?: string;
    };
    expect(tombstone.scopeUnit).toBe(unit);
    const kept = JSON.parse(readFileSync(join(fx.hostDir, "modelhost.starting"), "utf8")) as {
      pid?: number;
      scopeUnit?: string;
    };
    expect(kept.pid).toBe(replacement.pid);
    expect(kept.scopeUnit).toBe(replacementUnit);
  } finally {
    engine.teardown = originalTeardown;
    killQuiet(first.pid);
    killQuiet(replacement.pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 60_000);
