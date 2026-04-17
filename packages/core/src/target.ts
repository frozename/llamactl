import { resolveEnv } from './env.js';
import { normalizeProfile } from './profile.js';
import { resolvePreset } from './presets.js';
import type { MachineProfile } from './types.js';

/**
 * Recommended Qwen 3.6 35B-A3B quant for a given profile. Matches
 * `_llama_recommended_qwen36_model_for_profile` in the shell library.
 */
function qwen36ForProfile(profile: MachineProfile): string {
  switch (profile) {
    case 'mac-mini-16g':
      return 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf';
    case 'balanced':
      return 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf';
    case 'macbook-pro-48g':
    default:
      return 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf';
  }
}

/**
 * Resolve a user-facing target (named preset alias, hardcoded family,
 * or a rel path) into the canonical rel path under $LLAMA_CPP_MODELS.
 * Returns `null` when the target is not recognised so callers can emit
 * a stable error message. Mirrors `_local_ai_resolve_model_target`.
 */
export function resolveTarget(
  target: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const resolved = resolveEnv(env);
  const profile = normalizeProfile(resolved.LLAMA_CPP_MACHINE_PROFILE) ?? 'macbook-pro-48g';
  const raw = target ?? 'current';

  switch (raw) {
    case '':
    case 'current':
      return resolved.LOCAL_AI_SOURCE_MODEL;
    case 'best':
    case 'quality':
      return resolvePreset(profile, 'best', env, resolved).rel;
    case 'vision':
    case 'image':
      return resolvePreset(profile, 'vision', env, resolved).rel;
    case 'balanced':
    case 'daily':
      return resolvePreset(profile, 'balanced', env, resolved).rel;
    case 'fast':
    case 'small':
      return resolvePreset(profile, 'fast', env, resolved).rel;
    case '31b':
    case 'gemma4-31b':
    case 'gemma-4-31b':
      return 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf';
    case '26b':
    case 'gemma4-26b':
    case 'gemma-4-26b':
      return 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf';
    case 'e4b':
    case 'gemma4-e4b':
    case 'gemma-4-e4b':
      return 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf';
    case 'qwen':
    case 'qwen36':
    case 'qwen3.6':
    case 'qwen3.6-35b':
    case 'qwen35b':
      return qwen36ForProfile(profile);
    case 'qwen27':
    case 'qwen35':
    case 'qwen3.5-27b':
      return 'Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf';
    default:
      if (raw.endsWith('.gguf') || raw.includes('/')) return raw;
      return null;
  }
}
