// #806 phase 2: adopt instead of restart. Re-starting a ModelHost or
// ModelRun whose recorded spec hash is unchanged must ADOPT the surviving
// engine — same pid, tracking files untouched — instead of tearing it down
// and spawning a replacement. Unhealthy engines, spec drift, legacy records
// without a hash, and explicit restart requests must still replace it.
//
// The surviving engine is produced the same way engine-survival.test.ts
// makes one: launched through the real start path from a short-lived parent
// that is then killed, so the engine is reparented and keeps its own
// process group. The re-start then runs IN-PROCESS against the same
// workloads/runtime dirs. keepAlive coverage (G10) runs the real worker
// loop in-process with an injected abort signal.
//
// The fake engine advertises FAKE_SURVIVAL_MODEL_ID ("survival-model.gguf",
// the hosted rel's basename) so adoption's model-id check can confirm
// ownership. ModelHost children only receive spec.env (the child-env
// allowlist drops everything else), so ModelHost manifests carry both fake
// vars in spec.env; ModelRun children inherit this test process's env,
// which beforeAll points at the same values. FAKE_SURVIVAL_SICK_DIR makes
// the engine answer 503 for a bounded number of /health + /v1/models
// requests, keyed by pid so a replacement engine is healthy by construction.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeModelHostSpecHash, readModelHostState } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { runKeepAliveWorker } from "../../../core/src/keepAlive.js";
import {
  readServerPid,
  serverStatus,
  startServer,
  type StartServerOptions,
  type StartServerResult,
  stopServer,
} from "../../../core/src/server.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import {
  startModelHost,
  type StartModelHostResult,
  statusModelHost,
  stopModelHost,
} from "../../src/server/modelhost.js";
import { ModelHostManifestSchema, specForHash } from "../../src/workload/modelhost-schema.js";
import {
  baseEnv,
  ephemeralPort,
  type FixtureDirs,
  isProcessAlive,
  killQuiet,
  launchFromDyingParent,
  makeFixtureDirs,
  makeSick,
  makeSickDir,
  manifestFor,
  MODELHOST_PARENT,
  MODELRUN_PARENT,
  parentPids,
  waitFor,
} from "../fixtures/engine-survival-helpers.js";

const SICK_MODEL_ID = "survival-model.gguf";
const TARGET_REL = "survival/survival-model.gguf";
const FAKE_ENV_KEYS = ["FAKE_SURVIVAL_MODEL_ID", "FAKE_SURVIVAL_SICK_DIR"] as const;

let scratchRoot = "";
let sickDir = "";
const enginePids = new Set<number>();
const savedFakeEnv = new Map<string, string | undefined>();

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-adopt-"));
  sickDir = makeSickDir(join(scratchRoot, "sick"));
  for (const key of FAKE_ENV_KEYS) {
    savedFakeEnv.set(key, process.env[key]);
  }
  process.env["FAKE_SURVIVAL_MODEL_ID"] = SICK_MODEL_ID;
  process.env["FAKE_SURVIVAL_SICK_DIR"] = sickDir;
});

afterAll(async () => {
  const saved = [...savedFakeEnv];
  const clearedKeys = new Set(saved.filter(([, value]) => value === undefined).map(([key]) => key));
  if (clearedKeys.size > 0) {
    process.env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !clearedKeys.has(key)),
    );
  }
  for (const [key, value] of saved) {
    if (value !== undefined) {
      process.env[key] = value;
    }
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

function fixtureSpecEnv(): Record<string, string> {
  return {
    FAKE_SURVIVAL_MODEL_ID: SICK_MODEL_ID,
    FAKE_SURVIVAL_SICK_DIR: sickDir,
  };
}

function workloadFile(dirs: FixtureDirs, name: string, file: string): string {
  return join(dirs.runtimeDir, "workloads", name, file);
}

function stripJsonField(path: string, field: string): void {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!(field in parsed)) return;
  const stripped = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== field));
  writeFileSync(path, JSON.stringify(stripped, null, 2));
}

interface ModelHostFixture {
  readonly dirs: FixtureDirs;
  readonly name: string;
  readonly port: number;
  readonly manifest: unknown;
  readonly env: NodeJS.ProcessEnv;
  readonly resolved: ReturnType<typeof resolveEnv>;
  readonly pidA: number;
}

// Launch a ModelHost engine through the real startModelHost in a dying
// parent, then return everything an in-process re-start needs.
async function launchModelHostFixture(
  name: string,
  specOverrides: Record<string, unknown> = {},
): Promise<ModelHostFixture> {
  const dirs = makeFixtureDirs(scratchRoot);
  const port = ephemeralPort();
  const manifest = manifestFor(name, join(dirs.binDir, "llama-server"), dirs.modelsDir, port, {
    env: fixtureSpecEnv(),
    ...specOverrides,
  });
  const env = baseEnv(dirs, port);
  const outcome = await launchFromDyingParent(MODELHOST_PARENT, {
    name,
    manifest,
    workloadsDir: dirs.workloadsDir,
    runtimeDir: dirs.runtimeDir,
    env,
    resultPath: join(dirs.tmp, "host-result.json"),
  });
  expect(outcome.error ?? "").toBe("");
  expect(outcome.ok).toBe(true);
  if (outcome.pid === null) throw new Error("startModelHost returned no pid");
  enginePids.add(outcome.pid);
  return { dirs, name, port, manifest, env, resolved: resolveEnv(env), pidA: outcome.pid };
}

function startModelHostLike(
  fixture: ModelHostFixture,
  manifest: unknown = fixture.manifest,
): Promise<StartModelHostResult> {
  return startModelHost({
    key: { name: fixture.name },
    manifest,
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
  });
}

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

// Same launch shape for a ModelRun engine via the core startServer parent.
async function launchModelRunFixture(name: string): Promise<ModelRunFixture> {
  const dirs = makeFixtureDirs(scratchRoot);
  const port = ephemeralPort();
  const env = baseEnv(dirs, port);
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model.gguf"), "");
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

// Exactly the options the dying parent passed to startServer.
function startServerLike(
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

test("a ModelHost re-start with an unchanged spec adopts the surviving engine", async () => {
  const fixture = await launchModelHostFixture("adopt-host-same");
  const statePath = workloadFile(fixture.dirs, fixture.name, "modelhost.state");
  const pidPath = workloadFile(fixture.dirs, fixture.name, "modelhost.pid");
  const stateBytes = readFileSync(statePath, "utf8");
  const pidBytes = readFileSync(pidPath, "utf8");
  const pidMtime = statSync(pidPath, { bigint: true }).mtimeNs;

  const events: unknown[] = [];
  const result = await startModelHost({
    key: { name: fixture.name },
    manifest: fixture.manifest,
    workloadsDir: fixture.dirs.workloadsDir,
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
    onEvent: (event) => {
      events.push(event);
    },
  });

  // Kills: deleting the same-hash adopt branch — the host is torn down and a
  // replacement pid is spawned instead. `adopted` lands on the result type
  // with the phase-2 fix; binding it to a const keeps the literal's excess
  // property check from firing at base.
  const expectedAdopted = { ok: true, pid: fixture.pidA, adopted: true };
  expect(result).toEqual(expectedAdopted);
  expect(isProcessAlive(fixture.pidA)).toBe(true);
  expect(readFileSync(statePath, "utf8")).toBe(stateBytes);
  expect(readFileSync(pidPath, "utf8")).toBe(pidBytes);
  expect(statSync(pidPath, { bigint: true }).mtimeNs).toBe(pidMtime);
  expect(events.at(-1)).toEqual({ type: "done", result });
  const status = statusModelHost({
    key: { name: fixture.name },
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
  });
  expect(status.state).toBe("Running");
  expect(status.pid).toBe(fixture.pidA);
}, 90_000);

test("a ModelRun re-start with an unchanged spec adopts the surviving engine", async () => {
  const fixture = await launchModelRunFixture("adopt-run-same");
  const statePath = workloadFile(fixture.dirs, fixture.name, "llama-server.state");
  const pidPath = workloadFile(fixture.dirs, fixture.name, "llama-server.pid");
  const stateBytes = readFileSync(statePath, "utf8");
  const pidBytes = readFileSync(pidPath, "utf8");

  const result = await startServerLike(fixture);

  // Kills: removing the adopt check ahead of stopBeforeStart — the tracked
  // pid is always stopped and a replacement spawned.
  expect(result.ok).toBe(true);
  expect(result.pid).toBe(fixture.pidA);
  expect((result as { adopted?: boolean }).adopted).toBe(true);
  expect(result.retried).toBe(false);
  expect(result.error).toBeUndefined();
  expect(isProcessAlive(fixture.pidA)).toBe(true);
  expect(readFileSync(statePath, "utf8")).toBe(stateBytes);
  expect(readFileSync(pidPath, "utf8")).toBe(pidBytes);
  const status = await serverStatus({ name: fixture.name }, fixture.resolved);
  expect(status.state).toBe("up");
  expect(status.pid).toBe(fixture.pidA);
}, 90_000);

test("a ModelHost re-start that changes only out-of-hash fields adopts and records them", async () => {
  const dirs = makeFixtureDirs(scratchRoot);
  const name = "adopt-host-fields";
  const port = ephemeralPort();
  const binary = join(dirs.binDir, "llama-server");
  const env = baseEnv(dirs, port);
  const resolved = resolveEnv(env);
  const manifestV1 = manifestFor(name, binary, dirs.modelsDir, port, {
    env: fixtureSpecEnv(),
  });

  const first = await startModelHost({
    key: { name },
    manifest: manifestV1,
    workloadsDir: dirs.workloadsDir,
    runtimeDir: dirs.runtimeDir,
    env,
  });
  expect(first.ok).toBe(true);
  if (first.pid === null) throw new Error("startModelHost returned no pid");
  const pidA = first.pid;
  enginePids.add(pidA);

  const priorState = readModelHostState({ name }, resolved);
  if (priorState === null) throw new Error("missing modelhost state after first start");
  const pidPath = workloadFile(dirs, name, "modelhost.pid");
  const pidBytes = readFileSync(pidPath, "utf8");
  const pidMtime = statSync(pidPath, { bigint: true }).mtimeNs;

  // readiness is recorded on the state sidecar but stays outside the spec
  // hash, so this re-start must adopt AND refresh the recorded probe.
  const manifestV2 = manifestFor(name, binary, dirs.modelsDir, port, {
    env: fixtureSpecEnv(),
    readiness: { path: "/health" },
  });
  const result = await startModelHost({
    key: { name },
    manifest: manifestV2,
    workloadsDir: dirs.workloadsDir,
    runtimeDir: dirs.runtimeDir,
    env,
  });

  // Kills: adopting without refreshing the out-of-hash fields — the pid
  // assertions fail at base (a restart happens) and the readiness assertion
  // fails if the adopt path drops the new declaration.
  const expectedAdopted = { ok: true, pid: pidA, adopted: true };
  expect(result).toEqual(expectedAdopted);
  expect(isProcessAlive(pidA)).toBe(true);
  expect(readFileSync(pidPath, "utf8")).toBe(pidBytes);
  expect(statSync(pidPath, { bigint: true }).mtimeNs).toBe(pidMtime);
  const state = readModelHostState({ name }, resolved);
  expect(state?.pid).toBe(pidA);
  expect(state?.startedAt).toBe(priorState.startedAt);
  expect(state?.specHash).toBe(priorState.specHash);
  expect(state?.readiness).toEqual({ path: "/health", expectStatus: 200 });
}, 90_000);

test("guard G1: a ModelHost spec change restarts the engine", async () => {
  const fixture = await launchModelHostFixture("adopt-host-drift");
  const changed = manifestFor(
    fixture.name,
    join(fixture.dirs.binDir, "llama-server"),
    fixture.dirs.modelsDir,
    fixture.port,
    { env: fixtureSpecEnv(), timeoutSeconds: 31 },
  );
  const result = await startModelHostLike(fixture, changed);

  // Kills: adopting whenever the pid is alive regardless of the spec hash.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old host exit", 10_000);
  const state = readModelHostState({ name: fixture.name }, fixture.resolved);
  const expectedHash = computeModelHostSpecHash(
    specForHash(ModelHostManifestSchema.parse(changed).spec),
  );
  expect(state?.specHash).toBe(expectedHash);
}, 90_000);

test("guard G2: a ModelHost record without specHash restarts", async () => {
  const fixture = await launchModelHostFixture("adopt-host-legacy");
  stripJsonField(workloadFile(fixture.dirs, fixture.name, "modelhost.state"), "specHash");
  const result = await startModelHostLike(fixture);

  // Kills: treating a missing hash as a match — the legacy record must
  // restart rather than adopt an unproven spec.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old host exit", 10_000);
}, 90_000);

test("guard G3: an explicit ModelHost restart replaces the engine", async () => {
  const fixture = await launchModelHostFixture("adopt-host-stop");
  const stopped = await stopModelHost({
    key: { name: fixture.name },
    runtimeDir: fixture.dirs.runtimeDir,
    env: fixture.env,
  });
  expect(stopped.ok).toBe(true);
  await waitFor(() => !isProcessAlive(fixture.pidA), "host exit", 10_000);

  const result = await startModelHostLike(fixture);

  // Kills: stop leaving an adoptable record behind — the key must be gone.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  expect("adopted" in result).toBe(false);
}, 90_000);

test("guard G4: an unhealthy ModelHost is restarted, not adopted", async () => {
  const fixture = await launchModelHostFixture("adopt-host-sick");
  makeSick(sickDir, fixture.pidA, 1_000_000);
  const result = await startModelHostLike(fixture);

  // Kills: adopting without the readiness probe — a sick engine answering
  // 503 must be replaced by a healthy one, never adopted.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old host exit", 10_000);
  const res = await fetch(`http://127.0.0.1:${String(fixture.port)}/health`);
  expect(res.status).toBe(200);
}, 90_000);

test("guard G5: a ModelRun spec change restarts the engine", async () => {
  const fixture = await launchModelRunFixture("adopt-run-drift");
  const result = await startServerLike(fixture, { extraArgs: ["--threads", "2"] });

  // Kills: leaving extraArgs out of the spec hash — a launch-affecting
  // change must restart even when the pid is alive and healthy.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old server exit", 10_000);
}, 90_000);

test("guard G6: a ModelRun record without specHash restarts", async () => {
  const fixture = await launchModelRunFixture("adopt-run-legacy");
  stripJsonField(workloadFile(fixture.dirs, fixture.name, "llama-server.state"), "specHash");
  const result = await startServerLike(fixture);

  // Kills: a missing hash counting as a match — legacy sidecars restart.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old server exit", 10_000);
}, 90_000);

test("guard G7: an explicit ModelRun restart replaces the engine", async () => {
  const fixture = await launchModelRunFixture("adopt-run-stop");
  const stopped = await stopServer({ key: { name: fixture.name }, resolved: fixture.resolved });
  expect(stopped.stopped).toBe(true);
  await waitFor(() => !isProcessAlive(fixture.pidA), "server exit", 10_000);

  const result = await startServerLike(fixture);

  // Kills: stop leaving an adoptable record behind.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  expect("adopted" in result).toBe(false);
}, 90_000);

test("guard G8: an unhealthy ModelRun is restarted, not adopted", async () => {
  const fixture = await launchModelRunFixture("adopt-run-sick");
  makeSick(sickDir, fixture.pidA, 1_000_000);
  const result = await startServerLike(fixture);

  // Kills: removing the /health gate in the adopt — a sick engine must be
  // replaced by a healthy one even when the spec hash matches.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old server exit", 10_000);
  const res = await fetch(`http://127.0.0.1:${String(fixture.port)}/health`);
  expect(res.status).toBe(200);
}, 90_000);

test("guard G9: restart:true forces a ModelRun replacement", async () => {
  const fixture = await launchModelRunFixture("adopt-run-flag");
  // `restart` lands with the #806 fix; the intersection keeps this
  // typechecking both before and after the option joins StartServerOptions.
  const restartOptions: StartServerOptions & { restart?: boolean } = {
    key: { name: fixture.name },
    target: fixture.target,
    endpoint: fixture.endpoint,
    timeoutSeconds: 30,
    skipTuned: true,
    env: fixture.env,
    restart: true,
  };
  const result = await startServer(restartOptions);

  // Kills: ignoring the restart flag on a healthy same-hash engine. At base
  // the flag is ignored and the restart happens anyway, so this passes.
  expect(result.ok).toBe(true);
  if (result.pid === null) throw new Error("restart returned no pid");
  expect(result.pid).not.toBe(fixture.pidA);
  enginePids.add(result.pid);
  await waitFor(() => !isProcessAlive(fixture.pidA), "old server exit", 10_000);
  expect("adopted" in result).toBe(false);
}, 90_000);

test("guard G10: keepAlive restarts a server whose health was lost", async () => {
  const dirs = makeFixtureDirs(scratchRoot);
  const name = "adopt-run-keepalive";
  const port = ephemeralPort();
  const env = baseEnv(dirs, port);
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model.gguf"), "");
  // runKeepAliveWorker writes llama-keep-alive.pid before writeState gets a
  // chance to mkdir LOCAL_AI_RUNTIME_DIR, so the dir must already exist.
  mkdirSync(dirs.runtimeDir, { recursive: true });
  const resolved = resolveEnv(env);
  const key = { name };
  const controller = new AbortController();
  const worker = runKeepAliveWorker({
    key,
    target: TARGET_REL,
    env,
    intervalSeconds: 1,
    signal: controller.signal,
  });

  // Captured through an array so the value read after waitFor keeps its
  // `number | undefined` type: a `let` narrowed to null by the closure's
  // initial value makes the post-wait guard an always-true comparison.
  const upPids: number[] = [];
  await waitFor(
    async () => {
      const status = await serverStatus(key, resolved);
      if (status.state === "up" && status.pid !== null && status.health.reachable) {
        upPids.push(status.pid);
        return true;
      }
      return false;
    },
    "keepAlive server up",
    30_000,
  );
  const pidA = upPids[0];
  if (pidA === undefined) throw new Error("keepAlive server never came up");
  enginePids.add(pidA);

  // Wait for the worker's own "ready" marker before arming the sick file:
  // pollHealthUntilDown sleeps a full interval before its first fetch, so
  // the ONLY requester left once ready is written is that health poll.
  // Arming earlier lets a startup-phase /health probe (startServer's
  // readiness poll or the status waitFor above) consume the single 503.
  const keepAliveStatePath = join(dirs.runtimeDir, "llama-keep-alive.state");
  await waitFor(
    () => {
      if (!existsSync(keepAliveStatePath)) return false;
      return readFileSync(keepAliveStatePath, "utf8").includes("state=ready");
    },
    "keepAlive ready state",
    30_000,
  );

  // Exactly one 503: the worker's next /health poll consumes it, after which
  // the engine answers 200 again. Without restart:true the post-fix adopt
  // path would see a healthy same-hash engine and keep pid A forever.
  makeSick(sickDir, pidA, 1);

  const replacementPids: number[] = [];
  await waitFor(
    () => {
      const pid = readServerPid(key, resolved);
      if (pid !== null && pid !== pidA) {
        replacementPids.push(pid);
        return true;
      }
      return false;
    },
    "keepAlive replacement pid",
    30_000,
  );
  const pidB = replacementPids[0];
  if (pidB !== undefined) enginePids.add(pidB);

  controller.abort();
  await worker;
}, 90_000);
