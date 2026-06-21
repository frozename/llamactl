import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { Project } from "../src/config/projects.js";

import {
  appendProjectRoutingJournal,
  type BudgetSnapshot,
  defaultProjectRoutingJournalPath,
  makeProjectBudgetChecker,
  packRouteForUsage,
  parseProjectNodeName,
  type ProjectRoutingDecision,
  resolveProjectNodeTarget,
} from "../src/config/project-routing.js";
import { ProjectSchema } from "../src/config/projects.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function makeProject(overrides: Partial<Project["spec"]> = {}): Project {
  return ProjectSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "Project",
    metadata: { name: "novaflow" },
    spec: {
      path: "/Users/me/DevStorage/repos/work/novaflow",
      routing: {
        quick_qna: "private-first",
        code_review: "mac-mini.claude-pro",
      },
      ...overrides,
    },
  });
}

describe("parseProjectNodeName", () => {
  test("accepts project:<name>/<taskKind>", () => {
    expect(parseProjectNodeName("project:novaflow/quick_qna")).toEqual({
      project: "novaflow",
      taskKind: "quick_qna",
    });
  });
  test("rejects non-project prefix", () => {
    expect(parseProjectNodeName("mac-mini.claude-pro")).toBeNull();
    expect(parseProjectNodeName("private-first")).toBeNull();
    expect(parseProjectNodeName("")).toBeNull();
  });
  test("rejects malformed shapes (missing slash, empty halves)", () => {
    expect(parseProjectNodeName("project:novaflow")).toBeNull();
    expect(parseProjectNodeName("project:/quick_qna")).toBeNull();
    expect(parseProjectNodeName("project:novaflow/")).toBeNull();
  });
});

describe("resolveProjectNodeTarget — passthrough", () => {
  test("non-project node name returns unchanged + decision: null", async () => {
    const out = await resolveProjectNodeTarget("mac-mini.claude-pro");
    expect(out.node).toBe("mac-mini.claude-pro");
    expect(out.decision).toBeNull();
  });
});

describe("resolveProjectNodeTarget — project matches", () => {
  test("matched taskKind rewrites node + decision.reason=matched", async () => {
    const project = makeProject();
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      now: () => Date.UTC(2026, 3, 22, 12, 0, 0),
    });
    expect(out.node).toBe("mac-mini.claude-pro");
    expect(out.decision).not.toBeNull();
    expect(out.decision!.reason).toBe("matched");
    expect(out.decision!.matched).toBe(true);
    expect(out.decision!.project).toBe("novaflow");
    expect(out.decision!.taskKind).toBe("code_review");
    expect(out.decision!.target).toBe("mac-mini.claude-pro");
    expect(out.decision!.ts).toBe("2026-04-22T12:00:00.000Z");
  });
  test("unknown taskKind falls back to private-first + reason=fallback-default", async () => {
    const project = makeProject();
    const out = await resolveProjectNodeTarget("project:novaflow/unseen_task", {
      loadProjects: () => [project],
    });
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("fallback-default");
    expect(out.decision!.matched).toBe(false);
  });
});

describe("resolveProjectNodeTarget — project not found", () => {
  test("stale project name falls back to private-first + reason=project-not-found", async () => {
    const out = await resolveProjectNodeTarget("project:ghost/quick_qna", {
      loadProjects: () => [],
    });
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("project-not-found");
    expect(out.decision!.matched).toBe(false);
  });
});

describe("resolveProjectNodeTarget — budget check", () => {
  test("over-budget flips the decision to private-first with reason=over-budget", async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: () =>
        Promise.resolve({
          usdToday: 1.25,
          usdLimit: 1.0,
        } satisfies BudgetSnapshot),
    });
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("over-budget");
    // Preserve the declared match so operators see what WOULD have
    // been routed — the budget just overrode it.
    expect(out.decision!.matched).toBe(true);
    expect(out.decision!.budget?.usdToday).toBeCloseTo(1.25, 6);
    expect(out.decision!.budget?.limit).toBeCloseTo(1.0, 6);
  });
  test("under-budget keeps the matched decision unchanged", async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: () => Promise.resolve({ usdToday: 0.5, usdLimit: 1.0 }),
    });
    expect(out.node).toBe("mac-mini.claude-pro");
    expect(out.decision!.reason).toBe("matched");
  });
  test("spend exactly at the limit flips over-budget (boundary is inclusive)", async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: () => Promise.resolve({ usdToday: 1.0, usdLimit: 1.0 }),
    });
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("over-budget");
  });
  test("broken budget snapshotter does not block the dispatch", async () => {
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: async () => {
        await Promise.resolve();
        throw new Error("cost-guardian unreachable");
      },
    });
    // Original target preserved; the routing path does NOT fail
    // because cost-guardian is down.
    expect(out.node).toBe("mac-mini.claude-pro");
    expect(out.decision!.reason).toBe("matched");
  });
  test("budget block with no USD limit is not evaluated", async () => {
    const project = makeProject({
      budget: { cli_calls_per_day: { "claude-pro": 500 } },
    });
    let called = false;
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: async () => {
        await Promise.resolve();
        called = true;
        return { usdToday: 999, usdLimit: 1 };
      },
    });
    expect(called).toBe(false);
    expect(out.decision!.reason).toBe("matched");
  });

  test("usd_per_day: 0 is the strictest ceiling — any spend is over budget", async () => {
    // 0 is the most restrictive ceiling an operator can set: block ALL
    // paid spend. A falsy-0 gate would skip enforcement and yield UNLIMITED
    // spend — the exact fail-open this guards. The checker is consulted and
    // the inclusive >= comparator flips a 0-limit project to private-first.
    const project = makeProject({ budget: { usd_per_day: 0 } });
    let called = false;
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: async () => {
        await Promise.resolve();
        called = true;
        return { usdToday: 0, usdLimit: 0 };
      },
    });
    expect(called).toBe(true);
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("over-budget");
    expect(out.decision!.matched).toBe(true);
  });

  test("undefined usd_per_day remains unlimited (checker never consulted)", async () => {
    // No USD ceiling declared — the budget gate must stay off. This pins the
    // 'undefined === unlimited' contract so the 0-handling fix above does not
    // bleed into projects that simply never opted into a USD cap.
    const project = makeProject();
    let called = false;
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: async () => {
        await Promise.resolve();
        called = true;
        return { usdToday: 999, usdLimit: 0 };
      },
    });
    expect(called).toBe(false);
    expect(out.node).toBe("mac-mini.claude-pro");
    expect(out.decision!.reason).toBe("matched");
  });

  test("a positive usd_per_day limit still enforces normally", async () => {
    // Regression guard: the 0-handling fix must not weaken positive limits.
    const project = makeProject({ budget: { usd_per_day: 2.0 } });
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: () => Promise.resolve({ usdToday: 3.0, usdLimit: 2.0 }),
    });
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("over-budget");
  });
});

describe("makeProjectBudgetChecker", () => {
  let usageDir = "";
  let pricingDir = "";
  // Mid-day on 2026-04-22 UTC; the day window starts at 00:00:00Z.
  const NOW = Date.UTC(2026, 3, 22, 15, 0, 0);
  const TODAY = "2026-04-22";

  beforeEach(() => {
    usageDir = mkdtempSync(join(tmpdir(), "budget-usage-"));
    pricingDir = mkdtempSync(join(tmpdir(), "budget-pricing-"));
  });
  afterEach(() => {
    rmSync(usageDir, { recursive: true, force: true });
    rmSync(pricingDir, { recursive: true, force: true });
  });

  const writeUsage = (provider: string, date: string, records: Record<string, unknown>[]): void => {
    writeFileSync(
      join(usageDir, `${provider}-${date}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
  };
  const writePricing = (
    provider: string,
    models: Record<
      string,
      { prompt_per_1k_tokens_usd: number; completion_per_1k_tokens_usd: number }
    >,
  ): void => {
    writeFileSync(
      join(pricingDir, `${provider}.yaml`),
      stringifyYaml({ provider, models }),
      "utf8",
    );
  };
  const usageRow = (
    route: string | undefined,
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ts: `${TODAY}T10:00:00Z`,
    provider: "openai",
    model: "gpt-4o",
    kind: "chat",
    prompt_tokens: 1000,
    completion_tokens: 1000,
    total_tokens: 2000,
    latency_ms: 5,
    ...(route ? { route } : {}),
    ...extra,
  });

  test("sums today's project spend from a record's own estimated_cost_usd", async () => {
    writeUsage("openai", TODAY, [
      usageRow("project:novaflow/code_review/openai", { estimated_cost_usd: 0.3 }),
      usageRow("project:novaflow/quick_qna/openai", { estimated_cost_usd: 0.2 }),
      // Other project — must be excluded.
      usageRow("project:other/code_review/openai", { estimated_cost_usd: 99 }),
      // Sibling project sharing the name prefix — the trailing-slash guard
      // must keep novaflow-staging's spend out of novaflow's budget.
      usageRow("project:novaflow-staging/code_review/openai", { estimated_cost_usd: 88 }),
      // No route — not attributable to any project, excluded.
      usageRow(undefined, { estimated_cost_usd: 50 }),
    ]);
    const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
    const snap = await checker({ project: makeProject(), limit: 2 });
    expect(snap).not.toBeNull();
    expect(snap!.usdToday).toBeCloseTo(0.5, 6);
    expect(snap!.usdLimit).toBe(2);
  });

  test("a negative estimated_cost_usd contributes 0 — it cannot erase prior spend", async () => {
    // A crafted/corrupt record with a NEGATIVE cost must NOT subtract from the
    // running daily total — that would let an attacker drive usdToday below the
    // cap and bypass the budget. The negative record clamps to 0; only the real
    // positive spend accumulates.
    writeUsage("openai", TODAY, [
      usageRow("project:novaflow/code_review/openai", { estimated_cost_usd: 0.8 }),
      usageRow("project:novaflow/quick_qna/openai", { estimated_cost_usd: -5 }),
    ]);
    const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
    const snap = await checker({ project: makeProject(), limit: 2 });
    // 0.8 + max(0, -5) = 0.8, NOT 0.8 + (-5) = -4.2.
    expect(snap!.usdToday).toBeCloseTo(0.8, 6);
  });

  test("a zero estimated_cost_usd is summed without distorting the total", async () => {
    // 0 is a legitimate priced value (a free/cached call). The negative-cost
    // clamp must treat 0 as a real contribution of 0 — not reject it — so a
    // mix of zero and positive records sums to exactly the positive spend.
    writeUsage("openai", TODAY, [
      usageRow("project:novaflow/code_review/openai", { estimated_cost_usd: 0 }),
      usageRow("project:novaflow/quick_qna/openai", { estimated_cost_usd: 0.6 }),
    ]);
    const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
    const snap = await checker({ project: makeProject(), limit: 2 });
    expect(snap!.usdToday).toBeCloseTo(0.6, 6);
  });

  test("prices token counts via the catalog when a record lacks estimated_cost_usd", async () => {
    // The production path: recordChatUsage writes token counts but no cost.
    writePricing("openai", {
      "gpt-4o": { prompt_per_1k_tokens_usd: 0.01, completion_per_1k_tokens_usd: 0.03 },
    });
    writeUsage("openai", TODAY, [usageRow("project:novaflow/code_review/openai", {})]);
    // 1000/1000 * 0.01 + 1000/1000 * 0.03 = 0.04
    const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
    const snap = await checker({ project: makeProject(), limit: 1 });
    expect(snap!.usdToday).toBeCloseTo(0.04, 6);
  });

  test("excludes spend from earlier days", async () => {
    writeUsage("openai", "2026-04-21", [
      {
        ...usageRow("project:novaflow/code_review/openai", { estimated_cost_usd: 7 }),
        ts: "2026-04-21T23:59:00Z",
      },
    ]);
    const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
    const snap = await checker({ project: makeProject(), limit: 1 });
    expect(snap!.usdToday).toBe(0);
  });

  test("unpriceable records contribute zero instead of erroring", async () => {
    // No pricing file for this provider/model and no estimated_cost_usd.
    writeUsage("mystery", TODAY, [
      {
        ts: `${TODAY}T10:00:00Z`,
        provider: "mystery",
        model: "unknown-model",
        kind: "chat",
        prompt_tokens: 100,
        completion_tokens: 100,
        total_tokens: 200,
        latency_ms: 5,
        route: "project:novaflow/code_review/mystery",
      },
    ]);
    const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
    const snap = await checker({ project: makeProject(), limit: 1 });
    expect(snap!.usdToday).toBe(0);
  });

  test("warns + under-counts when the catalog is non-empty but lacks the spend's (provider, model)", async () => {
    // Seed pricing for ONE provider — catalog.size > 0 so the empty-
    // catalog warn-once short-circuits — and route spend to a DIFFERENT
    // unpriced provider. The earlier behavior (a flat `?? 0`) swallowed
    // the under-count silently; the new per-record warning must fire,
    // and the rollup must under-count the unpriced spend.
    //
    // Use a (provider, model) tuple distinct from any prior test in this
    // file so the per-key warn-once cache is cold for this assertion.
    writePricing("openai", {
      "gpt-4o": { prompt_per_1k_tokens_usd: 1, completion_per_1k_tokens_usd: 1 },
    });
    writeUsage("untracked", TODAY, [
      {
        ts: `${TODAY}T10:00:00Z`,
        provider: "untracked",
        model: "untracked-llm",
        kind: "chat",
        prompt_tokens: 1000,
        completion_tokens: 1000,
        total_tokens: 2000,
        latency_ms: 5,
        route: "project:novaflow/code_review/untracked",
      },
    ]);
    const stderrCalls: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown): boolean => {
      if (typeof chunk === "string") stderrCalls.push(chunk);
      return true;
    };
    try {
      const checker = makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir });
      const snap = await checker({ project: makeProject(), limit: 10 });
      expect(snap!.usdToday).toBe(0);
      const warned = stderrCalls.join("");
      expect(warned).toContain("under-counted");
      expect(warned).toContain("untracked/untracked-llm");
      // Empty-catalog warn-once must NOT fire — the catalog HAS entries.
      expect(warned).not.toContain("pricing catalog is empty");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("integrates with resolveProjectNodeTarget to flip an over-budget project", async () => {
    writePricing("openai", {
      "gpt-4o": { prompt_per_1k_tokens_usd: 1, completion_per_1k_tokens_usd: 1 },
    });
    // 1000+1000 tokens at $1/1k each = $2 spent today on novaflow.
    writeUsage("openai", TODAY, [usageRow("project:novaflow/code_review/openai", {})]);
    const project = makeProject({ budget: { usd_per_day: 1.0 } });
    const out = await resolveProjectNodeTarget("project:novaflow/code_review", {
      loadProjects: () => [project],
      checkBudget: makeProjectBudgetChecker({ now: () => NOW, usageDir, pricingDir }),
    });
    expect(out.node).toBe("private-first");
    expect(out.decision!.reason).toBe("over-budget");
    expect(out.decision!.budget?.usdToday).toBeCloseTo(2, 6);
    // The usage route the dispatch path will attribute reflects where the
    // call ACTUALLY went (private-first), not the would-be matched target.
    expect(packRouteForUsage(out.decision!)).toBe("project:novaflow/code_review/private-first");
  });
});

describe("decision journal", () => {
  let tmp = "";
  const originalEnv = { ...process.env };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-project-routing-"));
    process.env = {
      ...originalEnv,
      LLAMACTL_PROJECT_ROUTING_JOURNAL: join(tmp, "project-routing.jsonl"),
    };
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  test("append writes a JSONL line with the decision record", async () => {
    const decision: ProjectRoutingDecision = {
      ts: "2026-04-22T12:00:00.000Z",
      project: "novaflow",
      taskKind: "code_review",
      target: "mac-mini.claude-pro",
      matched: true,
      reason: "matched",
    };
    await appendProjectRoutingJournal(decision);
    const path = defaultProjectRoutingJournalPath();
    const raw = readFileSync(path, "utf8").trim();
    const parsed = JSON.parse(raw) as { project: string; target: string; reason: string };
    expect(parsed.project).toBe("novaflow");
    expect(parsed.target).toBe("mac-mini.claude-pro");
    expect(parsed.reason).toBe("matched");
  });

  test("append tolerates IO errors (non-throwing)", async () => {
    // Point the journal at a path inside a read-only dir that we
    // can't create. The appender should swallow + continue.
    process.env = {
      ...originalEnv,
      LLAMACTL_PROJECT_ROUTING_JOURNAL:
        "/this/path/definitely/cannot/be/created/by/test/journal.jsonl",
    };
    const decision: ProjectRoutingDecision = {
      ts: new Date().toISOString(),
      project: "x",
      taskKind: "y",
      target: "private-first",
      matched: false,
      reason: "fallback-default",
    };
    // Must not throw.
    await appendProjectRoutingJournal(decision);
  });
});

describe("packRouteForUsage", () => {
  test("packs decision into a stable route string", () => {
    const decision: ProjectRoutingDecision = {
      ts: "2026-04-22T12:00:00.000Z",
      project: "novaflow",
      taskKind: "code_review",
      target: "mac-mini.claude-pro",
      matched: true,
      reason: "matched",
    };
    expect(packRouteForUsage(decision)).toBe("project:novaflow/code_review/mac-mini.claude-pro");
  });
});

describe("loadProjects file-backed resolution", () => {
  let tmp = "";
  const originalEnv = { ...process.env };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-project-routing-file-"));
    process.env = {
      ...originalEnv,
      LLAMACTL_PROJECTS_FILE: join(tmp, "projects.yaml"),
    };
    const yaml = stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "ProjectList",
      projects: [makeProject()],
    });
    writeFileSync(join(tmp, "projects.yaml"), yaml, "utf8");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });
  test("resolves against the file at LLAMACTL_PROJECTS_FILE when no loader is injected", async () => {
    const out = await resolveProjectNodeTarget("project:novaflow/code_review");
    expect(out.node).toBe("mac-mini.claude-pro");
    expect(out.decision!.matched).toBe(true);
  });
});
