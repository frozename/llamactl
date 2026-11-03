import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  CostGuardianBudgetSchema,
  CostGuardianConfigSchema,
  CostGuardianThresholdsSchema,
  defaultCostGuardianConfigPath,
  emptyCostGuardianConfig,
  loadCostGuardianConfig,
} from "../src/config.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

describe("defaultCostGuardianConfigPath", () => {
  test("trimmed override beats DEV_STORAGE", () => {
    expect(
      defaultCostGuardianConfigPath({
        LLAMACTL_COST_GUARDIAN_CONFIG: "/x/cg.yaml",
        DEV_STORAGE: "/dev",
      }),
    ).toBe("/x/cg.yaml");
  });

  test("override is trimmed", () => {
    expect(defaultCostGuardianConfigPath({ LLAMACTL_COST_GUARDIAN_CONFIG: "  /x/cg.yaml  " })).toBe(
      "/x/cg.yaml",
    );
  });

  test("whitespace-only override is ignored in favor of DEV_STORAGE", () => {
    expect(
      defaultCostGuardianConfigPath({
        LLAMACTL_COST_GUARDIAN_CONFIG: "   ",
        DEV_STORAGE: "/dev",
      }),
    ).toBe(join("/dev", "cost-guardian.yaml"));
  });

  test("DEV_STORAGE is trimmed", () => {
    expect(defaultCostGuardianConfigPath({ DEV_STORAGE: "  /dev  " })).toBe(
      join("/dev", "cost-guardian.yaml"),
    );
  });

  test("whitespace-only DEV_STORAGE falls back to homedir", () => {
    expect(defaultCostGuardianConfigPath({ DEV_STORAGE: "   " })).toBe(
      join(homedir(), ".llamactl", "cost-guardian.yaml"),
    );
  });

  test("empty env falls back to homedir", () => {
    expect(defaultCostGuardianConfigPath({})).toBe(
      join(homedir(), ".llamactl", "cost-guardian.yaml"),
    );
  });
});

describe("loadCostGuardianConfig", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty file returns the empty config", () => {
    const path = join(dir, "empty.yaml");
    writeFileSync(path, "");
    expect(loadCostGuardianConfig(path)).toEqual(emptyCostGuardianConfig());
  });

  test("comment-only file returns the empty config", () => {
    const path = join(dir, "comment.yaml");
    writeFileSync(path, "# nothing here\n");
    expect(loadCostGuardianConfig(path)).toEqual(emptyCostGuardianConfig());
  });

  test("decreasing thresholds throw", () => {
    const path = join(dir, "bad-thresholds.yaml");
    writeFileSync(path, "thresholds:\n  warn: 0.9\n  force_private: 0.5\n  deregister: 0.95\n");
    expect(() => loadCostGuardianConfig(path)).toThrow(/non-decreasing/);
  });

  test("protectedProviders are trimmed and lowercased", () => {
    const path = join(dir, "providers.yaml");
    writeFileSync(path, 'protectedProviders:\n  - " OpenAI "\n  - "Anthropic"\n');
    const cfg = loadCostGuardianConfig(path);
    expect(cfg.protectedProviders).toEqual(["openai", "anthropic"]);
  });
});

describe("CostGuardianConfigSchema", () => {
  test("empty object gets default protectedProviders and budget", () => {
    const cfg = CostGuardianConfigSchema.parse({});
    expect(cfg.protectedProviders).toEqual(["fleet-internal"]);
    expect(cfg.budget).toEqual({});
  });

  test("thresholds get per-field defaults", () => {
    const cfg = CostGuardianConfigSchema.parse({ thresholds: { warn: 0.3 } });
    expect(cfg.thresholds).toEqual({ warn: 0.3, force_private: 0.8, deregister: 0.95 });
  });

  test("deregister below the default warn throws", () => {
    expect(() => CostGuardianConfigSchema.parse({ thresholds: { deregister: 0.4 } })).toThrow(
      /non-decreasing/,
    );
  });

  test("equal thresholds parse (non-strict ordering)", () => {
    const cfg = CostGuardianConfigSchema.parse({
      thresholds: { warn: 0.6, force_private: 0.6, deregister: 0.6 },
    });
    expect(cfg.thresholds).toEqual({ warn: 0.6, force_private: 0.6, deregister: 0.6 });
  });
});

describe("CostGuardianThresholdsSchema", () => {
  test("deregister above 1 throws", () => {
    expect(() =>
      CostGuardianThresholdsSchema.parse({ warn: 0.5, force_private: 0.8, deregister: 1.01 }),
    ).toThrow();
  });

  test("deregister of exactly 1 parses", () => {
    const thresholds = CostGuardianThresholdsSchema.parse({
      warn: 0.5,
      force_private: 0.8,
      deregister: 1,
    });
    expect(thresholds.deregister).toBe(1);
  });
});

describe("CostGuardianBudgetSchema", () => {
  test("daily_usd of 0 throws", () => {
    expect(() => CostGuardianBudgetSchema.parse({ daily_usd: 0 })).toThrow();
  });

  test("negative weekly_usd throws", () => {
    expect(() => CostGuardianBudgetSchema.parse({ weekly_usd: -5 })).toThrow();
  });
});
