import { z } from "zod";

import type { Runbook, RunbookStep } from "../types.js";

import { parseToolJson } from "../types.js";

// Mirrors MACHINE_PROFILES in packages/core/src/types.ts. Copied by hand
// because packages/agents does not depend on @llamactl/core.
const BUILTIN_PROFILES = ["mac-mini-16g", "balanced", "macbook-pro-48g", "large-128g"] as const;
const ProfileSchema = z.enum(BUILTIN_PROFILES);
const ParamsSchema = z.object({
  /** If set, only promote on this one profile. Otherwise fan out over
   *  every built-in profile. */
  profile: ProfileSchema.optional(),
});

type Params = z.infer<typeof ParamsSchema>;

interface BenchRow {
  rel: string;
  class: string;
  installed: boolean;
  tuned: { gen_tps: string } | null;
  /** Routing stage from the catalog qualification (#518). "experimental" rels
   *  are excluded from the fastest-vision promotion runbook. */
  qualificationStage?: string;
}

interface PromoteResult {
  ok?: boolean;
  refused?: string;
  dryRun?: boolean;
  error?: string;
}

/**
 * Pick the highest-gen-tps installed multimodal model and promote it
 * to the `vision` preset on every profile (or the one named in
 * params). Finishes by syncing embersynth.yaml so fusion-vision
 * routes through the new pick.
 *
 * Experimental rels (qualificationStage === "experimental") are excluded
 * from the eligible set and reported on `excludedExperimental` in the
 * bench.compare step result. When every benched installed multimodal rel
 * is experimental, the runbook returns ok:false with an error listing the
 * excluded rels and stating that experimental models are served only on
 * an exact model pin and never as a preset default.
 *
 * A failed promote step (ok:false with an error message, or a dry-run
 * with `refused` on the result) fails the runbook before embersynth.sync
 * is called.
 *
 * Runbook steps:
 *   1. llamactl.bench.compare { classFilter: multimodal }  — rank candidates
 *   2. llamactl.catalog.promote × N profiles               — write overrides
 *   3. llamactl.embersynth.sync                            — regenerate YAML
 */
export const promoteFastestVisionModel: Runbook<Params> = {
  name: "promote-fastest-vision-model",
  description:
    'Rank installed multimodal models by last-recorded gen_tps and promote the fastest to the vision preset. Fans out across every profile unless --params {"profile":"..."}.',
  paramsSchema: ParamsSchema,
  async execute(ctx, params) {
    const steps: RunbookStep[] = [];

    const benchRaw = await ctx.tools.callTool({
      name: "llamactl.bench.compare",
      arguments: { classFilter: "multimodal", scopeFilter: "all" },
    });
    const bench = parseToolJson<BenchRow[]>(benchRaw);
    const excludedExperimental: string[] = [];
    const eligible = bench.filter((r) => {
      // Installed + tuned + finite gen_tps first, so only otherwise-eligible
      // rels are ever reported as experimental exclusions.
      if (!r.installed || !r.tuned || !Number.isFinite(Number.parseFloat(r.tuned.gen_tps))) {
        return false;
      }
      if (r.qualificationStage === "experimental") {
        excludedExperimental.push(r.rel);
        return false;
      }
      return true;
    });
    const candidates = eligible
      .map((row) => ({ row, genTps: Number.parseFloat(row.tuned?.gen_tps ?? "0") }))
      .sort((a, b) => b.genTps - a.genTps);
    steps.push({
      tool: "llamactl.bench.compare",
      dryRun: false,
      result: {
        inspected: bench.length,
        candidates: candidates.length,
        top: candidates[0]?.row.rel ?? null,
        ...(excludedExperimental.length > 0 ? { excludedExperimental } : {}),
      },
    });
    const top = candidates.at(0)?.row;
    if (top === undefined) {
      if (excludedExperimental.length > 0) {
        return {
          ok: false,
          steps,
          error: `every benched installed multimodal rel is experimental (${excludedExperimental.join(", ")}); experimental models are served only on an exact model pin and never as a preset default`,
        };
      }
      return {
        ok: false,
        steps,
        error: "no installed multimodal models with a recorded bench run — pull + bench one first",
      };
    }
    ctx.log(`promote-fastest-vision-model: top candidate ${top.rel}`);

    const profiles = params.profile ? [params.profile] : BUILTIN_PROFILES;
    for (const profile of profiles) {
      const promoteRaw = await ctx.tools.callTool({
        name: "llamactl.catalog.promote",
        arguments: {
          profile,
          preset: "vision",
          rel: top.rel,
          dryRun: ctx.dryRun,
        },
      });
      const promoteResult = parseToolJson<PromoteResult>(promoteRaw);
      steps.push({
        tool: "llamactl.catalog.promote",
        dryRun: ctx.dryRun,
        result: promoteResult,
      });
      // A failure is ok === false (wet run) or a string `refused` (dry run).
      const isFailure = promoteResult.ok === false || typeof promoteResult.refused === "string";
      if (isFailure) {
        const message =
          typeof promoteResult.refused === "string"
            ? promoteResult.refused
            : (promoteResult.error ?? "unknown");
        return {
          ok: false,
          steps,
          error: `llamactl.catalog.promote refused ${top.rel} for profile ${profile}: ${message}`,
        };
      }
    }

    const syncRaw = await ctx.tools.callTool({
      name: "llamactl.embersynth.sync",
      arguments: { dryRun: ctx.dryRun },
    });
    steps.push({
      tool: "llamactl.embersynth.sync",
      dryRun: ctx.dryRun,
      result: parseToolJson(syncRaw),
    });

    return { ok: true, steps };
  },
};
