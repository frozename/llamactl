import { z } from 'zod';
import type { Runbook, RunbookStep } from '../types.js';
import { parseToolJson } from '../types.js';

/**
 * Snapshot every piece of fleet state a human operator would assemble
 * by running node.ls + promotions.list + workload.list + bench.compare
 * + server.status by hand. No mutations — the runbook is safe to run
 * on any schedule, and the result shape makes a clean artefact to
 * archive.
 *
 * Runbook steps:
 *   1. llamactl.node.ls
 *   2. llamactl.promotions.list
 *   3. llamactl.workload.list
 *   4. llamactl.server.status
 *   5. llamactl.bench.compare   (all classes, all scopes)
 *
 * Output: a single aggregated object (returned as the final step's
 * `result`) that downstream agents can consume directly.
 */

const ParamsSchema = z.object({}).default({});
type Params = z.infer<typeof ParamsSchema>;

interface NodesLsPayload {
  context: string | null;
  cluster: string | null;
  nodes: Array<{ name: string; endpoint: string; kind: string }>;
}

interface PromotionRow {
  profile: string;
  preset: string;
  rel: string;
  updated_at?: string;
}

interface WorkloadRow {
  name: string;
  node: string;
  rel: string;
  gateway: boolean;
  status: { phase?: string } | null;
}

interface WorkloadListPayload {
  count: number;
  workloads: WorkloadRow[];
}

interface ServerStatusPayload {
  state?: string;
  rel?: string | null;
  endpoint?: string;
  pid?: number | null;
}

interface BenchRow {
  rel: string;
  class: string;
  installed: boolean;
  tuned: { gen_tps?: string } | null;
}

export const auditFleet: Runbook<Params> = {
  name: 'audit-fleet',
  description:
    'Read-only fleet snapshot — nodes + promotions + workloads + local llama-server status + installed+benched model count. No mutations; safe to run on any cadence.',
  paramsSchema: ParamsSchema,
  async execute(ctx) {
    const steps: RunbookStep[] = [];

    const nodes = parseToolJson<NodesLsPayload>(
      await ctx.tools.callTool({ name: 'llamactl.node.ls', arguments: {} }),
    );
    steps.push({
      tool: 'llamactl.node.ls',
      dryRun: false,
      result: {
        context: nodes.context,
        cluster: nodes.cluster,
        nodeCount: nodes.nodes.length,
      },
    });

    const promotions = parseToolJson<PromotionRow[]>(
      await ctx.tools.callTool({ name: 'llamactl.promotions.list', arguments: {} }),
    );
    steps.push({
      tool: 'llamactl.promotions.list',
      dryRun: false,
      result: { count: promotions.length },
    });

    const workloads = parseToolJson<WorkloadListPayload>(
      await ctx.tools.callTool({ name: 'llamactl.workload.list', arguments: {} }),
    );
    steps.push({
      tool: 'llamactl.workload.list',
      dryRun: false,
      result: { count: workloads.count },
    });

    let serverStatus: ServerStatusPayload | { error: string };
    try {
      serverStatus = parseToolJson<ServerStatusPayload>(
        await ctx.tools.callTool({ name: 'llamactl.server.status', arguments: {} }),
      );
    } catch (err) {
      serverStatus = { error: (err as Error).message };
    }
    steps.push({
      tool: 'llamactl.server.status',
      dryRun: false,
      result: serverStatus,
    });

    const bench = parseToolJson<BenchRow[]>(
      await ctx.tools.callTool({
        name: 'llamactl.bench.compare',
        arguments: { classFilter: 'all', scopeFilter: 'all' },
      }),
    );
    const installedAndBenched = bench.filter(
      (r) => r.installed && r.tuned && Number.parseFloat(r.tuned.gen_tps ?? '0') > 0,
    );
    steps.push({
      tool: 'llamactl.bench.compare',
      dryRun: false,
      result: {
        inspected: bench.length,
        installedAndBenched: installedAndBenched.length,
      },
    });

    ctx.log(
      `audit-fleet: ${nodes.nodes.length} nodes, ${promotions.length} promotions, ` +
        `${workloads.count} workloads, ${installedAndBenched.length} benched models`,
    );

    return {
      ok: true,
      steps,
      summary: {
        context: nodes.context,
        cluster: nodes.cluster,
        nodes: nodes.nodes,
        promotions,
        workloads: workloads.workloads,
        serverStatus,
        installedAndBenched: installedAndBenched.map((r) => ({
          rel: r.rel,
          class: r.class,
          genTps: r.tuned?.gen_tps ?? '0',
        })),
      },
    };
  },
};
