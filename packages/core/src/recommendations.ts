import { findByRel } from './catalog.js';
import { resolveEnv } from './env.js';
import { summaryForRel } from './hf.js';
import { normalizeProfile } from './profile.js';
import { resolvePreset, type PresetOverrideSource, type PresetName } from './presets.js';
import { quantFromRel } from './quant.js';
import type { MachineProfile, ModelClass } from './types.js';

/** Recommendation row shape consumed by the CLI and (eventually) the UI. */
export interface RecommendationRow {
  /** Target slot label: `best`, `vision`, `balanced`, `fast`, `qwen`, `qwen27`. */
  target: string;
  /** Resolved relative GGUF path under $LLAMA_CPP_MODELS. */
  rel: string;
  /** Catalog label for the rel, or the file basename if off-catalog. */
  label: string;
  /** Model family: catalog value, or `custom` for off-catalog rels. */
  family: string;
  /** Class: catalog value, or `custom` for off-catalog rels. */
  class: ModelClass | 'custom';
  /** Catalog scope, or the target slot name for off-catalog rels. */
  scope: string;
  /** Short quant label, e.g. `q4`, `q8`, `q3s`. */
  quant: string;
  /** Recommended context size for this (profile, family) pair. */
  ctx: string;
  /** Whether a user override is in effect (`env` or `file`), null otherwise. */
  promoted: PresetOverrideSource;
  /** Optional HF summary line (populated when the catalog has a repo). */
  hf?: string | null;
}

export interface RecommendationsForProfile {
  profile: MachineProfile;
  rows: RecommendationRow[];
}

const PRESET_TARGETS: readonly PresetName[] = ['best', 'vision', 'balanced', 'fast'];
const TARGET_ORDER: readonly string[] = [...PRESET_TARGETS, 'qwen', 'qwen27'];

/**
 * Qwen 3.6 35B-A3B quant per machine profile.
 *
 * mac-mini-16g picks IQ2_M (~11.5 GB). Q3_K_S (15.4 GB) and larger
 * never fit under M4's `recommendedMaxWorkingSetSize` (12.7 GB on
 * 16 GiB unified memory) regardless of free RAM — Metal caps a
 * single app's GPU residency below total memory. IQ2_M leaves ~1.2 GB
 * of headroom; operators run it as a managed workload with
 * `extraArgs: -c 4096 -ctk q4_0 -ctv q4_0` to shrink the KV cache
 * into the same envelope. Verified live: 31 gen tok/s on M4.
 */
function qwen36ForProfile(profile: MachineProfile): string {
  switch (profile) {
    case 'mac-mini-16g':
      return 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-IQ2_M.gguf';
    case 'balanced':
      return 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf';
    default:
      return 'Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf';
  }
}

/**
 * Qwen 3.5 27B (legacy slot). Same Metal-cap rationale as
 * qwen36ForProfile — Q5_K_XL (18.9 GB) is unworkable on 16 GiB; pick
 * IQ2_M (10.2 GB) for that profile.
 */
function qwen35ForProfile(profile: MachineProfile): string {
  switch (profile) {
    case 'mac-mini-16g':
      return 'Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-IQ2_M.gguf';
    default:
      return 'Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf';
  }
}

const QWEN_CTX_BY_PROFILE: Record<MachineProfile, string> = {
  'mac-mini-16g': '16384',
  balanced: '32768',
  'macbook-pro-48g': '65536',
};

const GEMMA_CTX_BY_PROFILE: Record<MachineProfile, string> = {
  'mac-mini-16g': '16384',
  balanced: '24576',
  'macbook-pro-48g': '32768',
};

/**
 * Pick the recommended ctx for a rel under a specific profile. Unlike
 * `ctxForModel` which reads the current shell env, this variant is
 * profile-parameterised so the `all` view can show the correct ctx per
 * row even when the active machine differs from the profile displayed.
 */
function ctxForRelUnderProfile(rel: string, profile: MachineProfile): string {
  const isQwenFamily =
    /^Qwen3\.6-35B-A3B-GGUF\//.test(rel) || /^Qwen3\.5-27B-GGUF\//.test(rel);
  const table = isQwenFamily ? QWEN_CTX_BY_PROFILE : GEMMA_CTX_BY_PROFILE;
  return table[profile];
}

function basename(rel: string): string {
  const last = rel.lastIndexOf('/');
  return last < 0 ? rel : rel.slice(last + 1);
}

/**
 * Resolve every recommendation row for a profile. Skips preset slots
 * whose `resolvePreset` returns a non-existent default (defensive; the
 * current builtin map always has a value for every slot, so this is
 * effectively a no-op today).
 */
export function recommendationsForProfile(
  profile: MachineProfile,
  env: NodeJS.ProcessEnv = process.env,
): RecommendationRow[] {
  const resolved = resolveEnv(env);
  const rows: RecommendationRow[] = [];

  for (const target of TARGET_ORDER) {
    let rel: string;
    let promoted: PresetOverrideSource = null;
    if (target === 'qwen27') {
      rel = qwen35ForProfile(profile);
    } else if (target === 'qwen') {
      rel = qwen36ForProfile(profile);
    } else {
      const resolution = resolvePreset(profile, target as PresetName, env, resolved);
      if (!resolution.rel) continue;
      rel = resolution.rel;
      promoted = resolution.source;
    }

    const meta = findByRel(rel);
    const label = meta?.label ?? basename(rel);
    const family = meta?.family ?? 'custom';
    const klass: RecommendationRow['class'] = meta?.class ?? 'custom';
    const scope = meta?.scope ?? target;

    rows.push({
      target,
      rel,
      label,
      family,
      class: klass,
      scope,
      quant: quantFromRel(rel),
      ctx: ctxForRelUnderProfile(rel, profile),
      promoted,
    });
  }

  return rows;
}

/**
 * Async variant that also populates `hf` for every row. Issues concurrent
 * fetches under the cache TTL so the common case (warm cache) resolves in
 * a single tick, and the cold path fans out HTTP requests rather than
 * serialising them.
 */
export async function recommendationsWithHf(
  profile: MachineProfile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecommendationRow[]> {
  const resolved = resolveEnv(env);
  const rows = recommendationsForProfile(profile, env);
  await Promise.all(
    rows.map(async (row) => {
      const summary = await summaryForRel(row.rel, resolved, env);
      row.hf = summary ?? null;
    }),
  );
  return rows;
}

/**
 * Expand a user-facing `requested_profile` into the set of canonical
 * profiles to display. `all` → the three known profiles in the shell
 * order; `current` (or empty) → the active machine profile; anything
 * else normalises through `normalizeProfile`.
 */
export function expandRequestedProfile(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MachineProfile[] {
  const resolved = resolveEnv(env);
  const active = normalizeProfile(resolved.LLAMA_CPP_MACHINE_PROFILE) ?? 'macbook-pro-48g';
  switch (requested) {
    case 'all':
      return ['mac-mini-16g', 'balanced', 'macbook-pro-48g'];
    case undefined:
    case '':
    case 'current':
      return [active];
    default: {
      const norm = normalizeProfile(requested) ?? active;
      return [norm];
    }
  }
}
