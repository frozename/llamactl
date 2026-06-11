import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

export function registerCompositeTools(server: McpServer): void {
  server.registerTool(
    "llamactl.composite.apply",
    {
      title: "Apply a Composite manifest",
      description:
        "Apply a multi-component Composite manifest (services + workloads + ragNodes + gateways, ordered by an explicit dependency DAG). `dryRun: true` returns the topological order + implied edges without spawning anything. Wet-run drives the Docker runtime backend, rolls back on failure when `onFailure: rollback`.",
      inputSchema: {
        manifestYaml: z.string().min(1).describe("Raw YAML body of the Composite manifest."),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.compositeApply(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.composite.apply",
        input: { dryRun: input.dryRun, manifestBytes: input.manifestYaml.length },
        dryRun: input.dryRun,
        result:
          "dryRun" in result && result.dryRun
            ? { dryRun: true, orderCount: result.order.length }
            : { ok: (result as { ok: boolean }).ok },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.composite.destroy",
    {
      title: "Destroy a Composite",
      description:
        "Tear down every component of a previously-applied Composite, walking the dependency DAG in reverse. `dryRun: true` returns the teardown order without touching the runtime. Wet-run removes containers + rag-node kubeconfig entries and deletes the on-disk composite YAML. Destructive. Pass `purgeVolumes: true` for a full reset that also reaps anonymous docker volumes — storage is preserved by default.",
      inputSchema: {
        name: z.string().min(1).describe("metadata.name of the composite."),
        dryRun: z.boolean().default(false),
        purgeVolumes: z
          .boolean()
          .default(false)
          .describe(
            "Also remove anonymous docker volumes tied to the containers (default: preserve storage). Named volumes + bind mounts are not touched.",
          ),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.compositeDestroy(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.composite.destroy",
        input,
        dryRun: input.dryRun,
        result:
          "dryRun" in result && result.dryRun
            ? {
                dryRun: true,
                wouldRemoveCount: result.wouldRemove.length,
                wouldPurgeVolumes: result.wouldPurgeVolumes,
              }
            : {
                ok: (result as { ok: boolean }).ok,
                purgedVolumes: (result as { purgedVolumes?: boolean }).purgedVolumes ?? false,
              },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.composite.list",
    {
      title: "List Composites",
      description:
        "Enumerate every Composite manifest stored under ~/.llamactl/composites/. Read-only.",
      inputSchema: {},
    },
    async () => {
      const caller = router.createCaller({});
      const result = await caller.compositeList();
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.composite.list",
        input: {},
        dryRun: false,
        result: { count: result.length },
      });
      return toTextContent({ count: result.length, composites: result });
    },
  );

  server.registerTool(
    "llamactl.composite.get",
    {
      title: "Get one Composite",
      description:
        "Return a single Composite manifest (spec + last-known status) by name, or null when absent. Read-only.",
      inputSchema: {
        name: z.string().min(1).describe("metadata.name of the composite."),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.compositeGet(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.composite.get",
        input,
        dryRun: false,
        result: { found: result !== null },
      });
      return toTextContent(result);
    },
  );
}
