import { z } from 'zod';
import type { Runbook, RunbookStep } from '../types.js';
import { parseToolJson } from '../types.js';

/**
 * Drain a node: delete every workload manifest targeting the named
 * node, then remove the node from the kubeconfig. Does NOT stop a
 * running llama-server on the node — that's either an imperative
 * CLI step (llamactl server stop --node <n>) or a follow-up once a
 * server.stop MCP tool lands.
 *
 * Intended use:
 *   * Retiring a node that's being decommissioned.
 *   * Temporarily removing a flaky node from the fleet.
 *
 * Runbook steps:
 *   1. llamactl.workload.list
 *   2. llamactl.workload.delete × N matching workloads (or single
 *      dry-run step when no matches).
 *   3. llamactl.node.remove.
 */

const ParamsSchema = z.object({
  node: z.string().min(1).describe('metadata.name of the node to drain'),
  /** When true, keep the node registered in kubeconfig after draining
   *  workloads. Useful for a "quiesce" operation that reuses the node
   *  later without going through a fresh bootstrap. */
  keepNode: z.boolean().default(false),
});
type Params = z.infer<typeof ParamsSchema>;

interface WorkloadRow {
  name: string;
  node: string;
  rel: string;
}

interface WorkloadListPayload {
  count: number;
  workloads: WorkloadRow[];
}

export const drainNode: Runbook<Params> = {
  name: 'drain-node',
  description:
    'Delete every ModelRun manifest targeting the named node, then (unless --params {"keepNode":true}) remove the node from kubeconfig. Does NOT stop a running llama-server on the node; chain with a manual `llamactl server stop --node X` when needed.',
  paramsSchema: ParamsSchema,
  async execute(ctx, params) {
    const steps: RunbookStep[] = [];

    const workloadsRaw = await ctx.tools.callTool({
      name: 'llamactl.workload.list',
      arguments: {},
    });
    const workloads = parseToolJson<WorkloadListPayload>(workloadsRaw);
    const matching = workloads.workloads.filter((w) => w.node === params.node);
    steps.push({
      tool: 'llamactl.workload.list',
      dryRun: false,
      result: { total: workloads.count, matching: matching.length },
    });

    for (const w of matching) {
      const delRaw = await ctx.tools.callTool({
        name: 'llamactl.workload.delete',
        arguments: { name: w.name, dryRun: ctx.dryRun },
      });
      steps.push({
        tool: 'llamactl.workload.delete',
        dryRun: ctx.dryRun,
        result: parseToolJson(delRaw),
      });
    }

    if (!params.keepNode) {
      const rmRaw = await ctx.tools.callTool({
        name: 'llamactl.node.remove',
        arguments: { name: params.node, dryRun: ctx.dryRun },
      });
      steps.push({
        tool: 'llamactl.node.remove',
        dryRun: ctx.dryRun,
        result: parseToolJson(rmRaw),
      });
    }

    ctx.log(
      `drain-node: removed ${matching.length} manifest(s) on ${params.node}` +
        (params.keepNode ? ' (node kept)' : ' + node'),
    );

    return {
      ok: true,
      steps,
      summary: {
        node: params.node,
        drainedWorkloads: matching.map((w) => w.name),
        nodeRemoved: !params.keepNode,
      },
    };
  },
};
