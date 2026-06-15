import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { bench, env as envMod, SAFETY_TIERS } from "@llamactl/core";
import { BUILT_IN_PLANNER_TOOLS, mergePlannerTools } from "@llamactl/remote";
import { createOpenAICompatProvider } from "@nova/contracts";
import {
  computeCostSnapshot,
  createLlmExecutor,
  DEFAULT_ALLOWLIST,
  type PlannerExecutor,
  type PlannerToolDescriptor,
  runPlanner,
  stubPlannerExecutor,
} from "@nova/mcp";
import { toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

export function registerOperatorTools(server: McpServer): void {
  server.registerTool(
    "llamactl.env",
    {
      title: "Environment snapshot",
      description:
        "Return the shell environment llamactl is running under — paths, machine profile, provider config. Shows which values are explicitly set vs defaulted. Read-only.",
      inputSchema: {},
    },
    () => toTextContent(envMod.resolveEnv()),
  );

  server.registerTool(
    "llamactl.bench.history",
    {
      title: "Recent bench runs",
      description:
        "Return merged bench-history rows (current + legacy) for the local machine. Optional rel filter narrows to a single model; limit defaults to 50 most recent.",
      inputSchema: {
        rel: z.string().optional().describe("Filter to a single rel path."),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe("Max rows to return, newest first."),
      },
    },
    ({ rel, limit }) => {
      const resolved = envMod.resolveEnv();
      const rows = bench.readBenchHistory(bench.benchHistoryFile(resolved));
      const current = rows.current.map((r) => ({
        updated_at: r.updated_at,
        machine: r.machine,
        rel: r.rel,
        mode: r.mode,
        profile: r.profile,
        gen_ts: r.gen_ts,
        prompt_ts: r.prompt_ts,
        build: r.build,
      }));
      const filtered = rel ? current.filter((r) => r.rel === rel) : current;
      const sorted = [...filtered].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      const head = sorted.slice(0, limit);
      return toTextContent({
        count: head.length,
        total: filtered.length,
        legacyCount: rows.legacy.length,
        rows: head,
      });
    },
  );

  server.registerTool(
    "llamactl.cost.snapshot",
    {
      title: "Pricing-aware spend rollup",
      description:
        "Aggregate the local ~/.llamactl/usage/*.jsonl corpus over the last N days. Returns per-provider, per-model, and per-day rollups plus the same top-level totals the Cost dashboard polls.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .max(90)
          .default(7)
          .describe("Window size in days (max 90)."),
      },
    },
    ({ days }) => toTextContent(computeCostSnapshot({ days })),
  );

  server.registerTool(
    "llamactl.operator.plan",
    {
      title: "Operator planner (stub or LLM)",
      description:
        "Translate a natural-language operational goal into a validated sequence of MCP tool calls. Stub mode returns a canned plan (no tokens burned); LLM mode drives an OpenAI-compatible model. Optional history carries prior turns so callers can chain refinements. Approval + execution stay CLI-side — this tool only produces the plan.",
      inputSchema: {
        goal: z.string().min(1),
        context: z.string().optional(),
        mode: z.enum(["stub", "llm"]).default("stub"),
        model: z.string().optional().describe("Required when mode=llm."),
        baseUrl: z.string().optional(),
        apiKeyEnv: z
          .string()
          .optional()
          .describe("Env var holding the API key (default: OPENAI_API_KEY)."),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              text: z.string(),
            }),
          )
          .optional(),
        tools: z
          .array(
            z.object({
              name: z.string().min(1),
              description: z.string(),
              tier: z.enum(SAFETY_TIERS),
            }),
          )
          .optional(),
      },
    },
    async (input) => {
      const mode = input.mode;
      let executor: PlannerExecutor = stubPlannerExecutor;
      if (mode === "llm") {
        if (!input.model) {
          return toTextContent({
            ok: false,
            reason: "config",
            message: "model is required when mode=llm",
          });
        }
        const envName = input.apiKeyEnv ?? "OPENAI_API_KEY";
        const apiKey = process.env[envName];
        if (!apiKey) {
          return toTextContent({
            ok: false,
            reason: "config",
            message: `env var ${envName} is empty — set it or switch to mode=stub`,
          });
        }
        const provider = createOpenAICompatProvider({
          name: "planner-llm",
          baseUrl: input.baseUrl ?? "https://api.openai.com/v1",
          apiKey,
        });
        executor = createLlmExecutor({ provider, model: input.model });
      }
      const callerTools: PlannerToolDescriptor[] = (input.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: "object" },
        tier: t.tier,
      }));
      // Merge caller-supplied tools with the server-side built-ins so the
      // direct-MCP planner sees the same catalog (composite.apply +
      // workload.apply) as the tRPC operatorPlan path. Caller entries win
      // on name collision, matching mergePlannerTools' contract.
      const plannerTools = mergePlannerTools(callerTools, BUILT_IN_PLANNER_TOOLS);
      const history = input.history ?? [];
      const transcript = history
        .map((turn) => `${turn.role}: ${turn.text.trim()}`)
        .filter((line) => line.length > "user:".length)
        .join("\n");
      const userContext = input.context?.trim() ?? "";
      const mergedContext = [transcript, userContext].filter((s) => s.length > 0).join("\n\n");
      const result = await runPlanner({
        goal: input.goal,
        context: mergedContext,
        tools: plannerTools,
        executor,
        allowlist: DEFAULT_ALLOWLIST,
      });
      return toTextContent(result);
    },
  );
}
