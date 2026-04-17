import { resolveEnv } from './env.js';

/**
 * Pick the default context size for a model relative path. Qwen 3.5 27B
 * and Qwen 3.6 35B use the Qwen ctx envelope (they have larger native
 * context windows and get their own env var); everything else falls
 * back to the Gemma ctx envelope. Matches `_llama_ctx_for_model` in the
 * shell library.
 */
export function ctxForModel(rel: string, resolved = resolveEnv()): string {
  if (/^Qwen3\.6-35B-A3B-GGUF\//.test(rel) || /^Qwen3\.5-27B-GGUF\//.test(rel)) {
    return resolved.LLAMA_CPP_QWEN_CTX_SIZE;
  }
  return resolved.LLAMA_CPP_GEMMA_CTX_SIZE;
}
