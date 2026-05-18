import type { ResolvedEnv } from '../types.js';
import type { EngineAdapter, ModelHostSpecForEngine } from './types.js';
import { gracefulShutdown, pollUntilModelIds } from './lifecycle.js';
import { resolve, sep } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

export const llamacppEngine: EngineAdapter = {
  name: 'llamacpp',

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === '') {
      return { ok: false, error: 'llamacpp engine requires spec.binary' };
    }
    if (!spec.endpoint || typeof spec.endpoint.port !== 'number') {
      return { ok: false, error: 'llamacpp engine requires spec.endpoint.port' };
    }
    if (!LOOPBACK.has(spec.endpoint.host)) {
      return { ok: false, error: `endpoint.host must be loopback or 0.0.0.0; got ${spec.endpoint.host}` };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: 'hostedModels must have exactly one entry' };
    }
    return { ok: true };
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: ResolvedEnv) {
    const modelRel = spec.hostedModels[0].rel;
    const modelsDir =
      (env as Record<string, string>).LLAMACTL_MODELS_DIR ??
      (env as Record<string, string>).LLAMA_CPP_MODELS ??
      '/tmp/models';
    const fullModelPath = resolve(modelsDir, modelRel);
    if (!fullModelPath.startsWith(`${resolve(modelsDir)}${sep}`)) {
      throw new Error(`hostedModel rel escapes models dir: ${modelRel}`);
    }
    const args: string[] = [
      '--host',
      spec.endpoint.host,
      '--port',
      String(spec.endpoint.port),
      '-m',
      fullModelPath,
      ...spec.extraArgs,
    ];
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs) {
    return pollUntilModelIds(endpoint, timeoutMs);
  },

  async teardown(pid) {
    await gracefulShutdown(pid);
  },
};
