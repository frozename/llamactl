import type { SafetyTier } from "@llamactl/core";

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
 * Tier classification drives the UI's approval flow. `read` tools can
 * auto-run; `mutation-dry-run-safe` shows a dry-run preview card before
 * the wet-run button unlocks; `mutation-destructive` additionally asks
 * the operator to confirm by typing the tool name.
 */
export type ToolTier = SafetyTier;

export type Surface = "mcp" | "ops-chat";

const OPS_CHAT_AND_MCP_SURFACES = ["mcp", "ops-chat"] as const satisfies readonly Surface[];

/**
 * Capability registry for the Ops Chat surface: one typed `(name, tier,
 * surfaces)` list that the known-names list, the `OpsChatToolName` union,
 * and the `toolTier`/`toolSurfaces` classifiers are all derived from.
 * Co-locating each tool's approval tier and advertised surfaces with its
 * name gives a single place to add, re-tier, or expose a tool, replacing
 * parallel lists that previously had to be hand-kept in sync — the seed
 * of the cross-surface capability registry (audit Move #11). Keep
 * alphabetized so the coverage test output stays readable.
 */
export const OPS_CHAT_TOOLS = [
  { name: "llamactl.bench.compare", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.bench.history", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.catalog.list", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.catalog.promote",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.catalog.promoteDelete",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.composite.apply",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.composite.destroy",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.composite.get", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.composite.list", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.cost.snapshot", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.env", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.node.add",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.node.budget", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.node.facts", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.node.ls", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.node.remove",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.operator.plan", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.project.apply",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.project.get", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.project.index",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.project.list", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.project.remove",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.project.resolveRouting",
    tier: "read",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.promotions.list", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.rag.bench", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.rag.delete",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.rag.listCollections", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.rag.pipeline.apply",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.rag.pipeline.draft", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.rag.pipeline.get", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  { name: "llamactl.rag.pipeline.list", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.rag.pipeline.remove",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.rag.pipeline.run",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.rag.search", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.rag.store",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.reconciler.kick",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.server.status", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
  {
    name: "llamactl.server.stop",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.workload.apply",
    tier: "mutation-dry-run-safe",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  {
    name: "llamactl.workload.delete",
    tier: "mutation-destructive",
    surfaces: OPS_CHAT_AND_MCP_SURFACES,
  },
  { name: "llamactl.workload.list", tier: "read", surfaces: OPS_CHAT_AND_MCP_SURFACES },
] as const satisfies readonly { name: string; tier: ToolTier; surfaces: readonly Surface[] }[];

export type OpsChatToolName = (typeof OPS_CHAT_TOOLS)[number]["name"];

/** Names this dispatch knows how to run (derived from the registry). */
export const KNOWN_OPS_CHAT_TOOLS: readonly OpsChatToolName[] = OPS_CHAT_TOOLS.map((t) => t.name);

const TIER_BY_NAME = new Map<OpsChatToolName, ToolTier>(
  OPS_CHAT_TOOLS.map((t): [OpsChatToolName, ToolTier] => [t.name, t.tier]),
);

const SURFACES_BY_NAME = new Map<OpsChatToolName, readonly Surface[]>(
  OPS_CHAT_TOOLS.map((t): [OpsChatToolName, readonly Surface[]] => [t.name, t.surfaces]),
);

export function toolTier(name: OpsChatToolName): ToolTier {
  return TIER_BY_NAME.get(name) ?? "read";
}

export function toolSurfaces(name: OpsChatToolName): readonly Surface[] {
  return SURFACES_BY_NAME.get(name) ?? OPS_CHAT_AND_MCP_SURFACES;
}

/** Tool names of a given tier, derived from the registry — used to type
 *  the dispatch handler groups so each switch arm sees only its tier. */
type ToolNameOfTier<T extends ToolTier> = Extract<
  (typeof OPS_CHAT_TOOLS)[number],
  { tier: T }
>["name"];
type ReadToolName = ToolNameOfTier<"read">;
type MutationDryRunToolName = ToolNameOfTier<"mutation-dry-run-safe">;
type DestructiveToolName = ToolNameOfTier<"mutation-destructive">;

function isDestructiveTool(name: OpsChatToolName): name is DestructiveToolName {
  return TIER_BY_NAME.get(name) === "mutation-destructive";
}

function isMutationDryRunTool(name: OpsChatToolName): name is MutationDryRunToolName {
  return TIER_BY_NAME.get(name) === "mutation-dry-run-safe";
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

async function runServerStopDryRun(
  caller: Caller,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<unknown> {
  const workload = requireString(args, "workload");
  const graceSeconds = typeof args.graceSeconds === "number" ? args.graceSeconds : undefined;
  return await dryRunOr(
    dryRun,
    { dryRun: true, wouldStop: { workload, graceSeconds: graceSeconds ?? null } },
    async (): Promise<unknown> =>
      await caller.serverStop(
        graceSeconds === undefined ? { workload } : { workload, graceSeconds },
      ),
  );
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
    case "llamactl.reconciler.kick":
      return await dryRunOr(
        dryRun,
        { dryRun: true, wouldReconcile: true },
        async (): Promise<unknown> => await caller.reconcilerKick(),
      );
    case "llamactl.server.stop":
      return await runServerStopDryRun(caller, args, dryRun);
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
