import { z } from 'zod';
import type { Runbook, RunbookStep } from '../types.js';
import { parseToolJson } from '../types.js';

/**
 * Read-only cost snapshot. Aggregates recorded usage JSONL for the
 * last N days and summarises top spenders. Safe on any cadence — no
 * mutations. Pairs with the N.3.6 cost-guardian agent which will
 * extend this with thresholds + actions.
 *
 * Runbook steps:
 *   1. nova.ops.cost.snapshot({ days: params.days })
 *
 * Output (summary):
 *   {
 *     windowSince, windowUntil, totalRequests, totalTokens,
 *     topProviders: [{ key, totalTokens, requestCount, avgLatencyMs }],
 *     topModels:    [{ key, totalTokens, requestCount, avgLatencyMs }]
 *   }
 */

const ParamsSchema = z
  .object({
    days: z.number().int().positive().max(90).default(7),
    topN: z.number().int().positive().max(20).default(5),
  })
  .default({ days: 7, topN: 5 });
type Params = z.infer<typeof ParamsSchema>;

interface CostGroup {
  key: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

interface CostSnapshotPayload {
  windowSince: string;
  windowUntil: string;
  filesScanned: number;
  malformedLines: number;
  totalRequests: number;
  totalTokens: number;
  byProvider: CostGroup[];
  byModel: CostGroup[];
}

export const costSnapshot: Runbook<Params> = {
  name: 'cost-snapshot',
  description:
    'Read-only spend snapshot — aggregates ~/.llamactl/usage/*.jsonl over the last N days via nova.ops.cost.snapshot. Reports top spenders by provider + model. No mutations.',
  paramsSchema: ParamsSchema,
  async execute(ctx, params) {
    const steps: RunbookStep[] = [];
    const snap = parseToolJson<CostSnapshotPayload>(
      await ctx.tools.callTool({
        name: 'nova.ops.cost.snapshot',
        arguments: { days: params.days },
      }),
    );
    steps.push({
      tool: 'nova.ops.cost.snapshot',
      dryRun: false,
      result: {
        filesScanned: snap.filesScanned,
        totalRequests: snap.totalRequests,
        totalTokens: snap.totalTokens,
      },
    });

    const topProviders = snap.byProvider.slice(0, params.topN);
    const topModels = snap.byModel.slice(0, params.topN);

    ctx.log(
      `cost-snapshot: ${snap.totalRequests} requests / ${snap.totalTokens} tokens ` +
        `across ${snap.filesScanned} file(s) in window ` +
        `${snap.windowSince} → ${snap.windowUntil}`,
    );

    return {
      ok: true,
      steps,
      summary: {
        windowSince: snap.windowSince,
        windowUntil: snap.windowUntil,
        filesScanned: snap.filesScanned,
        malformedLines: snap.malformedLines,
        totalRequests: snap.totalRequests,
        totalTokens: snap.totalTokens,
        topProviders,
        topModels,
      },
    };
  },
};
