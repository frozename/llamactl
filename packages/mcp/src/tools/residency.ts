import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

export function registerResidencyTools(server: McpServer): void {
  registerResidencyStatus(server);
  registerResidencyForceUnload(server);
}

function registerResidencyStatus(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.status",
    {
      title: "Node residency status",
      description:
        'Read-only. Mirrors the remote residencyStatus procedure. nodeRun/policy/budget come from the NodeRun matched by metadata.name, while the store section is always the serving process\'s own node-local residency store (scope "serving-process"), not `node`\'s coordinator state. The leases section is this serving process\'s lease/drain registry snapshot: per-workload phase, epoch, active lease count, waiters and recent forced-unload audit. It reports status "unavailable" when no lease registry is installed.',
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

function registerResidencyForceUnload(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.forceUnload",
    {
      title: "Force-unload a workload through the lease fence",
      description:
        "Operator override of the stop fence: revokes any active leases on the workload, unloads it and audits the action as an operator override ('operator: <reason>'). Destructive — in-flight requests are aborted. `confirm: true` is required. `dryRun: true` previews the target without revoking anything. An idle unload (no leases held) writes no lease audit row.",
      inputSchema: {
        workload: z.string().min(1).describe("metadata.name of the ModelRun or ModelHost."),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Why the operator is forcing the unload; audited."),
        confirm: z.boolean().default(false).describe("Must be true to perform the unload."),
        dryRun: z.boolean().default(false),
      },
      annotations: { destructiveHint: true },
    },
    async (input) => {
      const { workload, reason, confirm, dryRun } = input;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.residency.forceUnload",
          input: { dryRun, workload, reason },
          dryRun: true,
        });
        return toTextContent({ dryRun: true, wouldForceUnload: { workload, reason } });
      }
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "refusing without confirm: true; a forced unload revokes active leases",
            },
          ],
        };
      }
      const caller = router.createCaller({});
      const result = await caller.residencyForceUnload({ workload, reason, confirm: true });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.residency.forceUnload",
        input: { dryRun, workload, reason },
        dryRun: false,
        result,
      });
      return { ...toTextContent(result), ...(result.ok ? {} : { isError: true }) };
    },
  );
}
