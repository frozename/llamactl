import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ModelSpec } from './types.js';

const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_TIMEOUT_MS = 120_000;

export interface BootResult {
  owned: boolean;
  proc: ChildProcess | null;
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
  const args = [
    '-m',
    model.gguf_path,
    '--host',
    model.host,
    '--port',
    String(model.port),
    ...(model.start_args ?? []),
    ...(model.extra_args ?? []),
  ];
  const proc = spawn(model.binary, args, { stdio: 'pipe', detached: false });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`llama-server for ${model.name} exited before /health came up (code=${proc.exitCode})`);
    }
    if (await pingHealth(model.host, model.port)) {
      return { owned: true, proc };
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  proc.kill('SIGTERM');
  throw new Error(`llama-server for ${model.name} health timeout after ${HEALTH_TIMEOUT_MS}ms`);
}

export async function teardownIfOwned(boot: BootResult): Promise<void> {
  if (!boot.owned || !boot.proc || boot.proc.exitCode !== null) return;
  boot.proc.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && boot.proc.exitCode === null) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (boot.proc.exitCode === null) boot.proc.kill('SIGKILL');
}
