/**
 * Map a rel path suffix to a short quant label used throughout the UI.
 * Mirrors `_llama_quant_from_rel` in the shell library. Suffix tests
 * are ordered most-specific first; the last-match-wins semantics of
 * the zsh `case` statement produce the same mapping either way, but
 * the explicit order here makes future additions easier to review.
 */
export function quantFromRel(rel: string): string {
  if (rel.endsWith("Q8_0.gguf")) return "q8";
  if (rel.endsWith("UD-Q6_K_XL.gguf")) return "q6";
  if (rel.endsWith("UD-Q5_K_XL.gguf")) return "q5";
  if (rel.endsWith("UD-Q4_K_M.gguf")) return "q4m";
  if (rel.endsWith("UD-Q4_K_XL.gguf")) return "q4";
  if (rel.endsWith("UD-Q3_K_S.gguf")) return "q3s";
  if (rel.endsWith("UD-Q3_K_M.gguf")) return "q3m";
  if (rel.endsWith("UD-Q3_K_XL.gguf")) return "q3xl";
  if (rel.endsWith("UD-Q2_K_XL.gguf")) return "q2";
  if (rel.endsWith("MXFP4_MOE.gguf")) return "mxfp4";
  if (rel.endsWith("Q4_K_M.gguf")) return "q4km";
  if (rel.endsWith("Q5_K_M.gguf")) return "q5km";
  return "custom";
}
