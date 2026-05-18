import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { ENGINES } from '../../../core/src/engines/index.js';
import type { ModelHostSpecForEngine } from '../../../core/src/engines/types.js';
import type { ModelSpec } from './types.js';

const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_TIMEOUT_MS = 120_000;
const STDERR_BUFFER_LINES = 50;

const ownedProcs = new Set<ChildProcess>();
let exitHookInstalled = false;

export interface BootResult {
  owned: boolean;
  proc: ChildProcess | null;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const cleanup = () => {
    for (const p of ownedProcs) {
      if (p.exitCode === null) {
        try {
          p.kill('SIGTERM');
        } catch {}
      }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

async function pingHealth(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function probeInference(host: string, port: number, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return typeof body.choices?.[0]?.message?.content === 'string';
  } catch {
    return false;
  }
}

function buildLlamaCppBootCommand(model: ModelSpec): { binary: string; args: string[] } {
  return {
    binary: model.binary!,
    args: [
      '-m',
      model.gguf_path,
      '--host',
      model.host,
      '--port',
      String(model.port),
      ...(model.start_args ?? []),
      ...(model.extra_args ?? []),
    ],
  };
}

export function buildBootCommandForModelSpec(model: ModelSpec): { binary: string; args: string[] } {
  if ((model.engine ?? 'llamacpp') === 'omlx') {
    if (!model.binary || !existsSync(model.binary)) {
      throw new Error(`model ${model.name} managed=true but binary not found: ${model.binary}`);
    }
    const spec: ModelHostSpecForEngine = {
      engine: 'omlx',
      binary: model.binary,
      endpoint: { host: model.host, port: model.port },
      hostedModels: [{ rel: basename(model.gguf_path) }],
      resources: {},
      extraArgs: model.extra_args ?? [],
      timeoutSeconds: 60,
    };
    return ENGINES.omlx.buildBootCommand(spec, {
      LLAMACTL_MODELS_DIR: model.mlx_model_dir ?? '',
    } as any);
  }
  return buildLlamaCppBootCommand(model);
}

export async function ensureModelServing(model: ModelSpec): Promise<BootResult> {
  if (await pingHealth(model.host, model.port)) {
    return { owned: false, proc: null };
  }
  if (!model.managed) {
    throw new Error(`model ${model.name} at ${model.host}:${model.port} is not reachable and managed=false`);
  }
  if (!model.binary || !existsSync(model.binary)) {
    throw new Error(`model ${model.name} managed=true but binary not found: ${model.binary}`);
  }
  const boot = buildBootCommandForModelSpec(model);
  const proc = spawn(boot.binary, boot.args, { stdio: 'pipe', detached: false });
  const stderrTail: string[] = [];
  function pushStderr(chunk: Buffer | string) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      stderrTail.push(line);
      while (stderrTail.length > STDERR_BUFFER_LINES) stderrTail.shift();
    }
  }
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', pushStderr);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `llama-server for ${model.name} exited before /health came up (code=${proc.exitCode})\n--- stderr tail ---\n${stderrTail.join('\n')}`,
      );
    }
    if (await pingHealth(model.host, model.port)) {
      if (!(await probeInference(model.host, model.port, 30_000))) {
        proc.kill('SIGTERM');
        throw new Error(
          `llama-server for ${model.name} /v1 boot-probe failed\n--- stderr tail ---\n${stderrTail.join('\n')}`,
        );
      }
      installExitHook();
      ownedProcs.add(proc);
      return { owned: true, proc };
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  proc.kill('SIGTERM');
  throw new Error(
    `llama-server for ${model.name} health timeout after ${HEALTH_TIMEOUT_MS}ms\n--- stderr tail ---\n${stderrTail.join('\n')}`,
  );
}

export async function teardownIfOwned(boot: BootResult): Promise<void> {
  if (!boot.owned || !boot.proc || boot.proc.exitCode !== null) return;
  ownedProcs.delete(boot.proc);
  boot.proc.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && boot.proc.exitCode === null) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (boot.proc.exitCode === null) boot.proc.kill('SIGKILL');
}

export function __ownedProcsForTests(): ReadonlySet<ChildProcess> {
  return ownedProcs;
}

export function __seedOwnedProcForTests(proc: ChildProcess): void {
  ownedProcs.add(proc);
}
