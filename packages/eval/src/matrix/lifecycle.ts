import type { EngineBootEnv, ModelHostSpecForEngine } from "@llamactl/core/engines";

import { ENGINES } from "@llamactl/core/engines";
import { resolveProfile } from "@llamactl/core/profile";
import { type ChildProcess, spawn } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { ModelSpec } from "./types.js";

import { existsSync } from "../safe-fs.js";

const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_TIMEOUT_MS = 120_000;
const STDERR_BUFFER_LINES = 50;

const ownedProcs = new Set<ChildProcess>();
let exitHookInstalled = false;

export interface BootResult {
  owned: boolean;
  proc: ChildProcess | null;
}

/**
 * Signal the whole process group of an owned server proc. Owned procs are
 * spawned `detached: true` (a new session/group leader, so the process-group id
 * equals the pid), so a negative-pid signal reaches the server AND any worker
 * subprocesses it forked (e.g. oMLX model workers) — signalling only the direct
 * child orphans those. Falls back to a direct child kill when the proc has no
 * pid (never spawned) or the group is already gone.
 */
function signalOwnedProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid === undefined) {
    try {
      proc.kill(signal);
    } catch {
      // Best-effort cleanup during process teardown.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Best-effort fallback after process-group signalling fails.
    }
  }
}

/**
 * A child has terminated once it reports either an exit code or a death signal.
 * A SIGTERM/SIGKILL-terminated process keeps `exitCode === null` and reports the
 * signal in `signalCode`, so checking only `exitCode` never observes a
 * signal-killed server and spins the teardown wait loop for its full timeout.
 */
function hasExited(proc: ChildProcess): boolean {
  const signalCode = (proc as { signalCode?: NodeJS.Signals | null }).signalCode;
  return proc.exitCode !== null || (signalCode !== null && signalCode !== undefined);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const cleanup = (): void => {
    for (const p of ownedProcs) {
      if (!hasExited(p)) {
        signalOwnedProcessGroup(p, "SIGTERM");
      }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

async function pingHealth(
  host: string,
  port: number,
  timeoutMs = 2000,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const resp = await fetch(`http://${host}:${String(port)}/health`, {
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeInference(
  host: string,
  port: number,
  timeoutMs: number,
  modelId = "local",
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const resp = await fetch(`http://${host}:${String(port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
    };
    // Some engines (oMLX gemma4 parser) route chain-of-thought into
    // reasoning_content and leave content empty under tight max_tokens
    // budgets. Accept either as proof the model responded.
    const msg = body.choices?.[0]?.message;
    return typeof msg?.content === "string" || typeof msg?.reasoning_content === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildLlamaCppBootCommand(model: ModelSpec): { binary: string; args: string[] } {
  if (!model.binary) {
    throw new Error(`model ${model.name} managed=true but binary not found: ${model.binary ?? ""}`);
  }
  return {
    binary: model.binary,
    args: [
      "-m",
      model.gguf_path,
      "--host",
      model.host,
      "--port",
      String(model.port),
      ...(model.start_args ?? []),
      ...(model.extra_args ?? []),
    ],
  };
}

function buildOmlxLaunch(model: ModelSpec): { spec: ModelHostSpecForEngine; env: EngineBootEnv } {
  if (!model.binary || !existsSync(model.binary)) {
    throw new Error(`model ${model.name} managed=true but binary not found: ${model.binary ?? ""}`);
  }
  const rel = model.request_model_id ?? (model.gguf_path ? basename(model.gguf_path) : model.name);
  const spec: ModelHostSpecForEngine = {
    engine: "omlx",
    binary: model.binary,
    endpoint: { host: model.host, port: model.port },
    // hostedModels is a no-op for the matrix path (oMLX auto-discovers
    // models from --model-dir subdirs). Use request_model_id when
    // provided, else fall back to basename(gguf_path) for legacy
    // llama.cpp-style specs that set both fields.
    hostedModels: [model.dflash ? { rel, dflash: model.dflash as never } : { rel }],
    resources: {},
    extraArgs: [...(model.extra_args ?? [])],
    timeoutSeconds: 60,
  };
  const env: EngineBootEnv = { ...process.env } as EngineBootEnv;
  if (model.mlx_model_dir) env.LLAMACTL_MODELS_DIR = model.mlx_model_dir;
  env.workloadName = model.name;
  env.machineProfile = resolveProfile(process.env);
  return { spec, env };
}

export function buildBootCommandForModelSpec(model: ModelSpec): { binary: string; args: string[] } {
  if ((model.engine ?? "llamacpp") === "omlx") {
    const { spec, env } = buildOmlxLaunch(model);
    return ENGINES.omlx.buildBootCommand(spec, env);
  }
  return buildLlamaCppBootCommand(model);
}

export async function ensureModelServing(model: ModelSpec): Promise<BootResult> {
  if (await pingHealth(model.host, model.port)) {
    return { owned: false, proc: null };
  }
  if (!model.managed) {
    throw new Error(
      `model ${model.name} at ${model.host}:${String(model.port)} is not reachable and managed=false`,
    );
  }
  if (!model.binary || !existsSync(model.binary)) {
    throw new Error(`model ${model.name} managed=true but binary not found: ${model.binary ?? ""}`);
  }
  if ((model.engine ?? "llamacpp") === "omlx") {
    const { spec, env } = buildOmlxLaunch(model);
    await ENGINES.omlx.prepareLaunch?.(spec, env);
  }
  const boot = buildBootCommandForModelSpec(model);
  // detached: true makes the server its own process-group leader so teardown
  // can signal the whole group (the server + any worker subprocesses it forks).
  const proc = spawn(boot.binary, boot.args, { stdio: "pipe", detached: true });
  const stderrTail: string[] = [];
  function pushStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      stderrTail.push(line);
      while (stderrTail.length > STDERR_BUFFER_LINES) stderrTail.shift();
    }
  }
  proc.stdout.resume();
  proc.stderr.on("data", pushStderr);
  const bootController = new AbortController();
  const healthBoot = waitForHealthyBoot(model, proc, stderrTail, bootController.signal);
  const spawnErrorP = new Promise<never>((_, reject) => {
    proc.on("error", (err) => {
      reject(new Error(`failed to spawn ${model.name}: ${err.message}`));
    });
  });
  try {
    return await Promise.race([healthBoot, spawnErrorP]);
  } finally {
    bootController.abort();
    await healthBoot.catch(() => undefined);
  }
}

/** /v1 boot-probe for a server that just passed /health; tears the
 *  owned proc down and throws when the probe fails. */
async function probeBootedServer(
  model: ModelSpec,
  proc: ChildProcess,
  stderrTail: string[],
  signal?: AbortSignal,
): Promise<void> {
  // dflash variants hit a 3-30 GB draft model sync from HF on first
  // load. 30s isn't always enough on slow links; give them 180s.
  const probeTimeoutMs = (model as { dflash?: unknown }).dflash ? 180_000 : 30_000;
  const ok = await probeInference(
    model.host,
    model.port,
    probeTimeoutMs,
    model.request_model_id ?? "local",
    signal,
  );
  signal?.throwIfAborted();
  if (!ok) {
    signalOwnedProcessGroup(proc, "SIGTERM");
    throw new Error(
      `llama-server for ${model.name} /v1 boot-probe failed\n--- stderr tail ---\n${stderrTail.join("\n")}`,
    );
  }
}

export async function waitForHealthyBoot(
  model: ModelSpec,
  proc: ChildProcess,
  stderrTail: string[],
  signal?: AbortSignal,
): Promise<BootResult> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (hasExited(proc)) {
      const signalCode = (proc as { signalCode?: NodeJS.Signals | null }).signalCode;
      const how =
        proc.exitCode !== null ? `code=${String(proc.exitCode)}` : `signal=${String(signalCode)}`;
      throw new Error(
        `llama-server for ${model.name} exited before /health came up (${how})\n--- stderr tail ---\n${stderrTail.join("\n")}`,
      );
    }
    const healthy = await pingHealth(model.host, model.port, 2000, signal);
    signal?.throwIfAborted();
    if (healthy) {
      await probeBootedServer(model, proc, stderrTail, signal);
      installExitHook();
      ownedProcs.add(proc);
      return { owned: true, proc };
    }
    await sleep(HEALTH_POLL_INTERVAL_MS, undefined, { signal });
  }
  signal?.throwIfAborted();
  signalOwnedProcessGroup(proc, "SIGTERM");
  throw new Error(
    `llama-server for ${model.name} health timeout after ${String(HEALTH_TIMEOUT_MS)}ms\n--- stderr tail ---\n${stderrTail.join("\n")}`,
  );
}

export async function teardownIfOwned(boot: BootResult): Promise<void> {
  if (!boot.owned || !boot.proc || hasExited(boot.proc)) return;
  ownedProcs.delete(boot.proc);
  signalOwnedProcessGroup(boot.proc, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !hasExited(boot.proc)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!hasExited(boot.proc)) signalOwnedProcessGroup(boot.proc, "SIGKILL");
}

export function __ownedProcsForTests(): ReadonlySet<ChildProcess> {
  return ownedProcs;
}

export function __seedOwnedProcForTests(proc: ChildProcess): void {
  ownedProcs.add(proc);
}
