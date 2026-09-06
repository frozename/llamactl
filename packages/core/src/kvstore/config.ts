const DEFAULT_KV_WORKLOAD_BUDGET_MB = 8192;
const DEFAULT_KV_QUARANTINE_PURGE_HOURS = 24;

export interface KvStoreConfig {
  workloadBudgetMb: number;
  workloadBudgetSource: "env" | "default";
  quarantinePurgeHours: number;
  quarantinePurgeSource: "env" | "default";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function kvWorkloadBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveInt(env["LLAMACTL_KV_WORKLOAD_BUDGET_MB"], DEFAULT_KV_WORKLOAD_BUDGET_MB) *
    1024 *
    1024
  );
}

export function kvQuarantinePurgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveFloat(
      env["LLAMACTL_KV_QUARANTINE_PURGE_HOURS"],
      DEFAULT_KV_QUARANTINE_PURGE_HOURS,
    ) *
    60 *
    60 *
    1000
  );
}

export function kvStoreConfig(env: NodeJS.ProcessEnv = process.env): KvStoreConfig {
  const rawBudget = env["LLAMACTL_KV_WORKLOAD_BUDGET_MB"];
  const rawPurge = env["LLAMACTL_KV_QUARANTINE_PURGE_HOURS"];
  return {
    workloadBudgetMb: parsePositiveInt(rawBudget, DEFAULT_KV_WORKLOAD_BUDGET_MB),
    workloadBudgetSource: rawBudget ? "env" : "default",
    quarantinePurgeHours: parsePositiveFloat(rawPurge, DEFAULT_KV_QUARANTINE_PURGE_HOURS),
    quarantinePurgeSource: rawPurge ? "env" : "default",
  };
}
