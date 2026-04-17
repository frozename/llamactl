/**
 * Machine profiles recognised by llamactl. Used to select context sizes,
 * default quant preferences, and preset mappings. Values kept in sync
 * with the historical zsh library so tuned bench records keep matching.
 */
export type MachineProfile = 'mac-mini-16g' | 'balanced' | 'macbook-pro-48g';

/**
 * Which local AI provider is active. `llama.cpp` talks to a local
 * llama-server; `lmstudio` talks to LM Studio's OpenAI-compatible port.
 */
export type Provider = 'llama.cpp' | 'lmstudio';

/**
 * Coarse class used by discovery, bench compare, and preset routing.
 * Keyed by the fields stored in the curated catalog TSV.
 */
export type ModelClass = 'multimodal' | 'reasoning' | 'general' | 'custom';

/**
 * Bench mode label. `vision` is a keying label on text-throughput records
 * for vision-capable models; `vision-image` would be real mmproj-driven
 * records (currently stored in a separate file as of Phase 0).
 */
export type BenchMode = 'text' | 'vision';

/**
 * Resolved environment that the library operates on. Produced by
 * `env.resolveEnv()` and emitted as shell export lines by
 * `llamactl env --eval`.
 */
export interface ResolvedEnv {
  DEV_STORAGE: string;
  HF_HOME: string;
  HUGGINGFACE_HUB_CACHE: string;
  OLLAMA_MODELS: string;
  LLAMA_CPP_SRC: string;
  LLAMA_CPP_BIN: string;
  LLAMA_CPP_ROOT: string;
  LLAMA_CPP_MODELS: string;
  LLAMA_CPP_CACHE: string;
  LLAMA_CPP_LOGS: string;
  LLAMA_CPP_HOST: string;
  LLAMA_CPP_PORT: string;
  LLAMA_CPP_MACHINE_PROFILE: MachineProfile;
  LLAMA_CPP_GEMMA_CTX_SIZE: string;
  LLAMA_CPP_QWEN_CTX_SIZE: string;
  LLAMA_CPP_DEFAULT_MODEL: string;
  LLAMA_CPP_SERVER_ALIAS: string;
  LLAMA_CACHE: string;
  LOCAL_AI_LMSTUDIO_HOST: string;
  LOCAL_AI_LMSTUDIO_PORT: string;
  LOCAL_AI_LMSTUDIO_BASE_URL: string;
  LOCAL_AI_LLAMA_CPP_BASE_URL: string;
  LOCAL_AI_RUNTIME_DIR: string;
  LOCAL_AI_ENABLE_THINKING: string;
  LOCAL_AI_PRESERVE_THINKING: string;
  LOCAL_AI_RECOMMENDATIONS_SOURCE: string;
  LOCAL_AI_HF_CACHE_TTL_SECONDS: string;
  LOCAL_AI_DISCOVERY_AUTHOR: string;
  LOCAL_AI_DISCOVERY_LIMIT: string;
  LOCAL_AI_DISCOVERY_SEARCH: string;
  LOCAL_AI_CUSTOM_CATALOG_FILE: string;
  LOCAL_AI_PRESET_OVERRIDES_FILE: string;
  LLAMA_CPP_KEEP_ALIVE_INTERVAL: string;
  LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF: string;
  LLAMA_CPP_AUTO_TUNE_ON_PULL: string;
  LLAMA_CPP_AUTO_BENCH_VISION: string;
  LOCAL_AI_BENCH_IMAGE: string;
  LOCAL_AI_SOURCE_MODEL: string;
  LOCAL_AI_PROVIDER: Provider;
  LOCAL_AI_CONTEXT_LENGTH: string;
  LOCAL_AI_PROVIDER_URL: string;
  LOCAL_AI_API_KEY: string;
  LOCAL_AI_MODEL: string;
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
}

/**
 * Subset of directories that should exist for llamactl to work.
 * Consumers call `env.ensureDirs(resolved)` when they want them created.
 */
export const MANAGED_DIRS: readonly (keyof ResolvedEnv)[] = [
  'HF_HOME',
  'HUGGINGFACE_HUB_CACHE',
  'OLLAMA_MODELS',
  'LLAMA_CPP_MODELS',
  'LLAMA_CPP_CACHE',
  'LLAMA_CPP_LOGS',
  'LOCAL_AI_RUNTIME_DIR',
] as const;
