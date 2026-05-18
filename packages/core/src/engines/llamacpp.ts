import type { ResolvedEnv } from '../types.js';
import type { EngineAdapter, ModelHostSpecForEngine } from './types.js';

export const llamacppEngine: EngineAdapter = {
  name: 'llamacpp',

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === '') {
      return { ok: false, error: 'llamacpp engine requires spec.binary' };
    }
    if (!spec.endpoint || typeof spec.endpoint.port !== 'number') {
      return { ok: false, error: 'llamacpp engine requires spec.endpoint.port' };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: 'Sub A: hostedModels must have exactly one entry' };
    }
    return { ok: true };
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: ResolvedEnv) {
    const modelRel = spec.hostedModels[0].rel;
    const modelsDir = (env as Record<string, string>).LLAMA_CPP_MODELS ?? '/tmp/models';
    const args: string[] = [
      '--host',
      spec.endpoint.host,
      '--port',
      String(spec.endpoint.port),
      '-m',
      `${modelsDir}/${modelRel}`,
      ...spec.extraArgs,
    ];
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://${endpoint.host}:${endpoint.port}/health`);
        if (r.ok) {
          return { ready: true, modelIds: [] };
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
