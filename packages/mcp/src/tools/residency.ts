import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

export function registerResidencyTools(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.status",
    {
      title: "Node residency status",
      description:
        "Read-only. Mirrors the remote residencyStatus procedure. nodeRun/policy/budget come from the NodeRun matched by metadata.name, while the store section is always the serving process's own node-local residency store (scope \"serving-process\"), not `node`'s coordinator state.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the NodeRun to inspect."),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const caller = router.createCaller({});
      return toTextContent(await caller.residencyStatus({ node: input.node }));
    },
  );
}
