import { z } from 'zod';
import type { Runbook, RunbookStep } from '../types.js';
import { parseToolJson } from '../types.js';

const ProfileSchema = z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']);
const ParamsSchema = z.object({
  /** If set, only promote on this one profile. Otherwise fan out over
   *  all three built-in profiles. */
  profile: ProfileSchema.optional(),
});

type Params = z.infer<typeof ParamsSchema>;

interface BenchRow {
  rel: string;
  class: string;
  installed: boolean;
  tuned: { gen_tps: string } | null;
}

/**
 * Pick the highest-gen-tps installed multimodal model and promote it
 * to the `vision` preset on every profile (or the one named in
 * params). Finishes by syncing embersynth.yaml so fusion-vision
 * routes through the new pick.
 *
 * Runbook steps:
 *   1. llamactl.bench.compare { classFilter: multimodal }  — rank candidates
 *   2. llamactl.catalog.promote × N profiles               — write overrides
 *   3. llamactl.embersynth.sync                            — regenerate YAML
 */
export const promoteFastestVisionModel: Runbook<Params> = {
  name: 'promote-fastest-vision-model',
  description:
    'Rank installed multimodal models by last-recorded gen_tps and promote the fastest to the vision preset. Fans out across every profile unless --params {"profile":"..."}.',
  paramsSchema: ParamsSchema,
  async execute(ctx, params) {
    const steps: RunbookStep[] = [];

    const benchRaw = await ctx.tools.callTool({
      name: 'llamactl.bench.compare',
      arguments: { classFilter: 'multimodal', scopeFilter: 'all' },
    });
    const bench = parseToolJson<BenchRow[]>(benchRaw);
    const candidates = bench
      .filter((r) => r.installed && r.tuned && Number.isFinite(Number.parseFloat(r.tuned.gen_tps)))
      .sort(
        (a, b) =>
          Number.parseFloat(b.tuned!.gen_tps) - Number.parseFloat(a.tuned!.gen_tps),
      );
    steps.push({
      tool: 'llamactl.bench.compare',
      dryRun: false,
      result: { inspected: bench.length, candidates: candidates.length, top: candidates[0]?.rel ?? null },
    });
    if (candidates.length === 0) {
      return {
        ok: false,
        steps,
        error: 'no installed multimodal models with a recorded bench run — pull + bench one first',
      };
    }
    const top = candidates[0]!;
    ctx.log(`promote-fastest-vision-model: top candidate ${top.rel}`);

    const profiles = params.profile ? [params.profile] : (['mac-mini-16g', 'balanced', 'macbook-pro-48g'] as const);
    for (const profile of profiles) {
      const promoteRaw = await ctx.tools.callTool({
        name: 'llamactl.catalog.promote',
        arguments: {
          profile,
          preset: 'vision',
          rel: top.rel,
          dryRun: ctx.dryRun,
        },
      });
      steps.push({
        tool: 'llamactl.catalog.promote',
        dryRun: ctx.dryRun,
        result: parseToolJson(promoteRaw),
      });
    }

    const syncRaw = await ctx.tools.callTool({
      name: 'llamactl.embersynth.sync',
      arguments: { dryRun: ctx.dryRun },
    });
    steps.push({
      tool: 'llamactl.embersynth.sync',
      dryRun: ctx.dryRun,
      result: parseToolJson(syncRaw),
    });

    return { ok: true, steps };
  },
};
