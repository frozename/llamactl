// #806 phase 1: engine survival contract. A ModelHost or ModelRun engine is
// launched through the real startModelHost / startServer from a SHORT-LIVED
// parent process, which is then killed. The engine (the parent's child, this
// test's grandchild) must keep serving, keep its own process group and its
// file-backed stdio, keep being reported Running by statusModelHost /
// serverStatus / listLocalRoutes, and keep being advertised by a fresh
// listServingOpenAIModels read. No behaviour change; this pins the contract.
//
// Phase 2 (adopt-instead-of-restart) is pinned in engine-adopt.test.ts; the
// ModelRun case below also pins the phase-2 gap #812 left: a fresh
// listServingOpenAIModels read must advertise the surviving ModelRun route.
//
// The stdio checks read the live child's fds with `lsof`. On macOS fd 0 for a
// `stdio: ["ignore", log, log]` launch lands on /dev/null; some runtimes leave
// it closed instead, so "closed" is accepted for fd 0 ONLY. fd 1 and fd 2 must
// be the engine's regular log file — a pipe or socket there would mean the
// engine dies with its launching parent.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEnv } from "../../../core/src/env.js";
import { listServingOpenAIModels } from "../../../core/src/openaiProxy.js";
import { serverStatus } from "../../../core/src/server.js";
import { listLocalRoutes } from "../../../core/src/workloadRuntime.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "../../src/safe-fs.js";
import { statusModelHost } from "../../src/server/modelhost.js";
import {
  baseEnv,
  ephemeralPort,
  isProcessAlive,
  killQuiet,
  launchFromDyingParent,
  makeFixtureDirs,
  manifestFor,
  MODELHOST_PARENT,
  MODELRUN_PARENT,
  parentPids,
  waitFor,
} from "../fixtures/engine-survival-helpers.js";

const enginePids = new Set<number>();
let scratchRoot = "";

function normalizePath(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

function processGroup(pid: number): number {
  const res = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
  return Number.parseInt(new TextDecoder().decode(res.stdout).trim(), 10);
}

// macOS ships lsof in /usr/sbin, which launchd PATH (and some test shells)
// omit — resolve by absolute path the same way probe.ts does.
function lsofPath(): string {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof", "/bin/lsof"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "lsof";
}

// fd -> resolved target for fds 0, 1 and 2, read straight from the kernel via
// lsof. A missing fd is simply absent from the map (i.e. "closed").
function stdioTargets(pid: number): Map<number, string> {
  const res = Bun.spawnSync([lsofPath(), "-p", String(pid), "-F", "fn"]);
  const stdout = new TextDecoder().decode(res.stdout);
  if (res.exitCode !== 0 || stdout.trim() === "") {
    throw new Error(`lsof failed for pid ${String(pid)}: exitCode=${String(res.exitCode)}`);
  }
  const targets = new Map<number, string>();
  let fd = -1;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("f")) {
      fd = Number.parseInt(line.slice(1), 10);
    } else if (line.startsWith("n") && fd >= 0 && fd <= 2) {
      targets.set(fd, line.slice(1));
    }
  }
  return targets;
}

function assertSurvivingEngine(enginePid: number, bootLogPath: string): void {
  // The launched engine is alive and leads its own process group, so a signal
  // aimed at the (now dead) parent's group cannot reach it.
  expect(isProcessAlive(enginePid)).toBe(true);
  expect(processGroup(enginePid)).toBe(enginePid);

  expect(existsSync(bootLogPath)).toBe(true);
  expect(statSync(bootLogPath).isFile()).toBe(true);
  const logTarget = normalizePath(bootLogPath);
  const fds = stdioTargets(enginePid);

  // fd 1 and fd 2 must be the regular engine log, never a pipe or socket.
  for (const fd of [1, 2]) {
    const target = fds.get(fd);
    expect(target).toBeDefined();
    expect(normalizePath(target ?? "")).toBe(logTarget);
  }

  // fd 0 is only ever accepted as /dev/null or closed (see file header).
  const stdinTarget = fds.get(0);
  if (stdinTarget !== undefined) {
    expect(stdinTarget).toBe("/dev/null");
  }
}

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "llamactl-engine-survival-"));
});

afterAll(async () => {
  for (const pid of parentPids) {
    killQuiet(pid);
  }
  const survivors = await reapFakeProcesses({ scratch: scratchRoot, pids: [...enginePids] });
  if (scratchRoot !== "") {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  expect(survivors).toEqual([]);
}, 60_000);

test("a ModelHost engine survives the death of its launching parent", async () => {
  const dirs = makeFixtureDirs(scratchRoot);
  const name = "survival-host";
  const port = ephemeralPort();
  const manifest = manifestFor(name, join(dirs.binDir, "llama-server"), dirs.modelsDir, port);
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
  const enginePid = outcome.pid;
  enginePids.add(enginePid);

  // Give the reparent a moment, then assert the survival contract holds.
  await waitFor(() => isProcessAlive(enginePid), "engine liveness", 5_000);
  assertSurvivingEngine(enginePid, join(dirs.runtimeDir, "workloads", name, "modelhost.boot.log"));

  const resolved = resolveEnv(env);
  const status = statusModelHost({ key: { name }, runtimeDir: dirs.runtimeDir, env });
  expect(status.state).toBe("Running");
  expect(status.pid).toBe(enginePid);
  expect(typeof status.specHash).toBe("string");

  const routes = listLocalRoutes(resolved).filter((route) => route.workload === name);
  expect(routes.length).toBeGreaterThan(0);
  expect(routes[0]?.pid).toBe(enginePid);
  expect(routes[0]?.engine).toBe("llamacpp");

  // A new agent read advertises the surviving model.
  const models = await listServingOpenAIModels(resolved);
  const ids = models.data.map((model) => model.id);
  expect(ids).toContain("survival/survival-model.gguf");
  expect(ids).toContain("survival-model.gguf");
}, 90_000);

test("a ModelRun engine survives the death of its launching parent", async () => {
  const dirs = makeFixtureDirs(scratchRoot);
  const name = "survival-run";
  const port = ephemeralPort();
  const env = baseEnv(dirs, port);
  writeFileSync(join(dirs.modelsDir, "survival", "survival-model.gguf"), "");

  const outcome = await launchFromDyingParent(MODELRUN_PARENT, {
    name,
    target: "survival/survival-model.gguf",
    endpoint: { host: "127.0.0.1", port },
    timeoutSeconds: 30,
    env,
    resultPath: join(dirs.tmp, "run-result.json"),
  });
  expect(outcome.error ?? "").toBe("");
  expect(outcome.ok).toBe(true);
  if (outcome.pid === null) throw new Error("startServer returned no pid");
  const enginePid = outcome.pid;
  enginePids.add(enginePid);

  await waitFor(() => isProcessAlive(enginePid), "engine liveness", 5_000);
  assertSurvivingEngine(enginePid, join(dirs.runtimeDir, "workloads", name, "llama-server.log"));

  const resolved = resolveEnv(env);
  const status = await serverStatus({ name }, resolved);
  expect(status.state).toBe("up");
  expect(status.pid).toBe(enginePid);
  expect(status.health.reachable).toBe(true);

  const routes = listLocalRoutes(resolved).filter((route) => route.workload === name);
  expect(routes.length).toBeGreaterThan(0);
  expect(routes[0]?.pid).toBe(enginePid);
  expect(routes[0]?.kind).toBe("ModelRun");

  // Phase-2 gap pin: a fresh agent read must advertise the surviving ModelRun
  // route — dropping ModelRun routes from the served listing fails here.
  const routeModel = routes[0]?.model;
  if (routeModel === undefined) throw new Error("surviving route has no model id");
  expect(routeModel).toBe("survival/survival-model.gguf");
  const serving = await listServingOpenAIModels(resolved);
  const servedIds = serving.data.map((model) => model.id);
  expect(servedIds).toContain(routeModel);
  const served = serving.data.find((model) => model.id === routeModel);
  expect(served?.owned_by).toBe("llamactl-agent");
}, 90_000);
