// Copy of packages/remote/test/storage-sandbox.ts (cross-package relative
// imports are forbidden); keep the two copies in step.
import { join } from "node:path";

export const SANDBOX_PREFIX = "llamactl-test-storage-";

// Runtime paths that resolveEnv (packages/core/src/env.ts) takes from the env
// before deriving them from DEV_STORAGE.
const RUNTIME_PATH_OVERRIDES = [
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_ROOT",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_LOGS",
  "LLAMA_CPP_CACHE",
  "LLAMA_CACHE",
  "HF_HOME",
  "HUGGINGFACE_HUB_CACHE",
  "OLLAMA_MODELS",
];

/**
 * Reroots operator state (kubeconfig, workloads, composites, journals) into
 * `root` and strips the env overrides that would point it back at the
 * operator's live directories. Without this, tests that exercise the router's
 * save paths write real manifests into $DEV_STORAGE and the live controller
 * then reconciles them.
 *
 * The composites dir is pinned through LLAMACTL_COMPOSITES_DIR, not
 * LLAMACTL_HOME. Without the override the cli falls back to LLAMACTL_HOME or
 * ~/.llamactl, and the remote router reads LLAMACTL_HOME as the llamactl repo
 * checkout for the keep-alive spawn, so LLAMACTL_HOME is left alone.
 *
 * The runtime path overrides that resolveEnv prefers over DEV_STORAGE (the
 * runtime dir, the llama.cpp root, models, logs and caches, and the Hugging
 * Face and Ollama dirs) are deleted too, so values exported by the operator's
 * shell profile cannot point a test at live model, log or cache directories.
 * LLAMA_CPP_SRC and LLAMA_CPP_BIN name binaries, not state, and are kept.
 */
export function sandboxOperatorStorage(env: NodeJS.ProcessEnv, root: string): void {
  env["DEV_STORAGE"] = root;
  env["LLAMACTL_COMPOSITES_DIR"] = join(root, "composites");
  Reflect.deleteProperty(env, "LLAMACTL_CONFIG");
  Reflect.deleteProperty(env, "LLAMACTL_WORKLOADS_DIR");
  for (const key of RUNTIME_PATH_OVERRIDES) {
    Reflect.deleteProperty(env, key);
  }
}
