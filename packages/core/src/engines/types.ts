import type { ResolvedEnv } from '../types.js';

export type EngineName = 'llamacpp' | 'omlx';

export interface ModelHostHostedModel {
  rel: string;
}

export interface ModelHostSpecForEngine {
  engine: EngineName;
  binary: string;
  endpoint: { host: string; port: number };
  hostedModels: ModelHostHostedModel[];
  resources?: { expectedMemoryGiB?: number };
  extraArgs: string[];
  timeoutSeconds: number;
}

export interface EngineAdapter {
  name: EngineName;
  validateSpec(spec: ModelHostSpecForEngine): { ok: true } | { ok: false; error: string };
  buildBootCommand(
    spec: ModelHostSpecForEngine,
    env: ResolvedEnv,
  ): { binary: string; args: string[]; envOverrides?: Record<string, string> };
  /**
   * Resolves when the engine is serving at least one model (not just process-alive).
   * `modelIds` lists what the engine advertises via /v1/models.
   */
  probeReady(
    endpoint: { host: string; port: number },
    timeoutMs: number,
  ): Promise<{ ready: boolean; modelIds: string[] }>;
  teardown(pid: number): Promise<void>;
}
