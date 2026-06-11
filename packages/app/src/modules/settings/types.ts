import type { schemas } from "@llamactl/core";

export type PresetOverride = schemas.PresetOverride;
export type Profile = "mac-mini-16g" | "balanced" | "macbook-pro-48g";
export type Preset = "best" | "vision" | "balanced" | "fast";

export const PROFILES: readonly Profile[] = ["mac-mini-16g", "balanced", "macbook-pro-48g"];
export const PRESETS: readonly Preset[] = ["best", "vision", "balanced", "fast"];

export const GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "Paths",
    keys: [
      "DEV_STORAGE",
      "LLAMA_CPP_ROOT",
      "LLAMA_CPP_MODELS",
      "LLAMA_CPP_CACHE",
      "LLAMA_CPP_LOGS",
      "LLAMA_CPP_BIN",
      "LOCAL_AI_RUNTIME_DIR",
      "HF_HOME",
      "OLLAMA_MODELS",
    ],
  },
  {
    title: "Machine",
    keys: [
      "LLAMA_CPP_MACHINE_PROFILE",
      "LLAMA_CPP_DEFAULT_MODEL",
      "LLAMA_CPP_GEMMA_CTX_SIZE",
      "LLAMA_CPP_QWEN_CTX_SIZE",
    ],
  },
  {
    title: "Provider",
    keys: [
      "LOCAL_AI_PROVIDER",
      "LOCAL_AI_PROVIDER_URL",
      "LOCAL_AI_MODEL",
      "LOCAL_AI_SOURCE_MODEL",
      "LOCAL_AI_CONTEXT_LENGTH",
    ],
  },
  {
    title: "Discovery",
    keys: [
      "LOCAL_AI_DISCOVERY_AUTHOR",
      "LOCAL_AI_DISCOVERY_LIMIT",
      "LOCAL_AI_DISCOVERY_SEARCH",
      "LOCAL_AI_RECOMMENDATIONS_SOURCE",
      "LOCAL_AI_HF_CACHE_TTL_SECONDS",
    ],
  },
  {
    title: "Feature toggles",
    keys: [
      "LLAMA_CPP_AUTO_TUNE_ON_PULL",
      "LLAMA_CPP_AUTO_BENCH_VISION",
      "LOCAL_AI_ENABLE_THINKING",
      "LOCAL_AI_PRESERVE_THINKING",
    ],
  },
];
