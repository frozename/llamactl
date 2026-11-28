import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getAuthenticatedAgentClientByName } from "@llamactl/cli/dispatcher";
import {
  MANAGED_PROFILE_PROTOCOL_VERSION,
  RESIDENCY_APPLY_PROFILE_TOOL,
  RESIDENCY_CALIBRATION_KEY_TOOL,
  RESIDENCY_CONTROL_TOOL,
  type ResidencyApplyProfileResult,
  residencyApplyProfileToolInput,
  residencyCalibrationKeyInput,
  residencyControlInput,
  type ResidencyControlResult,
  router,
} from "@llamactl/remote";
import { appendAudit, toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

export function registerResidencyTools(server: McpServer): void {
  registerResidencyControl(server);
  registerCalibrationKey(server);
  registerResidencyStatus(server);
  registerResidencyPlan(server);
  registerResidencyApplyProfile(server);
  registerResidencyCancelOperation(server);
  registerResidencyForceUnload(server);
  registerResidencyReleaseSession(server);
}

function missingProcedure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const data = "data" in error ? error.data : null;
  return (
    code === "NOT_FOUND" ||
    (typeof data === "object" && data !== null && "code" in data && data.code === "NOT_FOUND")
  );
}

function registerResidencyControl(server: McpServer): void {
  server.registerTool(
    RESIDENCY_CONTROL_TOOL,
    {
      title: "Manage workload residency on one node",
      description:
        "Preview a load or unload on the named authenticated managed agent. Dry-run is the default. Set dryRun to false and confirm to true to execute under the owner's capacity, policy and lease checks.",
      inputSchema: residencyControlInput,
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({ action, node, workload, dryRun, confirm }, { signal }) => {
      const target = { action, node, workload };
      const input = { ...target, dryRun, confirm };
      let result: ResidencyControlResult;
      if (!dryRun && !confirm) {
        result = { ...target, ok: false, reason: "ConfirmationRequired" };
      } else {
        try {
          const client = getAuthenticatedAgentClientByName(node);
          result = await client.residencyControl.mutate(input, { signal });
        } catch (error) {
          const reason = missingProcedure(error)
            ? "ManagedControlUnavailable"
            : "ControlTransportError";
          result = { ...target, ok: false, reason };
        }
      }
      appendAudit({ server: SERVER_SLUG, tool: RESIDENCY_CONTROL_TOOL, input, dryRun, result });
      return { ...toTextContent(result), ...(result.ok ? {} : { isError: true }) };
    },
  );
}

function registerCalibrationKey(server: McpServer): void {
  server.registerTool(
    RESIDENCY_CALIBRATION_KEY_TOOL,
    {
      title: "Read the owner calibration key",
      description:
        "Read the exact compiled launch key and prospective memory charge from one authenticated managed agent.",
      inputSchema: residencyCalibrationKeyInput,
      annotations: { readOnlyHint: true },
    },
    async (input, { signal }) => {
      try {
        const client = getAuthenticatedAgentClientByName(input.node);
        return toTextContent(await client.residencyCalibrationKey.query(input, { signal }));
      } catch (error) {
        const reason = missingProcedure(error)
          ? "ManagedCalibrationIdentityUnavailable"
          : "ManagedCalibrationOwnerUnavailable";
        return { ...toTextContent({ reason }), isError: true };
      }
    },
  );
}

function registerResidencyStatus(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.status",
    {
      title: "Node residency status",
      description:
        "Read-only. Mirrors the remote residencyStatus procedure. nodeRun/policy/budget come from the NodeRun matched by metadata.name, while the store section is always the serving process's own node-local residency store (scope \"serving-process\"), not `node`'s coordinator state. The leases section is this serving process's lease/drain registry snapshot: per-workload phase, epoch, active lease count, waiters and recent forced-unload audit. It reports status \"unavailable\" when no lease registry is installed. The omlxNative section reports, for each oMLX ModelHost on `node`, whether the native residency contract is used (native), the whole-process path is declared (process-fallback), or the state is unknown with a reason; it is probed and cached only on the serving process. The idleEviction section is an advisory read-out of the NodeRun idle-evict window against this serving process's ready lifecycle rows and lease activity, reported only when `node` is the serving node; nothing is evicted. The switchGates section is an advisory read-out of the NodeRun switchCooldownSeconds (from the last succeeded profile switch in this serving process's store) and minResidencySeconds (per ready lifecycle row), reported only when `node` is the serving node; a `held` resident would block a switch only if the target profile evicts it, and nothing is refused or switched. The ranking section is an advisory read-out of the ranking signals the unified proxy applies on the serving node (resident set, drain charge, cooldown/min-residency charge, in-flight load credit loadCredited, drain and degraded tiers); it is disabled when every ranking knob is 0 and never ranks anything. The effectivePolicy section lists every residency knob as resolved for `node`, in policy key order, with its value and whether it came from the defaults (defaulted), whether or not a NodeRun exists; it never changes anything.",
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

async function managedProfile(
  profile: Omit<z.output<typeof residencyApplyProfileToolInput>, "managed">,
  signal: AbortSignal,
): Promise<
  | ResidencyApplyProfileResult
  | (Omit<ResidencyApplyProfileResult, "outcome"> & { outcome: "unknown" })
> {
  try {
    const client = getAuthenticatedAgentClientByName(profile.node);
    return await client.residencyApplyManagedProfile.mutate(
      { ...profile, version: MANAGED_PROFILE_PROTOCOL_VERSION },
      { signal },
    );
  } catch (error) {
    const unsupported = missingProcedure(error);
    const unknown = !unsupported && !profile.dryRun;
    return {
      ok: false,
      outcome: unknown ? "unknown" : "refused",
      dryRun: profile.dryRun,
      node: profile.node,
      to: profile.to,
      from: profile.from ?? null,
      steps: [],
      deferred: [],
      refusal: unsupported
        ? {
            reason: "ManagedProfileUnavailable",
            detail: "the agent does not support managed profile version 1",
          }
        : {
            reason: unknown ? "ProfileOutcomeUnknown" : "ProfileTransportError",
            detail: "the managed profile result could not be retrieved",
          },
    };
  }
}

function registerResidencyApplyProfile(server: McpServer): void {
  server.registerTool(
    RESIDENCY_APPLY_PROFILE_TOOL,
    {
      title: "Apply a residency profile switch (dry-run by default)",
      description:
        "Preview a profile switch without mutating state. Use managed: true for the named authenticated owner. Execution stops victims, starts replacements and records an operation. Set dryRun: false and confirm: true to execute.",
      inputSchema: residencyApplyProfileToolInput,
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({ managed, ...input }, { signal }) => {
      const { dryRun, confirm } = input;
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
      const result = managed
        ? await managedProfile(input, signal)
        : await router.createCaller({}).residencyApplyProfile(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: RESIDENCY_APPLY_PROFILE_TOOL,
        input: { ...input, managed },
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

function registerResidencyReleaseSession(server: McpServer): void {
  server.registerTool(
    "llamactl.residency.releaseSession",
    {
      title: "Release one residency session binding",
      description:
        "Mirrors the remote residencyReleaseSession mutation (#520). Drops one session binding by id and nothing else: it never drains, revokes leases or stops a workload, so the DF-05 leases of in-flight requests stay held and LeasesActive still fences their stop. An idle binding (refs 0) is dropped; a binding with in-flight requests refuses SessionInFlight unless `force: true`. Other refusals: Unavailable (no session registry), SessionNotFound, SessionsUnknown. It is process-local: it reaches only the session registry installed in this MCP server process. `confirm: true` is required.",
      inputSchema: {
        sessionId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .describe("Session id to release (same bounds as the session header)."),
        force: z
          .boolean()
          .default(false)
          .describe("Drop the binding even with in-flight requests; their leases stay held."),
        confirm: z.boolean().default(false).describe("Must be true to release the binding."),
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async (input) => {
      const { sessionId, force, confirm } = input;
      if (!confirm) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "refusing without confirm: true; releasing a session lets its workload be unloaded",
            },
          ],
        };
      }
      const caller = router.createCaller({});
      const result = await caller.residencyReleaseSession({ sessionId, force, confirm: true });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.residency.releaseSession",
        input: { sessionId, force },
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
