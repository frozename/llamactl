import { readFileSync } from 'node:fs';
import { resolveEnv } from './env.js';
import { atomicWriteFile } from './fsAtomic.js';
import { normalizeProfile } from './profile.js';
import { PresetOverride, presetOverrideFields, splitTsvRow } from './schemas.js';
import type { MachineProfile } from './types.js';

export type PresetName = 'best' | 'vision' | 'balanced' | 'fast';

/**
 * Built-in mapping of (profile, preset) to the relative GGUF path that
 * should resolve for that slot. Mirrors the case ladder in the shell's
 * `_local_ai_profile_preset_model`. Values are the defaults shipped
 * with llamactl — user overrides at the env-var or file layer take
 * precedence.
 */
const BUILTIN_PRESETS: Record<MachineProfile, Record<PresetName, string>> = {
  'mac-mini-16g': {
    best: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
    vision: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
    balanced: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
    fast: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
  },
  balanced: {
    best: 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf',
    vision: 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    balanced: 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    fast: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
  },
  'macbook-pro-48g': {
    best: 'gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf',
    vision: 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    balanced: 'gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    fast: 'gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf',
  },
};

/**
 * Build the `LOCAL_AI_PRESET_<PROFILE>_<PRESET>_MODEL` env-var name
 * for a (profile, preset) pair. Uppercases and replaces dashes so
 * `mac-mini-16g + best` becomes `LOCAL_AI_PRESET_MAC_MINI_16G_BEST_MODEL`.
 */
function envVarName(profile: MachineProfile, preset: PresetName): string {
  const profileKey = profile.replace(/-/g, '_').toUpperCase();
  const presetKey = preset.toUpperCase();
  return `LOCAL_AI_PRESET_${profileKey}_${presetKey}_MODEL`;
}

/** Source of a preset resolution, useful for UI annotations. */
export type PresetOverrideSource = 'env' | 'file' | null;

export interface PresetResolution {
  rel: string;
  source: PresetOverrideSource;
}

/**
 * Read every row from LOCAL_AI_PRESET_OVERRIDES_FILE, tolerating blank
 * lines and `#` comments. Malformed rows are skipped silently so one
 * bad line doesn't blow up the whole file read.
 */
export function readPresetOverrides(file: string): PresetOverride[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: PresetOverride[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const cols = splitTsvRow(line);
    if (cols.length < presetOverrideFields.length) continue;
    const record: Record<string, string> = {};
    for (let i = 0; i < presetOverrideFields.length; i += 1) {
      const field = presetOverrideFields[i];
      if (field === undefined) continue;
      record[field] = cols[i] ?? '';
    }
    const parsed = PresetOverride.safeParse(record);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Resolve the active rel for a (profile, preset), honouring env-var
 * overrides first, then the on-disk override file, then the built-in
 * defaults. The `source` field reflects which layer won and is used by
 * `llama-recommendations` to annotate rows with `promoted=env|file`.
 */
export function resolvePreset(
  profile: MachineProfile,
  preset: PresetName,
  env: NodeJS.ProcessEnv = process.env,
  resolved = resolveEnv(env),
): PresetResolution {
  const envOverride = env[envVarName(profile, preset)];
  if (envOverride && envOverride.length > 0) {
    return { rel: envOverride, source: 'env' };
  }

  const fileOverride = readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE).find(
    (row) => row.profile === profile && row.preset === preset,
  );
  if (fileOverride) {
    return { rel: fileOverride.rel, source: 'file' };
  }

  const normalized = normalizeProfile(profile) ?? 'macbook-pro-48g';
  return { rel: BUILTIN_PRESETS[normalized][preset], source: null };
}

function formatIso(date: Date = new Date()): string {
  // Matches `date +%Y-%m-%dT%H:%M:%S%z` used by the shell library —
  // local time with an offset like `-0300`, no colon in the offset.
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}${om}`;
}

/**
 * Write a preset override row. If an existing row matches
 * `(profile, preset)` it is replaced in-place; otherwise the row is
 * appended. File write is atomic via `atomicWriteFile` so concurrent
 * readers never see a partial update.
 */
export function writePresetOverride(
  profile: MachineProfile,
  preset: PresetName,
  rel: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const resolved = resolveEnv(env);
  const file = resolved.LOCAL_AI_PRESET_OVERRIDES_FILE;
  const existing = readPresetOverrides(file);
  const updatedAt = formatIso();
  const next: PresetOverride[] = existing
    .filter((row) => !(row.profile === profile && row.preset === preset))
    .concat([{ profile, preset, rel, updated_at: updatedAt }]);
  const body = next
    .map((row) => `${row.profile}\t${row.preset}\t${row.rel}\t${row.updated_at ?? ''}`)
    .join('\n');
  atomicWriteFile(file, body === '' ? '' : `${body}\n`);
}

/**
 * Human-facing list of the current promotions. Matches the
 * `llama-curated-promotions` output line format
 * (`profile=... preset=... model=... updated_at=...`).
 */
export function formatPromotionsList(overrides: readonly PresetOverride[]): string {
  return overrides
    .map(
      (row) =>
        `profile=${row.profile} preset=${row.preset} model=${row.rel} updated_at=${row.updated_at ?? ''}`,
    )
    .join('\n');
}
