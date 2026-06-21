import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type QueryFilter, queryRows } from "@llamactl/eval";
import { toTextContent } from "@nova/mcp-shared";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";

import { existsSync } from "../safe-fs.js";

const deprecatedToolWarnings = new Set<string>();

function warnDeprecatedToolAlias(oldName: string, newName: string): void {
  if (deprecatedToolWarnings.has(oldName)) return;
  deprecatedToolWarnings.add(oldName);
  console.error(`[llamactl-mcp] deprecated: ${oldName} -> ${newName}; will be removed`);
}

function leaderboardDbPath(): string {
  const root = process.env["DEV_STORAGE"] ?? "";
  return join(root, "eval", "leaderboard.sqlite");
}

const leaderboardInputSchema = {
  node: z.string().optional(),
  min_throughput: z.number().optional(),
  min_tool_call_score: z.number().optional(),
  sort_by: z
    .enum([
      "model",
      "node",
      "ub",
      "throughput_tps",
      "ttft_ms",
      "tool_call_score",
      "context_8k_score",
      "context_16k_score",
      "json_score",
      "composite",
      "asof",
    ])
    .optional(),
};

function handleModelsLeaderboard(input: {
  node?: string | undefined;
  min_throughput?: number | undefined;
  min_tool_call_score?: number | undefined;
  sort_by?: QueryFilter["sort_by"];
}): { content: { type: "text"; text: string }[] } {
  const dbPath = leaderboardDbPath();
  if (!existsSync(dbPath)) {
    return toTextContent([]);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const filter: QueryFilter = {
      ...(input.node !== undefined ? { node: input.node } : {}),
      ...(input.min_throughput !== undefined ? { min_throughput: input.min_throughput } : {}),
      ...(input.min_tool_call_score !== undefined
        ? { min_tool_call_score: input.min_tool_call_score }
        : {}),
      ...(input.sort_by !== undefined ? { sort_by: input.sort_by } : {}),
    };
    return toTextContent(queryRows(db, filter));
  } finally {
    db.close();
  }
}

export function registerModelsLeaderboardTool(server: McpServer): void {
  server.registerTool(
    "llamactl.models.leaderboard",
    {
      title: "llamactl models leaderboard",
      description: "Read the eval leaderboard SQLite store and return sortable model rows.",
      inputSchema: leaderboardInputSchema,
    },
    handleModelsLeaderboard,
  );

  server.registerTool(
    "llamactl_models_leaderboard",
    {
      title: "llamactl models leaderboard (deprecated)",
      description:
        "[DEPRECATED — use llamactl.models.leaderboard] Backward-compatible alias for llamactl.models.leaderboard.",
      inputSchema: leaderboardInputSchema,
    },
    (input) => {
      warnDeprecatedToolAlias("llamactl_models_leaderboard", "llamactl.models.leaderboard");
      return handleModelsLeaderboard(input);
    },
  );
}
