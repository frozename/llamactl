import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { router } from "@llamactl/remote";
import { appendAudit, toTextContent } from "@nova/mcp-shared";
import { z } from "zod";

import { SERVER_SLUG } from "./shared.js";

export function registerRagTools(server: McpServer): void {
  registerRagCoreTools(server);
  registerRagPipelineCoreTools(server);
  registerRagBench(server);
  registerRagPipelineDraft(server);
}

function registerRagCoreTools(server: McpServer): void {
  server.registerTool(
    "llamactl.rag.search",
    {
      title: "Search a RAG node",
      description:
        "Run a vector search against a configured RAG node. Returns up to topK results with normalized scores (0..1, higher = more relevant). Read-only.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the RAG node in kubeconfig."),
        query: z.string().min(1),
        topK: z.number().int().positive().max(100).default(10),
        filter: z.record(z.string(), z.unknown()).optional(),
        collection: z.string().optional(),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragSearch(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.search",
        input,
        dryRun: false,
        result: { collection: result.collection, count: result.results.length },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.store",
    {
      title: "Store documents in a RAG node",
      description:
        "Upsert one or more documents into a configured RAG node. Backends embed internally (Chroma) or require caller-supplied vectors (pgvector).",
      inputSchema: {
        node: z.string().min(1).describe("Name of the RAG node in kubeconfig."),
        documents: z
          .array(
            z.object({
              id: z.string().min(1),
              content: z.string(),
              metadata: z.record(z.string(), z.unknown()).optional(),
              vector: z.array(z.number()).optional(),
            }),
          )
          .min(1),
        collection: z.string().optional(),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragStore(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.store",
        input: { node: input.node, collection: input.collection, count: input.documents.length },
        dryRun: false,
        result: { collection: result.collection, ids: result.ids.length },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.delete",
    {
      title: "Delete documents from a RAG node",
      description:
        "Remove one or more documents (by id) from a configured RAG node. Destructive — verify the ids before calling.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the RAG node in kubeconfig."),
        ids: z.array(z.string().min(1)).min(1),
        collection: z.string().optional(),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragDelete(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.delete",
        input,
        dryRun: false,
        result: { collection: result.collection, deleted: result.deleted },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.listCollections",
    {
      title: "List collections on a RAG node",
      description:
        "Return every collection registered on a RAG node with (when the backend exposes them) counts + dimensions. Read-only.",
      inputSchema: {
        node: z.string().min(1).describe("Name of the RAG node in kubeconfig."),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragListCollections(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.listCollections",
        input,
        dryRun: false,
        result: { count: result.collections.length },
      });
      return toTextContent(result);
    },
  );
}

function registerRagPipelineCoreTools(server: McpServer): void {
  server.registerTool(
    "llamactl.rag.pipeline.apply",
    {
      title: "Apply a RagPipeline manifest",
      description:
        "Persist a RagPipeline manifest to disk under $DEV_STORAGE/rag-pipelines/<name>/spec.yaml. Does NOT execute — pair with llamactl.rag.pipeline.run. Input is the full YAML body (apiVersion: llamactl/v1, kind: RagPipeline).",
      inputSchema: {
        manifestYaml: z.string().min(1).describe("Raw YAML body of the RagPipeline manifest."),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragPipelineApply(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.pipeline.apply",
        input: { manifestBytes: input.manifestYaml.length },
        dryRun: false,
        result: { name: result.name, created: result.created },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.pipeline.run",
    {
      title: "Execute a RagPipeline",
      description:
        "Run an applied RagPipeline: fetch sources, chunk, embed, store into the destination rag node. `dryRun: true` walks fetch + chunk without calling adapter.store — useful for previewing ingestion.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
            message:
              "pipeline name must start with a letter or digit and contain only letters, digits, hyphens, and underscores",
          })
          .describe("metadata.name of the pipeline."),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragPipelineRun(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.pipeline.run",
        input,
        dryRun: input.dryRun,
        result: {
          total_docs: result.summary.total_docs,
          total_chunks: result.summary.total_chunks,
          errors: result.summary.errors,
        },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.pipeline.list",
    {
      title: "List RagPipelines",
      description:
        "Enumerate every applied RagPipeline with its manifest + last-run summary (when available). Read-only.",
      inputSchema: {},
    },
    async () => {
      const caller = router.createCaller({});
      const result = await caller.ragPipelineList();
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.pipeline.list",
        input: {},
        dryRun: false,
        result: { count: result.pipelines.length },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.pipeline.get",
    {
      title: "Get one RagPipeline manifest",
      description:
        "Return a single RagPipeline manifest by name. Throws NOT_FOUND when absent. Read-only.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
            message:
              "pipeline name must start with a letter or digit and contain only letters, digits, hyphens, and underscores",
          }),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragPipelineGet(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.pipeline.get",
        input,
        dryRun: false,
        result: { found: true },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    "llamactl.rag.pipeline.remove",
    {
      title: "Remove a RagPipeline",
      description:
        "Delete the pipeline spec + journal + state. Does not touch already-stored documents in the destination rag node.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
            message:
              "pipeline name must start with a letter or digit and contain only letters, digits, hyphens, and underscores",
          }),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragPipelineRemove(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.pipeline.remove",
        input,
        dryRun: false,
        result,
      });
      return toTextContent(result);
    },
  );
}

function registerRagBench(server: McpServer): void {
  server.registerTool(
    "llamactl.rag.bench",
    {
      title: "Run a RagBench quality gate",
      description:
        "Run an operator-supplied RagBench manifest (query set + expected hits) against a rag node and return a hit-rate + mean reciprocal rank report. Each query must set expected_doc_id or expected_substring (or both); a hit = any top-k result matches. No writes — the report is the whole product.",
      inputSchema: {
        manifestYaml: z.string().min(1),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragBench(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.bench",
        input,
        dryRun: false,
        result: {
          name: result.manifest.metadata.name,
          hitRate: result.hitRate,
          mrr: result.mrr,
          hits: result.hits,
          errors: result.errors,
        },
      });
      return toTextContent(result);
    },
  );
}

function registerRagPipelineDraft(server: McpServer): void {
  server.registerTool(
    "llamactl.rag.pipeline.draft",
    {
      title: "Draft a RagPipeline from a description",
      description:
        "Scaffold a schema-valid RagPipeline YAML from a natural-language description. Deterministic: extracts URLs / filesystem paths / schedule aliases / rag node hints and emits a manifest the operator can review before `rag pipeline apply`. Returns `{ yaml, manifest, warnings }`. Read-only (no disk writes).",
      inputSchema: {
        description: z.string().default(""),
        availableRagNodes: z.array(z.string()).optional(),
        defaultRagNode: z.string().optional(),
        nameOverride: z.string().optional(),
      },
    },
    async (input) => {
      const caller = router.createCaller({});
      const result = await caller.ragPipelineDraft(input);
      appendAudit({
        server: SERVER_SLUG,
        tool: "llamactl.rag.pipeline.draft",
        input,
        dryRun: false,
        result: { name: result.manifest.metadata.name, warnings: result.warnings.length },
      });
      return toTextContent(result);
    },
  );
}
