import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryRows, type QueryFilter } from "../../../eval/src/index.js";
import { toTextContent } from "@nova/mcp-shared";

function leaderboardDbPath(): string {
  const root = process.env.DEV_STORAGE ?? "";
  return join(root, "eval", "leaderboard.sqlite");
}

export function registerModelsLeaderboardTool(server: McpServer): void {
  server.registerTool(
    "llamactl_models_leaderboard",
    {
      title: "llamactl models leaderboard",
      description: "Read the eval leaderboard SQLite store and return sortable model rows.",
      inputSchema: {
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
      },
    },
    async (input) => {
      const dbPath = leaderboardDbPath();
      if (!existsSync(dbPath)) {
        return toTextContent([]);
      }
      const db = new Database(dbPath, { readonly: true });
      try {
        const filter: QueryFilter = {
          node: input.node,
          min_throughput: input.min_throughput,
          min_tool_call_score: input.min_tool_call_score,
          sort_by: input.sort_by,
        };
        return toTextContent(queryRows(db, filter));
      } finally {
        db.close();
      }
    },
  );
}
