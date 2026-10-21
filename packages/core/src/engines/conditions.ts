// Persistent ModelHost runtime conditions. The manifest carries no status
// (the schema is strict and the store strips it), and modelhost.state is
// removed whenever a host stops, so anything that must survive a restart —
// a reconcile error that keeps a host down, an OOM kill, the restart count —
// lives in its own sidecar, modelhost.conditions.json, beside the state file
// in the workload runtime dir. removeModelHostState leaves it alone; deleting
// the workload removes the runtime dir and the conditions with it.
//
// Semantics:
//   ReconcileError  True while consecutive reconcile passes fail. count is the
//                   number of failing passes in the current episode; a pass
//                   that succeeds flips it to False (reason Recovered) and
//                   keeps the last error message for the record.
//   OOMKilled       History, not current state: stays True once recorded.
//                   count is the number of engine OOM kills attributed to the
//                   host; lastSeen and cgroupOomKill describe the latest.
import { join } from "node:path";

import type { ResolvedEnv } from "../types.js";

import { resolveEnv } from "../env.js";
import { atomicWriteFile } from "../fsAtomic.js";
import { existsSync, readFileSync } from "../safe-fs.js";
import { type WorkloadKey, workloadRuntimeDir } from "../workloadRuntime.js";

export const RECONCILE_ERROR_CONDITION = "ReconcileError";
export const OOM_KILLED_CONDITION = "OOMKilled";

export type ModelHostRestartReason = "EngineExited" | "SpecChanged";

export interface ModelHostCondition {
  type: string;
  status: "True" | "False";
  reason: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  lastTransitionTime: string;
  count: number;
  /** OOMKilled only: the controller cgroup's oom_kill counter at the latest kill. */
  cgroupOomKill?: number;
}

export interface ModelHostRuntimeStatus {
  conditions: ModelHostCondition[];
  /** Restarts of a host that had been running (engine found dead, or spec drift). */
  restarts: number;
  lastRestartAt: string | null;
  lastRestartReason: ModelHostRestartReason | null;
}

export function emptyModelHostRuntimeStatus(): ModelHostRuntimeStatus {
  return { conditions: [], restarts: 0, lastRestartAt: null, lastRestartReason: null };
}

function findCondition(
  record: ModelHostRuntimeStatus,
  type: string,
): ModelHostCondition | undefined {
  return record.conditions.find((c) => c.type === type);
}

function withCondition(
  record: ModelHostRuntimeStatus,
  condition: ModelHostCondition,
): ModelHostRuntimeStatus {
  const others = record.conditions.filter((c) => c.type !== condition.type);
  return { ...record, conditions: [...others, condition] };
}

export function withReconcileError(
  record: ModelHostRuntimeStatus,
  error: { reason: string; message: string },
  now: string,
): ModelHostRuntimeStatus {
  const prev = findCondition(record, RECONCILE_ERROR_CONDITION);
  const ongoing = prev?.status === "True";
  return withCondition(record, {
    type: RECONCILE_ERROR_CONDITION,
    status: "True",
    reason: error.reason,
    message: error.message,
    firstSeen: ongoing ? prev.firstSeen : now,
    lastSeen: now,
    lastTransitionTime: ongoing ? prev.lastTransitionTime : now,
    count: ongoing ? prev.count + 1 : 1,
  });
}

/** Flip an active ReconcileError to False. Null when there is nothing to clear. */
export function withReconcileRecovered(
  record: ModelHostRuntimeStatus,
  reason: string,
  now: string,
): ModelHostRuntimeStatus | null {
  const prev = findCondition(record, RECONCILE_ERROR_CONDITION);
  if (prev?.status !== "True") return null;
  return withCondition(record, { ...prev, status: "False", reason, lastTransitionTime: now });
}

export function withOomKill(
  record: ModelHostRuntimeStatus,
  cgroupOomKill: number,
  now: string,
): ModelHostRuntimeStatus {
  const prev = findCondition(record, OOM_KILLED_CONDITION);
  return withCondition(record, {
    type: OOM_KILLED_CONDITION,
    status: "True",
    reason: "CgroupOOMKill",
    message: `engine was OOM-killed (cgroup oom_kill ${String(cgroupOomKill)})`,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
    lastTransitionTime: prev?.lastTransitionTime ?? now,
    count: (prev?.count ?? 0) + 1,
    cgroupOomKill,
  });
}

export function withRestart(
  record: ModelHostRuntimeStatus,
  reason: ModelHostRestartReason,
  now: string,
): ModelHostRuntimeStatus {
  return {
    ...record,
    restarts: record.restarts + 1,
    lastRestartAt: now,
    lastRestartReason: reason,
  };
}

export function modelhostConditionsFile(
  resolved: ResolvedEnv = resolveEnv(),
  key: WorkloadKey,
): string {
  return join(workloadRuntimeDir(resolved, key), "modelhost.conditions.json");
}

function parseCondition(raw: unknown): ModelHostCondition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const strings = ["type", "reason", "message", "firstSeen", "lastSeen", "lastTransitionTime"];
  if (strings.some((field) => typeof c[field] !== "string")) return null;
  if (c["status"] !== "True" && c["status"] !== "False") return null;
  if (typeof c["count"] !== "number") return null;
  return {
    type: c["type"] as string,
    status: c["status"],
    reason: c["reason"] as string,
    message: c["message"] as string,
    firstSeen: c["firstSeen"] as string,
    lastSeen: c["lastSeen"] as string,
    lastTransitionTime: c["lastTransitionTime"] as string,
    count: c["count"],
    ...(typeof c["cgroupOomKill"] === "number" ? { cgroupOomKill: c["cgroupOomKill"] } : {}),
  };
}

function parseRestartReason(raw: unknown): ModelHostRestartReason | null {
  return raw === "EngineExited" || raw === "SpecChanged" ? raw : null;
}

export function readModelHostRuntimeStatus(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): ModelHostRuntimeStatus | null {
  const path = modelhostConditionsFile(resolved, key);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const conditions = Array.isArray(parsed["conditions"]) ? parsed["conditions"] : [];
    const restarts = parsed["restarts"];
    const lastRestartAt = parsed["lastRestartAt"];
    return {
      conditions: conditions.map(parseCondition).filter((c) => c !== null),
      restarts: typeof restarts === "number" && Number.isSafeInteger(restarts) ? restarts : 0,
      lastRestartAt: typeof lastRestartAt === "string" ? lastRestartAt : null,
      lastRestartReason: parseRestartReason(parsed["lastRestartReason"]),
    };
  } catch {
    return null;
  }
}

function updateModelHostRuntimeStatus(
  key: WorkloadKey,
  resolved: ResolvedEnv,
  update: (record: ModelHostRuntimeStatus) => ModelHostRuntimeStatus | null,
): void {
  const current = readModelHostRuntimeStatus(key, resolved) ?? emptyModelHostRuntimeStatus();
  const next = update(current);
  if (next === null) return;
  atomicWriteFile(modelhostConditionsFile(resolved, key), `${JSON.stringify(next, null, 2)}\n`);
}

export function recordModelHostReconcileError(
  key: WorkloadKey,
  error: { reason: string; message: string },
  resolved: ResolvedEnv = resolveEnv(),
  now: Date = new Date(),
): void {
  updateModelHostRuntimeStatus(key, resolved, (r) =>
    withReconcileError(r, error, now.toISOString()),
  );
}

/** Writes only when a ReconcileError is active, so healthy passes cost one stat. */
export function recordModelHostReconcileRecovered(
  key: WorkloadKey,
  reason: string,
  resolved: ResolvedEnv = resolveEnv(),
  now: Date = new Date(),
): void {
  if (!existsSync(modelhostConditionsFile(resolved, key))) return;
  updateModelHostRuntimeStatus(key, resolved, (r) =>
    withReconcileRecovered(r, reason, now.toISOString()),
  );
}

export function recordModelHostOomKill(
  key: WorkloadKey,
  cgroupOomKill: number,
  resolved: ResolvedEnv = resolveEnv(),
  now: Date = new Date(),
): void {
  updateModelHostRuntimeStatus(key, resolved, (r) =>
    withOomKill(r, cgroupOomKill, now.toISOString()),
  );
}

export function recordModelHostRestart(
  key: WorkloadKey,
  reason: ModelHostRestartReason,
  resolved: ResolvedEnv = resolveEnv(),
  now: Date = new Date(),
): void {
  updateModelHostRuntimeStatus(key, resolved, (r) => withRestart(r, reason, now.toISOString()));
}
