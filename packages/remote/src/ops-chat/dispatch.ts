import type { router as AppRouterType } from '../router.js';

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
  'llamactl.bench.compare',
  'llamactl.bench.history',
  'llamactl.catalog.list',
  'llamactl.catalog.promote',
  'llamactl.catalog.promoteDelete',
  'llamactl.composite.apply',
  'llamactl.composite.destroy',
  'llamactl.composite.get',
  'llamactl.composite.list',
  'llamactl.cost.snapshot',
  'llamactl.env',
  'llamactl.node.add',
  'llamactl.node.facts',
  'llamactl.node.ls',
  'llamactl.node.remove',
  'llamactl.operator.plan',
  'llamactl.promotions.list',
  'llamactl.rag.delete',
  'llamactl.rag.listCollections',
  'llamactl.rag.search',
  'llamactl.rag.store',
  'llamactl.server.status',
  'llamactl.workload.delete',
  'llamactl.workload.list',
] as const;

export type OpsChatToolName = (typeof KNOWN_OPS_CHAT_TOOLS)[number];

/**
 * Tier classification drives the UI's approval flow. `read` tools can
 * auto-run; `mutation-dry-run-safe` shows a dry-run preview card before
 * the wet-run button unlocks; `mutation-destructive` additionally asks
 * the operator to confirm by typing the tool name.
 */
export type ToolTier = 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';

export function toolTier(name: OpsChatToolName): ToolTier {
  switch (name) {
    case 'llamactl.node.remove':
    case 'llamactl.workload.delete':
    case 'llamactl.catalog.promoteDelete':
    case 'llamactl.rag.delete':
    case 'llamactl.composite.destroy':
      return 'mutation-destructive';
    case 'llamactl.node.add':
    case 'llamactl.catalog.promote':
    case 'llamactl.rag.store':
    case 'llamactl.composite.apply':
      return 'mutation-dry-run-safe';
    default:
      return 'read';
  }
}

export interface OpsChatDispatchInput {
  name: string;
  arguments: Record<string, unknown>;
  dryRun: boolean;
}

export interface OpsChatDispatchResult {
  ok: boolean;
  name: string;
  tier: ToolTier | 'unknown';
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
function coerceScope(v: unknown): 'all' | 'builtin' | 'custom' {
  if (v === 'builtin' || v === 'custom') return v;
  return 'all';
}

/**
 * Narrow `{profile, preset, rel}` shape used by the catalog.promote
 * family. Throws on missing keys so the dispatch surfaces a clean
 * validation error rather than a cryptic Zod message.
 */
function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required argument: ${key}`);
  }
  return v;
}

/**
 * Dispatch a single tool call. Wrapping the long switch in its own
 * function keeps router.ts readable and gives tests a pure entry
 * point that doesn't have to speak tRPC's mutation/query envelope.
 */
export async function dispatchOpsChatTool(
  caller: Caller,
  input: OpsChatDispatchInput,
): Promise<OpsChatDispatchResult> {
  const startedAt = Date.now();
  const tier: ToolTier | 'unknown' = isKnown(input.name)
    ? toolTier(input.name)
    : 'unknown';

  try {
    if (!isKnown(input.name)) {
      return {
        ok: false,
        name: input.name,
        tier,
        durationMs: Date.now() - startedAt,
        error: {
          code: 'unknown_tool',
          message: `ops-chat dispatch has no handler for '${input.name}'`,
        },
      };
    }

    const args = input.arguments;
    let result: unknown;

    switch (input.name) {
      /* ---------------- reads ---------------- */
      case 'llamactl.env':
        result = await caller.env();
        break;
      case 'llamactl.server.status':
        result = await caller.serverStatus();
        break;
      case 'llamactl.node.ls':
        result = await caller.nodeList();
        break;
      case 'llamactl.node.facts':
        result = await caller.nodeFacts();
        break;
      case 'llamactl.promotions.list':
        result = await caller.promotions();
        break;
      case 'llamactl.workload.list':
        result = await caller.workloadList();
        break;
      case 'llamactl.catalog.list':
        result = await caller.catalogList(coerceScope(args.scope));
        break;
      case 'llamactl.bench.compare':
        result = await caller.benchCompare({
          classFilter:
            (args.classFilter as
              | 'all'
              | 'reasoning'
              | 'multimodal'
              | 'general'
              | 'custom'
              | undefined) ?? 'all',
          scopeFilter: (args.scopeFilter as string | undefined) ?? 'all',
        });
        break;
      case 'llamactl.bench.history': {
        const opts: { rel?: string; limit?: number } = {};
        if (typeof args.rel === 'string') opts.rel = args.rel;
        if (typeof args.limit === 'number') opts.limit = args.limit;
        result = await caller.benchHistory(opts);
        break;
      }
      case 'llamactl.cost.snapshot':
        result = await caller.costSnapshot({
          days: typeof args.days === 'number' ? args.days : 7,
        });
        break;
      case 'llamactl.operator.plan':
        // Surface the router's operatorPlan verbatim; the UI passes
        // goal/context/history unchanged. Callers that skip these
        // still get a useful error from Zod.
        result = await caller.operatorPlan(
          args as unknown as Parameters<Caller['operatorPlan']>[0],
        );
        break;
      case 'llamactl.rag.search': {
        const payload: Parameters<Caller['ragSearch']>[0] = {
          node: requireString(args, 'node'),
          query: requireString(args, 'query'),
          topK: typeof args.topK === 'number' ? args.topK : 10,
        };
        if (args.filter && typeof args.filter === 'object') {
          payload.filter = args.filter as Record<string, unknown>;
        }
        if (typeof args.collection === 'string') {
          payload.collection = args.collection;
        }
        result = await caller.ragSearch(payload);
        break;
      }
      case 'llamactl.rag.listCollections':
        result = await caller.ragListCollections({
          node: requireString(args, 'node'),
        });
        break;
      case 'llamactl.composite.list':
        result = await caller.compositeList();
        break;
      case 'llamactl.composite.get':
        result = await caller.compositeGet({
          name: requireString(args, 'name'),
        });
        break;

      /* ---------------- mutations (dry-run-safe) ---------------- */
      case 'llamactl.catalog.promote': {
        const payload = {
          profile: requireString(args, 'profile') as
            | 'mac-mini-16g'
            | 'balanced'
            | 'macbook-pro-48g',
          preset: requireString(args, 'preset') as
            | 'best'
            | 'vision'
            | 'balanced'
            | 'fast',
          rel: requireString(args, 'rel'),
        };
        // The underlying procedure doesn't accept a dryRun flag — it
        // just writes the TSV. We surface the intended payload when
        // dryRun is requested instead of mutating disk.
        if (input.dryRun) {
          result = { dryRun: true, wouldWrite: payload };
        } else {
          result = await caller.promote(payload);
        }
        break;
      }
      case 'llamactl.node.add': {
        if (input.dryRun) {
          // No wet-run probe so dry-run just echoes the intended call.
          result = {
            dryRun: true,
            wouldRegister: {
              name: requireString(args, 'name'),
              bootstrapLength:
                typeof args.bootstrap === 'string' ? args.bootstrap.length : 0,
            },
          };
        } else {
          result = await caller.nodeAdd({
            name: requireString(args, 'name'),
            bootstrap: requireString(args, 'bootstrap'),
            ...(typeof args.force === 'boolean' ? { force: args.force } : {}),
          });
        }
        break;
      }
      case 'llamactl.rag.store': {
        const node = requireString(args, 'node');
        const documents = Array.isArray(args.documents)
          ? (args.documents as Array<{
              id: string;
              content: string;
              metadata?: Record<string, unknown>;
              vector?: number[];
            }>)
          : [];
        if (input.dryRun) {
          result = {
            dryRun: true,
            wouldStore: { node, count: documents.length },
          };
        } else {
          const payload: Parameters<Caller['ragStore']>[0] = {
            node,
            documents: documents as Parameters<Caller['ragStore']>[0]['documents'],
          };
          if (typeof args.collection === 'string') {
            payload.collection = args.collection;
          }
          result = await caller.ragStore(payload);
        }
        break;
      }
      case 'llamactl.composite.apply': {
        // The composite procedure supports dry-run natively (it
        // returns `{ dryRun: true, manifest, order, impliedEdges }`)
        // so we just forward the flag — no synthesized preview at
        // this layer.
        result = await caller.compositeApply({
          manifestYaml: requireString(args, 'manifestYaml'),
          dryRun: input.dryRun,
        });
        break;
      }

      /* ---------------- mutations (destructive) ---------------- */
      case 'llamactl.catalog.promoteDelete': {
        const payload = {
          profile: requireString(args, 'profile') as
            | 'mac-mini-16g'
            | 'balanced'
            | 'macbook-pro-48g',
          preset: requireString(args, 'preset') as
            | 'best'
            | 'vision'
            | 'balanced'
            | 'fast',
        };
        if (input.dryRun) {
          result = { dryRun: true, wouldRemove: payload };
        } else {
          result = await caller.promoteDelete(payload);
        }
        break;
      }
      case 'llamactl.workload.delete': {
        const payload = {
          name: requireString(args, 'name'),
          keepRunning:
            typeof args.keepRunning === 'boolean' ? args.keepRunning : false,
        };
        if (input.dryRun) {
          result = { dryRun: true, wouldDelete: payload };
        } else {
          result = await caller.workloadDelete(payload);
        }
        break;
      }
      case 'llamactl.node.remove': {
        const payload = { name: requireString(args, 'name') };
        if (input.dryRun) {
          result = { dryRun: true, wouldRemove: payload };
        } else {
          result = await caller.nodeRemove(payload);
        }
        break;
      }
      case 'llamactl.rag.delete': {
        const node = requireString(args, 'node');
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
        if (input.dryRun) {
          result = { dryRun: true, wouldDelete: { node, ids } };
        } else {
          const payload: Parameters<Caller['ragDelete']>[0] = { node, ids };
          if (typeof args.collection === 'string') {
            payload.collection = args.collection;
          }
          result = await caller.ragDelete(payload);
        }
        break;
      }
      case 'llamactl.composite.destroy': {
        // Like compositeApply, the procedure handles dry-run
        // natively — forward the flag. `purgeVolumes` is the
        // operator-initiated opt-in for wiping storage alongside
        // the container; default false so re-apply is data-safe.
        result = await caller.compositeDestroy({
          name: requireString(args, 'name'),
          dryRun: input.dryRun,
          purgeVolumes: (args.purgeVolumes as boolean | undefined) ?? false,
        });
        break;
      }
    }

    return {
      ok: true,
      name: input.name,
      tier,
      durationMs: Date.now() - startedAt,
      result,
    };
  } catch (err) {
    return {
      ok: false,
      name: input.name,
      tier,
      durationMs: Date.now() - startedAt,
      error: {
        code: (err as { code?: string }).code ?? 'dispatch_error',
        message: (err as Error).message ?? String(err),
      },
    };
  }
}
