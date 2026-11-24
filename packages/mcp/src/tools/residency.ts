import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

export function registerResidencyTools(server: McpServer): void {
  registerResidencyStatus(server);
  registerResidencyPlan(server);
  registerResidencyApplyProfile(server);
  registerResidencyCancelOperation(server);
  registerResidencyForceUnload(server);
}

function registerResidencyStatus(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.status",
    {
      title: "Node residency status",
      description:
        "Read-only. Mirrors the remote residencyStatus procedure. nodeRun/policy/budget come from the NodeRun matched by metadata.name, while the store section is always the serving process's own node-local residency store (scope \"serving-process\"), not `node`'s coordinator state. The leases section is this serving process's lease/drain registry snapshot: per-workload phase, epoch, active lease count, waiters and recent forced-unload audit. It reports status \"unavailable\" when no lease registry is installed. The omlxNative section reports, for each oMLX ModelHost on `node`, whether the native residency contract is used (native), the whole-process path is declared (process-fallback), or the state is unknown with a reason; it is probed and cached only on the serving process. The idleEviction section is an advisory read-out of the NodeRun idle-evict window against this serving process's ready lifecycle rows and lease activity, reported only when `node` is the serving node; nothing is evicted. The switchGates section is an advisory read-out of the NodeRun switchCooldownSeconds (from the last succeeded profile switch in this serving process's store) and minResidencySeconds (per ready lifecycle row), reported only when `node` is the serving node; a `held` resident would block a switch only if the target profile evicts it, and nothing is refused or switched. The ranking section is an advisory read-out of the ranking signals the unified proxy applies on the serving node (resident set, drain charge, cooldown/min-residency charge, in-flight load credit loadCredited, drain and degraded tiers); it is disabled when every ranking knob is 0 and never ranks anything.",
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

function registerResidencyPlan(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.plan",
    {
      title: "Node residency plan (dry run)",
      description:
        "Read-only. Mirrors the remote residencyPlan query: a dry-run profile switch that returns the budget source, victims, replacements and protected workloads, or a refusal reason. It never starts, stops or loads a workload and never writes the residency store.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the NodeRun to plan against."),
        to: z.string().min(1).describe("Target residency profile to switch to."),
        from: z
          .string()
          .min(1)
          .optional()
          .describe("Current residency profile; inferred when omitted."),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const caller = router.createCaller({});
      const { node, to, from } = input;
      const result = await caller.residencyPlan({
        node,
        to,
        ...(from !== undefined ? { from } : {}),
      });
      return toTextContent(result);
    },
  );
}

function registerResidencyApplyProfile(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.applyProfile",
    {
      title: "Apply a residency profile switch (dry-run by default)",
      description:
        "Mirrors the remote residencyApplyProfile mutation. Dry-run by default: plans and reports the profile switch without touching the store. Set `dryRun: false` to run it for real, which stops the victim workloads and starts the replacements and records a terminal operation under `profile-switch:<node>`; `confirm: true` is then required. Refuses NotServingNode off the serving process, ControllerActive while a live controller lock exists and NodeBusy while a profile switch is already in flight.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the NodeRun to switch."),
        to: z.string().min(1).describe("Target residency profile to switch to."),
        from: z
          .string()
          .min(1)
          .optional()
          .describe("Current residency profile; reported as null when omitted."),
        dryRun: z.boolean().default(true).describe("Preview only when true (default)."),
        confirm: z.boolean().default(false).describe("Must be true to run the switch for real."),
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async (input) => {
      const { node, to, from, dryRun, confirm } = input;
      if (!dryRun && !confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "refusing without confirm: true; a profile switch stops and starts workloads",
            },
          ],
        };
      }
      const caller = router.createCaller({});
      const result = await caller.residencyApplyProfile({
        node,
        to,
        ...(from !== undefined ? { from } : {}),
        dryRun,
        confirm,
      });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.residency.applyProfile",
        input: { dryRun, node, to, ...(from !== undefined ? { from } : {}) },
        dryRun,
        result,
      });
      return { ...toTextContent(result), ...(result.ok ? {} : { isError: true }) };
    },
  );
}

function registerResidencyCancelOperation(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.cancelOperation",
    {
      title: "Cancel an in-flight residency profile switch",
      description:
        "Mirrors the remote residencyCancelOperation mutation. The id comes from llamactl.residency.applyProfile (operationId / busy.operationId / inFlightOperationId) or residency status. Returns cancel-requested / not-found / already-terminal / not-owned-by-this-process. cancel-requested means the abort was delivered and the switch stops at its next step boundary; the recorded outcome lives on the operation. It is process-local: it reaches only switches running in this MCP server process. `confirm: true` is required.",
      inputSchema: {
        operationId: z.string().min(1).describe("Id of the in-flight profile-switch operation."),
        confirm: z.boolean().default(false).describe("Must be true to request the cancel."),
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async (input) => {
      const { operationId, confirm } = input;
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "refusing without confirm: true; cancelling aborts an in-flight profile switch",
            },
          ],
        };
      }
      const caller = router.createCaller({});
      const result = await caller.residencyCancelOperation({ operationId, confirm: true });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.residency.cancelOperation",
        input: { operationId },
        dryRun: false,
        result,
      });
      return { ...toTextContent(result), ...(result.ok ? {} : { isError: true }) };
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
