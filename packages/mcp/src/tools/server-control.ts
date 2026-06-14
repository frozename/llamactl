import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

/**
 * Imperative runtime control over MCP. The MCP surface previously exposed
 * only llamactl.server.status (read), so an agent could observe a wedged
 * server or a drifted fleet but could not stop the server or trigger a
 * reconcile — the self-healing-from-anywhere story stopped at observation.
 * server.start is intentionally NOT mirrored here: it is a streaming
 * subscription (boot/download progress) rather than a call/response, and
 * declarative bring-up is already covered by llamactl.workload.apply.
 */
export function registerServerControlTools(server: McpServer): void {
  registerServerStop(server);
  registerReconcilerKick(server);
}

function registerServerStop(server: McpServer): void {
  server.registerTool(
    "llamactl.server.stop",
    {
      title: "Stop a workload's llama-server",
      description:
        "Stop the running llama-server for a workload on the control plane's node. Reversible — restart via llamactl.workload.apply or `llamactl server start`. Does NOT delete the manifest. `dryRun: true` reports the target without stopping.",
      inputSchema: {
        workload: z.string().min(1).describe("metadata.name of the workload whose server to stop."),
        graceSeconds: z
          .number()
          .int()
          .positive()
          .max(60)
          .optional()
          .describe("Graceful shutdown window before SIGKILL."),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { workload, graceSeconds, dryRun } = input;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.server.stop",
          input: { dryRun, workload },
          dryRun: true,
        });
        return toTextContent({
          dryRun: true,
          wouldStop: { workload, graceSeconds: graceSeconds ?? null },
        });
      }
      const caller = router.createCaller({});
      const result = await caller.serverStop(
        graceSeconds === undefined ? { workload } : { workload, graceSeconds },
      );
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.server.stop",
        input: { dryRun, workload },
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}

function registerReconcilerKick(server: McpServer): void {
  server.registerTool(
    "llamactl.reconciler.kick",
    {
      title: "Trigger one reconcile pass",
      description:
        "Run a single reconcile pass immediately: converge every enabled workload manifest against live server state on its node, starting anything missing. Returns the reconcile-loop status. `dryRun: true` reports intent without reconciling.",
      inputSchema: {
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { dryRun } = input;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.reconciler.kick",
          input: { dryRun },
          dryRun: true,
        });
        return toTextContent({ dryRun: true, wouldReconcile: true });
      }
      const caller = router.createCaller({});
      const result = await caller.reconcilerKick();
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.reconciler.kick",
        input: { dryRun },
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}
