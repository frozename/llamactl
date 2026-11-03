import { describe, expect, test } from "bun:test";

import {
  kvQuarantinePurgeMs,
  kvStoreConfig,
  kvWorkloadBudgetBytes,
} from "../src/kvstore/config.js";
import * as kvIndex from "../src/kvstore/index.js";

function e(o: Record<string, string>): Record<string, string> {
  return o;
}

const mixedEnv = {
  LLAMACTL_KV_WORKLOAD_BUDGET_MB: "64",
  LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "3",
};

describe("kvWorkloadBudgetBytes", () => {
  test("default when no env key present", () => {
    expect(kvWorkloadBudgetBytes(e({}))).toBe(8589934592);
  });

  test("respects numeric string values", () => {
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "16" }))).toBe(16777216);
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "1" }))).toBe(1048576);
  });

  test("falls back on rejected values", () => {
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "0" }))).toBe(8589934592);
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "-4" }))).toBe(8589934592);
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "abc" }))).toBe(8589934592);
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "" }))).toBe(8589934592);
  });

  test("parseInt truncates decimals", () => {
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "8.9" }))).toBe(8388608);
  });

  test("parses numeric prefix from alphanumeric", () => {
    expect(kvWorkloadBudgetBytes(e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "12abc" }))).toBe(12582912);
  });
});

describe("kvQuarantinePurgeMs", () => {
  test("default when no env key present", () => {
    expect(kvQuarantinePurgeMs(e({}))).toBe(86400000);
  });

  test("respects numeric string values", () => {
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "2" }))).toBe(7200000);
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "0.5" }))).toBe(1800000);
  });

  test("falls back on rejected values", () => {
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "0" }))).toBe(86400000);
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "-1" }))).toBe(86400000);
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "nope" }))).toBe(86400000);
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "Infinity" }))).toBe(
      86400000,
    );
    expect(kvQuarantinePurgeMs(e({ LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "" }))).toBe(86400000);
  });
});

describe("kvStoreConfig", () => {
  test("defaults when no env keys present", () => {
    expect(kvStoreConfig(e({}))).toEqual({
      workloadBudgetMb: 8192,
      workloadBudgetSource: "default",
      quarantinePurgeHours: 24,
      quarantinePurgeSource: "default",
    });
  });

  test("reads env values with env source", () => {
    expect(
      kvStoreConfig(
        e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "32", LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "1.5" }),
      ),
    ).toEqual({
      workloadBudgetMb: 32,
      workloadBudgetSource: "env",
      quarantinePurgeHours: 1.5,
      quarantinePurgeSource: "env",
    });
  });

  test("empty strings treated as unset (source defaults)", () => {
    expect(
      kvStoreConfig(
        e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "", LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "" }),
      ),
    ).toEqual({
      workloadBudgetMb: 8192,
      workloadBudgetSource: "default",
      quarantinePurgeHours: 24,
      quarantinePurgeSource: "default",
    });
  });

  // pins existing behaviour: source reports "env" whenever the variable is
  // non-empty, even when the parsed value was rejected and the default was used
  test("rejected env values still report source as env (pins existing behaviour)", () => {
    expect(
      kvStoreConfig(
        e({ LLAMACTL_KV_WORKLOAD_BUDGET_MB: "abc", LLAMACTL_KV_QUARANTINE_PURGE_HOURS: "0" }),
      ),
    ).toEqual({
      workloadBudgetMb: 8192,
      workloadBudgetSource: "env",
      quarantinePurgeHours: 24,
      quarantinePurgeSource: "env",
    });
  });

  test("consistency: kvStoreConfig values convert to the same bytes/ms as the standalone functions", () => {
    const cfg = kvStoreConfig(e(mixedEnv));
    expect(cfg.workloadBudgetMb * 1048576).toBe(kvWorkloadBudgetBytes(e(mixedEnv)));
    expect(cfg.quarantinePurgeHours * 3600000).toBe(kvQuarantinePurgeMs(e(mixedEnv)));
  });
});

describe("kvstore index re-exports", () => {
  test("re-exports the three config functions", () => {
    expect(kvIndex.kvStoreConfig).toBe(kvStoreConfig);
    expect(kvIndex.kvWorkloadBudgetBytes).toBe(kvWorkloadBudgetBytes);
    expect(kvIndex.kvQuarantinePurgeMs).toBe(kvQuarantinePurgeMs);
  });
});
