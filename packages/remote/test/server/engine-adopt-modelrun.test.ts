// #806 phase 2 item B: ModelRun launch-spec drift guards. The spec hash must
// cover every input that moves the spawned argv — target rel, absolute model
// path, skipTuned, the resolved tuned profile, the injected alias, extraArgs,
// host, port and binary — so a re-start that changes any of them replaces the
// engine instead of adopting it. Also pinned here: the port-conflict adopt
// must persist specHash (else the next same-spec start bounces the engine),
// and adoption must decline while a published residency registry reports the
// workload phase as other than open.
//
// Engines are real fake-survival-engine processes launched through the same
// dying-parent harness engine-adopt.test.ts uses; helpers are imported from
// the shared fixtures file, never from that test file.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultModeForRel, machineLabel } from "../../../core/src/bench/mode.js";
import { benchProfileFile } from "../../../core/src/bench/store.js";
import { resolveBuildId } from "../../../core/src/build.js";
import { ctxForModel } from "../../../core/src/ctx.js";
import { resolveEnv } from "../../../core/src/env.js";
import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "../../../core/src/residency/leases.js";
import {
  readServerState,
  startServer,
  type StartServerOptions,
  type StartServerResult,
} from "../../../core/src/server.js";
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
  isProcessAlive,
  killQuiet,
  launchFromDyingParent,
  makeFixtureDirs,
  MODELRUN_PARENT,
  parentPids,
  waitFor,
} from "../fixtures/engine-survival-helpers.js";

const MODEL_ID = "survival-model.gguf";
const TARGET_REL = "survival/survival-model.gguf";
const TARGET_REL_2 = "survival/survival-model-2.gguf";

let scratchRoot = "";
const enginePids = new Set<number>();
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-adopt-modelrun-"));
  savedEnv.set("FAKE_SURVIVAL_MODEL_ID", process.env["FAKE_SURVIVAL_MODEL_ID"]);
  process.env["FAKE_SURVIVAL_MODEL_ID"] = MODEL_ID;
});

afterAll(async () => {
  const saved = [...savedEnv];
  const cleared = saved.filter(([, value]) => value === undefined).map(([key]) => key);
  if (cleared.length > 0) {
    process.env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !cleared.includes(key)),
    );
  }
  for (const [key, value] of saved) {
    if (value !== undefined) process.env[key] = value;
  }
  for (const pid of parentPids) {
    killQuiet(pid);
  }
  const survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: [...enginePids] });
  if (scratchRoot !== "") {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  expect(survivors).toEqual([]);
}, 60_000);

interface ModelRunFixture {
  readonly dirs: FixtureDirs;
  readonly name: string;
  readonly port: number;
  readonly target: string;
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly env: NodeJS.ProcessEnv;
  readonly resolved: ReturnType<typeof resolveEnv>;
  readonly pidA: number;
}

function workloadFile(dirs: FixtureDirs, name: string, file: string): string {
  return join(dirs.runtimeDir, "workloads", name, file);
}

function adoptedFlag(result: StartServerResult): boolean | undefined {
  return (result as { adopted?: boolean }).adopted;
}

// Launch through the real startServer in the dying parent, exactly like
// engine-adopt.test.ts, so the engine survives its launcher.
async function launchModelRunFixture(name: string): Promise<ModelRunFixture> {
  const dirs = makeFixtureDirs(scratchRoot);
  const port = ephemeralPort();
  const env = baseEnv(dirs, port);
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model.gguf"), "");
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model-2.gguf"), "");
  const target = TARGET_REL;
  const endpoint = { host: "127.0.0.1", port };
  const outcome = await launchFromDyingParent(MODELRUN_PARENT, {
    name,
    target,
    endpoint,
    timeoutSeconds: 30,
    env,
    resultPath: join(dirs.tmp, "run-result.json"),
  });
  expect(outcome.error ?? "").toBe("");
  expect(outcome.ok).toBe(true);
  if (outcome.pid === null) throw new Error("startServer returned no pid");
  enginePids.add(outcome.pid);
  return {
    dirs,
    name,
    port,
    target,
    endpoint,
    env,
    resolved: resolveEnv(env),
    pidA: outcome.pid,
  };
}

// In-process startServer with the fixture's launch shape plus per-test
// overrides. Used for both the first launch (tuned-profile fixture, where the
// parent script's hardcoded skipTuned would not resolve a profile) and every
// re-start under test.
function startRun(
  fixture: ModelRunFixture,
  extra?: Partial<StartServerOptions>,
): Promise<StartServerResult> {
  return startServer({
    key: { name: fixture.name },
    target: fixture.target,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    ...extra,
  });
}

// A bench-profiles row pinning `profile` for the fixture rel, written the same
// way server.mmprojRetry.test.ts's writeThroughputProfile does.
function writeBenchRow(resolved: ReturnType<typeof resolveEnv>, profile: string): void {
  const row = [
    machineLabel(resolved),
    TARGET_REL,
    defaultModeForRel(TARGET_REL, resolved),
    ctxForModel(TARGET_REL, resolved),
    resolveBuildId(resolved),
    profile,
    "1",
    "1",
    "2026-01-01T00:00:00.000Z",
  ];
  const file = benchProfileFile(resolved);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${row.join("\t")}\n`);
}

async function expectReplacement(
  fixture: ModelRunFixture,
  result: StartServerResult,
): Promise<void> {
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  expect(adoptedFlag(result)).not.toBe(true);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old server exit", 10_000);
}

test("ModelRun drift: a skipTuned flip replaces the engine", async () => {
  const fixture = await launchModelRunFixture("mr-drift-skip");
  const result = await startRun(fixture, { skipTuned: false });
  // Kills: leaving skipTuned out of the spec hash — the same live engine
  // would be adopted even though the next launch's argv differs.
  await expectReplacement(fixture, result);
}, 90_000);

test("ModelRun drift: a tuned-profile change replaces the engine", async () => {
  const dirs = makeFixtureDirs(scratchRoot);
  const name = "mr-drift-tuned";
  const port = ephemeralPort();
  const env = baseEnv(dirs, port);
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model.gguf"), "");
  const resolved = resolveEnv(env);
  writeBenchRow(resolved, "throughput");
  const endpoint = { host: "127.0.0.1", port };
  const first = await startServer({
    key: { name },
    target: TARGET_REL,
    endpoint,
    timeoutSeconds: 30,
    skipTuned: false,
    env,
  });
  expect(first.ok).toBe(true);
  if (first.pid === null) throw new Error("first start returned no pid");
  enginePids.add(first.pid);
  const fixture: ModelRunFixture = {
    dirs,
    name,
    port,
    target: TARGET_REL,
    endpoint,
    env,
    resolved,
    pidA: first.pid,
  };
  const prior = readServerState({ name }, resolved);
  expect(prior?.tunedProfile).toBe("throughput");
  const priorHash = prior?.specHash;

  writeBenchRow(resolved, "conservative");
  const result = await startRun(fixture, { skipTuned: false });

  // Kills: hashing the profile name request rather than the resolved profile —
  // or dropping it — so a bench-table change is adopted instead of applied.
  await expectReplacement(fixture, result);
  const state = readServerState({ name }, resolved);
  expect(state?.tunedProfile).toBe("conservative");
  expect(state?.specHash).not.toBe(priorHash);
}, 90_000);

test("ModelRun drift: a different target rel replaces the engine", async () => {
  const fixture = await launchModelRunFixture("mr-drift-rel");
  const result = await startRun(fixture, { target: TARGET_REL_2 });
  // Kills: M16 — dropping `rel` from the spec hash.
  await expectReplacement(fixture, result);
}, 90_000);

test("ModelRun drift: a different binary path replaces the engine", async () => {
  const fixture = await launchModelRunFixture("mr-drift-bin");
  const altDir = join(fixture.dirs.binDir, "alt");
  mkdirSync(altDir, { recursive: true });
  const altBinary = join(altDir, "llama-server");
  writeFileSync(altBinary, readFileSync(join(fixture.dirs.binDir, "llama-server"), "utf8"), {
    mode: 0o755,
  });
  const result = await startRun(fixture, { binary: altBinary });
  // Kills: M15 — dropping `binary` from the spec hash.
  await expectReplacement(fixture, result);
}, 90_000);

test("ModelRun drift: a changed bind host replaces the engine", async () => {
  const fixture = await launchModelRunFixture("mr-drift-host");
  const result = await startRun(fixture, {
    endpoint: { host: "0.0.0.0", port: fixture.port },
    allowExternalBind: true,
  });
  // Kills: M17 — dropping `host` from the spec hash.
  await expectReplacement(fixture, result);
}, 90_000);

test("ModelRun pid identity: a sidecar pointing at a non-engine pid is refused, not adopted", async () => {
  const fixture = await launchModelRunFixture("mr-pid-identity");
  const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const sleepPid = sleeper.pid;
  try {
    // Same specHash, same shape — but the recorded pid is a live `sleep`,
    // not the llama-server argv the identity check requires. /health still
    // answers because the real engine kept the port.
    const statePath = workloadFile(fixture.dirs, fixture.name, "llama-server.state");
    const pidPath = workloadFile(fixture.dirs, fixture.name, "llama-server.pid");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    state["pid"] = sleepPid;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    writeFileSync(pidPath, `${String(sleepPid)}\n`);

    const result = await startRun(fixture);

    // Kills: M19 — adopting on a pid whose identity verdict is not "alive".
    // The start must fail closed, never report adopted:true, and must not
    // signal either live process.
    expect(result.ok).toBe(false);
    expect(adoptedFlag(result)).not.toBe(true);
    expect(result.error ?? "").toContain("pid identity unknown");
    expect(isProcessAlive(sleepPid)).toBe(true);
    expect(isProcessAlive(fixture.pidA)).toBe(true);
  } finally {
    try {
      process.kill(sleepPid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}, 90_000);

test("port-conflict adopt records specHash so a same-spec re-start adopts", async () => {
  const fixture = await launchModelRunFixture("mr-port-adopt");
  const statePath = workloadFile(fixture.dirs, fixture.name, "llama-server.state");
  const pidPath = workloadFile(fixture.dirs, fixture.name, "llama-server.pid");
  // Drop the tracking pair while the engine keeps the port: the next start
  // takes the port-conflict adopt path, which must write specHash itself.
  rmSync(statePath);
  rmSync(pidPath);

  const first = await startRun(fixture);
  expect(first.ok).toBe(true);
  expect(first.pid).toBe(fixture.pidA);
  expect(existsSync(statePath)).toBe(true);

  const second = await startRun(fixture);
  expect(second.ok).toBe(true);
  expect(second.pid).toBe(fixture.pidA);
  expect(adoptedFlag(second)).toBe(true);
  expect(isProcessAlive(fixture.pidA)).toBe(true);
}, 90_000);

test("port-conflict adopt of a listener with different argv omits specHash so the next same-manifest start replaces the engine", async () => {
  const fixture = await launchModelRunFixture("mr-port-adopt-argv-drift");
  const statePath = workloadFile(fixture.dirs, fixture.name, "llama-server.state");
  const pidPath = workloadFile(fixture.dirs, fixture.name, "llama-server.pid");
  // Drop the tracking pair so the still-running engine (launched without `-c`)
  // is adopted through the port-conflict path by a start that asks for
  // `-c 32768`. Base stamped the desired specHash onto that argv-mismatched
  // listener, so the next start adopted the stale launch and never applied
  // `-c 32768`; the fix records no hash, so the next start replaces the pid.
  rmSync(statePath);
  rmSync(pidPath);

  const first = await startRun(fixture, { extraArgs: ["-c", "32768"] });
  expect(first.ok).toBe(true);
  expect(first.pid).toBe(fixture.pidA);
  const afterAdopt = readServerState({ name: fixture.name }, fixture.resolved);
  expect(afterAdopt?.specHash).toBeUndefined();

  const second = await startRun(fixture, { extraArgs: ["-c", "32768"] });
  await expectReplacement(fixture, second);
}, 90_000);

test("adopt declines while the residency phase is not open", async () => {
  const fixture = await launchModelRunFixture("mr-residency");
  const reg: ResidencyLeases = createResidencyLeases();
  setResidencyLeaseRegistry(reg);
  try {
    const drain = reg.beginDrain(fixture.name);
    if (!drain.ok) throw new Error(`beginDrain refused: ${drain.reason}`);
    expect(reg.commitUnload(drain.token).ok).toBe(true);
    expect(reg.snapshot(fixture.name).phase).toBe("unloaded");

    const result = await startRun(fixture);

    // Adopting here would hand withReopenAfterLoad an "unchanged" engine for a
    // workload whose admission is closed; the start must replace it instead.
    await expectReplacement(fixture, result);
    expect(reg.snapshot(fixture.name).phase).toBe("open");
  } finally {
    setResidencyLeaseRegistry(null);
  }
}, 90_000);
