import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

/**
 * Native MCP surface for projects. The six project procedures already
 * existed on tRPC, in the Electron Projects module, and in the ops-chat
 * dispatch table, but were never registered on the MCP server — so an
 * external MCP client (or an agent) could not manage the project/routing
 * abstraction at all. Tiers mirror the ops-chat dispatch classification:
 * list/get/resolveRouting are read, apply/index are dry-run-safe
 * mutations, remove is destructive.
 */
export function registerProjectTools(server: McpServer): void {
  registerProjectReads(server);
  registerProjectApply(server);
  registerProjectIndex(server);
  registerProjectRemove(server);
}

function registerProjectReads(server: McpServer): void {
  server.registerTool(
    "llamactl.project.list",
    {
      title: "List projects",
      description:
        "Enumerate every registered project (filesystem path + optional RAG target + per-task-kind routing policy + budgets). Read-only.",
      inputSchema: {},
    },
    async () => {
      const caller = router.createCaller({});
      const result = await caller.projectList();
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.project.list",
        input: {},
        dryRun: false,
        result: { count: result.projects.length },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.project.get",
    {
      title: "Get one project",
      description:
        "Return a single project by name (spec + routing policy), or null when absent. Read-only.",
      inputSchema: {
        name: z.string().min(1).describe("metadata.name of the project."),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.projectGet(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.project.get",
        input,
        dryRun: false,
        result: { ok: result.ok },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.project.resolveRouting",
    {
      title: "Resolve a project's routing target",
      description:
        "Resolve `project:<name>/<taskKind>` to the concrete node + lane the routing policy selects, journaling the decision. Read-only.",
      inputSchema: {
        project: z.string().min(1).describe("Project name."),
        taskKind: z.string().min(1).describe("Task kind to resolve (e.g. chat, code, embed)."),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.projectResolveRouting(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.project.resolveRouting",
        input,
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}

function registerProjectApply(server: McpServer): void {
  server.registerTool(
    "llamactl.project.apply",
    {
      title: "Apply a project manifest",
      description:
        "Apply (upsert) a Project manifest (YAML) — filesystem path, optional RAG target, per-task-kind routing policy + budgets. Idempotent. `dryRun: true` reports the manifest byte length without writing projects.yaml.",
      inputSchema: {
        manifestYaml: z.string().min(1).describe("Raw YAML body of the Project manifest."),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { manifestYaml, dryRun } = input;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.project.apply",
          input: { dryRun, bytes: manifestYaml.length },
          dryRun: true,
        });
        return toTextContent({ dryRun: true, wouldApply: { bytes: manifestYaml.length } });
      }
      const caller = router.createCaller({});
      const result = await caller.projectApply({ manifestYaml });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.project.apply",
        input: { dryRun, bytes: manifestYaml.length },
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}

function registerProjectIndex(server: McpServer): void {
  server.registerTool(
    "llamactl.project.index",
    {
      title: "Index a project's documents",
      description:
        "Generate + apply the auto-wired RagPipeline (`project-<name>`) that ingests the project's docs into its RAG target. `dryRun: true` reports the pipeline name without invoking the ingest.",
      inputSchema: {
        name: z.string().min(1).describe("Project name."),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { name, dryRun } = input;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.project.index",
          input: { dryRun, name },
          dryRun: true,
        });
        return toTextContent({
          dryRun: true,
          wouldIndex: { project: name, pipelineName: `project-${name}` },
        });
      }
      const caller = router.createCaller({});
      const result = await caller.projectIndex({ name });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.project.index",
        input: { dryRun, name },
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}

function registerProjectRemove(server: McpServer): void {
  server.registerTool(
    "llamactl.project.remove",
    {
      title: "Remove a project",
      description:
        "Delete a project registration. Does NOT delete already-indexed data in the RAG node (re-indexing requires project apply + index again). `dryRun: true` previews without writing. Destructive.",
      inputSchema: {
        name: z.string().min(1).describe("Project name."),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const { name, dryRun } = input;
      if (dryRun) {
        appendAudit({
          server: SERVER_SLUG,
          tool: "llamactl.project.remove",
          input: { dryRun, name },
          dryRun: true,
        });
        return toTextContent({ dryRun: true, wouldRemove: { name } });
      }
      const caller = router.createCaller({});
      const result = await caller.projectRemove({ name });
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.project.remove",
        input: { dryRun, name },
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}
