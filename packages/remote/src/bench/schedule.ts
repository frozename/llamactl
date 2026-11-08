import { llamactlHome } from "@llamactl/core/config/env";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { atomicWriteFileSync } from "../atomic-write.js";
import { existsSync, mkdirSync, readFileSync } from "../safe-fs.js";

/**
 * Recurring bench schedules. The control plane stores them in
 * `~/.llamactl/bench-schedules.yaml`; a single in-process tick
 * iterates them, fires `benchPreset` on the target node for any
 * schedule whose `lastRunAt + intervalSeconds < now`, and writes
 * the timestamp back to disk. Bench history itself (the TSV tables
 * in core) keeps being the source of truth for "how is this model
 * performing over time" — this module just triggers runs.
 *
 * A schedule carrying `kind: "suite"` + `suite: "<name>"` dispatches
 * a named perf suite through an injected runner instead of
 * `benchPresetRun.subscribe`. The scheduler never resolves the suite
 * id itself: an unknown id is the runner's to reject, and the
 * rejection lands in `lastError`.
 */

export const BENCH_SCHEDULE_KINDS = ["preset", "suite"] as const;

const benchScheduleBase = z.object({
  id: z.string().min(1),
  node: z.string().min(1),
  rel: z.string().min(1),
  mode: z.enum(["auto", "text", "vision"]).default("auto"),
  intervalSeconds: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600),
  enabled: z.boolean().default(true),
  lastRunAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  kind: z.enum(BENCH_SCHEDULE_KINDS).optional(),
  suite: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .optional(),
});

export const BenchScheduleSchema = benchScheduleBase.superRefine((data, ctx) => {
  if (data.kind === "suite" && !data.suite) {
    ctx.addIssue({
      code: "custom",
      message: "suite id is required for kind 'suite'",
      path: ["suite"],
    });
  }
  if (data.kind !== "suite" && data.suite !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "suite is only valid with kind 'suite'",
      path: ["suite"],
    });
  }
});
export type BenchSchedule = z.infer<typeof BenchScheduleSchema>;

export function scheduleKind(s: Pick<BenchSchedule, "kind">): "preset" | "suite" {
  return s.kind ?? "preset";
}

const BenchScheduleFileSchema = z.object({
  apiVersion: z.literal("llamactl/v1").default("llamactl/v1"),
  kind: z.literal("BenchScheduleList").default("BenchScheduleList"),
  schedules: z.array(BenchScheduleSchema).default([]),
});
type BenchScheduleFile = z.infer<typeof BenchScheduleFileSchema>;

export function defaultScheduleFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LLAMACTL_BENCH_SCHEDULES"]?.trim();
  if (override) return override;
  const base = llamactlHome(env);
  return join(base, "bench-schedules.yaml");
}

/**
 * Path of the cross-process run lock, kept beside the store so a
 * `bench schedule run` and a `bench schedule kick` from different
 * processes serialise on the same file.
 */
export function benchRunLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultScheduleFilePath(env)), "bench-schedule-run.lock");
}

export function loadSchedules(path: string = defaultScheduleFilePath()): BenchSchedule[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const parsed = BenchScheduleFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.schedules;
}

export function saveSchedules(
  schedules: readonly BenchSchedule[],
  path: string = defaultScheduleFilePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: BenchScheduleFile = {
    apiVersion: "llamactl/v1",
    kind: "BenchScheduleList",
    schedules: schedules.map((s) => BenchScheduleSchema.parse(s)),
  };
  atomicWriteFileSync(path, stringifyYaml(file));
}

export function addSchedule(
  schedules: readonly BenchSchedule[],
  entry: Omit<BenchSchedule, "lastRunAt" | "lastError">,
): BenchSchedule[] {
  if (schedules.some((s) => s.id === entry.id)) {
    throw new Error(`schedule with id '${entry.id}' already exists`);
  }
  const validated = BenchScheduleSchema.parse(entry);
  return [...schedules, { ...validated, lastRunAt: null, lastError: null }];
}

export function removeSchedule(schedules: readonly BenchSchedule[], id: string): BenchSchedule[] {
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

/**
 * Stamp one schedule's run outcome without clobbering concurrent edits:
 * the loop holds no lock across a bench run (up to 15 minutes), so the
 * in-memory list is stale by the time the bench finishes. Re-load the
 * store, patch only this id's run fields, and skip the write when the
 * schedule was removed or disabled in another process meanwhile.
 * Returns whether the store was written.
 */
export function recordRunOutcome(
  path: string,
  id: string,
  patch: Pick<BenchSchedule, "lastRunAt" | "lastError">,
): boolean {
  const fresh = loadSchedules(path);
  const current = fresh.find((s) => s.id === id);
  if (!current?.enabled) return false;
  saveSchedules(updateSchedule(fresh, id, patch), path);
  return true;
}

/** True when `now - lastRunAt >= intervalSeconds` (or never run yet). */
export function isDue(schedule: BenchSchedule, now: number = Date.now()): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;
  const last = Date.parse(schedule.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= schedule.intervalSeconds * 1000;
}
