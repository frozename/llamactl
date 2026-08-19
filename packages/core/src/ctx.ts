import { resolveEnv } from "./env.js";

/**
 * Pick the default context size for a model relative path.
 *
 * Rule, not a model list: a rel whose **leading path segment** starts with
 * `Qwen` (case-sensitive — the on-disk model dirs are `Qwen3.5-27B-GGUF`,
 * `Qwen3.6-35B-A3B-GGUF`, `Qwen3.8-27B-GGUF`, …) gets the Qwen ctx
 * envelope, because that family ships larger native context windows and
 * has its own env var. Everything else falls back to the Gemma envelope.
 *
 * Routing by pattern rather than by an enumeration is deliberate: `ctx` is
 * part of the bench record's primary key, so a newly released Qwen that
 * fell through to the Gemma envelope would write bench records under a key
 * a corrected run never matches. Matching the whole leading segment (not a
 * substring) keeps the fallback fail-closed — a vendor-prefixed rel such
 * as `mlx-community/Qwen3-8B-MLX-4bit` is not a llama.cpp Qwen model dir
 * and still resolves to Gemma, exactly as before.
 *
 * Matches `_llama_ctx_for_model` in the shell library.
 */
export function ctxForModel(rel: string, resolved = resolveEnv()): string {
  const family = rel.split("/")[0] ?? "";
  if (family.startsWith("Qwen")) {
    return resolved.LLAMA_CPP_QWEN_CTX_SIZE;
  }
  return resolved.LLAMA_CPP_GEMMA_CTX_SIZE;
}
