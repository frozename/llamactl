import { z } from 'zod';
import type { Runbook, RunbookStep } from '../types.js';
import { parseToolJson } from '../types.js';

/**
 * Register a freshly-bootstrapped agent node with the current cluster.
 * Dry-run previews the kubeconfig entry without writing; wet-run
 * commits the node to kubeconfig and syncs embersynth.yaml so the new
 * node appears in the routing fan-out immediately.
 *
 * Scope this runbook covers:
 *   1. Parse + validate the bootstrap blob (via llamactl.node.add dry-run)
 *   2. Commit the node (llamactl.node.add wet)
 *   3. Confirm the node is visible (llamactl.node.ls)
 *   4. Regenerate embersynth.yaml so the new agent joins the routing pool
 *
 * Out of scope:
 *   * Running a bench on the new node. Bench is a streaming op and
 *     doesn't expose cleanly as a single-shot MCP tool. Operator runs
 *     `llamactl --node <name> bench preset <rel>` manually after
 *     onboarding; the next embersynth.sync will pick up the priority.
 *   * Installing infra (llama.cpp, embersynth, sirius). Covered by the
 *     separate infra-deployment-kubeadm plan — this runbook assumes
 *     the node's agent is already serving.
 */

const ParamsSchema = z.object({
  name: z.string().min(1).describe('kubeconfig name for the new node'),
  bootstrap: z
    .string()
    .min(1)
    .describe('base64 blob emitted by `llamactl agent init` on the new host'),
});
type Params = z.infer<typeof ParamsSchema>;

interface NodesLsPayload {
  context: string | null;
  cluster: string | null;
  nodes: Array<{ name: string; kind: string }>;
}

export const onboardNewGpuNode: Runbook<Params> = {
  name: 'onboard-new-gpu-node',
  description:
    'Add a bootstrapped agent node to kubeconfig and refresh embersynth.yaml so the new agent joins the routing pool. Does NOT install infra or run bench — those are separate operator steps.',
  paramsSchema: ParamsSchema,
  async execute(ctx, params) {
    const steps: RunbookStep[] = [];

    // Validate the bootstrap + preview the add in dry-run first. Any
    // issue with the blob surfaces here instead of after a write.
    const preview = parseToolJson<{ dryRun: boolean; message: string; node?: unknown; error?: string }>(
      await ctx.tools.callTool({
        name: 'llamactl.node.add',
        arguments: { name: params.name, bootstrap: params.bootstrap, dryRun: true },
      }),
    );
    steps.push({ tool: 'llamactl.node.add', dryRun: true, result: preview });
    if (preview.error) {
      return { ok: false, steps, error: `bootstrap blob rejected: ${preview.error}` };
    }

    if (ctx.dryRun) {
      ctx.log(`onboard-new-gpu-node: dry-run — would add ${params.name} and sync embersynth`);
      return {
        ok: true,
        steps,
        summary: {
          dryRun: true,
          name: params.name,
          preview,
        },
      };
    }

    const addResult = parseToolJson<{ ok: boolean; name?: string; endpoint?: string; error?: string }>(
      await ctx.tools.callTool({
        name: 'llamactl.node.add',
        arguments: { name: params.name, bootstrap: params.bootstrap, dryRun: false },
      }),
    );
    steps.push({ tool: 'llamactl.node.add', dryRun: false, result: addResult });
    if (!addResult.ok) {
      return { ok: false, steps, error: addResult.error ?? 'node.add failed' };
    }

    const nodeList = parseToolJson<NodesLsPayload>(
      await ctx.tools.callTool({ name: 'llamactl.node.ls', arguments: {} }),
    );
    const confirmed = nodeList.nodes.some((n) => n.name === params.name);
    steps.push({
      tool: 'llamactl.node.ls',
      dryRun: false,
      result: { confirmed, totalNodes: nodeList.nodes.length },
    });
    if (!confirmed) {
      return {
        ok: false,
        steps,
        error: `node ${params.name} not visible in kubeconfig after add`,
      };
    }

    const sync = parseToolJson(
      await ctx.tools.callTool({
        name: 'llamactl.embersynth.sync',
        arguments: { dryRun: false },
      }),
    );
    steps.push({ tool: 'llamactl.embersynth.sync', dryRun: false, result: sync });

    ctx.log(
      `onboard-new-gpu-node: ${params.name} joined cluster ${nodeList.cluster ?? '?'} (${nodeList.nodes.length} total nodes)`,
    );

    return {
      ok: true,
      steps,
      summary: {
        name: params.name,
        endpoint: addResult.endpoint ?? null,
        cluster: nodeList.cluster,
        totalNodes: nodeList.nodes.length,
      },
    };
  },
};
