import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  type CostGuardianConfig,
  emptyCostGuardianConfig,
  loadCostGuardianConfig,
} from "../src/config.js";
import { appendCostJournal, defaultCostJournalPath } from "../src/journal.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import {
  type DailySnapshot,
  decideGuardianAction,
  type GuardianDecision,
  type WeeklySnapshot,
} from "../src/state.js";

function makeThresholds(
  overrides?: Partial<CostGuardianConfig["thresholds"]>,
): CostGuardianConfig["thresholds"] {
  return { warn: 0.5, force_private: 0.8, deregister: 0.9, ...overrides };
}

function makeConfig(
  budget: CostGuardianConfig["budget"] = {},
  thresholds: CostGuardianConfig["thresholds"] = makeThresholds(),
): CostGuardianConfig {
  return {
    ...emptyCostGuardianConfig(),
    budget,
    thresholds,
  };
}

function frozenNow(): () => Date {
  return () => new Date("2026-01-02T03:04:05.000Z");
}

function dailySnapshot(cost: number, topProviderKey?: string): DailySnapshot {
  return {
    snapshot: {
      windowSince: "2026-01-01T00:00:00.000Z",
      windowUntil: "2026-01-02T00:00:00.000Z",
      totalEstimatedCostUsd: cost,
      ...(topProviderKey !== undefined ? { topProvider: { key: topProviderKey } } : {}),
    },
  };
}

function weeklySnapshot(cost: number, topProviderKey?: string): WeeklySnapshot {
  return {
    snapshot: {
      windowSince: "2026-01-01T00:00:00.000Z",
      windowUntil: "2026-01-08T00:00:00.000Z",
      totalEstimatedCostUsd: cost,
      ...(topProviderKey !== undefined ? { topProvider: { key: topProviderKey } } : {}),
    },
  };
}

describe("loadCostGuardianConfig file handling", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-edge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("(a) non-existent path returns emptyCostGuardianConfig", () => {
    const path = join(dir, "does-not-exist.yaml");
    expect(loadCostGuardianConfig(path)).toEqual(emptyCostGuardianConfig());
  });

  test("(b) partial YAML with custom thresholds and webhook_url", () => {
    const path = join(dir, "partial.yaml");
    writeFileSync(
      path,
      "budget:\n  daily_usd: 10\n  weekly_usd: 60\nthresholds:\n  warn: 0.4\nwebhook_url: https://example.test/hook\nauto_force_private: true\n",
    );
    const cfg = loadCostGuardianConfig(path);
    expect(cfg).toEqual({
      budget: { daily_usd: 10, weekly_usd: 60 },
      thresholds: { warn: 0.4, force_private: 0.8, deregister: 0.95 },
      webhook_url: "https://example.test/hook",
      auto_force_private: true,
      auto_deregister: false,
      protectedProviders: ["fleet-internal"],
    });
  });

  test("(c) invalid URL string throws ZodError", () => {
    const path = join(dir, "bad-url.yaml");
    writeFileSync(path, "webhook_url: not a url\n");
    expect(() => loadCostGuardianConfig(path)).toThrow(z.ZodError);
  });

  test("(d) malformed YAML throws", () => {
    const path = join(dir, "malformed.yaml");
    writeFileSync(path, "budget: [unclosed\n");
    expect(() => loadCostGuardianConfig(path)).toThrow();
  });

  test("(e) scalar root value throws ZodError", () => {
    const path = join(dir, "scalar.yaml");
    writeFileSync(path, "42\n");
    expect(() => loadCostGuardianConfig(path)).toThrow(z.ZodError);
  });

  test("(f) string budget value (no coercion) throws ZodError", () => {
    const path = join(dir, "string-budget.yaml");
    writeFileSync(path, 'budget:\n  daily_usd: "10"\n');
    expect(() => loadCostGuardianConfig(path)).toThrow(z.ZodError);
  });

  test("(g) unknown top-level keys are stripped", () => {
    const path = join(dir, "unknown-keys.yaml");
    writeFileSync(path, "bogus: 1\n");
    expect(loadCostGuardianConfig(path)).toEqual(emptyCostGuardianConfig());
  });
});

describe("appendCostJournal append semantics", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-append-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("(h) appends two entries to a nested path, file ends with newline", () => {
    const nestedDir = join(dir, "nested");
    const filePath = join(nestedDir, "j.jsonl");
    // nestedDir does not exist yet — mkdirSync handles it.

    const decision: GuardianDecision = decideGuardianAction({
      config: {
        ...makeConfig({ daily_usd: 100 }, { warn: 0.5, force_private: 0.8, deregister: 0.9 }),
        thresholds: { warn: 0.5, force_private: 0.8, deregister: 0.9 },
      },
      daily: dailySnapshot(60, "p"),
      now: frozenNow(),
    });

    appendCostJournal({ kind: "tick", decision }, filePath);
    appendCostJournal(
      {
        kind: "action",
        ts: "2026-01-02T03:04:06.000Z",
        action: "webhook",
        ok: false,
        error: "boom",
      },
      filePath,
    );

    const content = readFileSync(filePath, "utf8");
    expect(content.endsWith("\n")).toBe(true);

    const lines = content.split("\n");
    // Drop the trailing empty string from the final newline.
    lines.pop();
    expect(lines).toHaveLength(2);

    const line0: unknown = JSON.parse(lines[0]!);
    const line1: unknown = JSON.parse(lines[1]!);

    expect((line0 as { kind: string; decision: GuardianDecision }).kind).toBe("tick");
    expect((line0 as { decision: GuardianDecision }).decision).toEqual(decision);

    expect(
      (line1 as { kind: string; ts: string; action: string; ok: boolean; error: string }).kind,
    ).toBe("action");
    expect((line1 as { ts: string; action: string; ok: boolean; error: string }).ts).toBe(
      "2026-01-02T03:04:06.000Z",
    );
    expect((line1 as { action: string }).action).toBe("webhook");
    expect((line1 as { ok: boolean }).ok).toBe(false);
    expect((line1 as { error: string }).error).toBe("boom");
  });

  test("(i) defaultCostJournalPath with DEV_STORAGE variations", () => {
    expect(defaultCostJournalPath({ DEV_STORAGE: "  /dev  " })).toBe(
      join("/dev", "healer", "cost-journal.jsonl"),
    );
    expect(defaultCostJournalPath({ DEV_STORAGE: "   " })).toBe(
      join(homedir(), ".llamactl", "healer", "cost-journal.jsonl"),
    );
  });
});

describe("decideGuardianAction edges", () => {
  const thresholds = makeThresholds();

  test("(j) daily 150 of 100, topProvider 'p' -> deregister with full fields", () => {
    const result = decideGuardianAction({
      config: {
        ...makeConfig({ daily_usd: 100 }, { warn: 0.5, force_private: 0.8, deregister: 0.9 }),
        thresholds,
      },
      daily: dailySnapshot(150, "p"),
      now: frozenNow(),
    });
    expect(result.tier).toBe("deregister");
    expect(result.thresholdCrossed).toBe(0.9);
    expect(result.dailyFraction).toBe(1.5);
    expect(result.dailyUsd).toBe(150);
    expect(result.deregisterTarget).toBe("p");
    expect(result.reason).toBe("daily spend $150.0000 of $100.00 budget = 150.0%");
  });

  test("(k) Infinity cost with topProvider 'p' -> deregister", () => {
    const result = decideGuardianAction({
      config: {
        ...makeConfig({ daily_usd: 100 }, { warn: 0.5, force_private: 0.8, deregister: 0.9 }),
        thresholds,
      },
      daily: {
        snapshot: {
          windowSince: "2026-01-01T00:00:00.000Z",
          windowUntil: "2026-01-02T00:00:00.000Z",
          totalEstimatedCostUsd: Infinity,
          topProvider: { key: "p" },
        },
      },
      now: frozenNow(),
    });
    expect(result.tier).toBe("deregister");
    expect(result.thresholdCrossed).toBe(0.9);
    expect(result.deregisterTarget).toBe("p");
    expect(result.reason).toBe("daily spend $Infinity of $100.00 budget = Infinity%");
  });

  test("(l) -Infinity cost -> noop, thresholdCrossed 0, dailyFraction 0", () => {
    const result = decideGuardianAction({
      config: {
        ...makeConfig({ daily_usd: 100 }, { warn: 0.5, force_private: 0.8, deregister: 0.9 }),
        thresholds,
      },
      daily: {
        snapshot: {
          windowSince: "2026-01-01T00:00:00.000Z",
          windowUntil: "2026-01-02T00:00:00.000Z",
          totalEstimatedCostUsd: -Infinity,
        },
      },
      now: frozenNow(),
    });
    expect(result.tier).toBe("noop");
    expect(result.thresholdCrossed).toBe(0);
    expect(result.dailyFraction).toBe(0);
    expect(result.deregisterTarget).toBeNull();
  });

  test("(m) both budgets, daily 10 of 100 + weekly 95 of 100 -> weekly wins deregister", () => {
    const result = decideGuardianAction({
      config: {
        ...makeConfig(
          { daily_usd: 100, weekly_usd: 100 },
          { warn: 0.5, force_private: 0.8, deregister: 0.9 },
        ),
      },
      daily: dailySnapshot(10, "pd"),
      weekly: weeklySnapshot(95),
      now: frozenNow(),
    });
    expect(result.tier).toBe("deregister");
    expect(result.deregisterTarget).toBe("pd");
    expect(result.dailyFraction).toBe(0.1);
    expect(result.weeklyFraction).toBe(0.95);
    expect(result.reason).toBe(
      "daily spend $10.0000 of $100.00 budget = 10.0%; weekly spend $95.0000 of $100.00 budget = 95.0%",
    );
  });

  test("(n) weekly only (cost 60), no daily -> warn, no dailyFraction/dailyUsd", () => {
    const result = decideGuardianAction({
      config: {
        ...makeConfig(
          { daily_usd: 100, weekly_usd: 100 },
          { warn: 0.5, force_private: 0.8, deregister: 0.9 },
        ),
      },
      weekly: weeklySnapshot(60),
      now: frozenNow(),
    });
    expect(result.tier).toBe("warn");
    expect(result.thresholdCrossed).toBe(0.5);
    expect(result.weeklyFraction).toBe(0.6);
    expect(result.weeklyUsd).toBe(60);
    expect("dailyFraction" in result).toBe(false);
    expect("dailyUsd" in result).toBe(false);
    expect(result.reason).toBe("weekly spend $60.0000 of $100.00 budget = 60.0%");
  });
});
