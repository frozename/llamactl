import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEnv } from '../env.js';
import {
  BenchHistoryEntry,
  BenchProfile,
  BenchProfileLegacy,
  BenchVision,
  benchHistoryFields,
  benchProfileFields,
  benchVisionFields,
  splitTsvRow,
} from '../schemas.js';

/**
 * Canonical on-disk paths for bench state. Names are `llama-*` prefixed
 * for historical compatibility with the shell library, which already
 * writes to these paths.
 */
export function benchProfileFile(resolved = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'llama-bench-profiles.tsv');
}

export function benchHistoryFile(resolved = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'llama-bench-history.tsv');
}

export function benchVisionFile(resolved = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'bench-vision.tsv');
}

export interface BenchProfileRows {
  current: BenchProfile[];
  legacy: BenchProfileLegacy[];
}

export interface BenchHistoryRows {
  current: BenchHistoryEntry[];
  /** Legacy bench-history rows — six fields, no machine/mode/ctx/build. */
  legacy: LegacyHistoryEntry[];
}

export interface LegacyHistoryEntry {
  updated_at: string;
  rel: string;
  profile: string;
  gen_ts: string;
  prompt_ts: string;
  launch_args: string;
}

function readLines(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n');
}

/**
 * Parse bench-profiles.tsv. Rows with 9+ fields load into the current
 * schema; rows with exactly 5 fields load as legacy (rel, profile,
 * gen_ts, prompt_ts, updated_at) and are returned in a separate bucket
 * so consumers can display them explicitly as `mode=legacy ctx=legacy`.
 */
export function readBenchProfiles(file: string): BenchProfileRows {
  const out: BenchProfileRows = { current: [], legacy: [] };
  for (const line of readLines(file)) {
    if (line.trim() === '') continue;
    const cols = splitTsvRow(line);
    if (cols.length >= benchProfileFields.length) {
      const record: Record<string, string> = {};
      for (let i = 0; i < benchProfileFields.length; i += 1) {
        const field = benchProfileFields[i];
        if (field === undefined) continue;
        record[field] = cols[i] ?? '';
      }
      const parsed = BenchProfile.safeParse(record);
      if (parsed.success) out.current.push(parsed.data);
      continue;
    }
    if (cols.length === 5) {
      const [rel, profile, gen, prompt, updated] = cols;
      const parsed = BenchProfileLegacy.safeParse({
        rel,
        profile,
        gen_ts: gen,
        prompt_ts: prompt,
        updated_at: updated,
      });
      if (parsed.success) out.legacy.push(parsed.data);
    }
  }
  return out;
}

/**
 * Find the latest bench-profile row matching the full key. Returns
 * `null` if no match exists in the current schema; callers that want
 * the legacy fallback should consult `rows.legacy` separately.
 */
export function findLatestProfile(
  rows: BenchProfileRows,
  key: {
    machine: string;
    rel: string;
    mode: string;
    ctx: string;
    build: string;
  },
): BenchProfile | null {
  let match: BenchProfile | null = null;
  for (const row of rows.current) {
    if (
      row.machine === key.machine &&
      row.rel === key.rel &&
      row.mode === key.mode &&
      row.ctx === key.ctx &&
      row.build === key.build
    ) {
      match = row; // keep the last match; file is append-plus-replace
    }
  }
  return match;
}

/** Find the most recent legacy bench-profile row for a rel, if any. */
export function findLegacyProfile(
  rows: BenchProfileRows,
  rel: string,
): BenchProfileLegacy | null {
  let match: BenchProfileLegacy | null = null;
  for (const row of rows.legacy) {
    if (row.rel === rel) match = row;
  }
  return match;
}

/**
 * Parse bench-vision.tsv. Single-schema file — no legacy fallback
 * because the format was introduced together with `llama-bench-vision`.
 * Rows shorter than the expected column count are dropped silently.
 */
export function readBenchVision(file: string): BenchVision[] {
  const out: BenchVision[] = [];
  for (const line of readLines(file)) {
    if (line.trim() === '') continue;
    const cols = splitTsvRow(line);
    if (cols.length < benchVisionFields.length) continue;
    const record: Record<string, string> = {};
    for (let i = 0; i < benchVisionFields.length; i += 1) {
      const field = benchVisionFields[i];
      if (field === undefined) continue;
      record[field] = cols[i] ?? '';
    }
    const parsed = BenchVision.safeParse(record);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Latest vision bench row for a `(machine, rel, build)` triple. Unlike
 * `findLatestProfile` which keys on (machine, rel, mode, ctx, build),
 * the vision record schema uses ctx inline and build as the version
 * axis — callers usually care about "newest for my machine + current
 * llama.cpp build" regardless of the exact ctx size that was used.
 */
export function findLatestVision(
  rows: BenchVision[],
  key: { machine: string; rel: string; build: string },
): BenchVision | null {
  let match: BenchVision | null = null;
  for (const row of rows) {
    if (
      row.machine === key.machine &&
      row.rel === key.rel &&
      row.build === key.build
    ) {
      match = row;
    }
  }
  return match;
}

/**
 * Parse bench-history.tsv. Rows with 10+ fields load into the current
 * schema; rows with exactly 6 fields load as legacy. Legacy rows look
 * like `<updated_at> <rel> <profile> <gen> <prompt> <launch_args>`.
 */
export function readBenchHistory(file: string): BenchHistoryRows {
  const out: BenchHistoryRows = { current: [], legacy: [] };
  for (const line of readLines(file)) {
    if (line.trim() === '') continue;
    const cols = splitTsvRow(line);
    if (cols.length >= benchHistoryFields.length) {
      const record: Record<string, string> = {};
      for (let i = 0; i < benchHistoryFields.length; i += 1) {
        const field = benchHistoryFields[i];
        if (field === undefined) continue;
        record[field] = cols[i] ?? '';
      }
      const parsed = BenchHistoryEntry.safeParse(record);
      if (parsed.success) out.current.push(parsed.data);
      continue;
    }
    if (cols.length === 6) {
      const [updatedAt, rel, profile, gen, prompt, launchArgs] = cols;
      out.legacy.push({
        updated_at: updatedAt ?? '',
        rel: rel ?? '',
        profile: profile ?? '',
        gen_ts: gen ?? '',
        prompt_ts: prompt ?? '',
        launch_args: launchArgs ?? '',
      });
    }
  }
  return out;
}
