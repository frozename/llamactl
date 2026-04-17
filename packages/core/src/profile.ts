import { execSync } from 'node:child_process';
import type { MachineProfile } from './types.js';

/** Total physical memory in bytes, detected per platform. */
export function detectMemoryBytes(): number | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('sysctl -n hw.memsize', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Pick a machine profile from detected memory. Matches the historical
 * zsh thresholds exactly so bench records key into the same buckets:
 *   <= 16 GiB  -> mac-mini-16g
 *   <= 32 GiB  -> balanced
 *   > 32 GiB   -> macbook-pro-48g
 * Unknown memory (non-darwin, detection failure) defaults to the most
 * capable profile to avoid over-restricting context on unidentified
 * hardware.
 */
export function profileFromMemory(memoryBytes: number | null): MachineProfile {
  if (memoryBytes === null) return 'macbook-pro-48g';
  if (memoryBytes <= 17_179_869_184) return 'mac-mini-16g';
  if (memoryBytes <= 34_359_738_368) return 'balanced';
  return 'macbook-pro-48g';
}

/** Normalise any user-facing alias onto the canonical profile name. */
export function normalizeProfile(raw: string | undefined): MachineProfile | null {
  if (!raw) return null;
  switch (raw) {
    case 'mac-mini-16g':
    case 'mini':
    case '16g':
      return 'mac-mini-16g';
    case 'balanced':
    case 'mid':
      return 'balanced';
    case 'macbook-pro-48g':
    case 'macbook-pro':
    case 'mbp':
    case 'laptop':
    case 'desktop-48g':
    case 'desktop':
    case '48g':
    case 'best':
      return 'macbook-pro-48g';
    default:
      return null;
  }
}

/**
 * Resolve the active profile from env, falling back to hardware detection.
 * Canonical entry point used by env.resolveEnv and any command that needs
 * the current machine profile without reading the environment directly.
 */
export function resolveProfile(env: NodeJS.ProcessEnv = process.env): MachineProfile {
  const override = normalizeProfile(env.LLAMA_CPP_MACHINE_PROFILE);
  if (override) return override;
  return profileFromMemory(detectMemoryBytes());
}
