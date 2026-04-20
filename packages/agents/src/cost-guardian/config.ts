import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Cost-guardian configuration. Lives at `~/.llamactl/cost-guardian.yaml`
 * (override via `$LLAMACTL_COST_GUARDIAN_CONFIG`). Operators edit this
 * by hand; llamactl never writes it.
 *
 * YAML shape:
 *   budget:
 *     daily_usd: 10
 *     weekly_usd: 60      # optional; when omitted, only daily is checked
 *   thresholds:
 *     warn: 0.5           # 50 % of budget → warn
 *     force_private: 0.8  # 80 % → flip embersynth default to private-first
 *     deregister: 0.95    # 95 % → dry-run deregister top spender
 *   webhook_url: https://...    # optional — POST'd on every non-noop tick
 *   auto_force_private: false   # N.3.6 does not yet act on tier-2; flag
 *                                 is recorded for future slices
 *   auto_deregister: false      # same — tier-3 is designed, never auto
 *
 * Missing file → returns a safe default (no budget, thresholds
 * inert). Malformed file → Zod parse error surfaces to the caller.
 */

export const CostGuardianBudgetSchema = z.object({
  daily_usd: z.number().positive().optional(),
  weekly_usd: z.number().positive().optional(),
});

export const CostGuardianThresholdsSchema = z
  .object({
    warn: z.number().min(0).max(1).default(0.5),
    force_private: z.number().min(0).max(1).default(0.8),
    deregister: z.number().min(0).max(1).default(0.95),
  })
  .refine((t) => t.warn <= t.force_private && t.force_private <= t.deregister, {
    message:
      'thresholds must be non-decreasing: warn ≤ force_private ≤ deregister',
  });

export const CostGuardianConfigSchema = z.object({
  budget: CostGuardianBudgetSchema.default({}),
  thresholds: CostGuardianThresholdsSchema.default({
    warn: 0.5,
    force_private: 0.8,
    deregister: 0.95,
  }),
  webhook_url: z.url().optional(),
  auto_force_private: z.boolean().default(false),
  auto_deregister: z.boolean().default(false),
  /** Provider names that must never be auto-deregistered, regardless of
   *  `auto_deregister` / `--auto-tier-3`. The denylist overrides the auto
   *  flag; matches here are always journaled as `deregister-refused`. */
  protectedProviders: z.array(z.string()).default(['fleet-internal']),
});

export type CostGuardianBudget = z.infer<typeof CostGuardianBudgetSchema>;
export type CostGuardianThresholds = z.infer<typeof CostGuardianThresholdsSchema>;
export type CostGuardianConfig = z.infer<typeof CostGuardianConfigSchema>;

export function defaultCostGuardianConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LLAMACTL_COST_GUARDIAN_CONFIG?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'cost-guardian.yaml');
}

export function emptyCostGuardianConfig(): CostGuardianConfig {
  return CostGuardianConfigSchema.parse({});
}

export function loadCostGuardianConfig(
  path: string = defaultCostGuardianConfigPath(),
): CostGuardianConfig {
  if (!existsSync(path)) return emptyCostGuardianConfig();
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = parseYaml(raw);
  return CostGuardianConfigSchema.parse(parsed ?? {});
}
