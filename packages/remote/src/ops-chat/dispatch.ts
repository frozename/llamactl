import type { router as AppRouterType } from "../router.js";

import { appendOpsChatAudit, hashArguments } from "./audit.js";

/**
 * N.4 — Ops Chat tool dispatch. Maps an MCP-style tool name +
 * arguments to the equivalent tRPC procedure on the llamactl router
 * so the renderer's Ops Chat module can execute tool calls without
 * speaking MCP or booting the @llamactl/mcp server in-process.
 *
 * The mapping is intentionally flat and mechanical. Adding or
 * removing an MCP tool means updating the `KNOWN_OPS_CHAT_TOOLS` list
 * and the switch. The `opsChatToolCoverage` test asserts every tool
 * in `@llamactl/mcp`'s registry has a handler here, so drift fails
 * CI rather than silently 404ing operators.
 */

export type Caller = ReturnType<typeof AppRouterType.createCaller>;

/**
 * Tools this dispatch knows how to run. Keep alphabetized so the
 * coverage test output is readable.
 */
export const KNOWN_OPS_CHAT_TOOLS = [
  "llamactl.bench.compare",
  "llamactl.bench.history",
  "llamactl.catalog.list",
  "llamactl.catalog.promote",
  "llamactl.catalog.promoteDelete",
  "llamactl.composite.apply",
  "llamactl.composite.destroy",
  "llamactl.composite.get",
  "llamactl.composite.list",
  "llamactl.cost.snapshot",
  "llamactl.env",
  "llamactl.node.add",
  "llamactl.node.budget",
  "llamactl.node.facts",
  "llamactl.node.ls",
  "llamactl.node.remove",
  "llamactl.operator.plan",
  "llamactl.project.apply",
  "llamactl.project.get",
  "llamactl.project.index",
  "llamactl.project.list",
  "llamactl.project.remove",
  "llamactl.project.resolveRouting",
  "llamactl.promotions.list",
  "llamactl.rag.bench",
  "llamactl.rag.delete",
  "llamactl.rag.listCollections",
  "llamactl.rag.pipeline.apply",
  "llamactl.rag.pipeline.draft",
  "llamactl.rag.pipeline.get",
  "llamactl.rag.pipeline.list",
  "llamactl.rag.pipeline.remove",
  "llamactl.rag.pipeline.run",
  "llamactl.rag.search",
  "llamactl.rag.store",
  "llamactl.server.status",
  "llamactl.workload.apply",
  "llamactl.workload.delete",
  "llamactl.workload.list",
] as const;

export type OpsChatToolName = (typeof KNOWN_OPS_CHAT_TOOLS)[number];

/**
 * Tier classification drives the UI's approval flow. `read` tools can
 * auto-run; `mutation-dry-run-safe` shows a dry-run preview card before
 * the wet-run button unlocks; `mutation-destructive` additionally asks
 * the operator to confirm by typing the tool name.
 */
export type ToolTier = "read" | "mutation-dry-run-safe" | "mutation-destructive";

const DESTRUCTIVE_TOOL_NAMES = [
  "llamactl.node.remove",
  "llamactl.workload.delete",
  "llamactl.catalog.promoteDelete",
  "llamactl.rag.delete",
  "llamactl.rag.pipeline.remove",
  "llamactl.composite.destroy",
  "llamactl.project.remove",
] as const satisfies readonly OpsChatToolName[];

type DestructiveToolName = (typeof DESTRUCTIVE_TOOL_NAMES)[number];

const DESTRUCTIVE_TOOLS = new Set<OpsChatToolName>(DESTRUCTIVE_TOOL_NAMES);

const MUTATION_DRY_RUN_TOOL_NAMES = [
  "llamactl.node.add",
  "llamactl.catalog.promote",
  "llamactl.rag.store",
  "llamactl.rag.pipeline.apply",
  "llamactl.rag.pipeline.run",
  "llamactl.composite.apply",
  "llamactl.project.apply",
  "llamactl.project.index",
  "llamactl.workload.apply",
] as const satisfies readonly OpsChatToolName[];

type MutationDryRunToolName = (typeof MUTATION_DRY_RUN_TOOL_NAMES)[number];

const MUTATION_DRY_RUN_TOOLS = new Set<OpsChatToolName>(MUTATION_DRY_RUN_TOOL_NAMES);

type ReadToolName = Exclude<OpsChatToolName, DestructiveToolName | MutationDryRunToolName>;

function isDestructiveTool(name: OpsChatToolName): name is DestructiveToolName {
  return DESTRUCTIVE_TOOLS.has(name);
}

function isMutationDryRunTool(name: OpsChatToolName): name is MutationDryRunToolName {
  return MUTATION_DRY_RUN_TOOLS.has(name);
}

export function toolTier(name: OpsChatToolName): ToolTier {
  if (isDestructiveTool(name)) return "mutation-destructive";
  if (isMutationDryRunTool(name)) return "mutation-dry-run-safe";
  return "read";
}

export interface OpsChatDispatchInput {
  name: string;
  arguments: Record<string, unknown>;
  dryRun: boolean;
}

export interface OpsChatDispatchResult {
  ok: boolean;
  name: string;
  tier: ToolTier | "unknown";
  durationMs: number;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

function isKnown(name: string): name is OpsChatToolName {
  return (KNOWN_OPS_CHAT_TOOLS as readonly string[]).includes(name);
}

/**
 * Resolve a string to the `scope` enum catalog.list accepts. Anything
 * unexpected falls back to `'all'` — the operator's tool call might
 * have sent a loose string and catalog.list rejects anything else.
 */
function coerceScope(v: unknown): "all" | "builtin" | "custom" {
  if (v === "builtin" || v === "custom") return v;
  return "all";
}

/**
 * Narrow `{profile, preset, rel}` shape used by the catalog.promote
 * family. Throws on missing keys so the dispatch surfaces a clean
 * validation error rather than a cryptic Zod message.
 */
function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required argument: ${key}`);
  }
  return v;
}

function buildBenchHistoryInput(args: Record<string, unknown>): { rel?: string; limit?: number } {
  const opts: { rel?: string; limit?: number } = {};
  if (typeof args.rel === "string") opts.rel = args.rel;
  if (typeof args.limit === "number") opts.limit = args.limit;
  return opts;
}

function buildRagSearchInput(args: Record<string, unknown>): Parameters<Caller["ragSearch"]>[0] {
  const payload: Parameters<Caller["ragSearch"]>[0] = {
    node: requireString(args, "node"),
    query: requireString(args, "query"),
    topK: typeof args.topK === "number" ? args.topK : 10,
  };
  if (args.filter && typeof args.filter === "object") {
    payload.filter = args.filter as Record<string, unknown>;
  }
  if (typeof args.collection === "string") {
    payload.collection = args.collection;
  }
  return payload;
}

function buildRagPipelineDraftInput(
  args: Record<string, unknown>,
): Parameters<Caller["ragPipelineDraft"]>[0] {
  const payload: Parameters<Caller["ragPipelineDraft"]>[0] = {
    description: typeof args.description === "string" ? args.description : "",
  };
  if (Array.isArray(args.availableRagNodes)) {
    payload.availableRagNodes = args.availableRagNodes as string[];
  }
  if (typeof args.defaultRagNode === "string") {
    payload.defaultRagNode = args.defaultRagNode;
  }
  if (typeof args.nameOverride === "string") {
    payload.nameOverride = args.nameOverride;
  }
  return payload;
}

async function executeReadTool(
  caller: Caller,
  name: ReadToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "llamactl.env":
      return await caller.env();
    case "llamactl.server.status":
      return await caller.serverStatus({ workload: requireString(args, "workload") });
    case "llamactl.node.ls":
      return await caller.nodeList();
    case "llamactl.node.facts":
      return await caller.nodeFacts();
    case "llamactl.node.budget":
      return await caller.nodeBudget({ node: requireString(args, "node") });
    case "llamactl.promotions.list":
      return await caller.promotions();
    case "llamactl.workload.list":
      return await caller.workloadList();
    case "llamactl.catalog.list":
      return await caller.catalogList(coerceScope(args.scope));
    case "llamactl.bench.compare":
      return await caller.benchCompare({
        classFilter:
          (args.classFilter as
            | "all"
            | "reasoning"
            | "multimodal"
            | "general"
            | "custom"
            | undefined) ?? "all",
        scopeFilter: (args.scopeFilter as string | undefined) ?? "all",
      });
    case "llamactl.bench.history":
      return await caller.benchHistory(buildBenchHistoryInput(args));
    case "llamactl.cost.snapshot":
      return await caller.costSnapshot({
        days: typeof args.days === "number" ? args.days : 7,
      });
    case "llamactl.operator.plan":
      // Surface the router's operatorPlan verbatim; the UI passes
      // goal/context/history unchanged. Callers that skip these
      // still get a useful error from Zod.
      return await caller.operatorPlan(args as unknown as Parameters<Caller["operatorPlan"]>[0]);
    case "llamactl.rag.search":
      return await caller.ragSearch(buildRagSearchInput(args));
    case "llamactl.rag.listCollections":
      return await caller.ragListCollections({
        node: requireString(args, "node"),
      });
    case "llamactl.composite.list":
      return await caller.compositeList();
    case "llamactl.composite.get":
      return await caller.compositeGet({
        name: requireString(args, "name"),
      });
    case "llamactl.rag.bench":
      // Read-only — bench only calls ragSearch under the hood,
      // doesn't write anywhere. No dry-run branch makes sense
      // (the whole thing is effectively a dry run against the
      // collection).
      return await caller.ragBench({
        manifestYaml: requireString(args, "manifestYaml"),
      });
    case "llamactl.rag.pipeline.list":
      return await caller.ragPipelineList();
    case "llamactl.rag.pipeline.get":
      return await caller.ragPipelineGet({
        name: requireString(args, "name"),
      });
    case "llamactl.rag.pipeline.draft":
      return await caller.ragPipelineDraft(buildRagPipelineDraftInput(args));
    case "llamactl.project.list":
      return await caller.projectList();
    case "llamactl.project.get":
      return await caller.projectGet({
        name: requireString(args, "name"),
      });
    case "llamactl.project.resolveRouting":
      return await caller.projectResolveRouting({
        project: requireString(args, "project"),
        taskKind: requireString(args, "taskKind"),
      });
  }
}

/**
 * Shared dry-run gate: surface the intended payload instead of
 * mutating when `dryRun` is set; otherwise run the real call.
 */
async function dryRunOr(
  dryRun: boolean,
  preview: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (dryRun) return preview;
  return await run();
}

async function executeMutationDryRunTool(
  caller: Caller,
  name: MutationDryRunToolName,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<unknown> {
  switch (name) {
    case "llamactl.catalog.promote": {
      const payload = {
        profile: requireString(args, "profile") as "mac-mini-16g" | "balanced" | "macbook-pro-48g",
        preset: requireString(args, "preset") as "best" | "vision" | "balanced" | "fast",
        rel: requireString(args, "rel"),
      };
      // The underlying procedure doesn't accept a dryRun flag — it
      // just writes the TSV. We surface the intended payload when
      // dryRun is requested instead of mutating disk.
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldWrite: payload },
        async (): Promise<unknown> => await caller.promote(payload),
      );
    }
    case "llamactl.node.add":
      // No wet-run probe so dry-run just echoes the intended call.
      return await dryRunOr(
        dryRun,
        {
          dryRun: true,
          wouldRegister: {
            name: requireString(args, "name"),
            bootstrapLength: typeof args.bootstrap === "string" ? args.bootstrap.length : 0,
          },
        },
        async (): Promise<unknown> =>
          await caller.nodeAdd({
            name: requireString(args, "name"),
            bootstrap: requireString(args, "bootstrap"),
            ...(typeof args.force === "boolean" ? { force: args.force } : {}),
          }),
      );
    case "llamactl.rag.store": {
      const node = requireString(args, "node");
      const documents = Array.isArray(args.documents)
        ? (args.documents as {
            id: string;
            content: string;
            metadata?: Record<string, unknown>;
            vector?: number[];
          }[])
        : [];
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldStore: { node, count: documents.length } },
        async (): Promise<unknown> => {
          const payload: Parameters<Caller["ragStore"]>[0] = {
            node,
            documents: documents,
          };
          if (typeof args.collection === "string") {
            payload.collection = args.collection;
          }
          return await caller.ragStore(payload);
        },
      );
    }
    case "llamactl.composite.apply":
      // The composite procedure supports dry-run natively (it
      // returns `{ dryRun: true, manifest, order, impliedEdges }`)
      // so we just forward the flag — no synthesized preview at
      // this layer.
      return await caller.compositeApply({
        manifestYaml: requireString(args, "manifestYaml"),
        dryRun,
      });
    case "llamactl.rag.pipeline.apply": {
      // Apply is idempotent — writing the spec.yaml is safe. Dry
      // run only parses + validates without touching disk.
      const manifestYaml = requireString(args, "manifestYaml");
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldApply: { bytes: manifestYaml.length } },
        async (): Promise<unknown> => await caller.ragPipelineApply({ manifestYaml }),
      );
    }
    case "llamactl.rag.pipeline.run":
      // The underlying procedure supports dry-run natively — it
      // walks fetch + transform + journal without calling
      // `adapter.store`. Forward the flag verbatim.
      return await caller.ragPipelineRun({
        name: requireString(args, "name"),
        dryRun,
      });
    case "llamactl.project.apply": {
      // projectApply is idempotent — writing projects.yaml is safe.
      // Dry run only parses + validates without touching disk.
      const manifestYaml = requireString(args, "manifestYaml");
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldApply: { bytes: manifestYaml.length } },
        async (): Promise<unknown> => await caller.projectApply({ manifestYaml }),
      );
    }
    case "llamactl.project.index": {
      // Generates + applies the auto-wired RagPipeline manifest.
      // Dry run surfaces the intended pipeline name without
      // invoking ragPipelineApply.
      const name = requireString(args, "name");
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldIndex: { project: name, pipelineName: `project-${name}` } },
        async (): Promise<unknown> => await caller.projectIndex({ name }),
      );
    }
    case "llamactl.workload.apply": {
      // workloadApply validates + applies + persists; it has no native
      // dry-run, so the preview just reports the manifest byte length.
      const yaml = requireString(args, "yaml");
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldApply: { bytes: yaml.length } },
        async (): Promise<unknown> => await caller.workloadApply({ yaml }),
      );
    }
  }
}

async function executeMutationDestructiveTool(
  caller: Caller,
  name: DestructiveToolName,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<unknown> {
  switch (name) {
    case "llamactl.catalog.promoteDelete": {
      const payload = {
        profile: requireString(args, "profile") as "mac-mini-16g" | "balanced" | "macbook-pro-48g",
        preset: requireString(args, "preset") as "best" | "vision" | "balanced" | "fast",
      };
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldRemove: payload },
        async (): Promise<unknown> => await caller.promoteDelete(payload),
      );
    }
    case "llamactl.workload.delete": {
      const payload = {
        name: requireString(args, "name"),
        keepRunning: typeof args.keepRunning === "boolean" ? args.keepRunning : false,
      };
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldDelete: payload },
        async (): Promise<unknown> => await caller.workloadDelete(payload),
      );
    }
    case "llamactl.node.remove": {
      const payload = { name: requireString(args, "name") };
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldRemove: payload },
        async (): Promise<unknown> => await caller.nodeRemove(payload),
      );
    }
    case "llamactl.rag.delete": {
      const node = requireString(args, "node");
      const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldDelete: { node, ids } },
        async (): Promise<unknown> => {
          const payload: Parameters<Caller["ragDelete"]>[0] = { node, ids };
          if (typeof args.collection === "string") {
            payload.collection = args.collection;
          }
          return await caller.ragDelete(payload);
        },
      );
    }
    case "llamactl.composite.destroy":
      // Like compositeApply, the procedure handles dry-run
      // natively — forward the flag. `purgeVolumes` is the
      // operator-initiated opt-in for wiping storage alongside
      // the container; default false so re-apply is data-safe.
      return await caller.compositeDestroy({
        name: requireString(args, "name"),
        dryRun,
        purgeVolumes: (args.purgeVolumes as boolean | undefined) ?? false,
      });
    case "llamactl.rag.pipeline.remove": {
      const payload = { name: requireString(args, "name") };
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldRemove: payload },
        async (): Promise<unknown> => await caller.ragPipelineRemove(payload),
      );
    }
    case "llamactl.project.remove": {
      // Matches ragPipelineRemove semantics — never touches the
      // already-indexed data in the rag node. Re-indexing requires
      // `project add` + `project index` again.
      const payload = { name: requireString(args, "name") };
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldRemove: payload },
        async (): Promise<unknown> => await caller.projectRemove(payload),
      );
    }
  }
}

async function executeToolCall(
  caller: Caller,
  name: OpsChatToolName,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<unknown> {
  if (isDestructiveTool(name)) {
    return await executeMutationDestructiveTool(caller, name, args, dryRun);
  }
  if (isMutationDryRunTool(name)) {
    return await executeMutationDryRunTool(caller, name, args, dryRun);
  }
  return await executeReadTool(caller, name, args);
}

/**
 * Dispatch a single tool call. Wrapping the per-tier switches in their
 * own functions keeps router.ts readable and gives tests a pure entry
 * point that doesn't have to speak tRPC's mutation/query envelope.
 */
export async function dispatchOpsChatTool(
  caller: Caller,
  input: OpsChatDispatchInput,
): Promise<OpsChatDispatchResult> {
  const startedAt = Date.now();
  const tier: ToolTier | "unknown" = isKnown(input.name) ? toolTier(input.name) : "unknown";

  try {
    if (!isKnown(input.name)) {
      return {
        ok: false,
        name: input.name,
        tier,
        durationMs: Date.now() - startedAt,
        error: {
          code: "unknown_tool",
          message: `ops-chat dispatch has no handler for '${input.name}'`,
        },
      };
    }

    const result = await executeToolCall(caller, input.name, input.arguments, input.dryRun);

    return {
      ok: true,
      name: input.name,
      tier,
      durationMs: Date.now() - startedAt,
      result,
    };
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "dispatch_error";
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      name: input.name,
      tier,
      durationMs: Date.now() - startedAt,
      error: {
        code,
        message,
      },
    };
  }
}

export function auditOpsChatToolRun(args: {
  tool: string;
  arguments: unknown;
  dryRun: boolean;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  sessionId?: string;
}): void {
  appendOpsChatAudit({
    ts: new Date().toISOString(),
    tool: args.tool,
    dryRun: args.dryRun,
    argumentsHash: hashArguments(args.arguments),
    ok: args.ok,
    durationMs: args.durationMs,
    errorCode: args.errorCode,
    errorMessage: args.errorMessage,
    sessionId: args.sessionId,
  });
}
