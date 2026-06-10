import type { ResolvedEnv } from "../types.js";

export type EngineName = "llamacpp" | "omlx";

export interface EngineBootEnv {
  LLAMACTL_MODELS_DIR?: string;
  LLAMA_CPP_MODELS?: string;
  LLAMACTL_RUNTIME_DIR?: string;
  workloadName?: string;
  machineProfile?: ResolvedEnv["LLAMA_CPP_MACHINE_PROFILE"];
}

export interface ModelHostHostedModel {
  rel: string;
  dflash?: {
    enabled: boolean;
    dflash_enabled?: boolean;
    dflash_draft_model?: string | null;
    dflash_draft_quant_enabled?: boolean;
    dflash_draft_quant_weight_bits?: number;
    dflash_draft_quant_activation_bits?: number;
    dflash_draft_quant_group_size?: number;
    dflash_max_ctx?: number | null;
    dflash_in_memory_cache?: boolean;
    dflash_in_memory_cache_max_entries?: number;
    dflash_in_memory_cache_max_bytes?: number;
    dflash_ssd_cache?: boolean;
    dflash_draft_window_size?: number;
    dflash_draft_sink_size?: number;
    dflash_verify_mode?: string | null;
  };
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
  prepareLaunch?(spec: ModelHostSpecForEngine, env: EngineBootEnv): Promise<void>;
  buildBootCommand(
    spec: ModelHostSpecForEngine,
    env: EngineBootEnv,
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
