import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { WorkloadDeleteDryRunResult } from "./tools/shared.js";

import { registerPipelineTools } from "./pipelines.js";
import { registerCompositeTools } from "./tools/composites.js";
import { registerEmbersynthTools } from "./tools/embersynth.js";
import { registerFleetTools } from "./tools/fleet.js";
import { registerModelsLeaderboardTool } from "./tools/models-leaderboard.js";
import { registerMutationTools } from "./tools/mutations.js";
import { registerOperatorTools } from "./tools/operator.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerRagTools } from "./tools/rag.js";
import { registerReadTools } from "./tools/reads.js";
import { registerServerControlTools } from "./tools/server-control.js";

export type { WorkloadDeleteDryRunResult };

export function buildMcpServer(opts?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: opts?.name ?? "llamactl",
    version: opts?.version ?? "0.0.0",
  });

  registerModelsLeaderboardTool(server);
  registerReadTools(server);
  registerMutationTools(server);
  registerEmbersynthTools(server);
  registerOperatorTools(server);
  registerRagTools(server);
  registerProjectTools(server);
  registerServerControlTools(server);
  registerCompositeTools(server);
  registerPipelineTools(server);
  registerFleetTools(server);

  return server;
}
