import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { ResolvedEnv } from '../types.js';
import type { EngineAdapter, ModelHostSpecForEngine } from './types.js';

export const omlxEngine: EngineAdapter = {
  name: 'omlx',

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === '') {
      return { ok: false, error: 'omlx engine requires spec.binary (no PATH fallback)' };
    }
    if (!existsSync(spec.binary)) {
      return {
        ok: false,
        error: `omlx binary not found at ${spec.binary}; run tools/install-omlx-from-source.sh`,
      };
    }
    if (!spec.endpoint || typeof spec.endpoint.port !== 'number') {
      return { ok: false, error: 'omlx engine requires spec.endpoint.port' };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: 'Sub A: hostedModels must have exactly one entry' };
    }
    return { ok: true };
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: ResolvedEnv) {
    const modelsDir = (env as Record<string, string>).LLAMA_CPP_MODELS ?? '/tmp/models';
    const args: string[] = [
      'serve',
      '--model-dir',
      modelsDir,
      '--host',
      spec.endpoint.host,
      '--port',
      String(spec.endpoint.port),
    ];
    if (spec.resources?.expectedMemoryGiB !== undefined) {
      args.push('--max-model-memory', `${spec.resources.expectedMemoryGiB}GB`);
    }
    args.push(...spec.extraArgs);
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://${endpoint.host}:${endpoint.port}/v1/models`);
        if (r.ok) {
          const body = (await r.json()) as { data?: Array<{ id?: string }> };
          const ids = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
          if (ids.length > 0) {
            return { ready: true, modelIds: ids };
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ready: false, modelIds: [] };
  },

  async teardown(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  },
};

export function matchHostedModel(rel: string, ids: string[]): boolean {
  return ids.includes(rel) || ids.includes(basename(rel));
}
