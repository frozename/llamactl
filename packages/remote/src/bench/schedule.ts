import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/**
 * Recurring bench schedules. The control plane stores them in
 * `~/.llamactl/bench-schedules.yaml`; a single in-process tick
 * iterates them, fires `benchPreset` on the target node for any
 * schedule whose `lastRunAt + intervalSeconds < now`, and writes
 * the timestamp back to disk. Bench history itself (the TSV tables
 * in core) keeps being the source of truth for "how is this model
 * performing over time" — this module just triggers runs.
 */

export const BenchScheduleSchema = z.object({
  id: z.string().min(1),
  node: z.string().min(1),
  rel: z.string().min(1),
  mode: z.enum(['auto', 'text', 'vision']).default('auto'),
  intervalSeconds: z.number().int().min(60).max(30 * 24 * 3600),
  enabled: z.boolean().default(true),
  lastRunAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});
export type BenchSchedule = z.infer<typeof BenchScheduleSchema>;

const BenchScheduleFileSchema = z.object({
  apiVersion: z.literal('llamactl/v1').default('llamactl/v1'),
  kind: z.literal('BenchScheduleList').default('BenchScheduleList'),
  schedules: z.array(BenchScheduleSchema).default([]),
});
type BenchScheduleFile = z.infer<typeof BenchScheduleFileSchema>;

export function defaultScheduleFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_BENCH_SCHEDULES?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'bench-schedules.yaml');
}

export function loadSchedules(path: string = defaultScheduleFilePath()): BenchSchedule[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const parsed = BenchScheduleFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.schedules;
}

export function saveSchedules(
  schedules: readonly BenchSchedule[],
  path: string = defaultScheduleFilePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: BenchScheduleFile = {
    apiVersion: 'llamactl/v1',
    kind: 'BenchScheduleList',
    schedules: schedules.map((s) => BenchScheduleSchema.parse(s)),
  };
  writeFileSync(path, stringifyYaml(file), 'utf8');
}

export function addSchedule(
  schedules: readonly BenchSchedule[],
  entry: Omit<BenchSchedule, 'lastRunAt' | 'lastError'>,
): BenchSchedule[] {
  if (schedules.some((s) => s.id === entry.id)) {
    throw new Error(`schedule with id '${entry.id}' already exists`);
  }
  return [...schedules, { ...entry, lastRunAt: null, lastError: null }];
}

export function removeSchedule(
  schedules: readonly BenchSchedule[],
  id: string,
): BenchSchedule[] {
  return schedules.filter((s) => s.id !== id);
}

export function updateSchedule(
  schedules: readonly BenchSchedule[],
  id: string,
  patch: Partial<BenchSchedule>,
): BenchSchedule[] {
  return schedules.map((s) =>
    s.id === id ? BenchScheduleSchema.parse({ ...s, ...patch, id: s.id }) : s,
  );
}

/** True when `now - lastRunAt >= intervalSeconds` (or never run yet). */
export function isDue(schedule: BenchSchedule, now: number = Date.now()): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;
  const last = Date.parse(schedule.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= schedule.intervalSeconds * 1000;
}
