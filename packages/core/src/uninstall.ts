import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { findByRel } from './catalog.js';
import {
  benchHistoryFile,
  benchProfileFile,
  benchVisionFile,
} from './bench/store.js';
import { resolveEnv } from './env.js';
import { atomicWriteFile } from './fsAtomic.js';

export interface UninstallOptions {
  rel: string;
  force?: boolean;
}

export interface UninstallReport {
  /** Always present: the rel that was acted on. */
  rel: string;
  scope: string | null;
  force: boolean;
  /** Human-readable lines describing what happened. Mirrors the shell output. */
  actions: string[];
  /** Exit code — 0 on success, non-zero when the operation refused. */
  code: number;
  error?: string;
}

/**
 * Drop every line of `file` that matches the given predicate, rewriting
 * the file atomically. Removes the file entirely when no lines remain,
 * matching the shell library's `[ -s "$file" ] || rm -f "$file"` idiom.
 */
function pruneTsv(
  file: string,
  predicate: (cols: string[]) => boolean,
): boolean {
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, 'utf8');
  const next: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const cols = line.split('\t');
    if (!predicate(cols)) next.push(line);
  }
  if (next.length === 0) {
    unlinkSync(file);
  } else {
    atomicWriteFile(file, `${next.join('\n')}\n`);
  }
  return true;
}

/**
 * Remove a pulled model and prune its on-disk footprint. Behaviour
 * mirrors the shell library's `llama-uninstall`:
 *
 *   1. Refuse if the catalog entry's scope is non-candidate and
 *      `force` is not set.
 *   2. Remove the model file. If no other GGUF remains in the repo
 *      directory (ignoring `mmproj*` sidecars), `rm -rf` the directory
 *      to sweep the mmproj and the HF cache sidecar.
 *   3. Prune rows matching the rel from bench-profiles.tsv,
 *      bench-history.tsv, bench-vision.tsv, and the custom catalog.
 *   4. Under `force`, also remove any preset-override row that points
 *      at this rel.
 */
export function uninstall(opts: UninstallOptions): UninstallReport {
  const rel = opts.rel;
  const force = Boolean(opts.force);
  const report: UninstallReport = {
    rel,
    scope: null,
    force,
    actions: [],
    code: 0,
  };

  if (!rel) {
    report.code = 1;
    report.error = 'Usage: llamactl uninstall <rel> [--force]';
    return report;
  }

  const slash = rel.indexOf('/');
  if (slash <= 0 || slash === rel.length - 1) {
    report.code = 1;
    report.error = `Expected rel of form <repo-dir>/<file.gguf>, got: ${rel}`;
    return report;
  }

  const resolved = resolveEnv();
  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  const modelDir = join(resolved.LLAMA_CPP_MODELS, rel.slice(0, slash));

  const entry = findByRel(rel);
  report.scope = entry?.scope ?? null;

  if (!entry && !existsSync(modelPath)) {
    report.code = 1;
    report.error = `No catalog entry and no file on disk for ${rel}`;
    return report;
  }

  if (report.scope && report.scope !== 'candidate' && !force) {
    report.code = 1;
    report.error = `Refusing to uninstall ${rel}: scope=${report.scope} (use --force to override)`;
    return report;
  }

  report.actions.push(
    `Uninstalling ${rel} (scope=${report.scope ?? 'unknown'}, force=${force ? 1 : 0})`,
  );

  if (existsSync(modelPath)) {
    unlinkSync(modelPath);
    report.actions.push(`  removed ${modelPath}`);
  }

  if (
    resolved.LLAMA_CPP_MODELS &&
    modelDir.startsWith(`${resolved.LLAMA_CPP_MODELS}/`) &&
    existsSync(modelDir)
  ) {
    let remainingGguf = false;
    try {
      const entries = readdirSync(modelDir);
      remainingGguf = entries.some((name) => {
        const lower = name.toLowerCase();
        return lower.endsWith('.gguf') && !lower.includes('mmproj');
      });
    } catch {
      remainingGguf = true;
    }
    if (!remainingGguf) {
      rmSync(modelDir, { recursive: true, force: true });
      if (!existsSync(modelDir)) {
        report.actions.push(
          `  removed empty dir ${modelDir} (including mmproj + hf cache)`,
        );
      }
    }
  }

  if (
    pruneTsv(benchProfileFile(resolved), (cols) => cols[0] === rel || cols[1] === rel)
  ) {
    report.actions.push(`  pruned bench profile rows for ${rel}`);
  }
  if (
    pruneTsv(benchHistoryFile(resolved), (cols) => cols[1] === rel || cols[2] === rel)
  ) {
    report.actions.push(`  pruned bench history rows for ${rel}`);
  }
  if (pruneTsv(benchVisionFile(resolved), (cols) => cols[1] === rel)) {
    report.actions.push(`  pruned vision bench rows for ${rel}`);
  }
  if (
    pruneTsv(resolved.LOCAL_AI_CUSTOM_CATALOG_FILE, (cols) => cols[5] === rel)
  ) {
    report.actions.push(`  pruned custom catalog entries for ${rel}`);
  }

  if (force) {
    if (
      pruneTsv(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE, (cols) => cols[2] === rel)
    ) {
      report.actions.push(`  pruned promotion overrides for ${rel}`);
    }
  }

  return report;
}
