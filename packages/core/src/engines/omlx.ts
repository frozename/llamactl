import { existsSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { EngineAdapter, EngineBootEnv, ModelHostSpecForEngine } from './types.js';
import { gracefulShutdown, pollUntilModelIds } from './lifecycle.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

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
    if (!LOOPBACK.has(spec.endpoint.host)) {
      return { ok: false, error: `endpoint.host must be loopback or 0.0.0.0; got ${spec.endpoint.host}` };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: 'hostedModels must have exactly one entry' };
    }
    return { ok: true };
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: EngineBootEnv) {
    const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS ?? '/tmp/models';
    const hostedModel = spec.hostedModels[0];
    if (!hostedModel) {
      throw new Error('hostedModels must have exactly one entry');
    }
    const sanitizedModelRel = hostedModel.rel;
    const normalizedModelPath = resolve(modelsDir, sanitizedModelRel);
    if (!normalizedModelPath.startsWith(`${resolve(modelsDir)}${sep}`)) {
      throw new Error(`hostedModel rel escapes models dir: ${sanitizedModelRel}`);
    }
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
    return pollUntilModelIds(endpoint, timeoutMs);
  },

  async teardown(pid) {
    await gracefulShutdown(pid);
  },
};

export function matchHostedModel(rel: string, ids: string[]): boolean {
  return ids.includes(rel) || ids.includes(basename(rel));
}
