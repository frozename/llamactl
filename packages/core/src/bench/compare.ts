import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listCatalog } from '../catalog.js';
import { resolveBuildId } from '../build.js';
import { ctxForModel } from '../ctx.js';
import { resolveEnv } from '../env.js';
import { defaultModeForRel, machineLabel } from './mode.js';
import {
  benchProfileFile,
  benchVisionFile,
  findLatestProfile,
  findLegacyProfile,
  findLatestVision,
  readBenchProfiles,
  readBenchVision,
} from './store.js';
import type { CuratedModel } from '../schemas.js';
import type { ModelClass } from '../types.js';

export interface BenchCompareRow {
  label: string;
  class: CuratedModel['class'];
  scope: string;
  rel: string;
  installed: boolean;
  mode: string;
  ctx: string;
  build: string;
  machine: string;
  /**
   * Present when a tuned bench record exists for the (machine, rel, mode,
   * ctx, build) key (current schema) or for a legacy rel-only match. Null
   * means the catalog entry exists but no bench has been recorded yet.
   */
  tuned: {
    profile: string;
    gen_tps: string;
    prompt_tps: string;
    updated_at: string;
    /** `true` when only a legacy 5-column row matched — mode/ctx/build come from env. */
    legacy: boolean;
  } | null;
  vision: {
    load_ms: string;
    image_encode_ms: string;
    prompt_tps: string;
    gen_tps: string;
    updated_at: string;
  } | null;
}

export interface BenchCompareOptions {
  /** Filter by model class. `all` (default) matches every row. */
  classFilter?: ModelClass | 'all';
  /** Filter by scope. `all` (default) matches every row. */
  scopeFilter?: string;
}

/**
 * Build the compare table rows. No I/O beyond reading the TSVs + probing
 * for installed rels. Consumers (CLI formatter, Electron renderer via
 * tRPC) receive structured data and decide how to present it.
 */
export function benchCompare(
  opts: BenchCompareOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): BenchCompareRow[] {
  const resolved = resolveEnv(env);
  const profiles = readBenchProfiles(benchProfileFile(resolved));
  const vision = readBenchVision(benchVisionFile(resolved));
  const build = resolveBuildId(resolved);
  const machine = machineLabel(resolved);
  const classFilter = opts.classFilter ?? 'all';
  const scopeFilter = opts.scopeFilter ?? 'all';

  const rows: BenchCompareRow[] = [];
  for (const entry of listCatalog('all')) {
    if (classFilter !== 'all' && entry.class !== classFilter) continue;
    if (scopeFilter !== 'all' && entry.scope !== scopeFilter) continue;

    const rel = entry.rel;
    const installed = existsSync(join(resolved.LLAMA_CPP_MODELS, rel));
    const mode = defaultModeForRel(rel, resolved);
    const ctx = ctxForModel(rel, resolved);

    const latest = findLatestProfile(profiles, {
      machine,
      rel,
      mode,
      ctx,
      build,
    });

    let tuned: BenchCompareRow['tuned'] = null;
    let effectiveMode: string = mode;
    let effectiveCtx: string = ctx;
    let effectiveBuild: string = build;
    if (latest) {
      tuned = {
        profile: latest.profile,
        gen_tps: latest.gen_ts,
        prompt_tps: latest.prompt_ts,
        updated_at: latest.updated_at,
        legacy: false,
      };
      effectiveMode = latest.mode;
      effectiveCtx = latest.ctx;
      effectiveBuild = latest.build;
    } else {
      const legacy = findLegacyProfile(profiles, rel);
      if (legacy) {
        tuned = {
          profile: legacy.profile,
          gen_tps: legacy.gen_ts,
          prompt_tps: legacy.prompt_ts,
          updated_at: legacy.updated_at,
          legacy: true,
        };
        effectiveMode = 'legacy';
        effectiveCtx = 'legacy';
        effectiveBuild = 'legacy';
      }
    }

    const visionRow = findLatestVision(vision, { machine, rel, build });

    rows.push({
      label: entry.label,
      class: entry.class,
      scope: entry.scope,
      rel,
      installed,
      mode: effectiveMode,
      ctx: effectiveCtx,
      build: effectiveBuild,
      machine,
      tuned,
      vision: visionRow
        ? {
            load_ms: visionRow.load_ms,
            image_encode_ms: visionRow.image_encode_ms,
            prompt_tps: visionRow.prompt_tps,
            gen_tps: visionRow.gen_tps,
            updated_at: visionRow.updated_at,
          }
        : null,
    });
  }

  return rows;
}

/** Side-effect-free check: is any tuned record available across the set? */
export function hasAnyTunedRecord(rows: readonly BenchCompareRow[]): boolean {
  return rows.some((row) => row.tuned !== null);
}
