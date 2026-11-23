// Shared fixtures for the #806 engine-survival / engine-adopt suites.
// Not a *.test.ts file: both server/engine-survival.test.ts and
// server/engine-adopt.test.ts import these helpers relatively.

import { join } from "node:path";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "../../src/safe-fs.js";

export interface ParentConfig {
  readonly name: string;
  readonly manifest?: unknown;
  readonly target?: string;
  readonly endpoint?: { readonly host: string; readonly port: number };
  readonly workloadsDir?: string;
  readonly runtimeDir?: string;
  readonly timeoutSeconds?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly resultPath: string;
}

export interface LaunchOutcome {
  readonly ok: boolean;
  readonly pid: number | null;
  readonly error: string | null;
}

export interface FixtureDirs {
  readonly tmp: string;
  readonly modelsDir: string;
  readonly binDir: string;
  readonly runtimeDir: string;
  readonly workloadsDir: string;
}

export const MODELHOST_PARENT = join(import.meta.dir, "engine-survival-modelhost-parent.ts");
export const MODELRUN_PARENT = join(import.meta.dir, "engine-survival-modelrun-parent.ts");
export const FAKE_ENGINE = join(import.meta.dir, "fake-survival-engine.ts");

export const parentPids = new Set<number>();

export function isProcessAlive(pid: number): boolean {
  const res = Bun.spawnSync(["ps", "-o", "pid=", "-p", String(pid)]);
  return res.exitCode === 0 && new TextDecoder().decode(res.stdout).trim() !== "";
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

export function killQuiet(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Launch through the real path from a short-lived parent, then kill the parent
// and return the surviving engine pid.
export async function launchFromDyingParent(
  parentScript: string,
  config: ParentConfig,
): Promise<LaunchOutcome> {
  const proc = Bun.spawn([process.execPath, parentScript, JSON.stringify(config)], {
    // Pass the live env: Bun does not forward runtime-mutated process.env
    // (FAKE_SURVIVAL_SICK_DIR, FAKE_SURVIVAL_MODEL_ID) to a spawn without one.
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  parentPids.add(proc.pid);
  await waitFor(() => existsSync(config.resultPath), "launch result", 30_000);
  const resultRaw = readFileSync(config.resultPath, "utf8");
  const outcome = JSON.parse(resultRaw) as LaunchOutcome;
  if (!outcome.ok) {
    throw new Error(`launch failed raw=${JSON.stringify(resultRaw)} spawnPid=${String(proc.pid)}`);
  }
  killQuiet(proc.pid);
  await waitFor(() => !isProcessAlive(proc.pid), "parent death", 10_000);
  return outcome;
}

export function manifestFor(
  name: string,
  binary: string,
  modelsDir: string,
  port: number,
  specOverrides: Record<string, unknown> = {},
): unknown {
  writeFileSync(join(modelsDir, "survival", "survival-model.gguf"), "");
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "llamacpp",
      node: "local",
      enabled: true,
      binary,
      endpoint: { host: "127.0.0.1", port },
      hostedModels: [{ rel: "survival/survival-model.gguf" }],
      extraArgs: [],
      restartPolicy: "Never",
      timeoutSeconds: 30,
      ...specOverrides,
    },
  };
}

export function ephemeralPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) {
    throw new Error("could not reserve an ephemeral port");
  }
  return port;
}

export function makeFixtureDirs(scratchRoot: string): FixtureDirs {
  const tmp = mkdtempSync(join(scratchRoot, "engine-survival-"));
  const modelsDir = join(tmp, "models");
  const binDir = join(tmp, "bin");
  const runtimeDir = join(tmp, "runtime");
  const workloadsDir = join(tmp, "workloads");
  mkdirSync(join(modelsDir, "survival"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // argv0 must read as llama-server to the pid-identity check, so the wrapper
  // execs the bun binary under that name (modelhost-libosmos.test.ts pattern).
  writeFileSync(
    join(binDir, "llama-server"),
    `#!/bin/bash\nexec -a llama-server "${process.execPath}" "${FAKE_ENGINE}" "$@"\n`,
    { mode: 0o755 },
  );
  return { tmp, modelsDir, binDir, runtimeDir, workloadsDir };
}

export function baseEnv(dirs: FixtureDirs, port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: join(dirs.tmp, "home"),
    LOCAL_AI_RUNTIME_DIR: dirs.runtimeDir,
    LLAMACTL_MODELS_DIR: dirs.modelsDir,
    LLAMA_CPP_MODELS: dirs.modelsDir,
    LLAMA_CPP_BIN: dirs.binDir,
    LLAMA_CPP_CACHE: join(dirs.tmp, "cache"),
    LLAMA_CPP_LOGS: join(dirs.tmp, "logs"),
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: String(port),
    LLAMA_CPP_MACHINE_PROFILE: "balanced",
  };
}

// #806 phase 2: the fake engine's sickness toggle. FAKE_SURVIVAL_SICK_DIR
// points at a directory; a file named for the engine pid holding N > 0 makes
// the next N requests to /health and /v1/models answer 503. Keying on pid
// means a replacement engine (new pid) is healthy by construction.
export function makeSickDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeSick(dir: string, pid: number, n: number): void {
  writeFileSync(join(dir, String(pid)), `${String(n)}\n`);
}
