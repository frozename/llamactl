/**
 * Map a rel path suffix to a short quant label used throughout the UI.
 * Mirrors `_llama_quant_from_rel` in the shell library. Suffix tests
 * are ordered most-specific first; the last-match-wins semantics of
 * the zsh `case` statement produce the same mapping either way, but
 * the explicit order here makes future additions easier to review.
 */
export function quantFromRel(rel: string): string {
  if (/Q8_0\.gguf$/.test(rel)) return 'q8';
  if (/UD-Q6_K_XL\.gguf$/.test(rel)) return 'q6';
  if (/UD-Q5_K_XL\.gguf$/.test(rel)) return 'q5';
  if (/UD-Q4_K_M\.gguf$/.test(rel)) return 'q4m';
  if (/UD-Q4_K_XL\.gguf$/.test(rel)) return 'q4';
  if (/UD-Q3_K_S\.gguf$/.test(rel)) return 'q3s';
  if (/UD-Q3_K_M\.gguf$/.test(rel)) return 'q3m';
  if (/UD-Q3_K_XL\.gguf$/.test(rel)) return 'q3xl';
  if (/UD-Q2_K_XL\.gguf$/.test(rel)) return 'q2';
  if (/MXFP4_MOE\.gguf$/.test(rel)) return 'mxfp4';
  if (/Q4_K_M\.gguf$/.test(rel)) return 'q4km';
  if (/Q5_K_M\.gguf$/.test(rel)) return 'q5km';
  return 'custom';
}
