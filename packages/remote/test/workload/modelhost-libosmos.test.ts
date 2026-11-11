// #557 S3: end-to-end libosmos ModelHost lifecycle against the fake
// osmos-api fixture — real spawn, real probeReady, real state records.
// startModelHost calls are wrapped so the schema-parse failure at base
// (engine enum) surfaces as { ok:false } and the test fails by assertion.

import type { spawn as nodeSpawn } from "node:child_process";

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { EngineName } from "../../../core/src/engines/types.js";

import { readModelHostState } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { isProcessAlive } from "../../../core/src/pidIdentity.js";
import { reapFakeProcesses } from "../../../core/test/fake-process-reaper.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, stopModelHost } from "../../src/server/modelhost.js";

const spawnedPids = new Set<number>();

const NAME = "libosmos-ds41";
const REL =
  "DeepSeek-V4.1-Flash-1017-GGUF/UD-IQ1_M/DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf";
const PACK = "DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005";
const LIBOSMOS = "libosmos" as EngineName;

let tmp = "";
let binDir = "";
let modelsDir = "";
let runtimeDir = "";
let workloadsDir = "";
let port = 0;

const fakeOsmsApi = join(import.meta.dir, "..", "fixtures", "fake-osmos-api.ts");

function libosmosManifest(): Record<string, unknown> {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name: NAME },
    spec: {
      engine: "libosmos",
      node: "local",
      binary: join(binDir, "osmos-api"),
      endpoint: { host: "127.0.0.1", port },
      hostedModels: [{ rel: REL }],
      extraArgs: [
        "--max-context",
        "65536",
        "--dspark",
        "dspark/drafter.gguf",
        "--budget",
        "80",
        "--no-guess",
      ],
      restartPolicy: "Never",
      timeoutSeconds: 30,
    },
  };
}

function osmosDir(): string {
  return join(runtimeDir, "workloads", NAME, ".osmos");
}

function osmosJsonPath(): string {
  return join(osmosDir(), "osmos.json");
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-libosmos-"));
  binDir = join(tmp, "bin");
  mkdirSync(binDir, { recursive: true });
  // argv0 must read as osmos-api to the pid-identity argv0 check, so the
  // wrapper execs the bun binary under that name (rpcServer.test.ts pattern).
  writeFileSync(
    join(binDir, "osmos-api"),
    `#!/bin/bash\nexec -a osmos-api "${process.execPath}" "${fakeOsmsApi}" "$@"\n`,
    { mode: 0o755 },
  );

  modelsDir = join(tmp, "models");
  mkdirSync(dirname(join(modelsDir, REL)), { recursive: true });
  writeFileSync(join(modelsDir, REL), "");
  mkdirSync(join(modelsDir, "dspark"), { recursive: true });
  writeFileSync(join(modelsDir, "dspark", "drafter.gguf"), "");

  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  port = probe.port!;
  await probe.stop();

  runtimeDir = join(tmp, "runtime");
  workloadsDir = join(tmp, "workloads");
});

afterAll(async () => {
  await reapFakeProcesses({ scratch: tmp, pids: [...spawnedPids] });
  // tmp stays empty when beforeAll threw before mkdtempSync.
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

test("libosmos host lifecycle: start, adopt, stop", async () => {
  const key = { name: NAME };
  const env = { ...process.env, LLAMACTL_MODELS_DIR: modelsDir };

  const started = await startModelHost({
    key,
    runtimeDir,
    workloadsDir,
    env,
    manifest: libosmosManifest(),
  }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
  expect(started.ok).toBe(true);
  if (started.pid === null) throw new Error("startModelHost returned no pid");
  const pid = started.pid;
  spawnedPids.add(pid);

  expect(JSON.parse(readFileSync(osmosJsonPath(), "utf8"))).toEqual({
    pack: PACK,
    model: join(modelsDir, REL),
    drafter: join(modelsDir, "dspark", "drafter.gguf"),
    drafted_budget_gib: 80,
    max_context: 65536,
    no_guess: true,
  });
  expect(JSON.parse(readFileSync(join(osmosDir(), "argv.json"), "utf8"))).toEqual([
    "--config",
    osmosJsonPath(),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  const health = readFileSync(join(osmosDir(), "health.log"), "utf8").trim().split("\n");
  expect(health.slice(0, 2)).toEqual(["503", "503"]);
  expect(health).toContain("200");

  const state = readModelHostState(key, resolveEnv({ LOCAL_AI_RUNTIME_DIR: runtimeDir }));
  expect(state?.engine).toBe(LIBOSMOS);
  expect(state?.modelAliases ?? []).toContain(
    "DeepSeek-V4.1-Flash-1017-UD-IQ1_M-00001-of-00005.gguf",
  );

  // Adopt: rewrite the recorded pid to an already-exited process so the
  // next start falls through to listener adoption of the live engine.
  const stateFile = join(runtimeDir, "workloads", NAME, "modelhost.state");
  expect(existsSync(stateFile)).toBe(true);
  const recorded = readModelHostState(key, resolveEnv({ LOCAL_AI_RUNTIME_DIR: runtimeDir }));
  const livePid = recorded?.pid ?? null;
  expect(livePid).toBe(pid);
  if (livePid === null) throw new Error("no recorded pid to adopt");
  spawnedPids.add(livePid);

  const rewritten = JSON.parse(readFileSync(stateFile, "utf8")) as {
    pid: number;
    specHash?: string;
  };
  expect(typeof rewritten.specHash).toBe("string");
  rewritten.pid = Bun.spawnSync(["true"]).pid;
  writeFileSync(stateFile, JSON.stringify(rewritten));

  const adopted = await startModelHost({
    key,
    runtimeDir,
    workloadsDir,
    env,
    manifest: libosmosManifest(),
    findListenerPid: () => Promise.resolve(livePid),
  }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
  expect(adopted.ok).toBe(true);
  expect(adopted.pid).toBe(livePid);

  const stopped = await stopModelHost({ key, runtimeDir }).catch((e: unknown) => ({
    ok: false as const,
    pid: null,
    error: String(e),
  }));
  expect(stopped.ok).toBe(true);
  expect(stopped.pid).toBe(livePid);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessAlive(livePid)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  expect(isProcessAlive(livePid)).toBe(false);
}, 60_000);

test("runtime-dir pin", async () => {
  const operatorDir = join(tmp, "operator-runtime");
  mkdirSync(operatorDir, { recursive: true });
  let capturedArgs: readonly string[] | undefined;
  const spawn = mock((_binary: string, args: readonly string[]) => {
    capturedArgs = args;
    return { pid: 4321 } as const;
  });
  const result = await startModelHost({
    key: { name: NAME },
    runtimeDir,
    workloadsDir,
    env: {
      ...process.env,
      LLAMACTL_MODELS_DIR: modelsDir,
      LLAMACTL_RUNTIME_DIR: operatorDir,
    },
    manifest: libosmosManifest(),
    spawn: spawn as unknown as typeof nodeSpawn,
    probeReady: () => Promise.resolve({ ready: true, modelIds: ["x"] }),
  }).catch((e: unknown) => ({ ok: false as const, pid: null, error: String(e) }));
  expect(result.ok).toBe(true);
  const configIndex = (capturedArgs ?? []).indexOf("--config");
  expect(configIndex).toBeGreaterThanOrEqual(0);
  expect(capturedArgs?.[configIndex + 1]).toBe(osmosJsonPath());
}, 30_000);
